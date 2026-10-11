import { formatMad } from '../domain/financialEngine';
import {
  BankDeposit,
  CashAudit,
  CashEntry,
  CompanyInfo,
  DefectiveProduct,
  Expense,
  InventoryItem,
  InventorySession,
  Invoice,
  InvoiceItem,
  Product,
  Purchase,
  PurchaseItem,
  Quote,
  QuoteItem,
  Sale,
  SaleItem,
} from '../types/domain';
import { formatBusinessDateFr } from '../utils/dateUtils';
import { escapeHtml } from '../utils/securityUtils';

export interface PrintableDocument {
  title: string;
  subtitle: string;
  filename?: string;
  format: 'A4' | 'TICKET_80MM';
  htmlContent: string;
}

/**
 * Conversion d'un montant en centimes vers toutes lettres en Français (Dirhams et centimes)
 * Exigé sur les factures, avoirs et devis commerciaux au Maroc.
 */
function integerToFrenchWords(n: number): string {
  if (n === 0) return 'zéro';
  if (n < 0) return 'moins ' + integerToFrenchWords(Math.abs(n));

  const units = [
    '',
    'un',
    'deux',
    'trois',
    'quatre',
    'cinq',
    'six',
    'sept',
    'huit',
    'neuf',
    'dix',
    'onze',
    'douze',
    'treize',
    'quatorze',
    'quinze',
    'seize',
    'dix-sept',
    'dix-huit',
    'dix-neuf',
  ];
  const tens = [
    '',
    'dix',
    'vingt',
    'trente',
    'quarante',
    'cinquante',
    'soixante',
    'soixante',
    'quatre-vingt',
    'quatre-vingt',
  ];

  const convertUnder100 = (num: number): string => {
    if (num < 20) return units[num];
    const ten = Math.floor(num / 10);
    const rem = num % 10;
    if (ten === 7 || ten === 9) {
      const sub = 10 + rem;
      const sep = ten === 7 && rem === 1 ? ' et ' : '-';
      return `${tens[ten]}${sep}${units[sub]}`;
    }
    if (rem === 0) {
      return ten === 8 ? 'quatre-vingts' : tens[ten];
    }
    if (rem === 1 && ten !== 8) {
      return `${tens[ten]} et un`;
    }
    return `${tens[ten]}-${units[rem]}`;
  };

  const convertUnder1000 = (num: number): string => {
    const hundred = Math.floor(num / 100);
    const rem = num % 100;
    let res = '';
    if (hundred > 0) {
      res = hundred === 1 ? 'cent' : `${units[hundred]} cent`;
      if (hundred > 1 && rem === 0) res += 's';
    }
    if (rem > 0) {
      res = res ? `${res} ${convertUnder100(rem)}` : convertUnder100(rem);
    }
    return res;
  };

  const parts: string[] = [];
  const millions = Math.floor(n / 1_000_000);
  const thousands = Math.floor((n % 1_000_000) / 1_000);
  const remainder = n % 1_000;

  if (millions > 0) {
    parts.push(`${convertUnder1000(millions)} million${millions > 1 ? 's' : ''}`);
  }
  if (thousands > 0) {
    parts.push(thousands === 1 ? 'mille' : `${convertUnder1000(thousands)} mille`);
  }
  if (remainder > 0) {
    parts.push(convertUnder1000(remainder));
  }

  return parts.join(' ');
}

export function amountInFrenchWordsMad(cents: number): string {
  const absCents = Math.abs(Math.round(cents));
  const dirhams = Math.floor(absCents / 100);
  const centimes = absCents % 100;
  const dhWords = integerToFrenchWords(dirhams);
  const capitalized = dhWords.charAt(0).toUpperCase() + dhWords.slice(1);
  if (centimes === 0) {
    return `${capitalized} Dirham${dirhams > 1 ? 's' : ''} TTC`;
  }
  return `${capitalized} Dirham${dirhams > 1 ? 's' : ''} et ${centimes
    .toString()
    .padStart(2, '0')} centimes TTC`;
}

export function isWatermarkActive(company: CompanyInfo): boolean {
  return Boolean(
    company.watermarkEnabled !== false &&
    company.watermarkDataUrl &&
    typeof company.watermarkDataUrl === 'string' &&
    company.watermarkDataUrl.trim().length > 0
  );
}

function buildCompanyHeaderHtml(company: CompanyInfo, accentColor = '#0F172A'): string {
  const hasWatermark = isWatermarkActive(company);

  const opacityVal = Math.max(
    0.05,
    Math.min(1, (company.watermarkOpacity ?? 100) / 100)
  );

  const attachedMentions =
    company.headerMentions && company.headerMentions.trim().length > 0
      ? company.headerMentions.trim()
      : "Traitement de l'eau, Filtration et Purificateur d'eau domestique et industriel";

  if (hasWatermark) {
    // Si filigrane actif : aucun en-tête texte (Nom entreprise...) ni trait de séparation.
    // Le papier à en-tête / filigrane téléchargé contient déjà le nom de l'entreprise.
    // L'impression est centrée verticalement sur la feuille A4 avec un dégagement suffisant en haut et en bas.
    return `
      <style>
        .print-paper-sheet {
          position: relative !important;
          overflow: hidden !important;
        }
        .print-paper-sheet > div, .print-container > div {
          position: relative !important;
          z-index: 0 !important;
          background: transparent !important;
          min-height: 1040px !important;
          display: flex !important;
          flex-direction: column !important;
          justify-content: center !important;
          padding-top: 130px !important;
          padding-bottom: 110px !important;
          box-sizing: border-box !important;
        }
        .print-paper-sheet table, .print-container table {
          background-color: transparent !important;
        }
        .print-paper-sheet table thead tr, .print-container table thead tr {
          background-color: transparent !important;
          color: #000000 !important;
          border-top: 1.5px solid #000000 !important;
          border-bottom: 2px solid #000000 !important;
        }
        .print-paper-sheet table thead th, .print-container table thead th {
          color: #000000 !important;
          background-color: transparent !important;
          font-weight: 800 !important;
        }
        @media print {
          @page {
            margin: 0 !important;
            size: A4 portrait;
          }
          body {
            margin: 0 !important;
            padding: 0 !important;
          }
          .print-container {
            width: 100% !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 0 12mm !important;
            box-sizing: border-box !important;
          }
          .print-container > div {
            min-height: 100vh !important;
            display: flex !important;
            flex-direction: column !important;
            justify-content: center !important;
            padding-top: 130px !important;
            padding-bottom: 110px !important;
            box-sizing: border-box !important;
          }
          .doc-watermark-layer {
            position: fixed !important;
            top: 0 !important;
            left: 0 !important;
            width: 100vw !important;
            height: 100vh !important;
            z-index: -1 !important;
          }
        }
      </style>
      <div class="doc-watermark-layer" style="position:absolute;top:0;left:0;right:0;bottom:0;width:100%;height:100%;z-index:-1;pointer-events:none;display:flex;align-items:center;justify-content:center;overflow:hidden;">
        <img src="${company.watermarkDataUrl}" alt="" style="width:100%;height:100%;object-fit:fill;opacity:${opacityVal};" />
      </div>
      <div style="height:10px;margin-bottom:6px;"></div>
    `;
  }

  return `
    <style>
      .print-paper-sheet > div, .print-container > div {
        min-height: 960px;
        display: flex;
        flex-direction: column;
      }
      .print-paper-sheet table, .print-container table {
        background-color: transparent !important;
      }
      .print-paper-sheet table thead tr, .print-container table thead tr {
        background-color: transparent !important;
        color: #000000 !important;
        border-top: 1.5px solid #000000 !important;
        border-bottom: 2px solid #000000 !important;
      }
      .print-paper-sheet table thead th, .print-container table thead th {
        color: #000000 !important;
        background-color: transparent !important;
        font-weight: 800 !important;
      }
    </style>
    <div style="display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #000000;padding-bottom:12px;margin-bottom:26px;background:transparent;border-radius:4px;">
      <div>
        <div style="font-family:'Cormorant Garamond',Georgia,serif;font-size:26px;font-weight:700;letter-spacing:0.03em;color:#000000;line-height:1.1;">
          ${escapeHtml(company.name)}
        </div>
        <div style="font-size:11px;font-weight:700;color:#000000;text-transform:uppercase;letter-spacing:0.05em;margin-top:3px;">
          ${escapeHtml(attachedMentions)}
        </div>
      </div>
      ${
        company.legalName && company.legalName.trim() !== company.name.trim()
          ? `<div style="font-size:11px;font-weight:700;color:#000000;text-align:right;font-family:'JetBrains Mono',monospace;">
              ${escapeHtml(company.legalName)}
            </div>`
          : ''
      }
    </div>
  `;
}

function buildCompanyFooterHtml(company: CompanyInfo, showSignatures = true): string {
  const hasWatermark = isWatermarkActive(company);

  if (hasWatermark) {
    // Si filigrane actif : aucun pied de page (adresse, coordonnées, identifiants légaux...).
    // Le filigrane comporte déjà le nom entreprise, adresse, tél, email et coordonnées.
    // L'impression est centrée verticalement et laisse assez de place pour le bas du filigrane.
    return `
      <div style="margin-top:auto;padding-top:14px;page-break-inside:avoid;">
        ${
          showSignatures
            ? `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:12px;page-break-inside:avoid;">
          <div style="border:1.5px dashed #000000;border-radius:6px;padding:9px 12px;min-height:70px;background:transparent;">
            <div style="font-size:10.5px;font-weight:800;text-transform:uppercase;color:#000000;letter-spacing:0.04em;">
              Cachet & Signature Client / Réception
            </div>
            <div style="font-size:10px;font-weight:600;color:#000000;margin-top:4px;">Date et mention « Lu et approuvé »</div>
          </div>
          <div style="border:1.5px dashed #000000;border-radius:6px;padding:9px 12px;min-height:70px;background:transparent;">
            <div style="font-size:10.5px;font-weight:800;text-transform:uppercase;color:#000000;letter-spacing:0.04em;">
              Cachet & Signature Entreprise
            </div>
            <div style="font-size:10px;font-weight:600;color:#000000;margin-top:4px;">Service Commercial & Technique</div>
          </div>
        </div>
        `
            : ''
        }
        <div style="height:12px;"></div>
      </div>
    `;
  }

  return `
    <div style="margin-top:auto;padding-top:16px;page-break-inside:avoid;">
      ${
        showSignatures
          ? `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:18px;page-break-inside:avoid;">
        <div style="border:1.5px dashed #000000;border-radius:6px;padding:10px 12px;min-height:74px;background:transparent;">
          <div style="font-size:10.5px;font-weight:800;text-transform:uppercase;color:#000000;letter-spacing:0.04em;">
            Cachet & Signature Client / Réception
          </div>
          <div style="font-size:10px;font-weight:600;color:#000000;margin-top:4px;">Date et mention « Lu et approuvé »</div>
        </div>
        <div style="border:1.5px dashed #000000;border-radius:6px;padding:10px 12px;min-height:74px;background:transparent;">
          <div style="font-size:10.5px;font-weight:800;text-transform:uppercase;color:#000000;letter-spacing:0.04em;">
            Cachet & Signature ${escapeHtml(company.name)}
          </div>
          <div style="font-size:10px;font-weight:600;color:#000000;margin-top:4px;">Service Commercial & Technique</div>
        </div>
      </div>
      `
          : ''
      }
      <div style="padding-top:10px;border-top:1.5px solid #000000;font-size:10px;color:#000000;line-height:1.55;page-break-inside:avoid;background:transparent;border-radius:4px;">
        <div style="display:flex;justify-content:space-between;gap:12px;">
          <div>${escapeHtml(company.paymentTerms || '')}</div>
          ${company.rib ? `<div style="font-family:monospace;"><strong style="font-weight:800;">RIB :</strong> ${escapeHtml(company.rib)}</div>` : ''}
        </div>
        ${company.legalMentions ? `<div style="margin-top:2px;">${escapeHtml(company.legalMentions)}</div>` : ''}
        <div style="margin-top:6px;padding-top:6px;border-top:1.5px solid #000000;text-align:center;color:#000000;">
          <div style="font-weight:700;font-size:10.5px;">
            ${escapeHtml(company.address)} — <strong style="font-weight:800;">${escapeHtml(company.city)}</strong> · Tél : <strong style="font-weight:800;">${escapeHtml(company.phone)}</strong>${company.whatsapp ? ` · WhatsApp : <strong style="font-weight:800;">${escapeHtml(company.whatsapp)}</strong>` : ''}${company.email ? ` · Email : <strong style="font-weight:800;">${escapeHtml(company.email)}</strong>` : ''}
          </div>
          <div style="font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:#000000;margin-top:2px;">
            ${escapeHtml(company.name)} (${escapeHtml(company.legalName)}) — ICE : ${escapeHtml(company.ice)} — IF : ${escapeHtml(company.ifNumber)} — RC : ${escapeHtml(company.rc)} — Patente : ${escapeHtml(company.patente)} — CNSS : ${escapeHtml(company.cnss)} — Devise : ${escapeHtml(company.currency)}
          </div>
        </div>
      </div>
    </div>
  `;
}

function buildVatBreakdownTableHtml(
  items: Array<{ vatRate: number; lineTaxableHtCents?: number; lineHtCents?: number; lineVatCents: number; lineTtcCents: number }>
): string {
  const byRate = new Map<number, { baseHt: number; vat: number; ttc: number }>();
  for (const it of items) {
    const rate = it.vatRate ?? 20;
    const base = it.lineTaxableHtCents ?? it.lineHtCents ?? it.lineTtcCents - it.lineVatCents;
    const cur = byRate.get(rate) || { baseHt: 0, vat: 0, ttc: 0 };
    cur.baseHt += base;
    cur.vat += it.lineVatCents;
    cur.ttc += it.lineTtcCents;
    byRate.set(rate, cur);
  }

  const rows = Array.from(byRate.entries())
    .sort((a, b) => a[0] - b[0])
    .map(
      ([rate, vals]) => `
      <tr style="border-bottom:1px solid #000000;background:transparent;color:#000000;">
        <td style="padding:6px 8px;font-family:monospace;font-weight:800;color:#000000;">TVA ${rate}%</td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace;font-weight:700;color:#000000;">${escapeHtml(formatMad(vals.baseHt))}</td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace;font-weight:700;color:#000000;">${escapeHtml(formatMad(vals.vat))}</td>
        <td style="padding:6px 8px;text-align:right;font-family:monospace;font-weight:900;color:#000000;">${escapeHtml(formatMad(vals.ttc))}</td>
      </tr>
    `
    )
    .join('');

  return `
    <table style="width:100%;border-collapse:collapse;font-size:10.5px;border:1.5px solid #000000;border-radius:4px;overflow:hidden;background:transparent;">
      <thead>
        <tr style="background:transparent;color:#000000;text-align:left;border-top:1.5px solid #000000;border-bottom:2px solid #000000;">
          <th style="padding:6px 8px;color:#000000;font-weight:800;background:transparent;">Taux TVA</th>
          <th style="padding:6px 8px;text-align:right;color:#000000;font-weight:800;background:transparent;">Base HT</th>
          <th style="padding:6px 8px;text-align:right;color:#000000;font-weight:800;background:transparent;">Montant TVA</th>
          <th style="padding:6px 8px;text-align:right;color:#000000;font-weight:800;background:transparent;">Total TTC</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/**
 * 1. FACTURE & FACTURE D'AVOIR A4
 */
export function buildInvoiceA4Print(
  company: CompanyInfo,
  invoice: Invoice,
  items: InvoiceItem[]
): PrintableDocument {
  const isCreditNote = invoice.type === 'CREDIT_NOTE';
  const docLabel = isCreditNote ? 'FACTURE D’AVOIR' : 'FACTURE COMMERCIALE';

  const statusLabels: Record<string, string> = {
    PAID: 'PAYÉE INTÉGRALEMENT',
    PARTIAL: 'PARTIELLEMENT PAYÉE',
    UNPAID: 'NON PAYÉE (EN ATTENTE)',
    CANCELLED: 'ANNULÉE',
  };

  const rowsHtml = items
    .map(
      (item, idx) => `
      <tr style="border-bottom:1px solid #000000;background:transparent;">
        <td style="padding:7px 6px;font-size:11px;color:#000000;font-family:monospace;font-weight:700;">${idx + 1}</td>
        <td style="padding:7px 6px;font-size:11px;font-family:monospace;font-weight:800;color:#000000;">${escapeHtml(item.productRef)}</td>
        <td style="padding:7px 6px;font-size:11px;font-weight:600;color:#000000;">${escapeHtml(item.productName)}</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:800;color:#000000;">${item.quantity}</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:600;color:#000000;">${escapeHtml(formatMad(item.unitPriceHtCents))}</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:600;color:#000000;">${item.discountPercent > 0 ? `${item.discountPercent}%` : '—'}</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:600;color:#000000;">${item.vatRate}%</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:800;color:#000000;">${escapeHtml(formatMad(item.lineTtcCents))}</td>
      </tr>
    `
    )
    .join('');

  const htmlContent = `
    <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#000000;padding:6px;background:transparent;">
      ${buildCompanyHeaderHtml(company, '#000000')}

      <!-- Espace vierge supplémentaire entre l'en-tête et le début de la facture (zone vierge) -->
      <div style="height:65px;"></div>

      <div style="display:grid;grid-template-columns:1.1fr 0.9fr;gap:16px;margin-bottom:18px;">
        <div style="background:transparent;border:1.5px solid #000000;border-left:4px solid #000000;padding:12px 14px;border-radius:6px;">
          <div style="font-size:10px;text-transform:uppercase;color:#000000;font-weight:800;letter-spacing:0.06em;">
            Pièce Comptable Officielle
          </div>
          <div style="font-size:19px;font-weight:900;color:#000000;margin-top:2px;font-family:'JetBrains Mono',monospace;">
            ${docLabel} N° ${escapeHtml(invoice.number)}
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;font-size:11.5px;color:#000000;">
            <div>Date d'émission : <strong style="font-weight:800;color:#000000;">${escapeHtml(formatBusinessDateFr(invoice.businessDate))}</strong></div>
            <div>Date d'échéance : <strong style="font-weight:800;color:#000000;">${escapeHtml(formatBusinessDateFr(invoice.dueDate))}</strong></div>
            <div style="grid-column:span 2;margin-top:4px;color:#000000;font-weight:600;">
              Statut de règlement :
              <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:800;border:1.5px solid #000000;background:transparent;color:#000000;">
                ${escapeHtml(statusLabels[invoice.status] || invoice.status)}
              </span>
            </div>
          </div>
        </div>

        <div style="background:transparent;border:1.5px solid #000000;padding:12px 14px;border-radius:6px;">
          <div style="font-size:10px;text-transform:uppercase;color:#000000;font-weight:800;letter-spacing:0.06em;">
            Client Facturé
          </div>
          <div style="font-size:16px;font-weight:800;color:#000000;margin-top:3px;">
            ${escapeHtml(invoice.customerName)}
          </div>
          <div style="font-size:12px;font-family:monospace;margin-top:5px;color:#000000;font-weight:600;">
            ICE Client : <strong style="font-weight:800;color:#000000;">${escapeHtml(invoice.customerIce || 'Non renseigné (Particulier)')}</strong>
          </div>
          ${invoice.notes ? `<div style="font-size:11.5px;color:#000000;font-weight:600;margin-top:6px;border-top:1px dashed #000000;padding-top:4px;">Réf / Note : ${escapeHtml(invoice.notes)}</div>` : ''}
        </div>
      </div>

      <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border:1.5px solid #000000;background:transparent;">
        <thead>
          <tr style="background:transparent;color:#000000;font-size:11px;text-align:left;border-top:1.5px solid #000000;border-bottom:2px solid #000000;">
            <th style="padding:8px 6px;width:32px;color:#000000;font-weight:800;background:transparent;">#</th>
            <th style="padding:8px 6px;color:#000000;font-weight:800;background:transparent;">Référence</th>
            <th style="padding:8px 6px;color:#000000;font-weight:800;background:transparent;">Désignation des Équipements / Prestations</th>
            <th style="padding:8px 6px;text-align:right;color:#000000;font-weight:800;background:transparent;">Qté</th>
            <th style="padding:8px 6px;text-align:right;color:#000000;font-weight:800;background:transparent;">P.U HT</th>
            <th style="padding:8px 6px;text-align:right;color:#000000;font-weight:800;background:transparent;">Rem.</th>
            <th style="padding:8px 6px;text-align:right;color:#000000;font-weight:800;background:transparent;">TVA</th>
            <th style="padding:8px 6px;text-align:right;color:#000000;font-weight:800;background:transparent;">Total TTC</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>

      <div style="display:grid;grid-template-columns:1.1fr 0.9fr;gap:18px;align-items:start;">
        <div style="display:flex;flex-direction:column;gap:10px;">
          <div style="font-size:10.5px;font-weight:800;color:#000000;text-transform:uppercase;letter-spacing:0.04em;">
            Ventilation de la TVA par taux (Règle 10)
          </div>
          ${buildVatBreakdownTableHtml(items)}
          <div style="background:transparent;border:1.5px solid #000000;border-radius:6px;padding:9px 12px;font-size:11px;color:#000000;line-height:1.4;">
            <strong>Arrêté la présente ${isCreditNote ? 'facture d’avoir' : 'facture'} à la somme de :</strong><br/>
            <span style="font-style:italic;font-weight:800;color:#000000;font-size:11.5px;">
              « ${escapeHtml(amountInFrenchWordsMad(invoice.totalTtcCents))} »
            </span>
          </div>
        </div>

        <div style="border:2px solid #000000;border-radius:6px;padding:12px 14px;background:transparent;font-size:12px;color:#000000;">
          <div style="display:flex;justify-content:space-between;padding:3px 0;color:#000000;">
            <span style="font-weight:700;">Sous-total HT :</span>
            <strong style="font-family:monospace;font-size:13px;font-weight:800;">${escapeHtml(formatMad(invoice.subtotalHtCents))}</strong>
          </div>
          ${
            invoice.globalDiscountCents > 0
              ? `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#000000;">
                  <span style="font-weight:700;">Remise globale (${invoice.globalDiscountPercent}%) :</span>
                  <strong style="font-family:monospace;font-size:13px;font-weight:800;">-${escapeHtml(formatMad(invoice.globalDiscountCents))}</strong>
                </div>`
              : ''
          }
          <div style="display:flex;justify-content:space-between;padding:3px 0;color:#000000;">
            <span style="font-weight:700;">Base Taxable HT :</span>
            <strong style="font-family:monospace;font-size:13px;font-weight:800;">${escapeHtml(formatMad(invoice.totalTaxableCents))}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;padding:3px 0;color:#000000;">
            <span style="font-weight:700;">Total TVA :</span>
            <strong style="font-family:monospace;font-size:13px;font-weight:800;">${escapeHtml(formatMad(invoice.totalVatCents))}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-top:2px solid #000000;border-bottom:2px solid #000000;margin:6px 0;font-size:15.5px;color:#000000;">
            <strong style="font-weight:900;">NET À PAYER TTC :</strong>
            <strong style="font-family:monospace;font-size:16px;font-weight:900;">${escapeHtml(formatMad(invoice.totalTtcCents))}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;padding:3px 0;color:#000000;">
            <span style="font-weight:700;">Montant déjà réglé :</span>
            <strong style="font-family:monospace;font-size:13px;font-weight:800;">${escapeHtml(formatMad(invoice.paidCents))}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;padding:3px 0;color:#000000;">
            <span style="font-weight:800;">Solde restant dû :</span>
            <strong style="font-family:monospace;font-size:13.5px;font-weight:900;">${escapeHtml(formatMad(invoice.remainingDueCents))}</strong>
          </div>
        </div>
      </div>

      ${buildCompanyFooterHtml(company, true)}
    </div>
  `;

  return {
    title: `${docLabel} ${invoice.number}`,
    subtitle: `${invoice.customerName} — ${formatMad(invoice.totalTtcCents)}`,
    filename: `${isCreditNote ? 'Avoir' : 'Facture'}_${invoice.number}`,
    format: 'A4',
    htmlContent,
  };
}

/**
 * 2. DEVIS PROFORMA A4
 */
export function buildQuoteA4Print(
  company: CompanyInfo,
  quote: Quote,
  items: QuoteItem[]
): PrintableDocument {
  const rowsHtml = items
    .map(
      (item, idx) => `
      <tr style="border-bottom:1px solid #000000;background:transparent;">
        <td style="padding:7px 6px;font-size:11px;color:#000000;font-family:monospace;font-weight:700;">${idx + 1}</td>
        <td style="padding:7px 6px;font-size:11px;font-family:monospace;font-weight:800;color:#000000;">${escapeHtml(item.productRef)}</td>
        <td style="padding:7px 6px;font-size:11px;font-weight:600;color:#000000;">${escapeHtml(item.productName)}</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:800;color:#000000;">${item.quantity}</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:600;color:#000000;">${escapeHtml(formatMad(item.unitPriceHtCents))}</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:600;color:#000000;">${item.discountPercent > 0 ? `${item.discountPercent}%` : '—'}</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:600;color:#000000;">${item.vatRate}%</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:800;color:#000000;">${escapeHtml(formatMad(item.lineTtcCents))}</td>
      </tr>
    `
    )
    .join('');

  return {
    title: `DEVIS PROFORMA ${quote.number}`,
    subtitle: `${quote.customerName} — Valide jusqu'au ${formatBusinessDateFr(quote.validUntil)}`,
    filename: `Devis_${quote.number}`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#000000;padding:6px;background:transparent;">
        ${buildCompanyHeaderHtml(company, '#000000')}

        <!-- Espace vierge supplémentaire entre l'en-tête et le début du devis (zone vierge) -->
        <div style="height:65px;"></div>

        <div style="display:grid;grid-template-columns:1.1fr 0.9fr;gap:16px;margin-bottom:18px;">
          <div style="background:transparent;border:1.5px solid #000000;border-left:4px solid #000000;padding:12px 14px;border-radius:6px;">
            <div style="font-size:10px;text-transform:uppercase;color:#000000;font-weight:800;letter-spacing:0.06em;">
              Proposition Commerciale & Technique
            </div>
            <div style="font-size:19px;font-weight:900;margin-top:2px;font-family:'JetBrains Mono',monospace;color:#000000;">
              DEVIS PROFORMA N° ${escapeHtml(quote.number)}
            </div>
            <div style="font-size:11.5px;margin-top:6px;color:#000000;">
              Date d'émission : <strong style="font-weight:800;color:#000000;">${escapeHtml(formatBusinessDateFr(quote.businessDate))}</strong> ·
              Offre valable jusqu'au : <strong style="font-weight:800;color:#000000;">${escapeHtml(formatBusinessDateFr(quote.validUntil))}</strong>
            </div>
            <div style="font-size:11.5px;color:#000000;margin-top:4px;">
              Statut : <strong style="font-weight:800;color:#000000;">${escapeHtml(quote.status)}</strong>
            </div>
          </div>

          <div style="background:transparent;border:1.5px solid #000000;padding:12px 14px;border-radius:6px;">
            <div style="font-size:10px;text-transform:uppercase;color:#000000;font-weight:800;letter-spacing:0.06em;">
              Destinataire de l'Offre
            </div>
            <div style="font-size:16px;font-weight:800;margin-top:3px;color:#000000;">${escapeHtml(quote.customerName)}</div>
            <div style="font-size:12px;color:#000000;margin-top:4px;">
              Conditions de règlement : <strong style="font-weight:800;color:#000000;">${escapeHtml(quote.paymentTerms)}</strong>
            </div>
            ${quote.notes ? `<div style="font-size:11.5px;color:#000000;font-weight:600;margin-top:4px;border-top:1px dashed #000000;padding-top:4px;">Observations : ${escapeHtml(quote.notes)}</div>` : ''}
          </div>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border:1.5px solid #000000;background:transparent;">
          <thead>
            <tr style="background:transparent;color:#000000;font-size:11px;text-align:left;border-top:1.5px solid #000000;border-bottom:2px solid #000000;">
              <th style="padding:8px 6px;width:32px;color:#000000;font-weight:800;background:transparent;">#</th>
              <th style="padding:8px 6px;color:#000000;font-weight:800;background:transparent;">Réf.</th>
              <th style="padding:8px 6px;color:#000000;font-weight:800;background:transparent;">Désignation des Équipements / Prestations</th>
              <th style="padding:8px 6px;text-align:right;color:#000000;font-weight:800;background:transparent;">Qté</th>
              <th style="padding:8px 6px;text-align:right;color:#000000;font-weight:800;background:transparent;">P.U HT</th>
              <th style="padding:8px 6px;text-align:right;color:#000000;font-weight:800;background:transparent;">Rem.</th>
              <th style="padding:8px 6px;text-align:right;color:#000000;font-weight:800;background:transparent;">TVA</th>
              <th style="padding:8px 6px;text-align:right;color:#000000;font-weight:800;background:transparent;">Total TTC</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>

        <div style="display:grid;grid-template-columns:1.1fr 0.9fr;gap:18px;align-items:start;">
          <div style="display:flex;flex-direction:column;gap:10px;">
            ${buildVatBreakdownTableHtml(items)}
            <div style="background:transparent;border:1.5px solid #000000;border-radius:6px;padding:9px 12px;font-size:11px;color:#000000;">
              <strong>Arrêté le présent devis à la somme de :</strong><br/>
              <span style="font-style:italic;font-weight:800;color:#000000;font-size:11.5px;">
                « ${escapeHtml(amountInFrenchWordsMad(quote.totalTtcCents))} »
              </span>
            </div>
          </div>

          <div style="border:2px solid #000000;border-radius:6px;padding:12px 14px;background:transparent;font-size:12px;color:#000000;">
            <div style="display:flex;justify-content:space-between;padding:3px 0;color:#000000;">
              <span style="font-weight:700;">Sous-total HT :</span>
              <strong style="font-family:monospace;font-size:13px;font-weight:800;">${escapeHtml(formatMad(quote.subtotalHtCents))}</strong>
            </div>
            ${
              quote.globalDiscountCents > 0
                ? `<div style="display:flex;justify-content:space-between;padding:3px 0;color:#000000;">
                    <span style="font-weight:700;">Remise globale (${quote.globalDiscountPercent}%) :</span>
                    <strong style="font-family:monospace;font-size:13px;font-weight:800;">-${escapeHtml(formatMad(quote.globalDiscountCents))}</strong>
                  </div>`
                : ''
            }
            <div style="display:flex;justify-content:space-between;padding:3px 0;color:#000000;">
              <span style="font-weight:700;">Total HT Net :</span>
              <strong style="font-family:monospace;font-size:13px;font-weight:800;">${escapeHtml(formatMad(quote.totalTaxableCents))}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;padding:3px 0;color:#000000;">
              <span style="font-weight:700;">Total TVA :</span>
              <strong style="font-family:monospace;font-size:13px;font-weight:800;">${escapeHtml(formatMad(quote.totalVatCents))}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;padding:8px 0;border-top:2px solid #000000;border-bottom:2px solid #000000;margin-top:6px;font-size:15.5px;color:#000000;">
              <strong style="font-weight:900;">TOTAL DEVIS TTC :</strong>
              <strong style="font-family:monospace;font-size:16px;font-weight:900;">${escapeHtml(formatMad(quote.totalTtcCents))}</strong>
            </div>
          </div>
        </div>

        ${buildCompanyFooterHtml(company, true)}
      </div>
    `,
  };
}

/**
 * 3. BON DE LIVRAISON A4 (À partir d'une vente)
 */
export function buildDeliveryNoteA4Print(
  company: CompanyInfo,
  sale: Sale,
  items: SaleItem[]
): PrintableDocument {
  const blNumber = sale.number.replace(/^VEN/, 'BL');
  const rowsHtml = items
    .map(
      (item, idx) => `
      <tr style="border-bottom:1px solid #000000;background:transparent;">
        <td style="padding:8px 6px;font-size:11px;font-family:monospace;font-weight:700;color:#000000;">${idx + 1}</td>
        <td style="padding:8px 6px;font-size:11px;font-family:monospace;font-weight:800;color:#000000;">${escapeHtml(item.productRef)}</td>
        <td style="padding:8px 6px;font-size:11px;font-weight:600;color:#000000;">${escapeHtml(item.productName)}</td>
        <td style="padding:8px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:800;color:#000000;">${item.quantity}</td>
        <td style="padding:8px 6px;font-size:11px;text-align:center;font-weight:700;color:#000000;">Conforme ☐</td>
      </tr>
    `
    )
    .join('');

  return {
    title: `BON DE LIVRAISON ${blNumber}`,
    subtitle: `${sale.customerName} — Réf Vente ${sale.number}`,
    filename: `Bon_Livraison_${blNumber}`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#000000;padding:6px;background:transparent;">
        ${buildCompanyHeaderHtml(company, '#000000')}

        <!-- Espace vierge supplémentaire entre l'en-tête et le début du bon de livraison (zone vierge) -->
        <div style="height:65px;"></div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px;">
          <div style="background:transparent;border:1.5px solid #000000;border-left:4px solid #000000;padding:12px 14px;border-radius:6px;">
            <div style="font-size:18px;font-weight:900;font-family:monospace;color:#000000;">BON DE LIVRAISON N° ${escapeHtml(blNumber)}</div>
            <div style="font-size:11.5px;margin-top:4px;color:#000000;">Date de livraison : <strong style="font-weight:800;color:#000000;">${escapeHtml(formatBusinessDateFr(sale.businessDate))}</strong></div>
            <div style="font-size:11.5px;color:#000000;">Référence Vente : <strong style="font-weight:800;color:#000000;">${escapeHtml(sale.number)}</strong></div>
          </div>
          <div style="background:transparent;border:1.5px solid #000000;padding:12px 14px;border-radius:6px;">
            <div style="font-size:10px;text-transform:uppercase;color:#000000;font-weight:800;letter-spacing:0.06em;">Client Réceptionnaire</div>
            <div style="font-size:16px;font-weight:800;margin-top:3px;color:#000000;">${escapeHtml(sale.customerName)}</div>
            ${sale.notes ? `<div style="font-size:11.5px;color:#000000;font-weight:600;margin-top:4px;border-top:1px dashed #000000;padding-top:4px;">Instructions : ${escapeHtml(sale.notes)}</div>` : ''}
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:20px;border:1.5px solid #000000;background:transparent;">
          <thead>
            <tr style="background:transparent;color:#000000;font-size:11px;text-align:left;border-top:1.5px solid #000000;border-bottom:2px solid #000000;">
              <th style="padding:8px 6px;width:36px;color:#000000;font-weight:800;background:transparent;">#</th>
              <th style="padding:8px 6px;color:#000000;font-weight:800;background:transparent;">Référence</th>
              <th style="padding:8px 6px;color:#000000;font-weight:800;background:transparent;">Désignation de la Marchandise Livrée</th>
              <th style="padding:8px 6px;text-align:right;color:#000000;font-weight:800;background:transparent;">Quantité Livrée</th>
              <th style="padding:8px 6px;text-align:center;width:110px;color:#000000;font-weight:800;background:transparent;">Contrôle</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        ${buildCompanyFooterHtml(company, true)}
      </div>
    `,
  };
}

/**
 * 4. TICKET THERMIQUE POS 80MM
 */
export function buildTicket80mmPrint(
  company: CompanyInfo,
  sale: Sale,
  items: SaleItem[]
): PrintableDocument {
  const linesHtml = items
    .map(
      (i) => `
      <div style="margin-bottom:6px;border-bottom:1px dotted #94A3B8;padding-bottom:4px;">
        <div style="font-weight:700;font-size:11px;color:#000;">${escapeHtml(i.productName)}</div>
        <div style="display:flex;justify-content:space-between;font-family:'JetBrains Mono',monospace;font-size:10.5px;">
          <span>${i.quantity} × ${escapeHtml(formatMad(i.unitPriceHtCents))} HT (${i.vatRate}%)</span>
          <strong>${escapeHtml(formatMad(i.lineTtcCents))}</strong>
        </div>
      </div>
    `
    )
    .join('');

  return {
    title: `Ticket Caisse 80mm ${sale.number}`,
    subtitle: `${sale.customerName} — ${formatMad(sale.totalTtcCents)}`,
    filename: `Ticket_${sale.number}`,
    format: 'TICKET_80MM',
    htmlContent: `
      <div style="width:290px;margin:0 auto;font-family:'JetBrains Mono',monospace;font-size:11px;color:#000;padding:8px;background:#FFF;">
        <div style="text-align:center;border-bottom:1.5px dashed #000;padding-bottom:8px;margin-bottom:8px;">
          <div style="font-size:15px;font-weight:800;letter-spacing:0.03em;">${escapeHtml(company.name)}</div>
          <div style="font-size:10px;">${escapeHtml(company.headerMentions || `${company.legalName} · Traitement de l'Eau & Osmose Inverse`)}</div>
        </div>
        <div style="margin-bottom:8px;font-size:10.5px;line-height:1.45;">
          <div>TICKET N° : <strong>${escapeHtml(sale.number)}</strong></div>
          <div>Date : ${escapeHtml(formatBusinessDateFr(sale.businessDate))}</div>
          <div>Client : <strong>${escapeHtml(sale.customerName)}</strong></div>
          <div>Caissier : Caissier 01</div>
        </div>
        <div style="border-top:1.5px dashed #000;padding-top:6px;">
          ${linesHtml}
        </div>
        <div style="border-top:1.5px solid #000;padding-top:6px;margin-top:6px;line-height:1.5;">
          ${
            sale.globalDiscountCents > 0 || sale.lineDiscountTotalCents > 0
              ? `<div style="display:flex;justify-content:space-between;"><span>Sous-total HT :</span><span>${escapeHtml(formatMad(sale.subtotalHtCents + sale.lineDiscountTotalCents))}</span></div>`
              : ''
          }
          ${
            sale.lineDiscountTotalCents > 0
              ? `<div style="display:flex;justify-content:space-between;"><span>Remise lignes HT :</span><span>-${escapeHtml(formatMad(sale.lineDiscountTotalCents))}</span></div>`
              : ''
          }
          ${
            sale.globalDiscountCents > 0
              ? `<div style="display:flex;justify-content:space-between;"><span>Remise globale (${sale.globalDiscountPercent}%) :</span><span>-${escapeHtml(formatMad(sale.globalDiscountCents))}</span></div>`
              : ''
          }
          <div style="display:flex;justify-content:space-between;"><span>Total HT Net :</span><span>${escapeHtml(formatMad(sale.totalTaxableCents))}</span></div>
          <div style="display:flex;justify-content:space-between;"><span>Total TVA :</span><span>${escapeHtml(formatMad(sale.totalVatCents))}</span></div>
          <div style="display:flex;justify-content:space-between;font-size:13px;font-weight:800;margin-top:4px;border-top:1px dotted #000;padding-top:4px;">
            <span>NET TTC :</span><span>${escapeHtml(formatMad(sale.totalTtcCents))}</span>
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:4px;">
            <span>Reçu (${escapeHtml(sale.paymentMethodSummary)}) :</span><span>${escapeHtml(formatMad(sale.amountReceivedCents))}</span>
          </div>
          <div style="display:flex;justify-content:space-between;">
            <span>Rendu monnaie :</span><span>${escapeHtml(formatMad(sale.changeGivenCents))}</span>
          </div>
          ${
            sale.remainingDueCents > 0
              ? `<div style="display:flex;justify-content:space-between;font-weight:700;">
                  <span>Reste à payer :</span><span>${escapeHtml(formatMad(sale.remainingDueCents))}</span>
                </div>`
              : ''
          }
        </div>
        <div style="text-align:center;margin-top:12px;border-top:1.5px dashed #000;padding-top:8px;font-size:9.5px;line-height:1.4;">
          Merci de votre confiance !<br/>
          ${escapeHtml(company.address)} — ${escapeHtml(company.city)}<br/>
          Tél : ${escapeHtml(company.phone)} · WhatsApp : ${escapeHtml(company.whatsapp)}<br/>
          ICE : ${escapeHtml(company.ice)} · IF : ${escapeHtml(company.ifNumber)} · RC : ${escapeHtml(company.rc)}
        </div>
      </div>
    `,
  };
}

/**
 * 5. BON DE COMMANDE / RÉCEPTION FOURNISSEUR A4
 */
export function buildPurchaseA4Print(
  company: CompanyInfo,
  purchase: Purchase,
  items: PurchaseItem[]
): PrintableDocument {
  const rowsHtml = items
    .map(
      (i, idx) => `
      <tr style="border-bottom:1px solid #E2E8F0;background:${idx % 2 === 1 ? '#F8FAFC' : '#FFFFFF'};">
        <td style="padding:7px 6px;font-size:11px;font-family:monospace;">${idx + 1}</td>
        <td style="padding:7px 6px;font-size:11px;font-family:monospace;font-weight:600;">${escapeHtml(i.productRef)}</td>
        <td style="padding:7px 6px;font-size:11px;">${escapeHtml(i.productName)}</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;">${i.orderedQty}</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:700;">${i.receivedQty}</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;">${escapeHtml(formatMad(i.unitPriceHtCents))}</td>
        <td style="padding:7px 6px;font-size:11px;text-align:right;font-family:monospace;font-weight:700;">${escapeHtml(formatMad(i.lineTtcCents))}</td>
      </tr>
    `
    )
    .join('');

  return {
    title: `BON DE COMMANDE FOURNISSEUR ${purchase.number}`,
    subtitle: `${purchase.supplierName} — ${formatMad(purchase.totalTtcCents)}`,
    filename: `Commande_Achat_${purchase.number}`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#0F172A;padding:6px;background:#FFFFFF;">
        ${buildCompanyHeaderHtml(company)}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px;">
          <div style="background:#F8FAFC;border:1px solid #CBD5E1;border-left:4px solid #0F172A;padding:12px 14px;border-radius:6px;">
            <div style="font-size:17px;font-weight:800;font-family:monospace;">BON DE COMMANDE / RÉCEPTION N° ${escapeHtml(purchase.number)}</div>
            <div style="font-size:11.5px;margin-top:4px;">Date : <strong>${escapeHtml(formatBusinessDateFr(purchase.businessDate))}</strong> · Statut : <strong>${escapeHtml(purchase.status)}</strong></div>
          </div>
          <div style="background:#F8FAFC;border:1px solid #CBD5E1;padding:12px 14px;border-radius:6px;">
            <div style="font-size:10px;text-transform:uppercase;color:#64748B;font-weight:700;">Fournisseur</div>
            <div style="font-size:15px;font-weight:700;margin-top:3px;">${escapeHtml(purchase.supplierName)}</div>
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border:1px solid #CBD5E1;">
          <thead>
            <tr style="background:#0F172A;color:#FFFFFF;font-size:11px;text-align:left;">
              <th style="padding:8px 6px;">#</th>
              <th style="padding:8px 6px;">Réf.</th>
              <th style="padding:8px 6px;">Article</th>
              <th style="padding:8px 6px;text-align:right;">Qté Cmd</th>
              <th style="padding:8px 6px;text-align:right;">Qté Reçue</th>
              <th style="padding:8px 6px;text-align:right;">P.A HT</th>
              <th style="padding:8px 6px;text-align:right;">Total TTC</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div style="display:flex;justify-content:flex-end;">
          <div style="width:310px;border:1.5px solid #0F172A;border-radius:6px;padding:12px;background:#F8FAFC;font-size:12px;font-family:monospace;">
            <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Total HT :</span><strong>${escapeHtml(formatMad(purchase.totalTaxableCents))}</strong></div>
            <div style="display:flex;justify-content:space-between;padding:2px 0;"><span>Total TVA :</span><strong>${escapeHtml(formatMad(purchase.totalVatCents))}</strong></div>
            <div style="display:flex;justify-content:space-between;padding:6px 0;border-top:2px solid #0F172A;margin-top:4px;font-size:14px;"><span>Total TTC :</span><strong>${escapeHtml(formatMad(purchase.totalTtcCents))}</strong></div>
            <div style="display:flex;justify-content:space-between;padding:2px 0;color:#15803D;"><span>Réglé :</span><strong>${escapeHtml(formatMad(purchase.paidCents))}</strong></div>
            <div style="display:flex;justify-content:space-between;padding:2px 0;color:#DC2626;"><span>Reste dû :</span><strong>${escapeHtml(formatMad(purchase.remainingDueCents))}</strong></div>
          </div>
        </div>
        ${buildCompanyFooterHtml(company, true)}
      </div>
    `,
  };
}

/**
 * 6. PV D'ARRÊT ET BILLETAGE DE CAISSE A4
 */
export function buildCashAuditPvPrint(
  company: CompanyInfo,
  audit: CashAudit
): PrintableDocument {
  const denomRows = Object.entries(audit.counts)
    .filter(([, count]) => count > 0)
    .map(([denom, count]) => {
      const subCents = Math.round(parseFloat(denom) * 100) * count;
      return `
        <tr style="border-bottom:1px solid #E2E8F0;">
          <td style="padding:7px 8px;font-family:monospace;font-weight:600;">${escapeHtml(denom)} MAD</td>
          <td style="padding:7px 8px;text-align:right;font-family:monospace;">${count}</td>
          <td style="padding:7px 8px;text-align:right;font-family:monospace;font-weight:700;">${escapeHtml(formatMad(subCents))}</td>
        </tr>
      `;
    })
    .join('');

  return {
    title: `PV d'Arrêt de Caisse ${audit.number}`,
    subtitle: `Date : ${formatBusinessDateFr(audit.businessDate)} — ${audit.status}`,
    filename: `PV_Arret_Caisse_${audit.number}`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#0F172A;padding:6px;background:#FFFFFF;">
        ${buildCompanyHeaderHtml(company)}
        <div style="background:#F8FAFC;border:1px solid #CBD5E1;border-left:4px solid #0F172A;padding:12px 14px;border-radius:6px;margin-bottom:16px;">
          <div style="font-size:17px;font-weight:800;font-family:monospace;">
            PROCÈS-VERBAL D'ARRÊT ET BILLETAGE DE CAISSE (${escapeHtml(audit.number)})
          </div>
          <div style="font-size:11.5px;margin-top:4px;">
            Date métier : <strong>${escapeHtml(formatBusinessDateFr(audit.businessDate))}</strong> · Établi par : <strong>${escapeHtml(audit.userName)}</strong>
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border:1px solid #CBD5E1;">
          <thead>
            <tr style="background:#0F172A;color:#FFF;font-size:11px;text-align:left;">
              <th style="padding:8px;">Coupure / Pièce (MAD)</th>
              <th style="padding:8px;text-align:right;">Quantité Comptée</th>
              <th style="padding:8px;text-align:right;">Sous-total</th>
            </tr>
          </thead>
          <tbody>${denomRows || '<tr><td colspan="3" style="padding:10px;text-align:center;color:#64748B;">Aucune coupure renseignée</td></tr>'}</tbody>
        </table>
        <div style="border:1.5px solid #0F172A;padding:12px 14px;border-radius:6px;background:#F8FAFC;font-size:12.5px;font-family:monospace;line-height:1.6;">
          <div style="display:flex;justify-content:space-between;"><span>Solde Théorique Caisse :</span><strong>${escapeHtml(formatMad(audit.theoreticalBalanceCents))}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>Solde Physique Compté :</span><strong>${escapeHtml(formatMad(audit.countedBalanceCents))}</strong></div>
          <div style="display:flex;justify-content:space-between;border-top:1px solid #CBD5E1;padding-top:4px;margin-top:4px;">
            <span>Écart Constaté :</span>
            <strong>${escapeHtml(formatMad(audit.varianceCents))} (${escapeHtml(audit.status)})</strong>
          </div>
        </div>
        ${buildCompanyFooterHtml(company, true)}
      </div>
    `,
  };
}

/**
 * 7. PV D'INVENTAIRE PHYSIQUE A4
 */
export function buildInventoryPvPrint(
  company: CompanyInfo,
  session: InventorySession,
  items: InventoryItem[]
): PrintableDocument {
  const rowsHtml = items
    .map(
      (i, idx) => `
      <tr style="border-bottom:1px solid #E2E8F0;background:${idx % 2 === 1 ? '#F8FAFC' : '#FFFFFF'};">
        <td style="padding:6px;font-size:11px;font-family:monospace;font-weight:600;">${escapeHtml(i.productRef)}</td>
        <td style="padding:6px;font-size:11px;">${escapeHtml(i.productName)}</td>
        <td style="padding:6px;font-size:11px;text-align:right;font-family:monospace;">${i.theoreticalQty}</td>
        <td style="padding:6px;font-size:11px;text-align:right;font-family:monospace;font-weight:600;">${i.countedQty}</td>
        <td style="padding:6px;font-size:11px;text-align:right;font-family:monospace;font-weight:700;color:${i.varianceQty < 0 ? '#DC2626' : i.varianceQty > 0 ? '#15803D' : '#0F172A'};">${i.varianceQty > 0 ? `+${i.varianceQty}` : i.varianceQty}</td>
        <td style="padding:6px;font-size:11px;text-align:right;font-family:monospace;">${escapeHtml(formatMad(i.varianceValueCents))}</td>
      </tr>
    `
    )
    .join('');

  return {
    title: `PV d'Inventaire ${session.number}`,
    subtitle: `${formatBusinessDateFr(session.businessDate)} — Statut : ${session.status}`,
    filename: `PV_Inventaire_${session.number}`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#0F172A;padding:6px;background:#FFFFFF;">
        ${buildCompanyHeaderHtml(company)}
        <div style="background:#F8FAFC;border:1px solid #CBD5E1;border-left:4px solid #0F172A;padding:12px 14px;border-radius:6px;margin-bottom:16px;">
          <div style="font-size:17px;font-weight:800;font-family:monospace;">
            PROCÈS-VERBAL D'INVENTAIRE PHYSIQUE (${escapeHtml(session.number)})
          </div>
          <div style="font-size:11.5px;margin-top:4px;">
            Date : <strong>${escapeHtml(formatBusinessDateFr(session.businessDate))}</strong> · Périmètre : <strong>${escapeHtml(session.mode)} (${escapeHtml(session.scopeFilter)})</strong> · Statut : <strong>${escapeHtml(session.status)}</strong>
          </div>
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border:1px solid #CBD5E1;">
          <thead>
            <tr style="background:#0F172A;color:#FFF;font-size:11px;text-align:left;">
              <th style="padding:7px 6px;">Référence</th>
              <th style="padding:7px 6px;">Désignation</th>
              <th style="padding:7px 6px;text-align:right;">Qté Théorique</th>
              <th style="padding:7px 6px;text-align:right;">Qté Comptée</th>
              <th style="padding:7px 6px;text-align:right;">Écart Qté</th>
              <th style="padding:7px 6px;text-align:right;">Écart Valorisé HT</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        <div style="border:1.5px solid #0F172A;padding:12px 14px;border-radius:6px;background:#F8FAFC;font-size:12.5px;font-family:monospace;line-height:1.6;">
          <div style="display:flex;justify-content:space-between;"><span>Valeur Théorique HT :</span><strong>${escapeHtml(formatMad(session.totalTheoreticalValueCents))}</strong></div>
          <div style="display:flex;justify-content:space-between;"><span>Valeur Physique Comptée HT :</span><strong>${escapeHtml(formatMad(session.totalCountedValueCents))}</strong></div>
          <div style="display:flex;justify-content:space-between;border-top:1px solid #CBD5E1;padding-top:4px;margin-top:4px;"><span>Écart Total Valorisé HT :</span><strong>${escapeHtml(formatMad(session.totalVarianceValueCents))}</strong></div>
        </div>
        ${buildCompanyFooterHtml(company, true)}
      </div>
    `,
  };
}

/**
 * 8. JOURNAL DE CAISSE PAR PÉRIODE (A4 / PDF)
 */
export function buildCashJournalPeriodPrint(
  company: CompanyInfo,
  entries: CashEntry[],
  startDate: string,
  endDate: string,
  currentPhysicalCashCents: number
): PrintableDocument {
  const sorted = [...entries].sort((a, b) => a.businessDate.localeCompare(b.businessDate));

  let totalInCents = 0;
  let totalOutCents = 0;
  const byType = new Map<string, { count: number; inCents: number; outCents: number }>();

  for (const ce of sorted) {
    if (ce.direction === 'IN') {
      totalInCents += ce.amountCents;
    } else {
      totalOutCents += ce.amountCents;
    }
    const cur = byType.get(ce.type) || { count: 0, inCents: 0, outCents: 0 };
    cur.count += 1;
    if (ce.direction === 'IN') cur.inCents += ce.amountCents;
    else cur.outCents += ce.amountCents;
    byType.set(ce.type, cur);
  }

  const netPeriodCents = totalInCents - totalOutCents;

  const typeLabels: Record<string, string> = {
    OPENING_FLOAT: 'Fond de caisse initial',
    SALE_CASH_IN: 'Encaissement Vente POS / Espèces',
    PAYMENT_CASH_IN: 'Règlement Facture / SAV Espèces',
    EXPENSE_CASH_OUT: 'Dépense / Charge payée en Espèces',
    SUPPLIER_CASH_OUT: 'Règlement Fournisseur en Espèces',
    REFUND_CASH_OUT: 'Remboursement Retour Client Espèces',
    SALE_CANCEL_CASH_OUT: 'Annulation Vente (Contre-écriture Caisse)',
    CORRECTION: 'Écriture corrective après clôture',
  };

  const summaryRowsHtml = Array.from(byType.entries())
    .map(
      ([tKey, stat]) => `
      <tr style="border-bottom:1px solid #E2E8F0;">
        <td style="padding:5px 8px;font-weight:600;">${escapeHtml(typeLabels[tKey] || tKey)}</td>
        <td style="padding:5px 8px;text-align:center;font-family:monospace;">${stat.count}</td>
        <td style="padding:5px 8px;text-align:right;font-family:monospace;color:#15803D;">${stat.inCents > 0 ? `+${escapeHtml(formatMad(stat.inCents))}` : '—'}</td>
        <td style="padding:5px 8px;text-align:right;font-family:monospace;color:#DC2626;">${stat.outCents > 0 ? `-${escapeHtml(formatMad(stat.outCents))}` : '—'}</td>
      </tr>
    `
    )
    .join('');

  const rowsHtml = sorted
    .map(
      (ce, idx) => `
      <tr style="border-bottom:1px solid #E2E8F0;background:${idx % 2 === 1 ? '#F8FAFC' : '#FFFFFF'};">
        <td style="padding:6px 6px;font-size:10.5px;font-family:monospace;">${escapeHtml(formatBusinessDateFr(ce.businessDate))}</td>
        <td style="padding:6px 6px;font-size:10.5px;font-family:monospace;font-weight:600;">${escapeHtml(ce.sourceNumber || '—')}</td>
        <td style="padding:6px 6px;font-size:10.5px;">${escapeHtml(typeLabels[ce.type] || ce.type)}</td>
        <td style="padding:6px 6px;font-size:10.5px;color:#334155;">${escapeHtml(ce.description)}</td>
        <td style="padding:6px 6px;font-size:10.5px;text-align:right;font-family:monospace;font-weight:700;color:#15803D;">
          ${ce.direction === 'IN' ? `+${escapeHtml(formatMad(ce.amountCents))}` : ''}
        </td>
        <td style="padding:6px 6px;font-size:10.5px;text-align:right;font-family:monospace;font-weight:700;color:#DC2626;">
          ${ce.direction === 'OUT' ? `-${escapeHtml(formatMad(ce.amountCents))}` : ''}
        </td>
        <td style="padding:6px 6px;font-size:10px;text-align:center;">
          ${ce.isLockedByAudit ? 'Clôturé' : 'Ouvert'}
        </td>
      </tr>
    `
    )
    .join('');

  const periodLabel = `Du ${formatBusinessDateFr(startDate)} au ${formatBusinessDateFr(endDate)}`;

  return {
    title: `Journal de Caisse (${periodLabel})`,
    subtitle: `${sorted.length} écriture(s) · Entrées : +${formatMad(totalInCents)} · Sorties : -${formatMad(totalOutCents)}`,
    filename: `Journal_Caisse_${startDate}_au_${endDate}`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#0F172A;padding:6px;background:#FFFFFF;">
        ${buildCompanyHeaderHtml(company, '#0F172A')}

        <div style="background:#F8FAFC;border:1px solid #CBD5E1;border-left:4px solid #0F172A;padding:12px 14px;border-radius:6px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:10px;text-transform:uppercase;color:#64748B;font-weight:700;letter-spacing:0.06em;">
              État de Trésorerie Espèces (Règle 4 & Règle 13)
            </div>
            <div style="font-size:18px;font-weight:800;margin-top:2px;">
              JOURNAL DE CAISSE PHYSIQUE PAR PÉRIODE
            </div>
            <div style="font-size:12px;margin-top:3px;">
              Période analysée : <strong>${escapeHtml(periodLabel)}</strong> · Nombre de mouvements : <strong>${sorted.length}</strong>
            </div>
          </div>
          <div style="text-align:right;font-family:monospace;font-size:11px;background:#FFF;padding:8px 12px;border:1px solid #CBD5E1;border-radius:6px;">
            <div style="color:#64748B;">Solde Caisse Actuel</div>
            <div style="font-size:15px;font-weight:800;color:#0F172A;">${escapeHtml(formatMad(currentPhysicalCashCents))}</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px;font-family:monospace;">
          <div style="border:1px solid #BBF7D0;background:#F0FDF4;padding:10px 12px;border-radius:6px;">
            <div style="font-size:10px;color:#166534;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;text-transform:uppercase;">Total Entrées Espèces (Période)</div>
            <div style="font-size:16px;font-weight:800;color:#15803D;margin-top:3px;">+${escapeHtml(formatMad(totalInCents))}</div>
          </div>
          <div style="border:1px solid #FECACA;background:#FEF2F2;padding:10px 12px;border-radius:6px;">
            <div style="font-size:10px;color:#991B1B;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;text-transform:uppercase;">Total Sorties Espèces (Période)</div>
            <div style="font-size:16px;font-weight:800;color:#DC2626;margin-top:3px;">-${escapeHtml(formatMad(totalOutCents))}</div>
          </div>
          <div style="border:1px solid #CBD5E1;background:#F8FAFC;padding:10px 12px;border-radius:6px;">
            <div style="font-size:10px;color:#334155;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;text-transform:uppercase;">Flux Net Espèces (Période)</div>
            <div style="font-size:16px;font-weight:800;color:#0F172A;margin-top:3px;">${netPeriodCents >= 0 ? '+' : ''}${escapeHtml(formatMad(netPeriodCents))}</div>
          </div>
        </div>

        ${
          summaryRowsHtml
            ? `
        <div style="margin-bottom:16px;">
          <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:6px;text-transform:uppercase;">
            Synthèse par Nature d'Opération de Caisse
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:11px;border:1px solid #CBD5E1;">
            <thead>
              <tr style="background:#F1F5F9;color:#334155;text-align:left;border-bottom:1px solid #CBD5E1;">
                <th style="padding:6px 8px;">Nature d'opération</th>
                <th style="padding:6px 8px;text-align:center;">Nb. Opérations</th>
                <th style="padding:6px 8px;text-align:right;">Total Entrées (+)</th>
                <th style="padding:6px 8px;text-align:right;">Total Sorties (-)</th>
              </tr>
            </thead>
            <tbody>${summaryRowsHtml}</tbody>
          </table>
        </div>
        `
            : ''
        }

        <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:6px;text-transform:uppercase;">
          Détail Chronologique des Mouvements de Caisse
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border:1px solid #CBD5E1;">
          <thead>
            <tr style="background:#0F172A;color:#FFFFFF;font-size:10.5px;text-align:left;">
              <th style="padding:7px 6px;">Date</th>
              <th style="padding:7px 6px;">Pièce Source</th>
              <th style="padding:7px 6px;">Type</th>
              <th style="padding:7px 6px;">Libellé / Motif</th>
              <th style="padding:7px 6px;text-align:right;">Entrée (+)</th>
              <th style="padding:7px 6px;text-align:right;">Sortie (-)</th>
              <th style="padding:7px 6px;text-align:center;">Statut</th>
            </tr>
          </thead>
          <tbody>
            ${
              rowsHtml ||
              '<tr><td colspan="7" style="padding:14px;text-align:center;color:#64748B;">Aucun mouvement de caisse sur la période sélectionnée.</td></tr>'
            }
          </tbody>
        </table>

        ${buildCompanyFooterHtml(company, true)}
      </div>
    `,
  };
}

/**
 * 9. JOURNAL DES DÉPENSES & CHARGES PAR PÉRIODE (A4 / PDF)
 */
export function buildExpensesPeriodPrint(
  company: CompanyInfo,
  expenses: Expense[],
  startDate: string,
  endDate: string
): PrintableDocument {
  const sorted = [...expenses].sort((a, b) => a.businessDate.localeCompare(b.businessDate));

  let totalHtCents = 0;
  let totalVatCents = 0;
  let totalTtcCents = 0;
  let paidCashCents = 0;
  let paidBankCents = 0;

  const byCategory = new Map<string, { count: number; htCents: number; ttcCents: number }>();

  for (const exp of sorted) {
    if (exp.status === 'CANCELLED') continue;
    totalHtCents += exp.amountHtCents;
    totalVatCents += exp.amountVatCents;
    totalTtcCents += exp.amountTtcCents;
    if (exp.paymentMethod === 'CASH') {
      paidCashCents += exp.amountTtcCents;
    } else {
      paidBankCents += exp.amountTtcCents;
    }
    const cur = byCategory.get(exp.category) || { count: 0, htCents: 0, ttcCents: 0 };
    cur.count += 1;
    cur.htCents += exp.amountHtCents;
    cur.ttcCents += exp.amountTtcCents;
    byCategory.set(exp.category, cur);
  }

  const categoryRowsHtml = Array.from(byCategory.entries())
    .sort((a, b) => b[1].ttcCents - a[1].ttcCents)
    .map(
      ([cat, st]) => `
      <tr style="border-bottom:1px solid #E2E8F0;">
        <td style="padding:5px 8px;font-weight:600;">${escapeHtml(cat)}</td>
        <td style="padding:5px 8px;text-align:center;font-family:monospace;">${st.count}</td>
        <td style="padding:5px 8px;text-align:right;font-family:monospace;">${escapeHtml(formatMad(st.htCents))}</td>
        <td style="padding:5px 8px;text-align:right;font-family:monospace;font-weight:700;">${escapeHtml(formatMad(st.ttcCents))}</td>
      </tr>
    `
    )
    .join('');

  const rowsHtml = sorted
    .map(
      (ex, idx) => `
      <tr style="border-bottom:1px solid #E2E8F0;background:${
        ex.status === 'CANCELLED' ? '#FEF2F2' : idx % 2 === 1 ? '#F8FAFC' : '#FFFFFF'
      };">
        <td style="padding:6px;font-size:10.5px;font-family:monospace;">${escapeHtml(formatBusinessDateFr(ex.businessDate))}</td>
        <td style="padding:6px;font-size:10.5px;font-family:monospace;font-weight:600;">${escapeHtml(ex.number)}</td>
        <td style="padding:6px;font-size:10.5px;font-weight:600;">${escapeHtml(ex.category)}</td>
        <td style="padding:6px;font-size:10.5px;">${escapeHtml(ex.label)} ${
          ex.status === 'CANCELLED'
            ? '<strong style="color:#DC2626;font-family:monospace;">[ANNULÉE / PV]</strong>'
            : ''
        }</td>
        <td style="padding:6px;font-size:10.5px;">${escapeHtml(ex.beneficiary || '—')}</td>
        <td style="padding:6px;font-size:10.5px;font-family:monospace;">${escapeHtml(ex.paymentMethod)}</td>
        <td style="padding:6px;font-size:10.5px;text-align:right;font-family:monospace;">${escapeHtml(formatMad(ex.amountHtCents))}</td>
        <td style="padding:6px;font-size:10.5px;text-align:right;font-family:monospace;">${escapeHtml(formatMad(ex.amountVatCents))}</td>
        <td style="padding:6px;font-size:10.5px;text-align:right;font-family:monospace;font-weight:700;color:${
          ex.status === 'CANCELLED' ? '#DC2626' : '#0F172A'
        };">${escapeHtml(formatMad(ex.amountTtcCents))}</td>
      </tr>
    `
    )
    .join('');

  const periodLabel = `Du ${formatBusinessDateFr(startDate)} au ${formatBusinessDateFr(endDate)}`;

  return {
    title: `Journal des Dépenses & Charges (${periodLabel})`,
    subtitle: `${sorted.length} dépense(s) · Total HT : ${formatMad(totalHtCents)} · Total TTC : ${formatMad(totalTtcCents)}`,
    filename: `Journal_Depenses_${startDate}_au_${endDate}`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#0F172A;padding:6px;background:#FFFFFF;">
        ${buildCompanyHeaderHtml(company, '#B45309')}

        <div style="background:#F8FAFC;border:1px solid #CBD5E1;border-left:4px solid #B45309;padding:12px 14px;border-radius:6px;margin-bottom:16px;">
          <div style="font-size:10px;text-transform:uppercase;color:#B45309;font-weight:700;letter-spacing:0.06em;">
            Comptabilité d'Exploitation & Suivi des Charges (Section 29)
          </div>
          <div style="font-size:18px;font-weight:800;margin-top:2px;">
            ÉTAT & JOURNAL DES DÉPENSES PAR PÉRIODE
          </div>
          <div style="font-size:12px;margin-top:3px;">
            Période : <strong>${escapeHtml(periodLabel)}</strong> · Nombre de pièces enregistrées : <strong>${sorted.length}</strong>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;font-family:monospace;">
          <div style="border:1px solid #CBD5E1;background:#F8FAFC;padding:9px 10px;border-radius:6px;">
            <div style="font-size:10px;color:#475569;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;text-transform:uppercase;">Total Charges HT</div>
            <div style="font-size:14.5px;font-weight:800;color:#0F172A;margin-top:3px;">${escapeHtml(formatMad(totalHtCents))}</div>
          </div>
          <div style="border:1px solid #CBD5E1;background:#F8FAFC;padding:9px 10px;border-radius:6px;">
            <div style="font-size:10px;color:#475569;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;text-transform:uppercase;">Total TVA Charges</div>
            <div style="font-size:14.5px;font-weight:800;color:#0F172A;margin-top:3px;">${escapeHtml(formatMad(totalVatCents))}</div>
          </div>
          <div style="border:1px solid #FECACA;background:#FEF2F2;padding:9px 10px;border-radius:6px;">
            <div style="font-size:10px;color:#991B1B;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;text-transform:uppercase;">Total Décaissements TTC</div>
            <div style="font-size:14.5px;font-weight:800;color:#DC2626;margin-top:3px;">${escapeHtml(formatMad(totalTtcCents))}</div>
          </div>
          <div style="border:1px solid #CBD5E1;background:#F8FAFC;padding:9px 10px;border-radius:6px;font-size:10.5px;">
            <div style="font-size:10px;color:#475569;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;text-transform:uppercase;">Ventilation Trésorerie</div>
            <div style="margin-top:3px;">Caisse : <strong>${escapeHtml(formatMad(paidCashCents))}</strong></div>
            <div>Banque : <strong>${escapeHtml(formatMad(paidBankCents))}</strong></div>
          </div>
        </div>

        ${
          categoryRowsHtml
            ? `
        <div style="margin-bottom:16px;">
          <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:6px;text-transform:uppercase;">
            Répartition par Catégorie de Dépense
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:11px;border:1px solid #CBD5E1;">
            <thead>
              <tr style="background:#F1F5F9;color:#334155;text-align:left;border-bottom:1px solid #CBD5E1;">
                <th style="padding:6px 8px;">Catégorie</th>
                <th style="padding:6px 8px;text-align:center;">Nb. Pièces</th>
                <th style="padding:6px 8px;text-align:right;">Total HT</th>
                <th style="padding:6px 8px;text-align:right;">Total TTC</th>
              </tr>
            </thead>
            <tbody>${categoryRowsHtml}</tbody>
          </table>
        </div>
        `
            : ''
        }

        <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:6px;text-transform:uppercase;">
          Détail des Dépenses & Charges de la Période
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border:1px solid #CBD5E1;">
          <thead>
            <tr style="background:#0F172A;color:#FFFFFF;font-size:10.5px;text-align:left;">
              <th style="padding:7px 6px;">Date</th>
              <th style="padding:7px 6px;">N° Pièce</th>
              <th style="padding:7px 6px;">Catégorie</th>
              <th style="padding:7px 6px;">Libellé</th>
              <th style="padding:7px 6px;">Bénéficiaire</th>
              <th style="padding:7px 6px;">Mode</th>
              <th style="padding:7px 6px;text-align:right;">HT</th>
              <th style="padding:7px 6px;text-align:right;">TVA</th>
              <th style="padding:7px 6px;text-align:right;">TTC</th>
            </tr>
          </thead>
          <tbody>
            ${
              rowsHtml ||
              '<tr><td colspan="9" style="padding:14px;text-align:center;color:#64748B;">Aucune dépense enregistrée sur cette période.</td></tr>'
            }
          </tbody>
        </table>

        ${buildCompanyFooterHtml(company, true)}
      </div>
    `,
  };
}

/**
 * 10. ÉTAT DES VENTES PAR PÉRIODE (A4 / PDF)
 */
export function buildSalesPeriodReportPrint(
  company: CompanyInfo,
  sales: Sale[],
  startDate: string,
  endDate: string
): PrintableDocument {
  const sorted = [...sales].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
  const activeSales = sorted.filter((s) => s.status !== 'CANCELLED');
  const cancelledSales = sorted.filter((s) => s.status === 'CANCELLED');

  let totalHtCents = 0;
  let totalVatCents = 0;
  let totalTtcCents = 0;
  let totalPaidCents = 0;
  let totalDueCents = 0;
  let totalMarginHtCents = 0;

  const byMethod = new Map<string, { count: number; ttcCents: number; paidCents: number }>();

  for (const s of activeSales) {
    totalHtCents += s.totalTaxableCents;
    totalVatCents += s.totalVatCents;
    totalTtcCents += s.totalTtcCents;
    totalPaidCents += s.paidCents;
    totalDueCents += s.remainingDueCents;
    totalMarginHtCents += s.marginCents;

    const methodKey = s.paymentMethodSummary || 'CASH';
    const cur = byMethod.get(methodKey) || { count: 0, ttcCents: 0, paidCents: 0 };
    cur.count += 1;
    cur.ttcCents += s.totalTtcCents;
    cur.paidCents += s.paidCents;
    byMethod.set(methodKey, cur);
  }

  const methodRowsHtml = Array.from(byMethod.entries())
    .map(
      ([m, st]) => `
      <tr style="border-bottom:1px solid #E2E8F0;">
        <td style="padding:5px 8px;font-weight:600;font-family:monospace;">${escapeHtml(m)}</td>
        <td style="padding:5px 8px;text-align:center;font-family:monospace;">${st.count}</td>
        <td style="padding:5px 8px;text-align:right;font-family:monospace;">${escapeHtml(formatMad(st.ttcCents))}</td>
        <td style="padding:5px 8px;text-align:right;font-family:monospace;color:#15803D;font-weight:700;">${escapeHtml(formatMad(st.paidCents))}</td>
      </tr>
    `
    )
    .join('');

  const rowsHtml = sorted
    .map(
      (s, idx) => `
      <tr style="border-bottom:1px solid #E2E8F0;background:${
        s.status === 'CANCELLED' ? '#FEF2F2' : idx % 2 === 1 ? '#F8FAFC' : '#FFFFFF'
      };">
        <td style="padding:6px;font-size:10.5px;font-family:monospace;">${escapeHtml(formatBusinessDateFr(s.businessDate))}</td>
        <td style="padding:6px;font-size:10.5px;font-family:monospace;font-weight:700;">${escapeHtml(s.number)}</td>
        <td style="padding:6px;font-size:10.5px;font-weight:500;">${escapeHtml(s.customerName)}</td>
        <td style="padding:6px;font-size:10.5px;">${escapeHtml(s.sellerName)}</td>
        <td style="padding:6px;font-size:10px;font-family:monospace;">${escapeHtml(s.paymentMethodSummary)}</td>
        <td style="padding:6px;font-size:10px;font-family:monospace;font-weight:700;color:${
          s.status === 'CANCELLED' ? '#DC2626' : s.status === 'VALIDATED' ? '#15803D' : '#B45309'
        };">${escapeHtml(s.status)}</td>
        <td style="padding:6px;font-size:10.5px;text-align:right;font-family:monospace;">${escapeHtml(formatMad(s.totalTaxableCents))}</td>
        <td style="padding:6px;font-size:10.5px;text-align:right;font-family:monospace;">${escapeHtml(formatMad(s.totalVatCents))}</td>
        <td style="padding:6px;font-size:10.5px;text-align:right;font-family:monospace;font-weight:700;">${escapeHtml(formatMad(s.totalTtcCents))}</td>
        <td style="padding:6px;font-size:10.5px;text-align:right;font-family:monospace;color:#15803D;">${escapeHtml(formatMad(s.paidCents))}</td>
        <td style="padding:6px;font-size:10.5px;text-align:right;font-family:monospace;color:${
          s.remainingDueCents > 0 ? '#DC2626' : '#64748B'
        };">${escapeHtml(formatMad(s.remainingDueCents))}</td>
      </tr>
    `
    )
    .join('');

  const periodLabel = `Du ${formatBusinessDateFr(startDate)} au ${formatBusinessDateFr(endDate)}`;

  return {
    title: `État des Ventes (${periodLabel})`,
    subtitle: `${activeSales.length} vente(s) active(s) · CA TTC : ${formatMad(totalTtcCents)} · Encaissé : ${formatMad(totalPaidCents)}`,
    filename: `Etat_Ventes_${startDate}_au_${endDate}`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#0F172A;padding:6px;background:#FFFFFF;">
        ${buildCompanyHeaderHtml(company, '#1D4ED8')}

        <div style="background:#F8FAFC;border:1px solid #CBD5E1;border-left:4px solid #1D4ED8;padding:12px 14px;border-radius:6px;margin-bottom:16px;">
          <div style="font-size:10px;text-transform:uppercase;color:#1D4ED8;font-weight:700;letter-spacing:0.06em;">
            Rapport Commercial & Comptable Certifié (Règles 2, 10 & 19)
          </div>
          <div style="font-size:18px;font-weight:800;margin-top:2px;">
            ÉTAT RÉCAPITULATIF DES VENTES PAR PÉRIODE
          </div>
          <div style="font-size:12px;margin-top:3px;">
            Période : <strong>${escapeHtml(periodLabel)}</strong> · Ventes actives : <strong>${activeSales.length}</strong> · Annulées tracées : <strong>${cancelledSales.length}</strong>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:16px;font-family:monospace;">
          <div style="border:1px solid #CBD5E1;background:#F8FAFC;padding:9px 10px;border-radius:6px;">
            <div style="font-size:10px;color:#475569;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;text-transform:uppercase;">CA Net HT (Hors Annul.)</div>
            <div style="font-size:14.5px;font-weight:800;color:#0F172A;margin-top:3px;">${escapeHtml(formatMad(totalHtCents))}</div>
            <div style="font-size:10px;color:#64748B;margin-top:2px;">Marge HT : ${escapeHtml(formatMad(totalMarginHtCents))}</div>
          </div>
          <div style="border:1px solid #CBD5E1;background:#F8FAFC;padding:9px 10px;border-radius:6px;">
            <div style="font-size:10px;color:#475569;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;text-transform:uppercase;">CA Total TTC</div>
            <div style="font-size:14.5px;font-weight:800;color:#1D4ED8;margin-top:3px;">${escapeHtml(formatMad(totalTtcCents))}</div>
            <div style="font-size:10px;color:#64748B;margin-top:2px;">Dont TVA : ${escapeHtml(formatMad(totalVatCents))}</div>
          </div>
          <div style="border:1px solid #BBF7D0;background:#F0FDF4;padding:9px 10px;border-radius:6px;">
            <div style="font-size:10px;color:#166534;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;text-transform:uppercase;">Total Encaissé</div>
            <div style="font-size:14.5px;font-weight:800;color:#15803D;margin-top:3px;">${escapeHtml(formatMad(totalPaidCents))}</div>
          </div>
          <div style="border:1px solid #FDE68A;background:#FFFBEB;padding:9px 10px;border-radius:6px;">
            <div style="font-size:10px;color:#92400E;font-family:'Plus Jakarta Sans',sans-serif;font-weight:700;text-transform:uppercase;">Reste à Recouvrer</div>
            <div style="font-size:14.5px;font-weight:800;color:#B45309;margin-top:3px;">${escapeHtml(formatMad(totalDueCents))}</div>
          </div>
        </div>

        ${
          methodRowsHtml
            ? `
        <div style="margin-bottom:16px;">
          <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:6px;text-transform:uppercase;">
            Ventilation par Mode de Règlement
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:11px;border:1px solid #CBD5E1;">
            <thead>
              <tr style="background:#F1F5F9;color:#334155;text-align:left;border-bottom:1px solid #CBD5E1;">
                <th style="padding:6px 8px;">Mode de Règlement</th>
                <th style="padding:6px 8px;text-align:center;">Nombre de Ventes</th>
                <th style="padding:6px 8px;text-align:right;">Volume TTC</th>
                <th style="padding:6px 8px;text-align:right;">Total Encaissé</th>
              </tr>
            </thead>
            <tbody>${methodRowsHtml}</tbody>
          </table>
        </div>
        `
            : ''
        }

        <div style="font-size:11px;font-weight:700;color:#334155;margin-bottom:6px;text-transform:uppercase;">
          Journal Détaillé des Ventes de la Période
        </div>
        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border:1px solid #CBD5E1;">
          <thead>
            <tr style="background:#0F172A;color:#FFFFFF;font-size:10px;text-align:left;">
              <th style="padding:7px 5px;">Date</th>
              <th style="padding:7px 5px;">N° Vente</th>
              <th style="padding:7px 5px;">Client</th>
              <th style="padding:7px 5px;">Vendeur</th>
              <th style="padding:7px 5px;">Mode</th>
              <th style="padding:7px 5px;">Statut</th>
              <th style="padding:7px 5px;text-align:right;">Total HT</th>
              <th style="padding:7px 5px;text-align:right;">TVA</th>
              <th style="padding:7px 5px;text-align:right;">Total TTC</th>
              <th style="padding:7px 5px;text-align:right;">Payé</th>
              <th style="padding:7px 5px;text-align:right;">Reste dû</th>
            </tr>
          </thead>
          <tbody>
            ${
              rowsHtml ||
              '<tr><td colspan="11" style="padding:14px;text-align:center;color:#64748B;">Aucune vente enregistrée sur la période sélectionnée.</td></tr>'
            }
          </tbody>
        </table>

        ${buildCompanyFooterHtml(company, true)}
      </div>
    `,
  };
}

/**
 * 11. PROCÈS-VERBAL D'ANNULATION DE PAIEMENT & RÉGULARISATION DÉPENSE (A4 / PDF)
 */
export function buildPaymentCancellationPvPrint(
  company: CompanyInfo,
  input: {
    pvNumber?: string;
    expenseNumber?: string;
    targetDocNumber?: string;
    partyName?: string;
    canceledAmountCents: number;
    paymentMethod: string;
    businessDate?: string;
    reason: string;
    userName?: string;
    pvAudit?: { number?: string; businessDate?: string; userName?: string };
    expense?: Expense;
    purchase?: Purchase;
  }
): PrintableDocument {
  const params = {
    pvNumber: input.pvNumber || input.pvAudit?.number || input.expense?.receiptRef || 'PV-ANNUL',
    expenseNumber: input.expenseNumber || input.expense?.number || '-',
    targetDocNumber:
      input.targetDocNumber || input.purchase?.number || input.expense?.number || '-',
    partyName:
      input.partyName || input.purchase?.supplierName || input.expense?.beneficiary || '-',
    canceledAmountCents: input.canceledAmountCents,
    paymentMethod: input.paymentMethod,
    businessDate:
      input.businessDate ||
      input.pvAudit?.businessDate ||
      input.expense?.businessDate ||
      new Date().toISOString().slice(0, 10),
    reason: input.reason,
    userName: input.userName || input.pvAudit?.userName || 'Administrateur',
  };
  return {
    title: `PV d'Annulation de Paiement ${params.pvNumber}`,
    subtitle: `${params.targetDocNumber} — ${params.partyName} — ${formatMad(params.canceledAmountCents)}`,
    filename: `PV_Annulation_Paiement_${params.pvNumber}`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#0F172A;padding:6px;background:#FFFFFF;">
        ${buildCompanyHeaderHtml(company, '#B45309')}

        <div style="background:#FFFBEB;border:1px solid #F59E0B;border-left:4px solid #B45309;padding:12px 14px;border-radius:6px;margin-bottom:18px;">
          <div style="font-size:10px;text-transform:uppercase;color:#B45309;font-weight:700;letter-spacing:0.06em;">
            Pièce de Régularisation Comptable & Trésorerie (Règle 8)
          </div>
          <div style="font-size:18px;font-weight:800;margin-top:2px;font-family:'JetBrains Mono',monospace;">
            PROCÈS-VERBAL D'ANNULATION DE PAIEMENT N° ${escapeHtml(params.pvNumber)}
          </div>
          <div style="font-size:11.5px;margin-top:4px;">
            Date métier : <strong>${escapeHtml(formatBusinessDateFr(params.businessDate))}</strong> ·
            Pièce Dépense / Régularisation liée : <strong>${escapeHtml(params.expenseNumber)}</strong> ·
            Établi par : <strong>${escapeHtml(params.userName)}</strong>
          </div>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border:1px solid #CBD5E1;font-size:11.5px;">
          <thead>
            <tr style="background:#0F172A;color:#FFFFFF;text-align:left;">
              <th style="padding:8px 10px;">Document / Commande Source</th>
              <th style="padding:8px 10px;">Fournisseur / Bénéficiaire</th>
              <th style="padding:8px 10px;">Mode Initial</th>
              <th style="padding:8px 10px;">N° Dépense Liée</th>
              <th style="padding:8px 10px;text-align:right;">Montant Annulé TTC</th>
            </tr>
          </thead>
          <tbody>
            <tr style="border-bottom:1px solid #CBD5E1;background:#F8FAFC;">
              <td style="padding:10px;font-family:monospace;font-weight:700;">${escapeHtml(params.targetDocNumber)}</td>
              <td style="padding:10px;font-weight:600;">${escapeHtml(params.partyName)}</td>
              <td style="padding:10px;font-family:monospace;">${escapeHtml(params.paymentMethod)}</td>
              <td style="padding:10px;font-family:monospace;font-weight:600;">${escapeHtml(params.expenseNumber)}</td>
              <td style="padding:10px;text-align:right;font-family:monospace;font-weight:800;color:#DC2626;font-size:13px;">
                ${escapeHtml(formatMad(params.canceledAmountCents))}
              </td>
            </tr>
          </tbody>
        </table>

        <div style="border:1.5px solid #0F172A;border-radius:6px;padding:12px 14px;background:#F8FAFC;font-size:12px;line-height:1.6;margin-bottom:16px;">
          <div><strong>Motif d'annulation & d'établissement du PV :</strong> ${escapeHtml(params.reason)}</div>
          <div><strong>Impact Trésorerie & Dette :</strong> Contre-passation du règlement (${escapeHtml(params.paymentMethod)}), enregistrement de la pièce de régularisation <strong>${escapeHtml(params.expenseNumber)}</strong> au journal des dépenses et rétablissement du solde dû sur le document <strong>${escapeHtml(params.targetDocNumber)}</strong>.</div>
          <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #CBD5E1;">
            <strong>Arrêté le présent Procès-Verbal d'annulation à la somme de :</strong>
            <span style="font-style:italic;font-weight:700;"> « ${escapeHtml(amountInFrenchWordsMad(params.canceledAmountCents))} »</span>
          </div>
        </div>

        ${buildCompanyFooterHtml(company, true)}
      </div>
    `,
  };
}

/**
 * 12. ÉTAT DES PRODUITS & DU STOCK VALORISÉ A4 / PDF (avec conservation du tri choisi)
 */
export function buildProductsAndStockReportPrint(
  company: CompanyInfo,
  products: Product[],
  options: {
    mode: 'CATALOG' | 'STOCK';
    sortLabel?: string;
    filterLabel?: string;
  }
): PrintableDocument {
  let totalStockQty = 0;
  let totalPurchaseValueHtCents = 0;
  let totalSaleValueHtCents = 0;
  let alertCount = 0;

  const rowsHtml = products
    .map((p, idx) => {
      const qty = Math.max(0, p.stock);
      const valPaHt = qty * p.purchasePriceCents;
      const valPvHt = qty * p.salePriceHtCents;
      const pvTtc = Math.round(p.salePriceHtCents * (1 + (p.vatRate || 20) / 100));
      totalStockQty += p.stock;
      totalPurchaseValueHtCents += valPaHt;
      totalSaleValueHtCents += valPvHt;

      const status =
        p.stock <= 0
          ? 'RUPTURE'
          : p.stock <= Math.max(1, Math.floor(p.minStock / 2))
          ? 'CRITIQUE'
          : p.stock <= p.minStock
          ? 'FAIBLE'
          : p.stock > p.maxStock && p.maxStock > 0
          ? 'SURSTOCK'
          : 'NORMAL';

      if (status === 'RUPTURE' || status === 'CRITIQUE' || status === 'FAIBLE') {
        alertCount += 1;
      }

      const statusColor =
        status === 'RUPTURE' || status === 'CRITIQUE'
          ? '#DC2626'
          : status === 'FAIBLE'
          ? '#B45309'
          : '#15803D';

      return `
        <tr style="border-bottom:1px solid #E2E8F0;background:${idx % 2 === 1 ? '#F8FAFC' : '#FFFFFF'};">
          <td style="padding:6px;font-family:monospace;font-size:10px;">${idx + 1}</td>
          <td style="padding:6px;font-family:monospace;font-weight:700;font-size:10px;">${escapeHtml(p.reference)}</td>
          <td style="padding:6px;font-size:10.5px;">
            <div style="font-weight:600;color:#0F172A;">${escapeHtml(p.name)}</div>
            <div style="font-size:9.5px;color:#64748B;">${escapeHtml(p.categoryName)} · ${escapeHtml(p.location)}</div>
          </td>
          <td style="padding:6px;text-align:right;font-family:monospace;font-size:10.5px;">${escapeHtml(formatMad(p.purchasePriceCents))}</td>
          <td style="padding:6px;text-align:right;font-family:monospace;font-size:10.5px;">${escapeHtml(formatMad(p.salePriceHtCents))}</td>
          <td style="padding:6px;text-align:right;font-family:monospace;font-size:10.5px;font-weight:600;">${escapeHtml(formatMad(pvTtc))}</td>
          <td style="padding:6px;text-align:right;font-family:monospace;font-size:10.5px;font-weight:700;color:${statusColor};">
            ${p.stock} ${escapeHtml(p.unit)}
          </td>
          <td style="padding:6px;text-align:right;font-family:monospace;font-size:10.5px;font-weight:700;">
            ${escapeHtml(formatMad(valPaHt))}
          </td>
          <td style="padding:6px;font-family:monospace;font-size:9.5px;font-weight:700;color:${statusColor};">
            ${status}
          </td>
        </tr>
      `;
    })
    .join('');

  const docTitle =
    options.mode === 'STOCK'
      ? 'ÉTAT VALORISÉ DU STOCK & SEUILS D’ALERTE'
      : 'ÉTAT DU CATALOGUE PRODUITS & TARIFS';

  return {
    title: docTitle,
    subtitle: `${products.length} référence(s)${options.sortLabel ? ` — Tri : ${options.sortLabel}` : ''}`,
    filename: options.mode === 'STOCK' ? 'Etat_Stock_Valorise' : 'Catalogue_Produits',
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#0F172A;padding:6px;background:#FFFFFF;">
        ${buildCompanyHeaderHtml(company)}
        <div style="background:#F8FAFC;border:1px solid #CBD5E1;border-left:4px solid #0F172A;padding:12px 14px;border-radius:6px;margin-bottom:16px;">
          <div style="font-size:17px;font-weight:800;font-family:'JetBrains Mono',monospace;">
            ${escapeHtml(docTitle)}
          </div>
          <div style="font-size:11px;margin-top:4px;color:#334155;">
            Articles listés : <strong>${products.length}</strong>
            ${options.sortLabel ? ` · Tri appliqué : <strong>${escapeHtml(options.sortLabel)}</strong>` : ''}
            ${options.filterLabel ? ` · Filtre : <strong>${escapeHtml(options.filterLabel)}</strong>` : ''}
          </div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:10px;margin-bottom:16px;">
          <div style="border:1px solid #CBD5E1;border-radius:6px;padding:8px 10px;background:#F8FAFC;">
            <div style="font-size:9.5px;text-transform:uppercase;color:#64748B;font-weight:700;">Références</div>
            <div style="font-size:14px;font-weight:800;font-family:monospace;margin-top:2px;">${products.length} (${alertCount} en alerte)</div>
          </div>
          <div style="border:1px solid #CBD5E1;border-radius:6px;padding:8px 10px;background:#F8FAFC;">
            <div style="font-size:9.5px;text-transform:uppercase;color:#64748B;font-weight:700;">Unités en Stock</div>
            <div style="font-size:14px;font-weight:800;font-family:monospace;margin-top:2px;">${totalStockQty}</div>
          </div>
          <div style="border:1px solid #CBD5E1;border-radius:6px;padding:8px 10px;background:#F8FAFC;">
            <div style="font-size:9.5px;text-transform:uppercase;color:#64748B;font-weight:700;">Valeur Coût d'Achat HT</div>
            <div style="font-size:14px;font-weight:800;font-family:monospace;margin-top:2px;color:#0F172A;">${escapeHtml(formatMad(totalPurchaseValueHtCents))}</div>
          </div>
          <div style="border:1px solid #CBD5E1;border-radius:6px;padding:8px 10px;background:#F8FAFC;">
            <div style="font-size:9.5px;text-transform:uppercase;color:#64748B;font-weight:700;">Valeur Vente HT</div>
            <div style="font-size:14px;font-weight:800;font-family:monospace;margin-top:2px;color:#1D4ED8;">${escapeHtml(formatMad(totalSaleValueHtCents))}</div>
          </div>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;border:1px solid #CBD5E1;">
          <thead>
            <tr style="background:#0F172A;color:#FFFFFF;font-size:10px;text-align:left;">
              <th style="padding:7px 6px;">#</th>
              <th style="padding:7px 6px;">Référence</th>
              <th style="padding:7px 6px;">Désignation / Catégorie / Emplacement</th>
              <th style="padding:7px 6px;text-align:right;">P.A HT</th>
              <th style="padding:7px 6px;text-align:right;">P.V HT</th>
              <th style="padding:7px 6px;text-align:right;">P.V TTC</th>
              <th style="padding:7px 6px;text-align:right;">Stock</th>
              <th style="padding:7px 6px;text-align:right;">Valeur Coût HT</th>
              <th style="padding:7px 6px;">Statut</th>
            </tr>
          </thead>
          <tbody>
            ${
              rowsHtml ||
              '<tr><td colspan="9" style="padding:12px;text-align:center;color:#64748B;">Aucun produit correspondant aux critères.</td></tr>'
            }
          </tbody>
        </table>

        ${buildCompanyFooterHtml(company, false)}
      </div>
    `,
  };
}

export interface AiMarketResearchSummaryData {
  status: 'FOUND' | 'PARTIAL' | 'NOT_FOUND';
  productQuery: string;
  country: string;
  city: string;
  locationLabel: string;
  evaluationFocus: string;
  reportMarkdown: string;
  sources: Array<{ title: string; uri: string }>;
  searchQueries: string[];
  modelUsed: string;
  timestamp: string;
}

export function buildAiMarketResearchReportPrint(
  company: CompanyInfo,
  report: AiMarketResearchSummaryData
): PrintableDocument {
  const statusLabel =
    report.status === 'FOUND'
      ? 'DONNÉES VÉRIFIÉES TROUVÉES'
      : report.status === 'PARTIAL'
      ? 'PARTIEL (PRODUIT IDENTIFIÉ / PRIX LOCAL NON PUBLIÉ)'
      : 'AUCUNE DONNÉE FIABLE TROUVÉE (ZÉRO INVENTION)';

  const statusColor =
    report.status === 'FOUND'
      ? '#047857'
      : report.status === 'PARTIAL'
      ? '#B45309'
      : '#B91C1C';

  const formattedBodyHtml = escapeHtml(report.reportMarkdown)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br/>');

  const sourcesHtml =
    report.sources.length > 0
      ? report.sources
          .map(
            (s, i) => `
          <li style="margin-bottom:4px;font-size:10px;word-break:break-all;">
            <strong>[${i + 1}] ${escapeHtml(s.title)}</strong> — <span style="font-family:monospace;color:#1D4ED8;">${escapeHtml(s.uri)}</span>
          </li>
        `
          )
          .join('')
      : '<li style="font-size:10px;color:#64748B;">Aucune source web publique référencée pour cette requête.</li>';

  return {
    title: `RAPPORT DE VEILLE & ÉVALUATION PRODUIT — ${report.productQuery}`,
    subtitle: `Zone : ${report.locationLabel} — ${statusLabel}`,
    filename: `Veille_IA_${report.productQuery.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 32)}`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#0F172A;padding:6px;background:#FFFFFF;">
        ${buildCompanyHeaderHtml(company)}
        <div style="background:#F8FAFC;border:1px solid #CBD5E1;border-left:4px solid #0F172A;padding:12px 14px;border-radius:6px;margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
            <div>
              <div style="font-size:16px;font-weight:800;font-family:'JetBrains Mono',monospace;">
                RAPPORT DE VEILLE MARCHÉ & ÉVALUATION PRODUIT
              </div>
              <div style="font-size:12px;margin-top:4px;font-weight:700;color:#0F172A;">
                Produit recherché : ${escapeHtml(report.productQuery)}
              </div>
              <div style="font-size:11px;margin-top:2px;color:#334155;">
                Localisation ciblée : <strong>${escapeHtml(report.locationLabel)}</strong> · Objectif : ${escapeHtml(report.evaluationFocus)}
              </div>
            </div>
            <div style="text-align:right;font-family:'JetBrains Mono',monospace;font-size:10px;font-weight:700;color:${statusColor};border:1px solid ${statusColor};padding:4px 8px;border-radius:4px;background:#FFFFFF;">
              ${escapeHtml(statusLabel)}
            </div>
          </div>
        </div>

        <div style="border:1px solid #CBD5E1;border-radius:6px;padding:14px 16px;margin-bottom:16px;font-size:11px;line-height:1.65;background:rgba(255,255,255,0.88);">
          ${formattedBodyHtml}
        </div>

        <div style="border:1px solid #CBD5E1;border-radius:6px;padding:10px 14px;margin-bottom:16px;background:#F8FAFC;">
          <div style="font-size:10.5px;font-weight:700;text-transform:uppercase;color:#334155;margin-bottom:6px;">
            Sources Web Vérifiées (Google Search Grounding — Zéro Invention)
          </div>
          <ul style="margin:0;padding-left:16px;">
            ${sourcesHtml}
          </ul>
        </div>

        ${buildCompanyFooterHtml(company, false)}
      </div>
    `,
  };
}

/**
 * 15. FICHE DE SUIVI PRODUIT DÉFECTUEUX & BON DE QUARANTAINE A4
 */
export function buildDefectiveProductSheetPrint(
  company: CompanyInfo,
  def: DefectiveProduct
): PrintableDocument {
  const statusLabels: Record<string, string> = {
    EN_QUARANTAINE: 'EN ZONE DE QUARANTAINE / ATTENTE',
    RETOURNE_FOURNISSEUR: 'RETOURNÉ AU FOURNISSEUR (RMA)',
    REMPLACE_FOURNISSEUR: 'REMPLACÉ PAR LE FOURNISSEUR',
    AVOIR_FOURNISSEUR: 'AVOIR / REMBOURSEMENT FOURNISSEUR',
    REPARE_REMIS_EN_STOCK: 'RÉPARÉ ET RÉINTÉGRÉ EN STOCK ACTIF',
    REBUTE_PERTE: 'REBUTÉ / DÉTRUIT EN PERTE',
  };

  const sourceLabels: Record<string, string> = {
    PURCHASE_RECEIPT: 'Constaté à la réception d’une commande fournisseur',
    CUSTOMER_RETURN: 'Constaté et retourné par un client',
    MANUAL_INSPECTION: 'Constaté lors de l’inspection en stock / magasin',
    SAV_INTERVENTION: 'Constaté lors d’une intervention SAV atelier',
  };

  return {
    title: `Fiche Défectueux ${def.number}`,
    subtitle: `${def.productName} — ${def.quantity} unité(s)`,
    filename: `Fiche_Defectueux_${def.number}`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#0F172A;padding:6px;background:#FFFFFF;">
        ${buildCompanyHeaderHtml(company, '#DC2626')}

        <div style="display:grid;grid-template-columns:1.2fr 0.8fr;gap:16px;margin-bottom:18px;">
          <div style="background:#FEF2F2;border:1px solid #FECACA;border-left:4px solid #DC2626;padding:12px 14px;border-radius:6px;">
            <div style="font-size:10px;text-transform:uppercase;color:#991B1B;font-weight:700;letter-spacing:0.06em;">
              Fiche de Constat & Bon de Quarantaine / Réclamation
            </div>
            <div style="font-size:19px;font-weight:800;color:#DC2626;margin-top:2px;font-family:'JetBrains Mono',monospace;">
              N° ${escapeHtml(def.number)}
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;font-size:11.5px;">
              <div>Date constat : <strong>${escapeHtml(formatBusinessDateFr(def.reportedDate))}</strong></div>
              <div>Déclaré par : <strong>${escapeHtml(def.reportedBy || 'Atelier ASW')}</strong></div>
              <div style="grid-column:span 2;">
                Statut actuel :
                <span style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:10.5px;font-weight:700;background:#FEE2E2;color:#991B1B;">
                  ${escapeHtml(statusLabels[def.status] || def.status)}
                </span>
              </div>
            </div>
          </div>

          <div style="background:#F8FAFC;border:1px solid #CBD5E1;padding:12px 14px;border-radius:6px;font-size:11.5px;">
            <div style="font-size:10px;text-transform:uppercase;color:#64748B;font-weight:700;letter-spacing:0.06em;">
              Origine & Document Source
            </div>
            <div style="font-size:13px;font-weight:700;color:#0F172A;margin-top:3px;">
              ${escapeHtml(sourceLabels[def.sourceType] || def.sourceType)}
            </div>
            ${def.supplierName ? `<div style="margin-top:4px;">Fournisseur : <strong>${escapeHtml(def.supplierName)}</strong></div>` : ''}
            ${def.customerName ? `<div style="margin-top:4px;">Client concerné : <strong>${escapeHtml(def.customerName)}</strong></div>` : ''}
            ${def.sourceDocNumber ? `<div style="margin-top:4px;font-family:monospace;">N° Doc associé : <strong>${escapeHtml(def.sourceDocNumber)}</strong></div>` : ''}
          </div>
        </div>

        <div style="border:1px solid #CBD5E1;border-radius:6px;overflow:hidden;margin-bottom:18px;">
          <div style="background:#0F172A;color:#FFFFFF;padding:8px 12px;font-size:11px;font-weight:700;">
            Détail du Produit Isolé en Quarantaine
          </div>
          <table style="width:100%;border-collapse:collapse;font-size:11px;">
            <thead>
              <tr style="background:#F1F5F9;text-align:left;border-bottom:1px solid #CBD5E1;">
                <th style="padding:8px 10px;">Référence</th>
                <th style="padding:8px 10px;">Désignation de l'Article</th>
                <th style="padding:8px 10px;text-align:right;">Quantité</th>
                <th style="padding:8px 10px;text-align:right;">Coût Unitaire HT</th>
                <th style="padding:8px 10px;text-align:right;">Total Immobilisé</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style="padding:10px;font-family:monospace;font-weight:700;">${escapeHtml(def.productRef)}</td>
                <td style="padding:10px;font-weight:600;">${escapeHtml(def.productName)}</td>
                <td style="padding:10px;text-align:right;font-family:monospace;font-size:13px;font-weight:800;color:#DC2626;">
                  ${def.quantity}
                </td>
                <td style="padding:10px;text-align:right;font-family:monospace;">${escapeHtml(formatMad(def.unitCostCents))}</td>
                <td style="padding:10px;text-align:right;font-family:monospace;font-weight:700;">${escapeHtml(formatMad(def.totalCostCents))}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;padding:12px 14px;margin-bottom:18px;font-size:11.5px;">
          <div style="font-weight:700;color:#92400E;margin-bottom:4px;text-transform:uppercase;font-size:10.5px;">
            Description Précise de la Défectuosité / Panne Constatée :
          </div>
          <div style="color:#78350F;line-height:1.5;font-weight:500;white-space:pre-wrap;">
            ${escapeHtml(def.defectReason)}
          </div>
        </div>

        ${
          def.resolutionNotes
            ? `<div style="background:#ECFDF5;border:1px solid #A7F3D0;border-radius:6px;padding:12px 14px;margin-bottom:18px;font-size:11.5px;">
                <div style="font-weight:700;color:#065F46;margin-bottom:4px;text-transform:uppercase;font-size:10.5px;">
                  Décision & Traitement Effectué (${def.resolutionDate ? formatBusinessDateFr(def.resolutionDate) : ''}) :
                </div>
                <div style="color:#047857;line-height:1.5;">${escapeHtml(def.resolutionNotes)}</div>
              </div>`
            : ''
        }

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:28px;padding-top:14px;border-top:1px dashed #CBD5E1;font-size:11px;">
          <div style="border:1px solid #CBD5E1;border-radius:6px;padding:12px;min-height:90px;">
            <div style="font-weight:700;color:#334155;">Visa / Signature Responsable Stock & SAV :</div>
            <div style="margin-top:35px;font-size:9.5px;color:#94A3B8;">Cachet et signature</div>
          </div>
          <div style="border:1px solid #CBD5E1;border-radius:6px;padding:12px;min-height:90px;">
            <div style="font-weight:700;color:#334155;">Visa Tiers / Fournisseur (Réclamation RMA) :</div>
            <div style="margin-top:35px;font-size:9.5px;color:#94A3B8;">Accusé de réception / Bon d'échange</div>
          </div>
        </div>

        ${buildCompanyFooterHtml(company, false)}
      </div>
    `,
  };
}

/**
 * 16. REGISTRE & ÉTAT DES PRODUITS DÉFECTUEUX / ZONE DE QUARANTAINE A4
 */
export function buildDefectiveRegisterPrint(
  company: CompanyInfo,
  defectiveList: DefectiveProduct[],
  filterLabel?: string
): PrintableDocument {
  const totalQty = defectiveList.reduce((acc, d) => acc + d.quantity, 0);
  const totalCost = defectiveList.reduce((acc, d) => acc + d.totalCostCents, 0);

  const statusLabels: Record<string, string> = {
    EN_QUARANTAINE: 'Quarantaine',
    RETOURNE_FOURNISSEUR: 'Retour Fournisseur',
    REMPLACE_FOURNISSEUR: 'Remplacé Fournisseur',
    AVOIR_FOURNISSEUR: 'Avoir Fournisseur',
    REPARE_REMIS_EN_STOCK: 'Réparé & Re-stocké',
    REBUTE_PERTE: 'Rebut / Perte',
  };

  const rows = defectiveList
    .map(
      (d) => `
    <tr style="border-bottom:1px solid #E2E8F0;font-size:10.5px;">
      <td style="padding:6px 8px;font-family:monospace;font-weight:700;">${escapeHtml(d.number)}</td>
      <td style="padding:6px 8px;">${escapeHtml(formatBusinessDateFr(d.reportedDate))}</td>
      <td style="padding:6px 8px;">
        <span style="font-size:9.5px;font-weight:600;padding:1px 5px;border-radius:3px;background:${
          d.sourceType === 'PURCHASE_RECEIPT' ? '#DBEAFE;color:#1E40AF' : d.sourceType === 'CUSTOMER_RETURN' ? '#FEF3C7;color:#92400E' : '#F1F5F9;color:#334155'
        };">
          ${d.sourceType === 'PURCHASE_RECEIPT' ? '📦 Réception Achat' : d.sourceType === 'CUSTOMER_RETURN' ? '👤 Retour Client' : '🔧 Interne / SAV'}
        </span>
        ${d.sourceDocNumber ? `<div style="font-family:monospace;font-size:9px;color:#64748B;">Doc: ${escapeHtml(d.sourceDocNumber)}</div>` : ''}
        ${d.supplierName ? `<div style="font-size:9px;color:#475569;">Fourn: ${escapeHtml(d.supplierName)}</div>` : ''}
        ${d.customerName ? `<div style="font-size:9px;color:#475569;">Client: ${escapeHtml(d.customerName)}</div>` : ''}
      </td>
      <td style="padding:6px 8px;">
        <span style="font-family:monospace;font-weight:700;">${escapeHtml(d.productRef)}</span> — ${escapeHtml(d.productName)}
        <div style="font-size:9.5px;color:#B91C1C;margin-top:2px;">Motif : ${escapeHtml(d.defectReason)}</div>
      </td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace;font-weight:700;color:#DC2626;">${d.quantity}</td>
      <td style="padding:6px 8px;text-align:right;font-family:monospace;">${escapeHtml(formatMad(d.totalCostCents))}</td>
      <td style="padding:6px 8px;text-align:center;">
        <span style="padding:1px 6px;border-radius:3px;font-size:9.5px;font-weight:700;background:${
          d.status === 'EN_QUARANTAINE' ? '#FEE2E2;color:#991B1B' : d.status === 'REPARE_REMIS_EN_STOCK' ? '#D1FAE5;color:#065F46' : '#EFF6FF;color:#1E40AF'
        };">
          ${escapeHtml(statusLabels[d.status] || d.status)}
        </span>
      </td>
    </tr>
  `
    )
    .join('');

  return {
    title: 'REGISTRE DES PRODUITS DÉFECTUEUX & ARTICLES EN QUARANTAINE',
    subtitle: `${defectiveList.length} dossier(s) — ${totalQty} unité(s) — Valeur immobilisée : ${formatMad(totalCost)}`,
    filename: `Registre_Defectueux_${new Date().toISOString().slice(0, 10)}`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',-apple-system,sans-serif;color:#0F172A;padding:6px;background:#FFFFFF;">
        ${buildCompanyHeaderHtml(company, '#DC2626')}

        <div style="background:#FEF2F2;border:1px solid #FECACA;border-left:4px solid #DC2626;padding:12px 14px;border-radius:6px;margin-bottom:16px;">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
            <div>
              <div style="font-size:16px;font-weight:800;color:#DC2626;font-family:'JetBrains Mono',monospace;">
                REGISTRE DE SUIVI DES PRODUITS DÉFECTUEUX & QUARANTAINE
              </div>
              <div style="font-size:11.5px;color:#78350F;margin-top:3px;">
                Traçabilité des anomalies : Réceptions commandes fournisseurs, Retours clients défectueux et constats magasin
              </div>
              ${filterLabel ? `<div style="font-size:10.5px;color:#64748B;margin-top:2px;">Filtre appliqué : <strong>${escapeHtml(filterLabel)}</strong></div>` : ''}
            </div>
            <div style="text-align:right;font-size:11px;">
              <div>Total dossiers : <strong>${defectiveList.length}</strong></div>
              <div>Quantité totale : <strong style="color:#DC2626;">${totalQty} unité(s)</strong></div>
              <div>Valeur coût HT : <strong style="font-family:monospace;">${escapeHtml(formatMad(totalCost))}</strong></div>
            </div>
          </div>
        </div>

        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;">
          <thead>
            <tr style="background:#0F172A;color:#FFFFFF;text-align:left;font-size:10px;text-transform:uppercase;">
              <th style="padding:7px 8px;">N° Fiche</th>
              <th style="padding:7px 8px;">Date</th>
              <th style="padding:7px 8px;">Origine / Tiers</th>
              <th style="padding:7px 8px;">Article & Motif Défaut</th>
              <th style="padding:7px 8px;text-align:right;">Qté</th>
              <th style="padding:7px 8px;text-align:right;">Valeur Coût</th>
              <th style="padding:7px 8px;text-align:center;">Statut</th>
            </tr>
          </thead>
          <tbody>
            ${rows || '<tr><td colspan="7" style="padding:20px;text-align:center;color:#64748B;">Aucun produit défectueux répertorié pour ce critère.</td></tr>'}
          </tbody>
        </table>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;font-size:10px;color:#475569;border-top:1px dashed #CBD5E1;padding-top:12px;">
          <div>Document de traçabilité interne et contrôle qualité édité le ${escapeHtml(formatBusinessDateFr(new Date().toISOString().slice(0, 10)))}.</div>
          <div style="text-align:right;">Visa Responsable Stock / Qualité SAV : ____________________</div>
        </div>

        ${buildCompanyFooterHtml(company, false)}
      </div>
    `,
  };
}

/**
 * 17. BORDEREAU DE VERSEMENT BANCAIRE & REMISE D'EFFETS A4
 */
export function buildBankDepositReceiptPrint(
  company: CompanyInfo,
  deposit: BankDeposit
): PrintableDocument {
  const checkRows = deposit.checksSelected.map((c, idx) => `
    <tr style="border-bottom:1px solid #E2E8F0;font-size:11px;">
      <td style="padding:7px 8px;font-family:monospace;color:#64748B;">${idx + 1}</td>
      <td style="padding:7px 8px;font-family:monospace;font-weight:700;color:#0F172A;">${escapeHtml(c.checkNumber)}</td>
      <td style="padding:7px 8px;font-weight:600;">${escapeHtml(c.partyName || 'Client')}</td>
      <td style="padding:7px 8px;color:#475569;">${escapeHtml(c.bankName || 'Banque')}</td>
      <td style="padding:7px 8px;font-family:monospace;color:#64748B;">${escapeHtml(formatBusinessDateFr(c.date))}</td>
      <td style="padding:7px 8px;text-align:right;font-family:monospace;font-weight:700;color:#1D4ED8;">${escapeHtml(formatMad(c.amountCents))}</td>
    </tr>
  `).join('');

  const totalWords = integerToFrenchWords(Math.floor(deposit.totalDepositCents / 100)) +
    ' Dirhams' +
    (deposit.totalDepositCents % 100 > 0 ? ` et ${deposit.totalDepositCents % 100} centimes` : '');

  const isConfirmed = deposit.status === 'CONFIRMED';

  return {
    title: `Bordereau de Versement ${deposit.number}`,
    subtitle: `${deposit.bankName} — ${formatBusinessDateFr(deposit.businessDate)}`,
    filename: `Bordereau_Versement_${deposit.number}.pdf`,
    format: 'A4',
    htmlContent: `
      <div style="font-family:'Plus Jakarta Sans',sans-serif;color:#0F172A;line-height:1.45;">
        ${buildCompanyHeaderHtml(company, '#1D4ED8')}

        <div style="background:#F8FAFC;border:1px solid #CBD5E1;border-left:4px solid #1D4ED8;padding:12px 14px;border-radius:6px;margin-bottom:16px;">
          <div style="font-size:16px;font-weight:800;font-family:monospace;color:#0F172A;">
            BORDEREAU DE VERSEMENT BANCAIRE & REMISE D'EFFETS (${escapeHtml(deposit.number)})
          </div>
          <div style="font-size:11.5px;margin-top:4px;color:#475569;">
            Date d'émission : <strong>${escapeHtml(formatBusinessDateFr(deposit.businessDate))}</strong> · Établi par : <strong>${escapeHtml(deposit.preparedByUserName)}</strong>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1.5fr 1fr;gap:15px;margin-bottom:20px;font-size:11.5px;">
          <div style="background:#F8FAFC;border:1px solid #E2E8F0;border-radius:8px;padding:12px;">
            <div style="font-weight:700;color:#0F172A;margin-bottom:6px;text-transform:uppercase;font-size:10.5px;letter-spacing:0.5px;">
              Informations Bancaires de Dépôt
            </div>
            <table style="width:100%;font-size:11px;border-collapse:collapse;">
              <tr>
                <td style="padding:2px 0;color:#64748B;width:130px;">Banque Réceptrice :</td>
                <td style="padding:2px 0;font-weight:700;color:#1D4ED8;font-size:12px;">${escapeHtml(deposit.bankName)}</td>
              </tr>
              ${deposit.bankAccountNumber ? `
              <tr>
                <td style="padding:2px 0;color:#64748B;">Compte / RIB :</td>
                <td style="padding:2px 0;font-family:monospace;font-weight:600;">${escapeHtml(deposit.bankAccountNumber)}</td>
              </tr>` : ''}
              <tr>
                <td style="padding:2px 0;color:#64748B;">Réf. Reçu Banque :</td>
                <td style="padding:2px 0;font-family:monospace;font-weight:600;">${escapeHtml(deposit.reference || 'En cours d\'acheminement')}</td>
              </tr>
              <tr>
                <td style="padding:2px 0;color:#64748B;">Opérateur Déposant :</td>
                <td style="padding:2px 0;font-weight:600;">${escapeHtml(deposit.preparedByUserName)}</td>
              </tr>
              ${deposit.notes ? `
              <tr>
                <td style="padding:2px 0;color:#64748B;">Observations :</td>
                <td style="padding:2px 0;color:#334155;">${escapeHtml(deposit.notes)}</td>
              </tr>` : ''}
            </table>
          </div>

          <div style="background:${isConfirmed ? '#F0FDF4' : '#FFFBEB'};border:1px solid ${isConfirmed ? '#BBF7D0' : '#FDE68A'};border-radius:8px;padding:12px;">
            <div style="font-weight:700;color:${isConfirmed ? '#166534' : '#92400E'};margin-bottom:6px;text-transform:uppercase;font-size:10.5px;">
              Statut du Versement
            </div>
            <div style="font-size:14px;font-weight:800;color:${isConfirmed ? '#15803D' : '#D97706'};">
              ${isConfirmed ? '✓ VERSEMENT EFFECTUÉ ET CONFIRMÉ' : '⏳ EN COURS DE REMISE (PRÉPARÉ)'}
            </div>
            <div style="font-size:10.5px;color:#64748B;margin-top:6px;line-height:1.35;">
              ${isConfirmed && deposit.confirmedAt
                ? `Confirmé au retour de la banque le ${escapeHtml(formatBusinessDateFr(deposit.confirmedAt.slice(0, 10)))}. La caisse physique a été débitée.`
                : 'Bordereau officiel d\'accompagnement des fonds pour dépôt en agence bancaire.'}
            </div>
          </div>
        </div>

        <!-- Section 1 : Détail Espèces -->
        <div style="margin-bottom:18px;">
          <div style="font-weight:700;font-size:12px;color:#0F172A;text-transform:uppercase;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
            <span style="background:#0F172A;color:#FFFFFF;padding:2px 6px;border-radius:3px;font-size:10px;">1</span>
            Détail du Versement en Espèces (Caisse Physique)
          </div>
          <table style="width:100%;border-collapse:collapse;border:1px solid #E2E8F0;font-size:11px;">
            <tr style="background:#F8FAFC;border-bottom:1px solid #E2E8F0;">
              <th style="padding:7px 10px;text-align:left;color:#475569;">Désignation</th>
              <th style="padding:7px 10px;text-align:right;color:#475569;">Montant (MAD)</th>
            </tr>
            <tr style="border-bottom:1px solid #E2E8F0;">
              <td style="padding:8px 10px;color:#64748B;">Solde théorique en caisse avant versement :</td>
              <td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:600;">${escapeHtml(formatMad(deposit.cashAvailableCents))}</td>
            </tr>
            <tr style="border-bottom:1px solid #E2E8F0;background:#EFF6FF;">
              <td style="padding:8px 10px;font-weight:700;color:#1D4ED8;">Montant en Espèces versé à la Banque :</td>
              <td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:800;color:#1D4ED8;font-size:13px;">${escapeHtml(formatMad(deposit.cashToDepositCents))}</td>
            </tr>
            <tr style="background:#F8FAFC;">
              <td style="padding:8px 10px;font-weight:600;color:#059669;">Solde restant laissé en caisse (Fond de roulement conservé) :</td>
              <td style="padding:8px 10px;text-align:right;font-family:monospace;font-weight:700;color:#059669;font-size:12px;">${escapeHtml(formatMad(deposit.cashRemainingInRegisterCents))}</td>
            </tr>
          </table>
        </div>

        <!-- Section 2 : Détail Chèques -->
        <div style="margin-bottom:18px;">
          <div style="font-weight:700;font-size:12px;color:#0F172A;text-transform:uppercase;margin-bottom:8px;display:flex;align-items:center;gap:6px;">
            <span style="background:#0F172A;color:#FFFFFF;padding:2px 6px;border-radius:3px;font-size:10px;">2</span>
            Bordereau de Remise de Chèques (${deposit.checksSelected.length} chèque(s))
          </div>
          ${deposit.checksSelected.length > 0 ? `
            <table style="width:100%;border-collapse:collapse;border:1px solid #E2E8F0;font-size:11px;margin-bottom:6px;">
              <thead>
                <tr style="background:#0F172A;color:#FFFFFF;text-align:left;font-size:10px;text-transform:uppercase;">
                  <th style="padding:6px 8px;width:30px;">N°</th>
                  <th style="padding:6px 8px;">N° Chèque</th>
                  <th style="padding:6px 8px;">Émetteur / Client</th>
                  <th style="padding:6px 8px;">Banque Tirée</th>
                  <th style="padding:6px 8px;">Date</th>
                  <th style="padding:6px 8px;text-align:right;">Montant (MAD)</th>
                </tr>
              </thead>
              <tbody>
                ${checkRows}
                <tr style="background:#F1F5F9;font-weight:700;border-top:2px solid #CBD5E1;">
                  <td colspan="5" style="padding:7px 8px;text-align:right;text-transform:uppercase;font-size:10px;">Sous-total Chèques Remis :</td>
                  <td style="padding:7px 8px;text-align:right;font-family:monospace;color:#1D4ED8;font-size:12px;">${escapeHtml(formatMad(deposit.totalChecksCents))}</td>
                </tr>
              </tbody>
            </table>
          ` : `
            <div style="padding:10px 14px;background:#F8FAFC;border:1px dashed #CBD5E1;border-radius:6px;font-size:11px;color:#64748B;">
              Aucun chèque inclus dans cette remise (remise 100% en espèces).
            </div>
          `}
        </div>

        <!-- Récapitulatif Total Général -->
        <div style="background:#0F172A;color:#FFFFFF;border-radius:8px;padding:14px 18px;margin-bottom:24px;display:flex;justify-content:between;align-items:center;">
          <div>
            <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#94A3B8;">
              Montant Total de la Remise en Banque (Espèces + Chèques)
            </div>
            <div style="font-size:11px;font-style:italic;color:#E2E8F0;margin-top:3px;">
              Arrêté à la somme de : <strong style="color:#D9A95B;">${escapeHtml(totalWords)}</strong>.
            </div>
          </div>
          <div style="text-align:right;">
            <div style="font-family:monospace;font-size:20px;font-weight:800;color:#D9A95B;">
              ${escapeHtml(formatMad(deposit.totalDepositCents))}
            </div>
          </div>
        </div>

        <!-- Cadre de Signatures Tripartite -->
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:20px;">
          <div style="border:1px solid #CBD5E1;border-radius:6px;padding:10px;min-height:90px;font-size:10px;">
            <div style="font-weight:700;color:#334155;">Visa Caissier / Déposant :</div>
            <div style="color:#64748B;font-size:9.5px;margin-top:2px;">${escapeHtml(deposit.preparedByUserName)}</div>
            <div style="margin-top:40px;border-top:1px dashed #E2E8F0;padding-top:3px;color:#94A3B8;">Signature & Date</div>
          </div>
          <div style="border:1px solid #CBD5E1;border-radius:6px;padding:10px;min-height:90px;font-size:10px;">
            <div style="font-weight:700;color:#334155;">Visa Responsable Financier / Gérance :</div>
            <div style="color:#64748B;font-size:9.5px;margin-top:2px;">Contrôle et autorisation</div>
            <div style="margin-top:40px;border-top:1px dashed #E2E8F0;padding-top:3px;color:#94A3B8;">Cachet et Signature</div>
          </div>
          <div style="border:1px solid #CBD5E1;border-radius:6px;padding:10px;min-height:90px;font-size:10px;background:#F8FAFC;">
            <div style="font-weight:700;color:#1D4ED8;">Accusé de Réception / Banque :</div>
            <div style="color:#64748B;font-size:9.5px;margin-top:2px;">Tampon guichet & dateur</div>
            <div style="margin-top:40px;border-top:1px dashed #CBD5E1;padding-top:3px;color:#94A3B8;">Signature Guichetier / Caissier Banque</div>
          </div>
        </div>

        ${buildCompanyFooterHtml(company, false)}
      </div>
    `,
  };
}

/**
 * Génère une page HTML autonome complète prête pour l'impression A4 / Ticket 80mm ou l'enregistrement PDF
 */
export function buildStandalonePrintableHtml(doc: PrintableDocument): string {
  const isTicket = doc.format === 'TICKET_80MM';
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <title>${escapeHtml(doc.filename || doc.title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@600;700&family=JetBrains+Mono:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    html, body {
      margin: 0;
      padding: 0;
      background: #FFFFFF;
      color: #000000;
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
    }
    @page {
      size: ${isTicket ? '80mm auto' : 'A4 portrait'};
      margin: ${isTicket ? '4mm' : '10mm'};
    }
    .print-container {
      width: ${isTicket ? '76mm' : '100%'};
      max-width: ${isTicket ? '76mm' : '190mm'};
      margin: 0 auto;
    }
    .print-container table {
      background-color: transparent !important;
    }
    .print-container table thead tr {
      background-color: transparent !important;
      color: #000000 !important;
      border-top: 1.5px solid #000000 !important;
      border-bottom: 2px solid #000000 !important;
    }
    .print-container table thead th {
      color: #000000 !important;
      background-color: transparent !important;
      font-weight: 800 !important;
    }
  </style>
</head>
<body>
  <div class="print-container">
    ${doc.htmlContent}
  </div>
</body>
</html>`;
}
