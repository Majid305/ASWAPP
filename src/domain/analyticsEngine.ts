import { AtlasSoftWaterDB, db } from '../db/database';
import { computeSavReminderStatus, computeStockStatus } from './financialEngine';
import {
  addDaysToBusinessDate,
  addMonthsToBusinessDate,
  getMoroccoBusinessDate,
} from '../utils/dateUtils';

export type AnalyticsPeriodPreset =
  | 'TODAY'
  | '7_DAYS'
  | '30_DAYS'
  | '3_MONTHS'
  | '12_MONTHS'
  | 'CUSTOM';

export interface TopProductMetric {
  productId: string;
  productRef: string;
  productName: string;
  qtySold: number;
  revenueHtCents: number;
  revenueTtcCents: number;
  marginCents: number;
}

export interface CentralFinancialSnapshot {
  periodStart: string;
  periodEnd: string;
  todayBusinessDate: string;
  // Chiffre d'affaires & Marge (Règles 23 & 24 : exclut les documents annulés)
  todayCaHtCents: number;
  todayCaTtcCents: number;
  periodCaHtCents: number;
  periodCaTtcCents: number;
  periodVatCollectedCents: number;
  periodCostOfGoodsSoldCents: number;
  periodGrossMarginCents: number;
  periodMarginRatePercent: number;
  periodSalesCount: number;
  averageBasketTtcCents: number;
  // Flux de Trésorerie (Séparés du CA — Section 27)
  periodCollectionsCents: number; // Encaissements réels clients
  periodSupplierPaymentsCents: number;
  periodExpensesTtcCents: number;
  periodDisbursementsCents: number; // Décaissements totaux (Fournisseurs + Charges)
  periodOperatingResultCents: number; // Marge brute - Charges HT
  // Soldes globaux actuels
  physicalCashBalanceCents: number; // Caisse espèces réelle théorique
  bankBalanceCents: number; // Encaissements/décaissements hors espèces
  totalTreasuryCents: number;
  customerReceivablesCents: number; // Créances clients totales
  customerCreditsCents: number; // Avoirs / Trop-perçus clients
  supplierDebtsCents: number; // Dettes fournisseurs totales
  // Stock & Alertes
  stockValueCostCents: number;
  stockValueSaleHtCents: number;
  outOfStockCount: number;
  criticalStockCount: number;
  lowStockCount: number;
  overstockCount: number;
  pendingPurchasesCount: number;
  unpaidInvoicesCount: number;
  urgentSavCount: number;
  topProducts: TopProductMetric[];
  dormantProducts: { id: string; reference: string; name: string; stock: number; stockValueCents: number }[];
}

export function resolvePeriodBounds(
  preset: AnalyticsPeriodPreset,
  customStart?: string,
  customEnd?: string,
  referenceDate?: string
): { start: string; end: string } {
  const today = referenceDate ?? getMoroccoBusinessDate();
  switch (preset) {
    case 'TODAY':
      return { start: today, end: today };
    case '7_DAYS':
      return { start: addDaysToBusinessDate(today, -6), end: today };
    case '30_DAYS':
      return { start: addDaysToBusinessDate(today, -29), end: today };
    case '3_MONTHS':
      return { start: addMonthsToBusinessDate(today, -3), end: today };
    case '12_MONTHS':
      return { start: addMonthsToBusinessDate(today, -12), end: today };
    case 'CUSTOM':
      return {
        start: customStart || addDaysToBusinessDate(today, -29),
        end: customEnd || today,
      };
  }
}

/**
 * RÈGLES 23 & 24 : Moteur centralisé unique pour Dashboard, Finance et Analyse Commerciale.
 * Garantit qu'aucune vente annulée ni paiement contre-passé ne gonfle artificiellement les chiffres.
 */
export async function computeCentralFinancialSnapshot(
  preset: AnalyticsPeriodPreset = '30_DAYS',
  customStart?: string,
  customEnd?: string,
  targetDb: AtlasSoftWaterDB = db
): Promise<CentralFinancialSnapshot> {
  const today = getMoroccoBusinessDate();
  const { start, end } = resolvePeriodBounds(preset, customStart, customEnd, today);

  const [
    allSales,
    allSaleItems,
    allInvoices,
    allPayments,
    allPurchases,
    allExpenses,
    allCashEntries,
    allProducts,
    allCustomers,
    allReminders,
  ] = await Promise.all([
    targetDb.sales.toArray(),
    targetDb.saleItems.toArray(),
    targetDb.invoices.toArray(),
    targetDb.payments.toArray(),
    targetDb.purchases.toArray(),
    targetDb.expenses.toArray(),
    targetDb.cashEntries.toArray(),
    targetDb.products.toArray(),
    targetDb.customers.toArray(),
    targetDb.reminders.toArray(),
  ]);

  const activeSales = allSales.filter((s) => s.status !== 'CANCELLED');
  const creditNotes = allInvoices.filter(
    (inv) => inv.type === 'CREDIT_NOTE' && inv.status !== 'CANCELLED'
  );

  // CA du jour
  const todaySales = activeSales.filter((s) => s.businessDate === today);
  const todayCreditNotes = creditNotes.filter((c) => c.businessDate === today);
  const todayCaHtCents = Math.max(
    0,
    todaySales.reduce((acc, s) => acc + s.totalTaxableCents, 0) -
      todayCreditNotes.reduce((acc, c) => acc + c.totalTaxableCents, 0)
  );
  const todayCaTtcCents = Math.max(
    0,
    todaySales.reduce((acc, s) => acc + s.totalTtcCents, 0) -
      todayCreditNotes.reduce((acc, c) => acc + c.totalTtcCents, 0)
  );

  // CA de la période sélectionnée
  const periodSales = activeSales.filter(
    (s) => s.businessDate >= start && s.businessDate <= end
  );
  const periodCreditNotes = creditNotes.filter(
    (c) => c.businessDate >= start && c.businessDate <= end
  );

  const periodCaHtCents = Math.max(
    0,
    periodSales.reduce((acc, s) => acc + s.totalTaxableCents, 0) -
      periodCreditNotes.reduce((acc, c) => acc + c.totalTaxableCents, 0)
  );
  const periodCaTtcCents = Math.max(
    0,
    periodSales.reduce((acc, s) => acc + s.totalTtcCents, 0) -
      periodCreditNotes.reduce((acc, c) => acc + c.totalTtcCents, 0)
  );
  const periodVatCollectedCents = Math.max(
    0,
    periodSales.reduce((acc, s) => acc + s.totalVatCents, 0) -
      periodCreditNotes.reduce((acc, c) => acc + c.totalVatCents, 0)
  );

  // Calcul exact du coût des marchandises vendues (net des retours)
  const periodSaleIds = new Set(periodSales.map((s) => s.id));
  let periodCostOfGoodsSoldCents = 0;
  const productMetricsMap = new Map<string, TopProductMetric>();
  const soldProductIdsInPeriod = new Set<string>();

  for (const item of allSaleItems) {
    if (!periodSaleIds.has(item.saleId)) continue;
    const netQty = Math.max(0, item.quantity - item.returnedQty);
    if (netQty <= 0) continue;

    soldProductIdsInPeriod.add(item.productId);
    const ratio = item.quantity > 0 ? netQty / item.quantity : 0;
    const netHt = Math.round(item.lineTaxableCents * ratio);
    const netTtc = Math.round(item.lineTtcCents * ratio);
    const netCost = Math.round(item.unitCostCents * netQty);
    const netMargin = netHt - netCost;

    periodCostOfGoodsSoldCents += netCost;

    const existing = productMetricsMap.get(item.productId) ?? {
      productId: item.productId,
      productRef: item.productRef,
      productName: item.productName,
      qtySold: 0,
      revenueHtCents: 0,
      revenueTtcCents: 0,
      marginCents: 0,
    };
    existing.qtySold += netQty;
    existing.revenueHtCents += netHt;
    existing.revenueTtcCents += netTtc;
    existing.marginCents += netMargin;
    productMetricsMap.set(item.productId, existing);
  }

  const periodGrossMarginCents = periodCaHtCents - periodCostOfGoodsSoldCents;
  const periodMarginRatePercent =
    periodCaHtCents > 0
      ? Math.round((periodGrossMarginCents / periodCaHtCents) * 10000) / 100
      : 0;
  const periodSalesCount = periodSales.length;
  const averageBasketTtcCents =
    periodSalesCount > 0 ? Math.round(periodCaTtcCents / periodSalesCount) : 0;

  // Encaissements & Décaissements sur la période (Règle 24 : exclut les paiements annulés/REVERSED)
  const validPaymentsInPeriod = allPayments.filter(
    (p) => p.status === 'VALIDATED' && p.businessDate >= start && p.businessDate <= end
  );

  const incomingPaymentsCents = validPaymentsInPeriod
    .filter((p) => p.direction === 'IN')
    .reduce((acc, p) => acc + p.amountCents, 0);

  const customerRefundsCents = validPaymentsInPeriod
    .filter((p) => p.direction === 'OUT' && p.targetType === 'CUSTOMER_REFUND')
    .reduce((acc, p) => acc + p.amountCents, 0);

  const periodCollectionsCents = Math.max(0, incomingPaymentsCents - customerRefundsCents);

  const periodSupplierPaymentsCents = validPaymentsInPeriod
    .filter((p) => p.direction === 'OUT' && p.targetType === 'PURCHASE')
    .reduce((acc, p) => acc + p.amountCents, 0);

  const validExpensesInPeriod = allExpenses.filter(
    (e) => e.status === 'VALIDATED' && e.businessDate >= start && e.businessDate <= end
  );
  const periodExpensesTtcCents = validExpensesInPeriod.reduce(
    (acc, e) => acc + e.amountTtcCents,
    0
  );
  const periodExpensesHtCents = validExpensesInPeriod.reduce(
    (acc, e) => acc + e.amountHtCents,
    0
  );

  const periodDisbursementsCents = periodSupplierPaymentsCents + periodExpensesTtcCents;
  const periodOperatingResultCents = periodGrossMarginCents - periodExpensesHtCents;

  // Trésorerie globale actuelle (Caisse physique vs Banque)
  const physicalCashBalanceCents = allCashEntries.reduce(
    (acc, e) => acc + (e.direction === 'IN' ? e.amountCents : -e.amountCents),
    0
  );

  const allValidNonCashPayments = allPayments.filter(
    (p) => p.status === 'VALIDATED' && p.method !== 'CASH' && p.method !== 'CREDIT_NOTE'
  );
  const allValidNonCashExpenses = allExpenses.filter(
    (e) => e.status === 'VALIDATED' && e.paymentMethod !== 'CASH'
  );

  const cashDepositsToBankCents = allCashEntries
    .filter((e) => e.type === 'BANK_DEPOSIT')
    .reduce((acc, e) => acc + e.amountCents, 0);

  const bankBalanceCents =
    allValidNonCashPayments.reduce(
      (acc, p) => acc + (p.direction === 'IN' ? p.amountCents : -p.amountCents),
      0
    ) -
    allValidNonCashExpenses.reduce((acc, e) => acc + e.amountTtcCents, 0) +
    cashDepositsToBankCents;

  const totalTreasuryCents = physicalCashBalanceCents + bankBalanceCents;

  // Créances & Dettes réelles
  const activeInvoices = allInvoices.filter(
    (i) => i.type === 'INVOICE' && i.status !== 'CANCELLED'
  );
  const customerReceivablesCents = activeInvoices.reduce(
    (acc, i) => acc + i.remainingDueCents,
    0
  );
  const customerCreditsCents = allCustomers.reduce(
    (acc, c) => acc + (c.creditAvailableCents || 0),
    0
  );
  const unpaidInvoicesCount = activeInvoices.filter((i) => i.remainingDueCents > 0).length;

  const activePurchases = allPurchases.filter((p) => p.status !== 'ANNULE');
  const supplierDebtsCents = activePurchases.reduce(
    (acc, p) => acc + p.remainingDueCents,
    0
  );
  const pendingPurchasesCount = activePurchases.filter(
    (p) => p.status === 'COMMANDE' || p.status === 'EN_ATTENTE' || p.status === 'PARTIELLEMENT_RECU'
  ).length;

  // Stock & Alertes
  const activeProducts = allProducts.filter((p) => p.active);
  let stockValueCostCents = 0;
  let stockValueSaleHtCents = 0;
  let outOfStockCount = 0;
  let criticalStockCount = 0;
  let lowStockCount = 0;
  let overstockCount = 0;

  for (const p of activeProducts) {
    const positiveStock = Math.max(0, p.stock);
    stockValueCostCents += Math.round(positiveStock * p.purchasePriceCents);
    stockValueSaleHtCents += Math.round(positiveStock * p.salePriceHtCents);

    const st = computeStockStatus(p.stock, p.minStock, p.maxStock);
    if (st === 'RUPTURE') outOfStockCount++;
    else if (st === 'CRITIQUE') criticalStockCount++;
    else if (st === 'FAIBLE') lowStockCount++;
    else if (st === 'SURSTOCK') overstockCount++;
  }

  const urgentSavCount = allReminders.filter((r) => {
    const st = computeSavReminderStatus(r.dueDate, r.completedAt, today);
    return st === 'URGENT' || st === 'DEPASSE' || st === 'ATTENTION';
  }).length;

  const topProducts = Array.from(productMetricsMap.values())
    .sort((a, b) => b.revenueTtcCents - a.revenueTtcCents)
    .slice(0, 8);

  const dormantProducts = activeProducts
    .filter((p) => p.stock > 0 && !soldProductIdsInPeriod.has(p.id))
    .map((p) => ({
      id: p.id,
      reference: p.reference,
      name: p.name,
      stock: p.stock,
      stockValueCents: Math.round(p.stock * p.purchasePriceCents),
    }))
    .sort((a, b) => b.stockValueCents - a.stockValueCents)
    .slice(0, 8);

  return {
    periodStart: start,
    periodEnd: end,
    todayBusinessDate: today,
    todayCaHtCents,
    todayCaTtcCents,
    periodCaHtCents,
    periodCaTtcCents,
    periodVatCollectedCents,
    periodCostOfGoodsSoldCents,
    periodGrossMarginCents,
    periodMarginRatePercent,
    periodSalesCount,
    averageBasketTtcCents,
    periodCollectionsCents,
    periodSupplierPaymentsCents,
    periodExpensesTtcCents,
    periodDisbursementsCents,
    periodOperatingResultCents,
    physicalCashBalanceCents,
    bankBalanceCents,
    totalTreasuryCents,
    customerReceivablesCents,
    customerCreditsCents,
    supplierDebtsCents,
    stockValueCostCents,
    stockValueSaleHtCents,
    outOfStockCount,
    criticalStockCount,
    lowStockCount,
    overstockCount,
    pendingPurchasesCount,
    unpaidInvoicesCount,
    urgentSavCount,
    topProducts,
    dormantProducts,
  };
}
