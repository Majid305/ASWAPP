import {
  FinancialDestination,
  InvoiceStatus,
  PaymentMethod,
  ReminderStatus,
  StockStatus,
} from '../types/domain';
import { daysBetweenBusinessDates, getMoroccoBusinessDate } from '../utils/dateUtils';

/**
 * MOTEUR MONÉTAIRE CENTRALISÉ (Sections 12 & 13, Règles 10 & 11)
 * Toutes les valeurs monétaires sont stockées et calculées en centimes entiers (1 MAD = 100 centimes)
 * pour éliminer toute dérive de virgule flottante IEEE 754.
 */

export function dhToCents(amountDh: number | string): number {
  const num = typeof amountDh === 'string' ? parseFloat(amountDh.replace(',', '.')) : amountDh;
  if (!Number.isFinite(num)) return 0;
  return Math.round(num * 100);
}

export function centsToDh(amountCents: number): number {
  if (!Number.isFinite(amountCents)) return 0;
  return Math.round(amountCents) / 100;
}

export function formatMad(amountCents: number, currencyLabel = 'MAD'): string {
  const val = centsToDh(amountCents);
  const formatted = new Intl.NumberFormat('fr-MA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val);
  return `${formatted} ${currencyLabel}`;
}

export interface DocumentLineInput {
  productId: string;
  productRef: string;
  productName: string;
  quantity: number;
  unitCostCents?: number;
  unitPriceHtCents: number;
  discountPercent: number;
  discountAmountHtCents?: number;
  vatRate: number;
}

export interface CalculatedDocumentLine extends DocumentLineInput {
  unitCostCents: number;
  lineGrossHtCents: number;
  lineDiscountCents: number;
  lineSubtotalHtCents: number;
  lineGlobalDiscountShareCents: number;
  lineTaxableCents: number;
  lineVatCents: number;
  lineTtcCents: number;
  lineCostCents: number;
  lineMarginCents: number;
}

export interface VatRateBreakdown {
  vatRate: number;
  taxableBaseCents: number;
  vatAmountCents: number;
  ttcAmountCents: number;
}

export interface CalculatedDocumentTotals {
  lines: CalculatedDocumentLine[];
  grossHtCents: number;
  lineDiscountTotalCents: number;
  subtotalHtCents: number;
  globalDiscountPercent: number;
  globalDiscountCents: number;
  totalTaxableCents: number;
  totalVatCents: number;
  totalTtcCents: number;
  totalCostCents: number;
  marginCents: number;
  marginRatePercent: number;
  markupRatePercent: number;
  vatBreakdown: VatRateBreakdown[];
}

/**
 * RÈGLES 10 & 11 :
 * Ordre strict : Prix ligne -> remise ligne -> sous-total -> remise globale -> base taxable -> TVA par ligne -> TTC
 * Une remise par ligne et une remise globale ne sont jamais appliquées deux fois sur la même base.
 * La remise globale s'applique sur le sous-total déjà net des remises lignes, répartie exactement ligne par ligne.
 */
export function calculateDocumentLinesAndTotals(
  rawLines: DocumentLineInput[],
  globalDiscountPercentInput = 0,
  globalDiscountAmountCentsInput?: number
): CalculatedDocumentTotals {
  // Étape 1 : Calcul Prix ligne -> Remise ligne (% ou Montant avec décimales) -> Sous-total ligne HT
  const step1Lines = rawLines.map((line) => {
    const qty = Math.max(0, Number(line.quantity) || 0);
    const unitPriceHtCents = Math.max(0, Math.round(Number(line.unitPriceHtCents) || 0));
    const unitCostCents = Math.max(0, Math.round(Number(line.unitCostCents) || 0));
    const vatRate = Math.max(0, Number(line.vatRate) || 0);

    const lineGrossHtCents = Math.round(unitPriceHtCents * qty);

    let lineDiscountCents = 0;
    let discountPercent = Math.max(0, Math.min(100, Number(line.discountPercent) || 0));

    if (
      line.discountAmountHtCents !== undefined &&
      Number.isFinite(line.discountAmountHtCents) &&
      line.discountAmountHtCents >= 0
    ) {
      lineDiscountCents = Math.max(
        0,
        Math.min(lineGrossHtCents, Math.round(line.discountAmountHtCents))
      );
      discountPercent =
        lineGrossHtCents > 0
          ? Math.round((lineDiscountCents / lineGrossHtCents) * 10000) / 100
          : 0;
    } else {
      lineDiscountCents = Math.round((lineGrossHtCents * discountPercent) / 100);
    }

    const lineSubtotalHtCents = Math.max(0, lineGrossHtCents - lineDiscountCents);
    const lineCostCents = Math.round(unitCostCents * qty);

    return {
      ...line,
      quantity: qty,
      unitPriceHtCents,
      unitCostCents,
      discountPercent,
      vatRate,
      lineGrossHtCents,
      lineDiscountCents,
      lineSubtotalHtCents,
      lineCostCents,
    };
  });

  const grossHtCents = step1Lines.reduce((acc, l) => acc + l.lineGrossHtCents, 0);
  const lineDiscountTotalCents = step1Lines.reduce((acc, l) => acc + l.lineDiscountCents, 0);
  const subtotalHtCents = step1Lines.reduce((acc, l) => acc + l.lineSubtotalHtCents, 0);

  // Étape 2 : Remise globale sur le sous-total HT (% ou Montant avec décimales) et répartition prorata exacte
  let globalDiscountCents = 0;
  let globalDiscountPercent = Math.max(0, Math.min(100, Number(globalDiscountPercentInput) || 0));

  if (
    globalDiscountAmountCentsInput !== undefined &&
    Number.isFinite(globalDiscountAmountCentsInput) &&
    globalDiscountAmountCentsInput >= 0
  ) {
    globalDiscountCents = Math.max(
      0,
      Math.min(subtotalHtCents, Math.round(globalDiscountAmountCentsInput))
    );
    globalDiscountPercent =
      subtotalHtCents > 0
        ? Math.round((globalDiscountCents / subtotalHtCents) * 10000) / 100
        : 0;
  } else {
    globalDiscountCents = Math.round((subtotalHtCents * globalDiscountPercent) / 100);
  }

  let remainingGlobalDiscountToAllocate = globalDiscountCents;
  const calculatedLines: CalculatedDocumentLine[] = step1Lines.map((line, idx) => {
    let share = 0;
    if (subtotalHtCents > 0 && globalDiscountCents > 0) {
      if (idx === step1Lines.length - 1) {
        share = Math.max(0, Math.min(line.lineSubtotalHtCents, remainingGlobalDiscountToAllocate));
      } else {
        share = Math.min(
          line.lineSubtotalHtCents,
          Math.round((globalDiscountCents * line.lineSubtotalHtCents) / subtotalHtCents)
        );
        remainingGlobalDiscountToAllocate -= share;
      }
    }

    const lineTaxableCents = Math.max(0, line.lineSubtotalHtCents - share);
    // Étape 3 : TVA calculée sur la base taxable de chaque ligne avec son propre taux
    const lineVatCents = Math.round((lineTaxableCents * line.vatRate) / 100);
    const lineTtcCents = lineTaxableCents + lineVatCents;
    const lineMarginCents = lineTaxableCents - line.lineCostCents;

    return {
      ...line,
      lineGlobalDiscountShareCents: share,
      lineTaxableCents,
      lineVatCents,
      lineTtcCents,
      lineMarginCents,
    };
  });

  const totalTaxableCents = calculatedLines.reduce((acc, l) => acc + l.lineTaxableCents, 0);
  const totalVatCents = calculatedLines.reduce((acc, l) => acc + l.lineVatCents, 0);
  const totalTtcCents = calculatedLines.reduce((acc, l) => acc + l.lineTtcCents, 0);
  const totalCostCents = calculatedLines.reduce((acc, l) => acc + l.lineCostCents, 0);
  const marginCents = totalTaxableCents - totalCostCents;

  // Taux de marque = Marge / CA HT ; Taux de marge = Marge / Coût d'achat HT
  const marginRatePercent =
    totalTaxableCents > 0 ? Math.round((marginCents / totalTaxableCents) * 10000) / 100 : 0;
  const markupRatePercent =
    totalCostCents > 0 ? Math.round((marginCents / totalCostCents) * 10000) / 100 : 0;

  // Ventilation par taux de TVA
  const vatMap = new Map<number, VatRateBreakdown>();
  for (const line of calculatedLines) {
    const existing = vatMap.get(line.vatRate) ?? {
      vatRate: line.vatRate,
      taxableBaseCents: 0,
      vatAmountCents: 0,
      ttcAmountCents: 0,
    };
    existing.taxableBaseCents += line.lineTaxableCents;
    existing.vatAmountCents += line.lineVatCents;
    existing.ttcAmountCents += line.lineTtcCents;
    vatMap.set(line.vatRate, existing);
  }

  const vatBreakdown = Array.from(vatMap.values()).sort((a, b) => a.vatRate - b.vatRate);

  return {
    lines: calculatedLines,
    grossHtCents,
    lineDiscountTotalCents,
    subtotalHtCents,
    globalDiscountPercent,
    globalDiscountCents,
    totalTaxableCents,
    totalVatCents,
    totalTtcCents,
    totalCostCents,
    marginCents,
    marginRatePercent,
    markupRatePercent,
    vatBreakdown,
  };
}

/**
 * RÈGLE 3 : Facture et paiement
 * Le statut est exclusivement calculé à partir des paiements réellement enregistrés.
 */
export function computeInvoiceStatus(
  totalTtcCents: number,
  paidCents: number,
  isCancelled = false
): InvoiceStatus {
  if (isCancelled) return 'CANCELLED';
  const cleanPaid = Math.max(0, Math.round(paidCents));
  const cleanTotal = Math.max(0, Math.round(totalTtcCents));
  if (cleanPaid <= 0) return 'UNPAID';
  if (cleanPaid < cleanTotal) return 'PARTIAL';
  return 'PAID';
}

/**
 * RÈGLE 4 : Paiement et caisse
 * Chaque moyen de paiement possède une destination financière stricte.
 * Seul CASH alimente ou diminue la caisse physique.
 */
export function resolvePaymentDestination(
  method: Exclude<PaymentMethod, 'CREDIT'>
): FinancialDestination {
  switch (method) {
    case 'CASH':
      return 'CAISSE_PHYSIQUE';
    case 'CARD':
    case 'TRANSFER':
      return 'BANQUE';
    case 'CHECK':
      return 'PORTEFEUILLE_EFFETS';
    case 'CREDIT_NOTE':
      return 'COMPTE_AVOIR';
  }
}

export function computeStockStatus(
  stock: number,
  minStock: number,
  maxStock = 0
): StockStatus {
  if (stock <= 0) return 'RUPTURE';
  if (stock <= Math.max(1, Math.floor(minStock / 2))) return 'CRITIQUE';
  if (stock <= minStock) return 'FAIBLE';
  if (maxStock > 0 && stock > maxStock) return 'SURSTOCK';
  return 'NORMAL';
}

export function computeSavReminderStatus(
  dueDate: string,
  completedAt: string | null,
  referenceDate?: string
): ReminderStatus {
  if (completedAt) return 'EFFECTUE';
  const today = referenceDate ?? getMoroccoBusinessDate();
  const daysLeft = daysBetweenBusinessDates(today, dueDate);
  if (daysLeft < 0) return 'DEPASSE';
  if (daysLeft <= 7) return 'URGENT';
  if (daysLeft <= 15) return 'ATTENTION';
  if (daysLeft <= 30) return 'PROCHE';
  return 'NORMAL';
}
