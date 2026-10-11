import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  ArrowUpDown,
  Ban,
  CheckCircle2,
  FileText,
  Plus,
  Printer,
  RotateCcw,
  Trash2,
  Wallet,
} from 'lucide-react';
import { db } from '../db/database';
import { ArbitrageError } from '../domain/arbitrageEngine';
import {
  calculateDocumentLinesAndTotals,
  centsToDh,
  dhToCents,
  DocumentLineInput,
  formatMad,
} from '../domain/financialEngine';
import {
  buildDeliveryNoteA4Print,
  buildInvoiceA4Print,
  buildQuoteA4Print,
  buildSalesPeriodReportPrint,
  buildTicket80mmPrint,
  PrintableDocument,
} from '../printing/printTemplates';
import {
  executeAttemptModifyValidatedDocument,
  executeAttemptPhysicalDeleteDocument,
  executeCancelSale,
  executeConvertQuoteToSale,
  executeCreateQuote,
  executeCustomerReturn,
  executeRecordInvoicePayment,
} from '../services/commandService';
import {
  AppSettings,
  CompanyInfo,
  Customer,
  Invoice,
  Payment,
  PaymentMethod,
  Product,
  Quote,
  Sale,
  SaleItem,
  UserProfile,
} from '../types/domain';
import {
  addDaysToBusinessDate,
  formatBusinessDateFr,
  getMoroccoBusinessDate,
} from '../utils/dateUtils';
import { hasPermission } from '../utils/securityUtils';

/**
 * SECTION 16 : HISTORIQUE ET GESTION DES VENTES (Règles 2, 8, 9 & 12)
 */
export const SalesView: React.FC<{
  company: CompanyInfo;
  currentProfile: UserProfile | null;
  refreshTrigger: number;
  onChanged: () => void;
  onOpenPrintPreview: (doc: PrintableDocument) => void;
}> = ({ company, currentProfile, refreshTrigger, onChanged, onOpenPrintPreview }) => {
  const today = getMoroccoBusinessDate();
  const [sales, setSales] = useState<Sale[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [saleSortBy, setSaleSortBy] = useState<
    'DATE_DESC' | 'DATE_ASC' | 'TOTAL_DESC' | 'TOTAL_ASC' | 'DUE_DESC' | 'CUSTOMER_ASC'
  >('DATE_DESC');
  const [startDate, setStartDate] = useState<string>(addDaysToBusinessDate(today, -30));
  const [endDate, setEndDate] = useState<string>(today);
  const [selectedSale, setSelectedSale] = useState<Sale | null>(null);
  const [selectedItems, setSelectedItems] = useState<SaleItem[]>([]);

  // Modales d'action
  const [cancelModalSale, setCancelModalSale] = useState<Sale | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [returnModalSale, setReturnModalSale] = useState<Sale | null>(null);
  const [returnQuantities, setReturnQuantities] = useState<Record<string, number>>({});
  const [returnDefectiveFlags, setReturnDefectiveFlags] = useState<Record<string, boolean>>({});
  const [returnDefectReasons, setReturnDefectReasons] = useState<Record<string, string>>({});
  const [returnRefundMethod, setReturnRefundMethod] = useState<'CASH' | 'TRANSFER' | 'CREDIT_NOTE'>(
    'CASH'
  );
  const [returnReason, setReturnReason] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    db.sales.orderBy('createdAt').reverse().toArray().then(setSales);
  }, [refreshTrigger]);

  const loadSaleDetails = async (sale: Sale) => {
    setSelectedSale(sale);
    const items = await db.saleItems.where('saleId').equals(sale.id).toArray();
    setSelectedItems(items);
  };

  const handlePrintTicket = async (sale: Sale) => {
    const items = await db.saleItems.where('saleId').equals(sale.id).toArray();
    onOpenPrintPreview(buildTicket80mmPrint(company, sale, items));
  };

  const handlePrintDeliveryNote = async (sale: Sale) => {
    const items = await db.saleItems.where('saleId').equals(sale.id).toArray();
    onOpenPrintPreview(buildDeliveryNoteA4Print(company, sale, items));
  };

  const handlePrintInvoice = async (sale: Sale) => {
    if (!sale.invoiceId) return;
    const inv = await db.invoices.get(sale.invoiceId);
    if (!inv) return;
    const items = await db.invoiceItems.where('invoiceId').equals(inv.id).toArray();
    onOpenPrintPreview(buildInvoiceA4Print(company, inv, items));
  };

  const handleConfirmCancel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelModalSale) return;
    setFeedback(null);
    try {
      await executeCancelSale({
        saleId: cancelModalSale.id,
        reason: cancelReason,
        actor: currentProfile
          ? {
              userId: currentProfile.id,
              userName: currentProfile.name,
              userRole: currentProfile.role,
            }
          : undefined,
      });
      setCancelModalSale(null);
      setCancelReason('');
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Vente ${cancelModalSale.number} annulée conformément à la Règle 2 : historique conservé, stock restitué, contre-écriture financière et sortie caisse générées.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const openReturnModal = async (sale: Sale) => {
    const items = await db.saleItems.where('saleId').equals(sale.id).toArray();
    setSelectedItems(items);
    const initMap: Record<string, number> = {};
    items.forEach((i) => {
      initMap[i.id] = 0;
    });
    setReturnQuantities(initMap);
    setReturnDefectiveFlags({});
    setReturnDefectReasons({});
    setReturnReason('Retour marchandise client');
    setReturnModalSale(sale);
  };

  const handleConfirmReturn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!returnModalSale) return;
    setFeedback(null);
    try {
      let hasDefective = false;
      const itemsToReturn = Object.entries(returnQuantities)
        .filter(([, q]) => q > 0)
        .map(([saleItemId, returnQty]) => {
          const isDef = !!returnDefectiveFlags[saleItemId];
          if (isDef) hasDefective = true;
          return {
            saleItemId,
            returnQty,
            isDefective: isDef,
            defectReason: returnDefectReasons[saleItemId]?.trim() || returnReason,
          };
        });

      const res = await executeCustomerReturn({
        saleId: returnModalSale.id,
        itemsToReturn,
        refundMethod: returnRefundMethod,
        reason: returnReason,
      });

      setReturnModalSale(null);
      onChanged();
      setFeedback({
        type: 'success',
        msg: hasDefective
          ? `Retour client enregistré (Règle 12) : Avoir ${res.creditNote.number} créé. Les articles sains ont été réintégrés en stock, et les articles défectueux ont été isolés en Quarantaine (fiche de suivi créée).`
          : `Retour client enregistré (Règle 12) : Avoir ${res.creditNote.number} créé, stock réintégré et solde client mis à jour.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleAttemptPhysicalDelete = async (sale: Sale) => {
    try {
      await executeAttemptPhysicalDeleteDocument({
        entityType: 'SALE',
        entityId: sale.id,
      });
    } catch (err) {
      if (err instanceof ArbitrageError) {
        setFeedback({ type: 'error', msg: err.decision.resolutionMessage });
      }
    }
  };

  const handleAttemptDirectEdit = async (sale: Sale) => {
    try {
      await executeAttemptModifyValidatedDocument({
        entityType: 'SALE',
        entityId: sale.id,
        documentNumber: sale.number,
      });
    } catch (err) {
      if (err instanceof ArbitrageError) {
        setFeedback({ type: 'error', msg: err.decision.resolutionMessage });
      }
    }
  };

  const filtered = sales
    .filter((s) => {
      if (startDate && s.businessDate < startDate) return false;
      if (endDate && s.businessDate > endDate) return false;
      if (statusFilter !== 'ALL' && s.status !== statusFilter) return false;
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        s.number.toLowerCase().includes(q) ||
        s.customerName.toLowerCase().includes(q) ||
        s.sellerName.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      switch (saleSortBy) {
        case 'DATE_DESC':
          return b.createdAt.localeCompare(a.createdAt);
        case 'DATE_ASC':
          return a.createdAt.localeCompare(b.createdAt);
        case 'TOTAL_DESC':
          return b.totalTtcCents - a.totalTtcCents;
        case 'TOTAL_ASC':
          return a.totalTtcCents - b.totalTtcCents;
        case 'DUE_DESC':
          return b.remainingDueCents - a.remainingDueCents;
        case 'CUSTOMER_ASC':
          return a.customerName.localeCompare(b.customerName, 'fr');
        default:
          return 0;
      }
    });

  const activePeriodSales = filtered.filter((s) => s.status !== 'CANCELLED');
  const periodTotalHt = activePeriodSales.reduce((acc, s) => acc + s.totalTaxableCents, 0);
  const periodTotalTtc = activePeriodSales.reduce((acc, s) => acc + s.totalTtcCents, 0);
  const periodTotalPaid = activePeriodSales.reduce((acc, s) => acc + s.paidCents, 0);
  const periodTotalDue = activePeriodSales.reduce((acc, s) => acc + s.remainingDueCents, 0);

  const canCancel = hasPermission(currentProfile?.role, 'CANCEL_SALES');

  return (
    <div className="space-y-5">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              Journal & État des Ventes par Période
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Règles 2, 8, 9 & 12 : Aucune suppression physique · Annulation avec contre-écriture ·
              Retours liés à la vente d&apos;origine
            </p>
          </div>

          <button
            type="button"
            onClick={() =>
              onOpenPrintPreview(
                buildSalesPeriodReportPrint(
                  company,
                  filtered,
                  startDate || '2020-01-01',
                  endDate || today
                )
              )
            }
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#1D4ED8] text-white text-xs font-semibold rounded-md hover:bg-blue-800 transition-colors shadow-xs"
          >
            <Printer className="w-4 h-4" />
            Imprimer / PDF État des Ventes ({filtered.length})
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-600 dark:text-slate-300">Période :</span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-2.5 py-1 font-mono border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
            />
            <span className="text-slate-500">au</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-2.5 py-1 font-mono border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
            />
            <div className="inline-flex items-center gap-1 ml-1">
              <button
                type="button"
                onClick={() => {
                  setStartDate(today);
                  setEndDate(today);
                }}
                className="px-2 py-1 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Aujourd&apos;hui
              </button>
              <button
                type="button"
                onClick={() => {
                  setStartDate(addDaysToBusinessDate(today, -7));
                  setEndDate(today);
                }}
                className="px-2 py-1 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                7 jours
              </button>
              <button
                type="button"
                onClick={() => {
                  setStartDate(addDaysToBusinessDate(today, -30));
                  setEndDate(today);
                }}
                className="px-2 py-1 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                30 jours
              </button>
              <button
                type="button"
                onClick={() => {
                  setStartDate('2020-01-01');
                  setEndDate(today);
                }}
                className="px-2 py-1 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Tout afficher
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="N° vente, client, vendeur..."
              className="px-3 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
            />
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-3 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
            >
              <option value="ALL">Tous les statuts ({sales.length})</option>
              <option value="VALIDATED">Validées</option>
              <option value="PARTIAL_RETURN">Retour partiel</option>
              <option value="RETURNED">Retournées</option>
              <option value="CANCELLED">Annulées</option>
            </select>
            <div className="flex items-center gap-1.5">
              <ArrowUpDown className="w-3.5 h-3.5 text-[#1D4ED8]" />
              <span className="font-semibold text-slate-700 dark:text-slate-200">Trier par :</span>
              <select
                value={saleSortBy}
                onChange={(e) => setSaleSortBy(e.target.value as typeof saleSortBy)}
                className="px-2.5 py-1.5 text-xs border border-blue-300 bg-blue-50/40 rounded-md font-medium text-slate-900"
              >
                <option value="DATE_DESC">Date (Plus récent → Plus ancien)</option>
                <option value="DATE_ASC">Date (Plus ancien → Plus récent)</option>
                <option value="TOTAL_DESC">Total TTC (Décroissant ↓)</option>
                <option value="TOTAL_ASC">Total TTC (Croissant ↑)</option>
                <option value="DUE_DESC">Reste Dû (Décroissant ↓)</option>
                <option value="CUSTOMER_ASC">Client (A → Z)</option>
              </select>
            </div>
          </div>
        </div>

        {/* Synthèse de la période sélectionnée */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2">
          <div className="p-2.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
            <div className="text-[11px] text-slate-500">CA Période HT ({activePeriodSales.length} ventes)</div>
            <div className="font-mono-tabular font-bold text-sm text-slate-900 dark:text-white mt-0.5">
              {formatMad(periodTotalHt)}
            </div>
          </div>
          <div className="p-2.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
            <div className="text-[11px] text-slate-500">CA Période TTC</div>
            <div className="font-mono-tabular font-bold text-sm text-[#1D4ED8] dark:text-blue-400 mt-0.5">
              {formatMad(periodTotalTtc)}
            </div>
          </div>
          <div className="p-2.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
            <div className="text-[11px] text-slate-500">Total Encaissé sur Période</div>
            <div className="font-mono-tabular font-bold text-sm text-emerald-700 dark:text-emerald-400 mt-0.5">
              {formatMad(periodTotalPaid)}
            </div>
          </div>
          <div className="p-2.5 rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
            <div className="text-[11px] text-slate-500">Reste Dû (Crédit Période)</div>
            <div className="font-mono-tabular font-bold text-sm text-amber-800 dark:text-amber-400 mt-0.5">
              {formatMad(periodTotalDue)}
            </div>
          </div>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-md border text-xs flex items-start justify-between gap-3 ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
              : 'bg-red-50 border-red-300 text-red-900'
          }`}
        >
          <span>{feedback.msg}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-xs underline shrink-0"
          >
            Fermer
          </button>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 text-slate-600 text-left">
                <th className="py-3 px-4 font-semibold">N° Vente</th>
                <th className="py-3 px-4 font-semibold">Date Métier</th>
                <th className="py-3 px-4 font-semibold">Client</th>
                <th className="py-3 px-4 font-semibold">Mode</th>
                <th className="py-3 px-4 font-semibold text-right">Total HT</th>
                <th className="py-3 px-4 font-semibold text-right">Total TTC</th>
                <th className="py-3 px-4 font-semibold text-right">Payé</th>
                <th className="py-3 px-4 font-semibold text-right">Reste dû</th>
                <th className="py-3 px-4 font-semibold">Statut</th>
                <th className="py-3 px-4 font-semibold text-right">Actions Métier</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50/80">
                  <td className="py-3 px-4 font-mono font-semibold text-slate-900">
                    {s.number}
                    {s.quoteId && (
                      <span className="block text-[10px] text-blue-700 font-normal">
                        Issu d&apos;un devis
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 font-mono-tabular">
                    {formatBusinessDateFr(s.businessDate)}
                  </td>
                  <td className="py-3 px-4 font-medium text-slate-900">{s.customerName}</td>
                  <td className="py-3 px-4 font-mono text-[11px]">{s.paymentMethodSummary}</td>
                  <td className="py-3 px-4 text-right font-mono-tabular">
                    {formatMad(s.totalTaxableCents)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular font-semibold">
                    {formatMad(s.totalTtcCents)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-emerald-700">
                    {formatMad(s.paidCents)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-amber-800">
                    {formatMad(s.remainingDueCents)}
                  </td>
                  <td className="py-3 px-4">
                    <span
                      className={`font-mono text-[11px] font-semibold ${
                        s.status === 'CANCELLED'
                          ? 'text-red-700 line-through'
                          : s.status === 'VALIDATED'
                          ? 'text-emerald-700'
                          : 'text-amber-700'
                      }`}
                    >
                      {s.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => loadSaleDetails(s)}
                      className="px-2 py-1 border border-slate-300 rounded hover:bg-slate-100 text-slate-700"
                    >
                      Détails
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePrintTicket(s)}
                      className="px-2 py-1 border border-slate-300 rounded hover:bg-slate-100 text-slate-700"
                      title="Ticket 80mm"
                    >
                      Ticket
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePrintDeliveryNote(s)}
                      className="px-2 py-1 border border-slate-300 rounded hover:bg-slate-100 text-slate-700"
                      title="Bon de Livraison A4"
                    >
                      BL
                    </button>
                    <button
                      type="button"
                      onClick={() => handlePrintInvoice(s)}
                      className="px-2 py-1 border border-slate-300 rounded hover:bg-slate-100 text-slate-700"
                      title="Facture A4"
                    >
                      Facture
                    </button>
                    {s.status !== 'CANCELLED' && s.status !== 'RETURNED' && (
                      <button
                        type="button"
                        onClick={() => openReturnModal(s)}
                        className="px-2 py-1 border border-amber-300 bg-amber-50 text-amber-900 rounded hover:bg-amber-100"
                      >
                        Retour
                      </button>
                    )}
                    {s.status !== 'CANCELLED' && canCancel && (
                      <button
                        type="button"
                        onClick={() => {
                          setCancelModalSale(s);
                          setCancelReason('');
                        }}
                        className="px-2 py-1 border border-red-300 bg-red-50 text-red-800 rounded hover:bg-red-100"
                      >
                        Annuler
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleAttemptDirectEdit(s)}
                      className="px-2 py-1 text-slate-400 hover:text-slate-700"
                      title="Tester le blocage de modification directe (Règle 9)"
                    >
                      Éditer
                    </button>
                    <button
                      type="button"
                      onClick={() => handleAttemptPhysicalDelete(s)}
                      className="px-2 py-1 text-slate-400 hover:text-red-700"
                      title="Tester l'interdiction de suppression physique (Règle 8)"
                    >
                      <Trash2 className="w-3.5 h-3.5 inline" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Détail des lignes d'une vente sélectionnée */}
      {selectedSale && (
        <div className="bg-white border border-slate-300 rounded-lg p-5 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-bold text-slate-900">
                Détail de la vente {selectedSale.number} — {selectedSale.customerName}
              </h3>
              <p className="text-xs text-slate-500">
                Facture liée ID : {selectedSale.invoiceId || 'Aucune'} · Devis source ID :{' '}
                {selectedSale.quoteId || 'Vente directe'}
                {selectedSale.cancelReason && ` · Motif annulation : ${selectedSale.cancelReason}`}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedSale(null)}
              className="text-xs text-slate-500 hover:text-slate-900"
            >
              Fermer le détail
            </button>
          </div>
          <table className="w-full text-xs border-t border-slate-200">
            <thead>
              <tr className="text-left text-slate-500 border-b border-slate-200">
                <th className="py-2">Réf.</th>
                <th className="py-2">Désignation</th>
                <th className="py-2 text-right">Qté vendue</th>
                <th className="py-2 text-right">Qté retournée</th>
                <th className="py-2 text-right">P.U HT</th>
                <th className="py-2 text-right">Rem. Ligne</th>
                <th className="py-2 text-right">TVA</th>
                <th className="py-2 text-right">Total TTC</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {selectedItems.map((item) => (
                <tr key={item.id}>
                  <td className="py-2 font-mono">{item.productRef}</td>
                  <td className="py-2 font-medium">{item.productName}</td>
                  <td className="py-2 text-right font-mono-tabular">{item.quantity}</td>
                  <td className="py-2 text-right font-mono-tabular text-amber-700">
                    {item.returnedQty}
                  </td>
                  <td className="py-2 text-right font-mono-tabular">
                    {formatMad(item.unitPriceHtCents)}
                  </td>
                  <td className="py-2 text-right font-mono-tabular">{item.discountPercent}%</td>
                  <td className="py-2 text-right font-mono-tabular">{item.vatRate}%</td>
                  <td className="py-2 text-right font-mono-tabular font-semibold">
                    {formatMad(item.lineTtcCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Modale d'annulation de vente payée (Règle 2) */}
      {cancelModalSale && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmCancel}
            className="bg-white border border-slate-300 rounded-lg max-w-md w-full p-6 space-y-4"
          >
            <div className="flex items-center gap-2 text-red-700">
              <Ban className="w-5 h-5" />
              <h3 className="text-base font-bold">
                Annuler la vente {cancelModalSale.number} (Règle 2)
              </h3>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Conformément à la Règle Métier 2, cette vente ne sera pas supprimée physiquement :
              le stock sera restitué, les paiements ({formatMad(cancelModalSale.paidCents)}) feront
              l&apos;objet d&apos;une contre-écriture automatique et la caisse sera régularisée.
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1">
                Motif d&apos;annulation obligatoire (Journal d&apos;audit) *
              </label>
              <input
                type="text"
                required
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder="Ex: Erreur de facturation / Désistement client..."
                className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCancelModalSale(null)}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded-md"
              >
                Fermer
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs bg-red-700 text-white font-medium rounded-md hover:bg-red-800"
              >
                Confirmer l&apos;annulation et contre-passer
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modale de retour client (Règle 12) */}
      {returnModalSale && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmReturn}
            className="bg-white border border-slate-300 rounded-lg max-w-lg w-full p-6 space-y-4"
          >
            <div className="flex items-center gap-2 text-amber-800">
              <RotateCcw className="w-5 h-5" />
              <h3 className="text-base font-bold">
                Retour Client rattaché à {returnModalSale.number} (Règle 12)
              </h3>
            </div>
            <div className="space-y-2.5 max-h-64 overflow-y-auto border border-slate-200 rounded p-3">
              {selectedItems.map((item) => {
                const maxRet = item.quantity - item.returnedQty;
                const retQty = returnQuantities[item.id] ?? 0;
                const isDef = !!returnDefectiveFlags[item.id];

                return (
                  <div
                    key={item.id}
                    className="p-2 border border-slate-100 rounded-md bg-slate-50/50 space-y-1.5"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <div>
                        <div className="font-semibold text-slate-900">{item.productName}</div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          Vendu : {item.quantity} · Déjà retourné : {item.returnedQty} · Retournable :{' '}
                          <strong>{maxRet}</strong>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-slate-600 font-medium">À retourner :</span>
                        <input
                          type="number"
                          min={0}
                          max={maxRet}
                          value={returnQuantities[item.id] ?? 0}
                          onChange={(e) =>
                            setReturnQuantities({
                              ...returnQuantities,
                              [item.id]: Math.max(
                                0,
                                Math.min(maxRet, parseInt(e.target.value, 10) || 0)
                              ),
                            })
                          }
                          className="w-16 px-2 py-1 text-right font-mono border border-slate-300 rounded font-bold bg-white"
                        />
                      </div>
                    </div>

                    {retQty > 0 && (
                      <div className="pt-1.5 border-t border-slate-200 text-[11px] space-y-1">
                        <label className="flex items-center gap-1.5 text-amber-900 font-medium cursor-pointer">
                          <input
                            type="checkbox"
                            checked={isDef}
                            onChange={(e) =>
                              setReturnDefectiveFlags({
                                ...returnDefectiveFlags,
                                [item.id]: e.target.checked,
                              })
                            }
                            className="rounded border-slate-300 text-amber-700 focus:ring-amber-500"
                          />
                          <span>
                            Article constaté défectueux par le client{' '}
                            <strong className="text-amber-800">
                              (Isoler en Quarantaine — ne pas remettre en stock vendable)
                            </strong>
                          </span>
                        </label>

                        {isDef && (
                          <input
                            type="text"
                            placeholder="Motif précis du défaut / panne (ex: fuite membrane, moteur brûlé, odeur...)"
                            value={returnDefectReasons[item.id] ?? ''}
                            onChange={(e) =>
                              setReturnDefectReasons({
                                ...returnDefectReasons,
                                [item.id]: e.target.value,
                              })
                            }
                            className="w-full px-2 py-1 border border-amber-300 rounded bg-white text-xs placeholder:text-slate-400"
                          />
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Mode de régularisation financière
                </label>
                <select
                  value={returnRefundMethod}
                  onChange={(e) =>
                    setReturnRefundMethod(
                      e.target.value as 'CASH' | 'TRANSFER' | 'CREDIT_NOTE'
                    )
                  }
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                >
                  <option value="CASH">Remboursement Espèces (Caisse)</option>
                  <option value="TRANSFER">Remboursement Virement (Banque)</option>
                  <option value="CREDIT_NOTE">Conserver en Avoir Client</option>
                </select>
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Motif du retour</label>
                <input
                  type="text"
                  required
                  value={returnReason}
                  onChange={(e) => setReturnReason(e.target.value)}
                  className="w-full px-2.5 py-1.5 border border-slate-300 rounded"
                />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setReturnModalSale(null)}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs bg-amber-700 text-white font-medium rounded hover:bg-amber-800"
              >
                Valider le retour & générer l&apos;avoir
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

/**
 * SECTION 17 : MODULE DEVIS & CONVERSION EN VENTE (Règle 5)
 */
export const QuotesView: React.FC<{
  company: CompanyInfo;
  refreshTrigger: number;
  onChanged: () => void;
  onOpenPrintPreview: (doc: PrintableDocument) => void;
}> = ({ company, refreshTrigger, onChanged, onOpenPrintPreview }) => {
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const [customerId, setCustomerId] = useState('');
  const [selectedProductId, setSelectedProductId] = useState('');
  const [qty, setQty] = useState(1);
  const [draftLines, setDraftLines] = useState<DocumentLineInput[]>([]);
  const [globalDiscount, setGlobalDiscount] = useState(0);
  const [globalDiscountAmountCents, setGlobalDiscountAmountCents] = useState<number | undefined>(
    undefined
  );
  const [globalDiscountAmountInput, setGlobalDiscountAmountInput] = useState('');
  const [notes, setNotes] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      db.quotes.orderBy('createdAt').reverse().toArray(),
      db.customers.filter((c) => c.active).toArray(),
      db.products.filter((p) => p.active).toArray(),
    ]).then(([qList, cList, pList]) => {
      setQuotes(qList);
      setCustomers(cList);
      setProducts(pList);
      if (cList[0] && !customerId) setCustomerId(cList[0].id);
      if (pList[0] && !selectedProductId) setSelectedProductId(pList[0].id);
    });
  }, [refreshTrigger, customerId, selectedProductId]);

  const addDraftLine = () => {
    const prod = products.find((p) => p.id === selectedProductId);
    if (!prod) return;
    setDraftLines((prev) => [
      ...prev,
      {
        productId: prod.id,
        productRef: prod.reference,
        productName: prod.name,
        quantity: Math.max(1, qty),
        unitPriceHtCents: prod.salePriceHtCents,
        discountPercent: 0,
        vatRate: prod.vatRate,
      },
    ]);
  };

  const draftCalc = calculateDocumentLinesAndTotals(
    draftLines,
    globalDiscount,
    globalDiscountAmountCents
  );

  const handleSaveQuote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (draftLines.length === 0) return;
    try {
      const q = await executeCreateQuote({
        customerId,
        lines: draftLines,
        globalDiscountPercent: draftCalc.globalDiscountPercent,
        globalDiscountAmountCents:
          draftCalc.globalDiscountCents > 0 ? draftCalc.globalDiscountCents : undefined,
        notes,
      });
      setDraftLines([]);
      setGlobalDiscount(0);
      setGlobalDiscountAmountCents(undefined);
      setGlobalDiscountAmountInput('');
      setShowCreate(false);
      onChanged();
      setFeedback(
        `Devis ${q.number} créé avec succès (Règle 5 : aucun impact sur le stock avant conversion).`
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConvert = async (quote: Quote) => {
    try {
      const res = await executeConvertQuoteToSale({
        quoteId: quote.id,
        paymentMethod: 'CASH',
        amountPaidCents: quote.totalTtcCents,
      });
      onChanged();
      setFeedback(
        `Devis ${quote.number} converti en Vente ${res.sale.number} -> Facture ${res.invoice.number} avec déduction atomique du stock.`
      );
    } catch (err) {
      if (err instanceof ArbitrageError) {
        setFeedback(err.decision.resolutionMessage);
      } else {
        setFeedback(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const handlePrint = async (quote: Quote) => {
    const items = await db.quoteItems.where('quoteId').equals(quote.id).toArray();
    onOpenPrintPreview(buildQuoteA4Print(company, quote, items));
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            Devis & Offres Commerciales
          </h1>
          <p className="text-xs text-slate-500">
            Règle 5 : La création d&apos;un devis ne modifie pas le stock réel · Lien explicite
            Devis → Vente → Facture → Paiement
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[#0F172A] text-white text-xs font-medium rounded-md hover:bg-slate-800"
        >
          <Plus className="w-4 h-4" />
          Nouveau Devis Proforma
        </button>
      </div>

      {feedback && (
        <div className="p-3 bg-blue-50 border border-blue-200 text-blue-900 rounded-md text-xs flex justify-between">
          <span>{feedback}</span>
          <button type="button" onClick={() => setFeedback(null)} className="underline">
            Fermer
          </button>
        </div>
      )}

      {showCreate && (
        <form
          onSubmit={handleSaveQuote}
          className="bg-white border border-slate-300 rounded-lg p-5 space-y-4 text-xs"
        >
          <h3 className="text-sm font-bold text-slate-900">Créer un Devis Client</h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <label className="block font-medium text-slate-700 mb-1">Client</label>
              <select
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded bg-white"
              >
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.city})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Remise Globale (%)</label>
              <input
                type="number"
                step="0.01"
                min={0}
                max={100}
                value={draftCalc.globalDiscountPercent}
                onChange={(e) => {
                  setGlobalDiscount(Math.max(0, Math.min(100, parseFloat(e.target.value) || 0)));
                  setGlobalDiscountAmountCents(undefined);
                  setGlobalDiscountAmountInput('');
                }}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Remise en Montant ({company.currency})
              </label>
              <input
                type="number"
                step="0.01"
                min={0}
                placeholder="0.00"
                value={
                  globalDiscountAmountInput !== ''
                    ? globalDiscountAmountInput
                    : draftCalc.globalDiscountCents > 0
                    ? centsToDh(draftCalc.globalDiscountCents).toFixed(2)
                    : ''
                }
                onChange={(e) => {
                  const raw = e.target.value;
                  setGlobalDiscountAmountInput(raw);
                  if (raw.trim() === '') {
                    setGlobalDiscountAmountCents(undefined);
                    setGlobalDiscount(0);
                    return;
                  }
                  const cents = Math.max(0, dhToCents(raw));
                  setGlobalDiscountAmountCents(cents);
                }}
                className="w-full px-3 py-2 font-mono border border-amber-300 bg-amber-50/40 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Notes / Conditions</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Ex: Installation incluse sur Casablanca"
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2 bg-slate-50 p-3 rounded border border-slate-200">
            <div className="flex-1 min-w-[220px]">
              <label className="block font-medium text-slate-700 mb-1">Ajouter un produit</label>
              <select
                value={selectedProductId}
                onChange={(e) => setSelectedProductId(e.target.value)}
                className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.reference} — {p.name} ({formatMad(p.salePriceHtCents)} HT · TVA {p.vatRate}%)
                  </option>
                ))}
              </select>
            </div>
            <div className="w-24">
              <label className="block font-medium text-slate-700 mb-1">Quantité</label>
              <input
                type="number"
                min={1}
                value={qty}
                onChange={(e) => setQty(parseInt(e.target.value, 10) || 1)}
                className="w-full px-2 py-1.5 font-mono border border-slate-300 rounded bg-white"
              />
            </div>
            <button
              type="button"
              onClick={addDraftLine}
              className="px-4 py-1.5 bg-[#1D4ED8] text-white font-medium rounded hover:bg-blue-800"
            >
              + Ajouter la ligne
            </button>
          </div>

          {draftLines.length > 0 && (
            <div className="border border-slate-200 rounded p-3 space-y-2">
              {draftLines.map((l, idx) => (
                <div key={idx} className="flex items-center justify-between py-1 border-b border-slate-100">
                  <span>
                    <strong className="font-mono">{l.productRef}</strong> — {l.productName} ×{' '}
                    <strong>{l.quantity}</strong> (TVA {l.vatRate}%)
                  </span>
                  <button
                    type="button"
                    onClick={() => setDraftLines((prev) => prev.filter((_, i) => i !== idx))}
                    className="text-red-600"
                  >
                    Retirer
                  </button>
                </div>
              ))}
              <div className="text-right font-mono-tabular font-bold text-sm pt-2">
                Total Devis TTC : {formatMad(draftCalc.totalTtcCents)}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowCreate(false)}
              className="px-3 py-1.5 border border-slate-300 rounded"
            >
              Annuler
            </button>
            <button
              type="submit"
              disabled={draftLines.length === 0}
              className="px-4 py-1.5 bg-emerald-700 text-white font-medium rounded hover:bg-emerald-800 disabled:opacity-50"
            >
              Enregistrer le Devis
            </button>
          </div>
        </form>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
              <th className="py-3 px-4">N° Devis</th>
              <th className="py-3 px-4">Date</th>
              <th className="py-3 px-4">Validité</th>
              <th className="py-3 px-4">Client</th>
              <th className="py-3 px-4 text-right">Total HT</th>
              <th className="py-3 px-4 text-right">Total TTC</th>
              <th className="py-3 px-4">Statut & Lien</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {quotes.map((q) => (
              <tr key={q.id} className="hover:bg-slate-50/70">
                <td className="py-3 px-4 font-mono font-semibold">{q.number}</td>
                <td className="py-3 px-4 font-mono-tabular">
                  {formatBusinessDateFr(q.businessDate)}
                </td>
                <td className="py-3 px-4 font-mono-tabular">
                  {formatBusinessDateFr(q.validUntil)}
                </td>
                <td className="py-3 px-4 font-medium">{q.customerName}</td>
                <td className="py-3 px-4 text-right font-mono-tabular">
                  {formatMad(q.totalTaxableCents)}
                </td>
                <td className="py-3 px-4 text-right font-mono-tabular font-bold">
                  {formatMad(q.totalTtcCents)}
                </td>
                <td className="py-3 px-4">
                  <span className="font-mono font-semibold">{q.status}</span>
                  {q.convertedSaleId && (
                    <span className="block text-[10px] text-emerald-700">
                      Converti en Vente & Facture
                    </span>
                  )}
                </td>
                <td className="py-3 px-4 text-right space-x-2">
                  <button
                    type="button"
                    onClick={() => handlePrint(q)}
                    className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-100 inline-flex items-center gap-1"
                  >
                    <Printer className="w-3.5 h-3.5" /> A4
                  </button>
                  {!q.convertedSaleId && q.status !== 'ANNULE' && (
                    <button
                      type="button"
                      onClick={() => handleConvert(q)}
                      className="px-2.5 py-1 bg-[#1D4ED8] text-white rounded hover:bg-blue-800 inline-flex items-center gap-1"
                    >
                      <ArrowRightLeft className="w-3.5 h-3.5" /> Convertir en Vente
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/**
 * SECTION 18 : FACTURES, AVOIRS & HISTORIQUE DES PAIEMENTS (Règles 3, 4 & 19)
 */
export const InvoicesView: React.FC<{
  company: CompanyInfo;
  settings: AppSettings;
  refreshTrigger: number;
  onChanged: () => void;
  onOpenPrintPreview: (doc: PrintableDocument) => void;
}> = ({ company, settings, refreshTrigger, onChanged, onOpenPrintPreview }) => {
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [invSortBy, setInvSortBy] = useState<
    'DATE_DESC' | 'DATE_ASC' | 'TOTAL_DESC' | 'TOTAL_ASC' | 'DUE_DESC' | 'CUSTOMER_ASC'
  >('DATE_DESC');

  const [payModalInvoice, setPayModalInvoice] = useState<Invoice | null>(null);
  const [payAmountDh, setPayAmountDh] = useState('');
  const [payMethod, setPayMethod] = useState<Exclude<PaymentMethod, 'CREDIT'>>('CASH');
  const [payRef, setPayRef] = useState('');
  const [confirmOverpay, setConfirmOverpay] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    Promise.all([
      db.invoices.orderBy('createdAt').reverse().toArray(),
      db.payments.orderBy('createdAt').reverse().toArray(),
    ]).then(([invList, payList]) => {
      setInvoices(invList);
      setPayments(payList);
    });
  }, [refreshTrigger]);

  const openPayModal = (inv: Invoice) => {
    setPayModalInvoice(inv);
    setPayAmountDh(centsToDh(inv.remainingDueCents).toFixed(2));
    setPayMethod('CASH');
    setPayRef('');
    setConfirmOverpay(false);
  };

  const handleRecordPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payModalInvoice) return;
    setFeedback(null);
    try {
      const res = await executeRecordInvoicePayment({
        invoiceId: payModalInvoice.id,
        amountCents: dhToCents(payAmountDh),
        method: payMethod,
        reference: payRef,
        confirmOverpayment: confirmOverpay,
      });
      setPayModalInvoice(null);
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Paiement ${res.payment.number} enregistré (${res.payment.destination}). Nouveau statut calculé de ${res.invoice.number} : ${res.invoice.status}.`,
      });
    } catch (err) {
      if (err instanceof ArbitrageError) {
        setFeedback({ type: 'error', msg: err.decision.resolutionMessage });
      } else {
        setFeedback({
          type: 'error',
          msg: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };

  const handlePrint = async (inv: Invoice) => {
    const items = await db.invoiceItems.where('invoiceId').equals(inv.id).toArray();
    onOpenPrintPreview(buildInvoiceA4Print(company, inv, items));
  };

  const filtered = invoices
    .filter((i) => (statusFilter === 'ALL' ? true : i.status === statusFilter))
    .sort((a, b) => {
      switch (invSortBy) {
        case 'DATE_DESC':
          return b.createdAt.localeCompare(a.createdAt);
        case 'DATE_ASC':
          return a.createdAt.localeCompare(b.createdAt);
        case 'TOTAL_DESC':
          return b.totalTtcCents - a.totalTtcCents;
        case 'TOTAL_ASC':
          return a.totalTtcCents - b.totalTtcCents;
        case 'DUE_DESC':
          return b.remainingDueCents - a.remainingDueCents;
        case 'CUSTOMER_ASC':
          return a.customerName.localeCompare(b.customerName, 'fr');
        default:
          return 0;
      }
    });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            Factures, Avoirs & Règlements Clients
          </h1>
          <p className="text-xs text-slate-500">
            Règles 3, 4 & 19 : Statut calculé (UNPAID / PARTIAL / PAID) · Routage Caisse vs Banque ·
            Contrôle des trop-perçus
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs">
            <ArrowUpDown className="w-3.5 h-3.5 text-[#1D4ED8]" />
            <span className="font-semibold text-slate-700">Trier par :</span>
            <select
              value={invSortBy}
              onChange={(e) => setInvSortBy(e.target.value as typeof invSortBy)}
              className="px-2.5 py-1.5 border border-blue-300 bg-blue-50/40 rounded-md font-medium text-slate-900"
            >
              <option value="DATE_DESC">Date (Plus récent → Plus ancien)</option>
              <option value="DATE_ASC">Date (Plus ancien → Plus récent)</option>
              <option value="TOTAL_DESC">Total TTC (Décroissant ↓)</option>
              <option value="TOTAL_ASC">Total TTC (Croissant ↑)</option>
              <option value="DUE_DESC">Reste Dû (Décroissant ↓)</option>
              <option value="CUSTOMER_ASC">Client (A → Z)</option>
            </select>
          </div>
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg">
            {(['ALL', 'UNPAID', 'PARTIAL', 'PAID', 'CANCELLED'] as const).map((st) => (
              <button
                key={st}
                type="button"
                onClick={() => setStatusFilter(st)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  statusFilter === st
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {st === 'ALL' ? 'Toutes' : st}
              </button>
            ))}
          </div>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-md border text-xs flex items-start justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
              : 'bg-red-50 border-red-300 text-red-900'
          }`}
        >
          <span>{feedback.msg}</span>
          <button type="button" onClick={() => setFeedback(null)} className="underline ml-4">
            Fermer
          </button>
        </div>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
              <th className="py-3 px-4">N° Document</th>
              <th className="py-3 px-4">Type</th>
              <th className="py-3 px-4">Date</th>
              <th className="py-3 px-4">Client & ICE</th>
              <th className="py-3 px-4 text-right">Total TTC</th>
              <th className="py-3 px-4 text-right">Payé</th>
              <th className="py-3 px-4 text-right">Reste Dû</th>
              <th className="py-3 px-4">Statut Calculé</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((inv) => (
              <tr key={inv.id} className="hover:bg-slate-50/70">
                <td className="py-3 px-4 font-mono font-semibold">{inv.number}</td>
                <td className="py-3 px-4 font-mono text-[11px]">
                  {inv.type === 'CREDIT_NOTE' ? 'AVOIR' : 'FACTURE'}
                </td>
                <td className="py-3 px-4 font-mono-tabular">
                  {formatBusinessDateFr(inv.businessDate)}
                </td>
                <td className="py-3 px-4">
                  <div className="font-medium text-slate-900">{inv.customerName}</div>
                  {inv.customerIce && (
                    <div className="font-mono text-[10px] text-slate-500">
                      ICE: {inv.customerIce}
                    </div>
                  )}
                </td>
                <td className="py-3 px-4 text-right font-mono-tabular font-bold">
                  {formatMad(inv.totalTtcCents)}
                </td>
                <td className="py-3 px-4 text-right font-mono-tabular text-emerald-700">
                  {formatMad(inv.paidCents)}
                </td>
                <td className="py-3 px-4 text-right font-mono-tabular font-semibold text-amber-800">
                  {formatMad(inv.remainingDueCents)}
                </td>
                <td className="py-3 px-4 font-mono font-semibold">
                  <span
                    className={
                      inv.status === 'PAID'
                        ? 'text-emerald-700'
                        : inv.status === 'PARTIAL'
                        ? 'text-amber-700'
                        : inv.status === 'UNPAID'
                        ? 'text-red-700'
                        : 'text-slate-400 line-through'
                    }
                  >
                    {inv.status}
                  </span>
                </td>
                <td className="py-3 px-4 text-right space-x-2">
                  <button
                    type="button"
                    onClick={() => handlePrint(inv)}
                    className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-100 inline-flex items-center gap-1"
                  >
                    <Printer className="w-3.5 h-3.5" /> Imprimer A4
                  </button>
                  {inv.type === 'INVOICE' &&
                    inv.status !== 'CANCELLED' &&
                    inv.remainingDueCents > 0 && (
                      <button
                        type="button"
                        onClick={() => openPayModal(inv)}
                        className="px-2.5 py-1 bg-emerald-700 text-white rounded hover:bg-emerald-800 inline-flex items-center gap-1"
                      >
                        <Wallet className="w-3.5 h-3.5" /> Régler
                      </button>
                    )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Historique des paiements liés */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
        <h2 className="text-sm font-bold text-slate-900 dark:text-white mb-3">
          Registre des Paiements & Destinations Financières (Règle 4)
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-200 text-left text-slate-500">
                <th className="py-2">N° Règlement</th>
                <th className="py-2">Date</th>
                <th className="py-2">Sens</th>
                <th className="py-2">Document Cible</th>
                <th className="py-2">Tiers</th>
                <th className="py-2">Moyen</th>
                <th className="py-2">Destination Financière</th>
                <th className="py-2 text-right">Montant</th>
                <th className="py-2">Statut</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {payments.slice(0, 20).map((p) => (
                <tr key={p.id}>
                  <td className="py-2 font-mono font-semibold">{p.number}</td>
                  <td className="py-2 font-mono-tabular">
                    {formatBusinessDateFr(p.businessDate)}
                  </td>
                  <td className="py-2 font-mono">
                    {p.direction === 'IN' ? 'ENTRÉE (+)' : 'SORTIE (-)'}
                  </td>
                  <td className="py-2 font-mono">{p.targetNumber}</td>
                  <td className="py-2">{p.partyName}</td>
                  <td className="py-2 font-mono">{p.method}</td>
                  <td className="py-2 font-mono text-[11px] text-slate-600">{p.destination}</td>
                  <td className="py-2 text-right font-mono-tabular font-semibold">
                    {formatMad(p.amountCents)}
                  </td>
                  <td className="py-2 font-mono text-[11px]">{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modale d'enregistrement de paiement sur facture */}
      {payModalInvoice && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleRecordPayment}
            className="bg-white border border-slate-300 rounded-lg max-w-md w-full p-6 space-y-4 text-xs"
          >
            <h3 className="text-base font-bold text-slate-900">
              Enregistrer un règlement sur {payModalInvoice.number}
            </h3>
            <div className="p-3 bg-slate-50 border border-slate-200 rounded font-mono-tabular space-y-1">
              <div>Total Facture TTC : {formatMad(payModalInvoice.totalTtcCents)}</div>
              <div>Déjà réglé : {formatMad(payModalInvoice.paidCents)}</div>
              <div className="font-bold text-amber-800">
                Solde restant dû : {formatMad(payModalInvoice.remainingDueCents)}
              </div>
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Montant du paiement (MAD)
              </label>
              <input
                type="number"
                step="0.01"
                required
                value={payAmountDh}
                onChange={(e) => setPayAmountDh(e.target.value)}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Moyen de paiement (Règle 4 : Espèces → Caisse | Autres → Banque/Effets)
              </label>
              <select
                value={payMethod}
                onChange={(e) =>
                  setPayMethod(e.target.value as Exclude<PaymentMethod, 'CREDIT'>)
                }
                className="w-full px-3 py-2 border border-slate-300 rounded bg-white"
              >
                <option value="CASH">Espèces (Entrée Caisse Physique)</option>
                <option value="TRANSFER">Virement Bancaire (Compte Banque)</option>
                <option value="CHECK">Chèque (Portefeuille Effets)</option>
                <option value="CARD">Carte Bancaire TPE (Compte Banque)</option>
              </select>
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Référence (N° Chèque / Virement / Reçu)
              </label>
              <input
                type="text"
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>

            {dhToCents(payAmountDh) > payModalInvoice.remainingDueCents && (
              <div className="p-3 bg-amber-50 border border-amber-300 rounded space-y-2 text-amber-900">
                <div className="font-semibold">
                  Arbitrage Règle 19 : Montant supérieur au solde restant dû
                </div>
                <p>
                  {settings.allowOverpayment
                    ? "Le paramètre d'autorisation des trop-perçus est actif. Cochez ci-dessous pour convertir l'excédent en crédit/avoir client explicite."
                    : "Par défaut, un paiement ne peut pas dépasser le solde restant dû. Activez l'option dans Paramètres > Finance si vous souhaitez autoriser les avoirs de trop-perçu."}
                </p>
                {settings.allowOverpayment && (
                  <label className="flex items-center gap-2 font-medium">
                    <input
                      type="checkbox"
                      checked={confirmOverpay}
                      onChange={(e) => setConfirmOverpay(e.target.checked)}
                    />
                    Confirmer la création d&apos;un crédit client pour l&apos;excédent
                  </label>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPayModalInvoice(null)}
                className="px-3 py-1.5 border border-slate-300 rounded"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-emerald-700 text-white font-medium rounded hover:bg-emerald-800"
              >
                Valider le paiement
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
