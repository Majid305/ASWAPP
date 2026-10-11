import React, { useEffect, useState } from 'react';
import {
  Archive,
  ArrowUpDown,
  CheckCircle2,
  Download,
  FileWarning,
  MessageCircle,
  PackageCheck,
  Plus,
  Printer,
  RotateCcw,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { db, enqueueTransactionalMutation, getAllTables, nextDocumentNumberInTx } from '../db/database';
import {
  centsToDh,
  computeSavReminderStatus,
  dhToCents,
  DocumentLineInput,
  formatMad,
} from '../domain/financialEngine';
import {
  buildPaymentCancellationPvPrint,
  buildPurchaseA4Print,
  PrintableDocument,
} from '../printing/printTemplates';
import { downloadExcelImportTemplate } from '../services/backupAndDiagnosticService';
import {
  executeAddEquipmentAndSavReminder,
  executeCancelPurchasePaymentViaPvAndExpense,
  executeCancelPurchaseStockReception,
  executeCompleteSavReminder,
  executeCreatePurchaseOrder,
  executeDeleteOrDeactivateCustomer,
  executeDeleteOrDeactivateSupplier,
  executeDeletePurchaseBeforeReceiptAndPayment,
  executeReceivePurchaseItems,
  executeRecordSupplierPayment,
} from '../services/commandService';
import {
  CompanyInfo,
  Customer,
  CustomerEquipment,
  CustomerType,
  PaymentMethod,
  Product,
  Purchase,
  PurchaseItem,
  SavReminder,
  Supplier,
} from '../types/domain';
import { formatBusinessDateFr, getMoroccoBusinessDate } from '../utils/dateUtils';
import { generateId } from '../utils/securityUtils';

/**
 * SECTION 25 : ACHATS & RÉCEPTION FOURNISSEURS (Règle 6)
 */
export const PurchasesView: React.FC<{
  company: CompanyInfo;
  refreshTrigger: number;
  onChanged: () => void;
  onOpenPrintPreview: (doc: PrintableDocument) => void;
}> = ({ company, refreshTrigger, onChanged, onOpenPrintPreview }) => {
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const [supplierId, setSupplierId] = useState('');
  const [selectedProdId, setSelectedProdId] = useState('');
  const [orderQty, setOrderQty] = useState(5);
  const [draftLines, setDraftLines] = useState<DocumentLineInput[]>([]);
  const [notes, setNotes] = useState('');

  // Modales Réception et Paiement Fournisseur
  const [receivingPurchase, setReceivingPurchase] = useState<Purchase | null>(null);
  const [receivingItems, setReceivingItems] = useState<PurchaseItem[]>([]);
  const [receiveDeltas, setReceiveDeltas] = useState<Record<string, number>>({});
  const [defectiveDeltas, setDefectiveDeltas] = useState<Record<string, number>>({});
  const [defectReasons, setDefectReasons] = useState<Record<string, string>>({});

  const [payingPurchase, setPayingPurchase] = useState<Purchase | null>(null);
  const [payAmountDh, setPayAmountDh] = useState('');
  const [payMethod, setPayMethod] = useState<'CASH' | 'TRANSFER' | 'CHECK' | 'CARD'>('TRANSFER');
  const [payRef, setPayRef] = useState('');

  // Modales Suppression avant réception/paiement, Annulation réception stock, Annulation paiement via PV & Dépense
  const [deletingPurchase, setDeletingPurchase] = useState<Purchase | null>(null);
  const [deleteReason, setDeleteReason] = useState('');

  const [cancelingStockPurchase, setCancelingStockPurchase] = useState<Purchase | null>(null);
  const [cancelingStockItems, setCancelingStockItems] = useState<PurchaseItem[]>([]);
  const [cancelStockReason, setCancelStockReason] = useState('');

  const [cancelingPaymentPurchase, setCancelingPaymentPurchase] = useState<Purchase | null>(null);
  const [cancelPaymentReason, setCancelPaymentReason] = useState('');

  const [feedback, setFeedback] = useState<string | null>(null);
  const [purchaseSortBy, setPurchaseSortBy] = useState<
    | 'DATE_DESC'
    | 'DATE_ASC'
    | 'SUPPLIER_ASC'
    | 'TOTAL_DESC'
    | 'TOTAL_ASC'
    | 'DUE_DESC'
    | 'STATUS_ASC'
  >('DATE_DESC');

  useEffect(() => {
    Promise.all([
      db.purchases.orderBy('createdAt').reverse().toArray(),
      db.suppliers.filter((s) => s.active).toArray(),
      db.products.filter((p) => p.active).toArray(),
    ]).then(([pList, sList, prodList]) => {
      setPurchases(pList);
      setSuppliers(sList);
      setProducts(prodList);
      if (sList[0] && !supplierId) setSupplierId(sList[0].id);
      if (prodList[0] && !selectedProdId) setSelectedProdId(prodList[0].id);
    });
  }, [refreshTrigger, supplierId, selectedProdId]);

  // Fermeture par touche Échap (Escape) de toutes les modales d'achats
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setReceivingPurchase(null);
        setPayingPurchase(null);
        setDeletingPurchase(null);
        setCancelingStockPurchase(null);
        setCancelingPaymentPurchase(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const addLine = () => {
    const prod = products.find((p) => p.id === selectedProdId);
    if (!prod) return;
    setDraftLines((prev) => [
      ...prev,
      {
        productId: prod.id,
        productRef: prod.reference,
        productName: prod.name,
        quantity: Math.max(1, orderQty),
        unitPriceHtCents: prod.purchasePriceCents,
        discountPercent: 0,
        vatRate: prod.vatRate,
      },
    ]);
  };

  const handleCreatePurchase = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draftLines.length) return;
    const po = await executeCreatePurchaseOrder({
      supplierId,
      lines: draftLines,
      notes,
    });
    setDraftLines([]);
    setShowCreate(false);
    onChanged();
    setFeedback(
      `Bon de commande fournisseur ${po.number} créé (Règle 6 : le stock n'augmente qu'à la réception physique).`
    );
  };

  const openReceiveModal = async (po: Purchase) => {
    const items = await db.purchaseItems.where('purchaseId').equals(po.id).toArray();
    setReceivingItems(items);
    const init: Record<string, number> = {};
    items.forEach((i) => {
      init[i.id] = Math.max(0, i.orderedQty - i.receivedQty);
    });
    setReceiveDeltas(init);
    setDefectiveDeltas({});
    setDefectReasons({});
    setReceivingPurchase(po);
  };

  const openCancelStockModal = async (po: Purchase) => {
    const items = await db.purchaseItems.where('purchaseId').equals(po.id).toArray();
    setCancelingStockItems(items.filter((i) => i.receivedQty > 0));
    setCancelStockReason('');
    setCancelingStockPurchase(po);
  };

  const handleConfirmReception = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!receivingPurchase) return;
    try {
      let totalGoodUnits = 0;
      let totalDefUnits = 0;

      const receptions = receivingItems
        .map((item) => {
          const totalRec = Number(receiveDeltas[item.id]) || 0;
          const defQty = Math.max(0, Math.min(totalRec, Number(defectiveDeltas[item.id]) || 0));
          const goodQty = totalRec - defQty;
          totalGoodUnits += goodQty;
          totalDefUnits += defQty;

          return {
            purchaseItemId: item.id,
            receivedDeltaQty: totalRec,
            defectiveQty: defQty,
            defectReason: defectReasons[item.id]?.trim() || undefined,
          };
        })
        .filter((r) => r.receivedDeltaQty > 0);

      const updated = await executeReceivePurchaseItems({
        purchaseId: receivingPurchase.id,
        receptions,
      });
      setReceivingPurchase(null);
      onChanged();

      let msg = `Réception enregistrée sur ${updated.number} -> Statut : ${updated.status}. `;
      if (totalGoodUnits > 0) {
        msg += `+${totalGoodUnits} unité(s) entrée(s) en stock vendable. `;
      }
      if (totalDefUnits > 0) {
        msg += `⚠️ ${totalDefUnits} unité(s) constatée(s) défectueuse(s) isolée(s) en Quarantaine (fiche de suivi créée).`;
      }
      setFeedback(msg);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmSupplierPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!payingPurchase) return;
    try {
      const updated = await executeRecordSupplierPayment({
        purchaseId: payingPurchase.id,
        amountCents: dhToCents(payAmountDh),
        method: payMethod,
        reference: payRef,
      });
      setPayingPurchase(null);
      onChanged();
      setFeedback(`Paiement fournisseur enregistré sur ${updated.number}.`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmDeleteBeforeReceiptAndPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deletingPurchase) return;
    try {
      const res = await executeDeletePurchaseBeforeReceiptAndPayment({
        purchaseId: deletingPurchase.id,
        reason: deleteReason.trim() || undefined,
      });
      setDeletingPurchase(null);
      setDeleteReason('');
      onChanged();
      setFeedback(
        `Commande fournisseur ${res.deletedNumber} supprimée avec succès (aucune réception en stock et aucun paiement engagé).`
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmCancelStockReception = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelingStockPurchase) return;
    try {
      const updated = await executeCancelPurchaseStockReception({
        purchaseId: cancelingStockPurchase.id,
        reason: cancelStockReason.trim() || undefined,
      });
      setCancelingStockPurchase(null);
      setCancelStockReason('');
      onChanged();
      setFeedback(
        `Intégration au stock annulée pour ${updated.number} : les quantités reçues ont été retirées du stock et la commande est revenue à l'état COMMANDE.`
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    }
  };

  const handleConfirmCancelPaymentViaPvAndExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelingPaymentPurchase) return;
    try {
      const reason =
        cancelPaymentReason.trim() ||
        `Annulation règlement fournisseur sur commande ${cancelingPaymentPurchase.number}`;
      const res = await executeCancelPurchasePaymentViaPvAndExpense({
        purchaseId: cancelingPaymentPurchase.id,
        reason,
      });
      setCancelingPaymentPurchase(null);
      setCancelPaymentReason('');
      onChanged();
      setFeedback(
        `Paiement annulé sur ${res.purchase.number} (${formatMad(res.canceledAmountCents)}) via PV ${res.pvAudit.number} et Dépense ${res.expense.number}.`
      );
      onOpenPrintPreview(
        buildPaymentCancellationPvPrint(company, {
          pvAudit: res.pvAudit,
          expense: res.expense,
          purchase: res.purchase,
          canceledAmountCents: res.canceledAmountCents,
          paymentMethod: res.paymentMethod,
          reason,
        })
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePrint = async (po: Purchase) => {
    const items = await db.purchaseItems.where('purchaseId').equals(po.id).toArray();
    onOpenPrintPreview(buildPurchaseA4Print(company, po, items));
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            Commandes Fournisseurs & Réceptions de Marchandises
          </h1>
          <p className="text-xs text-slate-500">
            Règle 6 : Le bon de commande n&apos;augmente pas le stock · Réception partielle ou
            complète avec mouvements de stock réels
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[#0F172A] text-white text-xs font-medium rounded-md hover:bg-slate-800"
        >
          <Plus className="w-4 h-4" /> Nouvelle Commande Fournisseur
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
          onSubmit={handleCreatePurchase}
          className="bg-white border border-slate-300 rounded-lg p-5 space-y-4 text-xs"
        >
          <h3 className="text-sm font-bold text-slate-900">Créer un Bon de Commande Achat</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block font-medium text-slate-700 mb-1">Fournisseur</label>
              <select
                value={supplierId}
                onChange={(e) => setSupplierId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded bg-white"
              >
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.city})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Notes commande</label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
          </div>

          <div className="flex items-end gap-2 bg-slate-50 p-3 rounded border border-slate-200">
            <div className="flex-1">
              <label className="block font-medium text-slate-700 mb-1">Article commandé</label>
              <select
                value={selectedProdId}
                onChange={(e) => setSelectedProdId(e.target.value)}
                className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.reference} — {p.name} (P.A HT: {formatMad(p.purchasePriceCents)})
                  </option>
                ))}
              </select>
            </div>
            <div className="w-28">
              <label className="block font-medium text-slate-700 mb-1">Qté commandée</label>
              <input
                type="number"
                min={1}
                value={orderQty}
                onChange={(e) => setOrderQty(parseInt(e.target.value, 10) || 1)}
                className="w-full px-2 py-1.5 font-mono border border-slate-300 rounded bg-white"
              />
            </div>
            <button
              type="button"
              onClick={addLine}
              className="px-4 py-1.5 bg-[#1D4ED8] text-white font-medium rounded"
            >
              + Ajouter
            </button>
          </div>

          {draftLines.length > 0 && (
            <div className="border border-slate-200 rounded p-3 space-y-1">
              {draftLines.map((l, idx) => (
                <div key={idx} className="flex justify-between py-1 border-b border-slate-100">
                  <span>
                    <strong className="font-mono">{l.productRef}</strong> — {l.productName} ×{' '}
                    <strong>{l.quantity}</strong>
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
              disabled={!draftLines.length}
              className="px-4 py-1.5 bg-emerald-700 text-white font-medium rounded disabled:opacity-50"
            >
              Valider le Bon de Commande
            </button>
          </div>
        </form>
      )}

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs bg-slate-50/50">
          <span className="font-semibold text-slate-700">
            Commandes & Réceptions Fournisseurs ({purchases.length})
          </span>
          <div className="flex items-center gap-1.5">
            <ArrowUpDown className="w-3.5 h-3.5 text-[#1D4ED8]" />
            <span className="font-semibold text-slate-700">Trier par :</span>
            <select
              value={purchaseSortBy}
              onChange={(e) => setPurchaseSortBy(e.target.value as typeof purchaseSortBy)}
              className="px-2.5 py-1 border border-blue-300 bg-blue-50/40 rounded font-medium text-slate-900"
            >
              <option value="DATE_DESC">Date (Plus récent → Plus ancien)</option>
              <option value="DATE_ASC">Date (Plus ancien → Plus récent)</option>
              <option value="SUPPLIER_ASC">Fournisseur (A → Z)</option>
              <option value="TOTAL_DESC">Montant TTC (Décroissant ↓)</option>
              <option value="TOTAL_ASC">Montant TTC (Croissant ↑)</option>
              <option value="DUE_DESC">Reste Dû (Décroissant ↓)</option>
              <option value="STATUS_ASC">Statut Réception</option>
            </select>
          </div>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600 select-none">
              <th className="py-3 px-4">N° Achat</th>
              <th
                onClick={() =>
                  setPurchaseSortBy((p) => (p === 'DATE_DESC' ? 'DATE_ASC' : 'DATE_DESC'))
                }
                className="py-3 px-4 cursor-pointer hover:text-slate-900"
              >
                Date {purchaseSortBy === 'DATE_ASC' ? '↑' : purchaseSortBy === 'DATE_DESC' ? '↓' : '↕'}
              </th>
              <th
                onClick={() => setPurchaseSortBy('SUPPLIER_ASC')}
                className="py-3 px-4 cursor-pointer hover:text-slate-900"
              >
                Fournisseur {purchaseSortBy === 'SUPPLIER_ASC' ? '↑' : '↕'}
              </th>
              <th
                onClick={() =>
                  setPurchaseSortBy((p) => (p === 'TOTAL_DESC' ? 'TOTAL_ASC' : 'TOTAL_DESC'))
                }
                className="py-3 px-4 text-right cursor-pointer hover:text-slate-900"
              >
                Total TTC{' '}
                {purchaseSortBy === 'TOTAL_ASC' ? '↑' : purchaseSortBy === 'TOTAL_DESC' ? '↓' : '↕'}
              </th>
              <th className="py-3 px-4 text-right">Payé</th>
              <th
                onClick={() => setPurchaseSortBy('DUE_DESC')}
                className="py-3 px-4 text-right cursor-pointer hover:text-slate-900"
              >
                Reste Dû {purchaseSortBy === 'DUE_DESC' ? '↓' : '↕'}
              </th>
              <th
                onClick={() => setPurchaseSortBy('STATUS_ASC')}
                className="py-3 px-4 cursor-pointer hover:text-slate-900"
              >
                Statut Réception {purchaseSortBy === 'STATUS_ASC' ? '↑' : '↕'}
              </th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {[...purchases]
              .sort((a, b) => {
                switch (purchaseSortBy) {
                  case 'DATE_DESC':
                    return b.createdAt.localeCompare(a.createdAt);
                  case 'DATE_ASC':
                    return a.createdAt.localeCompare(b.createdAt);
                  case 'SUPPLIER_ASC':
                    return a.supplierName.localeCompare(b.supplierName, 'fr');
                  case 'TOTAL_DESC':
                    return b.totalTtcCents - a.totalTtcCents;
                  case 'TOTAL_ASC':
                    return a.totalTtcCents - b.totalTtcCents;
                  case 'DUE_DESC':
                    return b.remainingDueCents - a.remainingDueCents;
                  case 'STATUS_ASC':
                    return a.status.localeCompare(b.status, 'fr');
                  default:
                    return 0;
                }
              })
              .map((po) => {
              const hasStockReceived =
                po.status === 'PARTIELLEMENT_RECU' || po.status === 'RECU';
              const canDeleteBeforeReceiptAndPayment =
                po.status === 'COMMANDE' && po.paidCents === 0;

              return (
                <tr key={po.id} className="hover:bg-slate-50">
                  <td className="py-3 px-4 font-mono font-semibold">{po.number}</td>
                  <td className="py-3 px-4 font-mono-tabular">
                    {formatBusinessDateFr(po.businessDate)}
                  </td>
                  <td className="py-3 px-4 font-medium">{po.supplierName}</td>
                  <td className="py-3 px-4 text-right font-mono-tabular font-bold">
                    {formatMad(po.totalTtcCents)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-emerald-700">
                    {formatMad(po.paidCents)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-red-700">
                    {formatMad(po.remainingDueCents)}
                  </td>
                  <td className="py-3 px-4 font-mono font-semibold">{po.status}</td>
                  <td className="py-3 px-4 text-right">
                    <div className="flex flex-wrap items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => handlePrint(po)}
                        className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-100 inline-flex items-center gap-1"
                      >
                        <Printer className="w-3.5 h-3.5" /> A4
                      </button>

                      {po.status !== 'RECU' && po.status !== 'ANNULE' && (
                        <button
                          type="button"
                          onClick={() => openReceiveModal(po)}
                          className="px-2.5 py-1 bg-[#1D4ED8] text-white rounded hover:bg-blue-800 inline-flex items-center gap-1"
                        >
                          <PackageCheck className="w-3.5 h-3.5" /> Réceptionner
                        </button>
                      )}

                      {hasStockReceived && (
                        <button
                          type="button"
                          onClick={() => openCancelStockModal(po)}
                          title="Annuler l'intégration au stock de la commande après réception"
                          className="px-2.5 py-1 bg-amber-50 border border-amber-300 text-amber-900 rounded hover:bg-amber-100 inline-flex items-center gap-1 font-medium"
                        >
                          <RotateCcw className="w-3.5 h-3.5" /> Annuler Stock
                        </button>
                      )}

                      {po.remainingDueCents > 0 && po.status !== 'ANNULE' && (
                        <button
                          type="button"
                          onClick={() => {
                            setPayingPurchase(po);
                            setPayAmountDh(centsToDh(po.remainingDueCents).toFixed(2));
                          }}
                          className="px-2.5 py-1 bg-emerald-700 text-white rounded hover:bg-emerald-800"
                        >
                          Payer Fournisseur
                        </button>
                      )}

                      {po.paidCents > 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            setCancelingPaymentPurchase(po);
                            setCancelPaymentReason('');
                          }}
                          title="Annuler le paiement via PV et dépense"
                          className="px-2.5 py-1 bg-rose-50 border border-rose-300 text-rose-900 rounded hover:bg-rose-100 inline-flex items-center gap-1 font-medium"
                        >
                          <FileWarning className="w-3.5 h-3.5" /> Annuler Paiement (PV & Dépense)
                        </button>
                      )}

                      {canDeleteBeforeReceiptAndPayment && (
                        <button
                          type="button"
                          onClick={() => {
                            setDeletingPurchase(po);
                            setDeleteReason('');
                          }}
                          title="Supprimer la commande avant réception et paiement"
                          className="px-2.5 py-1 bg-red-600 text-white rounded hover:bg-red-700 inline-flex items-center gap-1"
                        >
                          <Trash2 className="w-3.5 h-3.5" /> Supprimer
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Modale de réception partielle ou complète (Règle 6) */}
      {receivingPurchase && (
        <div
          onClick={() => setReceivingPurchase(null)}
          className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4 overflow-y-auto"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleConfirmReception}
            className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg max-w-xl w-full max-h-[85vh] flex flex-col overflow-hidden p-5 text-xs shadow-xl"
          >
            {/* En-tête fixe avec bouton X de fermeture */}
            <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800 shrink-0">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  Réception Marchandises sur {receivingPurchase.number} (Règle 6)
                </h3>
                <p className="text-slate-600 dark:text-slate-400 mt-0.5">
                  Saisissez les quantités réellement livrées ({receivingItems.length} ligne(s)). Le
                  stock augmentera exactement des quantités réceptionnées.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setReceivingPurchase(null)}
                title="Fermer (Échap)"
                className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-slate-900 hover:bg-slate-100 shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Raccourcis de remplissage rapide */}
            <div className="flex items-center justify-between py-2.5 shrink-0">
              <span className="font-mono text-[11px] text-slate-500">
                Total à entrer en stock :{' '}
                <strong className="text-slate-900 dark:text-white">
                  {Object.values(receiveDeltas).reduce((acc, q) => acc + (Number(q) || 0), 0)}{' '}
                  unité(s)
                </strong>
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const zeros: Record<string, number> = {};
                    receivingItems.forEach((i) => {
                      zeros[i.id] = 0;
                    });
                    setReceiveDeltas(zeros);
                  }}
                  className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-100 text-[11px]"
                >
                  Tout mettre à 0
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const allRem: Record<string, number> = {};
                    receivingItems.forEach((i) => {
                      allRem[i.id] = Math.max(0, i.orderedQty - i.receivedQty);
                    });
                    setReceiveDeltas(allRem);
                  }}
                  className="px-2.5 py-1 border border-blue-300 bg-blue-50 text-blue-900 rounded hover:bg-blue-100 text-[11px] font-medium"
                >
                  Tout recevoir (Reliquat)
                </button>
              </div>
            </div>

            {/* Liste défilante des articles (scrollable) */}
            <div className="flex-1 min-h-0 max-h-[50vh] overflow-y-auto space-y-2.5 border border-slate-200 dark:border-slate-800 rounded p-3">
              {receivingItems.map((item) => {
                const rem = item.orderedQty - item.receivedQty;
                const recQty = Number(receiveDeltas[item.id]) || 0;
                const defQty = Number(defectiveDeltas[item.id]) || 0;
                const goodQty = Math.max(0, recQty - defQty);

                return (
                  <div
                    key={item.id}
                    className="p-2.5 bg-slate-50/70 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700/80 rounded-md space-y-2"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-slate-900 dark:text-slate-100 truncate">
                          {item.productName}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">
                          Commandé : {item.orderedQty} · Déjà reçu : {item.receivedQty} · Reliquat :{' '}
                          <strong>{rem}</strong>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[11px] text-slate-600 font-medium">Reçu total :</span>
                        <input
                          type="number"
                          min={0}
                          max={rem}
                          value={receiveDeltas[item.id] ?? 0}
                          onChange={(e) => {
                            const val = Math.max(0, Math.min(rem, parseInt(e.target.value, 10) || 0));
                            setReceiveDeltas({
                              ...receiveDeltas,
                              [item.id]: val,
                            });
                            if (defQty > val) {
                              setDefectiveDeltas({
                                ...defectiveDeltas,
                                [item.id]: val,
                              });
                            }
                          }}
                          className="w-20 px-2 py-1.5 text-right font-mono border border-slate-300 rounded shrink-0 font-bold bg-white"
                        />
                      </div>
                    </div>

                    {recQty > 0 && (
                      <div className="pt-2 border-t border-slate-200 dark:border-slate-700/60 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <div className="flex items-center gap-2">
                          <label className="flex items-center gap-1.5 text-amber-800 font-medium cursor-pointer">
                            <span>Dont défectueux / abîmé à la réception :</span>
                            <input
                              type="number"
                              min={0}
                              max={recQty}
                              value={defectiveDeltas[item.id] ?? 0}
                              onChange={(e) =>
                                setDefectiveDeltas({
                                  ...defectiveDeltas,
                                  [item.id]: Math.max(
                                    0,
                                    Math.min(recQty, parseInt(e.target.value, 10) || 0)
                                  ),
                                })
                              }
                              className="w-16 px-1.5 py-1 text-right font-mono border border-amber-300 bg-amber-50 rounded text-amber-950 font-bold"
                            />
                          </label>
                          {defQty > 0 && (
                            <span className="text-emerald-700 font-medium">
                              (Stock vendable : <strong>+{goodQty}</strong> · Quarantaine :{' '}
                              <strong className="text-red-700">+{defQty}</strong>)
                            </span>
                          )}
                        </div>

                        {defQty > 0 && (
                          <div className="w-full">
                            <input
                              type="text"
                              placeholder="Motif du défaut constaté (ex: carton écrasé, casse transport, dysfonctionnement...)"
                              value={defectReasons[item.id] ?? ''}
                              onChange={(e) =>
                                setDefectReasons({
                                  ...defectReasons,
                                  [item.id]: e.target.value,
                                })
                              }
                              className="w-full px-2 py-1 border border-amber-300 rounded bg-white text-xs placeholder:text-slate-400"
                            />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Pied de modale fixe (toujours visible) */}
            <div className="flex items-center justify-end gap-2 pt-3 mt-3 border-t border-slate-200 dark:border-slate-800 shrink-0">
              <button
                type="button"
                onClick={() => setReceivingPurchase(null)}
                className="px-3.5 py-2 border border-slate-300 rounded font-medium hover:bg-slate-100"
              >
                Annuler / Fermer
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-[#1D4ED8] text-white font-semibold rounded hover:bg-blue-800"
              >
                Valider l&apos;entrée en stock
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modale paiement fournisseur */}
      {payingPurchase && (
        <div
          onClick={() => setPayingPurchase(null)}
          className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4 overflow-y-auto"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleConfirmSupplierPayment}
            className="bg-white border border-slate-300 rounded-lg max-w-md w-full max-h-[85vh] overflow-y-auto p-6 space-y-4 text-xs shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">
                Règlement Fournisseur sur {payingPurchase.number}
              </h3>
              <button
                type="button"
                onClick={() => setPayingPurchase(null)}
                className="p-1 text-slate-400 hover:text-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Montant (MAD)</label>
              <input
                type="number"
                step="0.01"
                required
                value={payAmountDh}
                onChange={(e) => setPayAmountDh(e.target.value)}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Moyen de paiement</label>
              <select
                value={payMethod}
                onChange={(e) =>
                  setPayMethod(e.target.value as 'CASH' | 'TRANSFER' | 'CHECK' | 'CARD')
                }
                className="w-full px-3 py-2 border border-slate-300 rounded bg-white"
              >
                <option value="TRANSFER">Virement Bancaire</option>
                <option value="CHECK">Chèque</option>
                <option value="CASH">Espèces (Sortie Caisse Physique)</option>
                <option value="CARD">Carte Bancaire</option>
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Référence</label>
              <input
                type="text"
                value={payRef}
                onChange={(e) => setPayRef(e.target.value)}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPayingPurchase(null)}
                className="px-3 py-1.5 border border-slate-300 rounded"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-emerald-700 text-white font-medium rounded"
              >
                Enregistrer le décaissement
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 1. Modale Suppression de Commande AVANT réception et paiement */}
      {deletingPurchase && (
        <div
          onClick={() => setDeletingPurchase(null)}
          className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4 overflow-y-auto"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleConfirmDeleteBeforeReceiptAndPayment}
            className="bg-white border border-slate-300 rounded-lg max-w-md w-full max-h-[85vh] overflow-y-auto p-6 space-y-4 text-xs shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-red-700 flex items-center gap-2">
                <Trash2 className="w-4 h-4" /> Supprimer la commande {deletingPurchase.number}
              </h3>
              <button
                type="button"
                onClick={() => setDeletingPurchase(null)}
                className="p-1 text-slate-400 hover:text-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-slate-600 leading-relaxed">
              Cette commande fournisseur (<strong>{deletingPurchase.supplierName}</strong> —{' '}
              <strong>{formatMad(deletingPurchase.totalTtcCents)}</strong>) n&apos;a fait
              l&apos;objet d&apos;aucune réception en stock et d&apos;aucun règlement. Sa
              suppression retirera également l&apos;engagement correspondant de la dette fournisseur.
            </p>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Motif de suppression (optionnel)
              </label>
              <input
                type="text"
                value={deleteReason}
                onChange={(e) => setDeleteReason(e.target.value)}
                placeholder="Ex: Erreur de saisie, commande annulée auprès du fournisseur..."
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeletingPurchase(null)}
                className="px-3 py-1.5 border border-slate-300 rounded"
              >
                Retour
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-red-600 text-white font-medium rounded hover:bg-red-700"
              >
                Confirmer la suppression
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 2. Modale Annulation de l'intégration au stock APRÈS réception */}
      {cancelingStockPurchase && (
        <div
          onClick={() => setCancelingStockPurchase(null)}
          className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4 overflow-y-auto"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleConfirmCancelStockReception}
            className="bg-white border border-slate-300 rounded-lg max-w-lg w-full max-h-[85vh] flex flex-col overflow-hidden p-6 space-y-4 text-xs shadow-xl"
          >
            <div className="flex items-center justify-between shrink-0">
              <h3 className="text-base font-bold text-amber-900 flex items-center gap-2">
                <RotateCcw className="w-4 h-4" /> Annuler l&apos;intégration au stock (
                {cancelingStockPurchase.number})
              </h3>
              <button
                type="button"
                onClick={() => setCancelingStockPurchase(null)}
                className="p-1 text-slate-400 hover:text-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-slate-600 leading-relaxed shrink-0">
              Les quantités précédemment réceptionnées sur cette commande seront retirées du stock
              avec génération d&apos;un mouvement inverse traçable, et la commande repassera au
              statut <strong>COMMANDE</strong> (non réceptionnée).
            </p>
            <div className="border border-slate-200 rounded p-3 space-y-1.5 flex-1 min-h-0 max-h-52 overflow-y-auto">
              {cancelingStockItems.map((item) => (
                <div
                  key={item.id}
                  className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0"
                >
                  <div>
                    <div className="font-medium">{item.productName}</div>
                    <div className="font-mono text-[11px] text-slate-500">
                      Réf: {item.productRef} · Commandé: {item.orderedQty}
                    </div>
                  </div>
                  <span className="font-mono font-bold text-red-700">
                    -{item.receivedQty} en stock
                  </span>
                </div>
              ))}
            </div>
            <div className="shrink-0">
              <label className="block font-medium text-slate-700 mb-1">
                Motif d&apos;annulation de la réception
              </label>
              <input
                type="text"
                value={cancelStockReason}
                onChange={(e) => setCancelStockReason(e.target.value)}
                placeholder="Ex: Erreur de réception, retour marchandise non conforme..."
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
            <div className="flex justify-end gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setCancelingStockPurchase(null)}
                className="px-3 py-1.5 border border-slate-300 rounded"
              >
                Retour
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-amber-700 text-white font-medium rounded hover:bg-amber-800"
              >
                Confirmer l&apos;annulation du stock
              </button>
            </div>
          </form>
        </div>
      )}

      {/* 3. Modale Annulation du paiement via PV et Dépense */}
      {cancelingPaymentPurchase && (
        <div
          onClick={() => setCancelingPaymentPurchase(null)}
          className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4 overflow-y-auto"
        >
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleConfirmCancelPaymentViaPvAndExpense}
            className="bg-white border border-slate-300 rounded-lg max-w-lg w-full max-h-[85vh] overflow-y-auto p-6 space-y-4 text-xs shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-rose-800 flex items-center gap-2">
                <FileWarning className="w-4 h-4" /> Annuler le paiement via PV et Dépense (
                {cancelingPaymentPurchase.number})
              </h3>
              <button
                type="button"
                onClick={() => setCancelingPaymentPurchase(null)}
                className="p-1 text-slate-400 hover:text-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-3 bg-rose-50 border border-rose-200 rounded text-rose-900 space-y-1">
              <div>
                Fournisseur : <strong>{cancelingPaymentPurchase.supplierName}</strong>
              </div>
              <div>
                Montant réglé à annuler :{' '}
                <strong className="font-mono">
                  {formatMad(cancelingPaymentPurchase.paidCents)}
                </strong>
              </div>
            </div>
            <p className="text-slate-600 leading-relaxed">
              Cette opération annule le règlement fournisseur enregistré sur{' '}
              <strong>{cancelingPaymentPurchase.number}</strong> en générant automatiquement :
              <br />• Un <strong>Procès-Verbal (PV)</strong> de régularisation (avec réintégration
              en caisse si le paiement était en espèces) ;
              <br />• Une pièce de <strong>Dépense annulée</strong> liée au PV pour la traçabilité
              comptable ;
              <br />• Le rétablissement du solde restant dû sur la commande.
            </p>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Motif d&apos;annulation (figurera sur le PV et la Dépense) *
              </label>
              <input
                type="text"
                required
                value={cancelPaymentReason}
                onChange={(e) => setCancelPaymentReason(e.target.value)}
                placeholder="Ex: Annulation décaissement / rejet virement / erreur de règlement..."
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCancelingPaymentPurchase(null)}
                className="px-3 py-1.5 border border-slate-300 rounded"
              >
                Retour
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-rose-700 text-white font-medium rounded hover:bg-rose-800"
              >
                Valider l&apos;annulation & Générer PV + Dépense
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

/**
 * SECTION 26 : FOURNISSEURS (Règle 17)
 */
export const SuppliersView: React.FC<{
  refreshTrigger: number;
  onChanged: () => void;
}> = ({ refreshTrigger, onChanged }) => {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: '',
    contactName: '',
    phone: '',
    whatsapp: '',
    email: '',
    city: 'Casablanca',
    address: '',
    ice: '',
    ifNumber: '',
    rc: '',
    paymentTerms: '30 jours',
  });
  const [feedback, setFeedback] = useState<string | null>(null);
  const [supplierSortBy, setSupplierSortBy] = useState<
    'NAME_ASC' | 'NAME_DESC' | 'DEBT_DESC' | 'VOL_DESC' | 'CITY_ASC'
  >('NAME_ASC');

  useEffect(() => {
    db.suppliers.toArray().then(setSuppliers);
  }, [refreshTrigger]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name) return;
    const now = new Date().toISOString();
    await enqueueTransactionalMutation(async () => {
      await db.transaction('rw', getAllTables(db), async () => {
        const code = await nextDocumentNumberInTx(db, 'supplier');
        await db.suppliers.add({
          id: generateId(),
          code,
          ...form,
          totalPurchasesCents: 0,
          debtCents: 0,
          notes: '',
          active: true,
          isDemo: false,
          createdAt: now,
          updatedAt: now,
        });
      });
    });
    setShowCreate(false);
    onChanged();
  };

  const handleDeactivate = async (s: Supplier) => {
    const res = await executeDeleteOrDeactivateSupplier(s.id);
    onChanged();
    setFeedback(
      res.mode === 'DEACTIVATED'
        ? `Arbitrage Règle 17 : Fournisseur "${s.name}" désactivé logiquement (historique achats conservé).`
        : `Fournisseur "${s.name}" supprimé.`
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between bg-white border border-slate-200 rounded-lg p-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900">
            Répertoire des Fournisseurs & Dettes
          </h1>
          <p className="text-xs text-slate-500">
            Règle 17 : Désactivation logique si des commandes ou paiements existent
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => downloadExcelImportTemplate('SUPPLIERS')}
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-emerald-300 bg-emerald-50 text-emerald-900 text-xs font-medium rounded-md hover:bg-emerald-100"
          >
            <Download className="w-3.5 h-3.5" /> Modèle .xlsx Fournisseurs
          </button>
          <button
            type="button"
            onClick={() => setShowCreate((v) => !v)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#0F172A] text-white text-xs font-medium rounded-md"
          >
            <Plus className="w-4 h-4" /> Nouveau Fournisseur
          </button>
        </div>
      </div>

      {feedback && (
        <div className="p-3 bg-blue-50 border border-blue-200 text-blue-900 rounded text-xs">
          {feedback}
        </div>
      )}

      {showCreate && (
        <form
          onSubmit={handleCreate}
          className="bg-white border border-slate-300 rounded-lg p-5 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs"
        >
          <div>
            <label className="block font-medium mb-1">Raison sociale *</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-1.5 border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Contact commercial</label>
            <input
              type="text"
              value={form.contactName}
              onChange={(e) => setForm({ ...form, contactName: e.target.value })}
              className="w-full px-3 py-1.5 border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Téléphone</label>
            <input
              type="text"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Ville</label>
            <input
              type="text"
              value={form.city}
              onChange={(e) => setForm({ ...form, city: e.target.value })}
              className="w-full px-3 py-1.5 border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">ICE</label>
            <input
              type="text"
              value={form.ice}
              onChange={(e) => setForm({ ...form, ice: e.target.value })}
              className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
            />
          </div>
          <div className="flex items-end justify-end gap-2">
            <button
              type="submit"
              className="px-4 py-1.5 bg-[#0F172A] text-white font-medium rounded"
            >
              Enregistrer
            </button>
          </div>
        </form>
      )}

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between text-xs bg-slate-50/50">
          <span className="font-semibold text-slate-700">
            Fournisseurs ({suppliers.length})
          </span>
          <div className="flex items-center gap-1.5">
            <ArrowUpDown className="w-3.5 h-3.5 text-[#1D4ED8]" />
            <span className="font-semibold text-slate-700">Trier par :</span>
            <select
              value={supplierSortBy}
              onChange={(e) => setSupplierSortBy(e.target.value as typeof supplierSortBy)}
              className="px-2.5 py-1 border border-blue-300 bg-blue-50/40 rounded font-medium text-slate-900"
            >
              <option value="NAME_ASC">Fournisseur (A → Z)</option>
              <option value="NAME_DESC">Fournisseur (Z → A)</option>
              <option value="DEBT_DESC">Dette Actuelle (Décroissant ↓)</option>
              <option value="VOL_DESC">Volume Achats (Décroissant ↓)</option>
              <option value="CITY_ASC">Ville (A → Z)</option>
            </select>
          </div>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
              <th className="py-3 px-4">Code</th>
              <th className="py-3 px-4">Fournisseur & ICE</th>
              <th className="py-3 px-4">Contact & Tél</th>
              <th className="py-3 px-4">Ville</th>
              <th className="py-3 px-4 text-right">Volume Achats</th>
              <th className="py-3 px-4 text-right">Dette Actuelle</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {[...suppliers]
              .sort((a, b) => {
                switch (supplierSortBy) {
                  case 'NAME_ASC':
                    return a.name.localeCompare(b.name, 'fr');
                  case 'NAME_DESC':
                    return b.name.localeCompare(a.name, 'fr');
                  case 'DEBT_DESC':
                    return b.debtCents - a.debtCents;
                  case 'VOL_DESC':
                    return b.totalPurchasesCents - a.totalPurchasesCents;
                  case 'CITY_ASC':
                    return a.city.localeCompare(b.city, 'fr');
                  default:
                    return 0;
                }
              })
              .map((s) => (
              <tr key={s.id} className={!s.active ? 'opacity-50 bg-slate-50' : ''}>
                <td className="py-3 px-4 font-mono font-semibold">{s.code}</td>
                <td className="py-3 px-4">
                  <div className="font-medium text-slate-900">{s.name}</div>
                  <div className="font-mono text-[10px] text-slate-500">ICE : {s.ice || '—'}</div>
                </td>
                <td className="py-3 px-4">
                  {s.contactName} · <span className="font-mono">{s.phone}</span>
                </td>
                <td className="py-3 px-4">{s.city}</td>
                <td className="py-3 px-4 text-right font-mono-tabular">
                  {formatMad(s.totalPurchasesCents)}
                </td>
                <td className="py-3 px-4 text-right font-mono-tabular font-bold text-red-700">
                  {formatMad(s.debtCents)}
                </td>
                <td className="py-3 px-4 text-right">
                  {s.active && (
                    <button
                      type="button"
                      onClick={() => handleDeactivate(s)}
                      className="px-2.5 py-1 border border-red-200 text-red-700 rounded hover:bg-red-50"
                    >
                      Désactiver
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
 * SECTIONS 19 & 20 : CLIENTS & ÉQUIPEMENTS INSTALLÉS (Règles 15 & 18)
 */
export const CustomersView: React.FC<{
  refreshTrigger: number;
  onChanged: () => void;
}> = ({ refreshTrigger, onChanged }) => {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [equipments, setEquipments] = useState<CustomerEquipment[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [showCreateCust, setShowCreateCust] = useState(false);
  const [showAddEquipForCust, setShowAddEquipForCust] = useState<Customer | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [custSortBy, setCustSortBy] = useState<
    'NAME_ASC' | 'NAME_DESC' | 'BALANCE_DESC' | 'CREDIT_DESC' | 'CITY_ASC'
  >('NAME_ASC');

  const [custForm, setCustForm] = useState({
    name: '',
    type: 'PARTICULIER' as CustomerType,
    phone: '',
    whatsapp: '',
    email: '',
    city: 'Casablanca',
    address: '',
    ice: '',
  });

  const [equipForm, setEquipForm] = useState({
    type: 'Osmoseur 7 Étapes',
    brand: 'AquaPro Maroc',
    model: 'RO-75G-PRO',
    serialNumber: `SN-ASW-${Math.floor(1000 + Math.random() * 9000)}`,
    installDate: getMoroccoBusinessDate(),
    capacity: '75 GPD (280 L/j)',
    membraneType: 'FilmTec 1812-75',
    replacementProductId: '',
    intervalMonths: 6,
  });

  useEffect(() => {
    Promise.all([
      db.customers.toArray(),
      db.customerEquipments.toArray(),
      db.products.filter((p) => p.active).toArray(),
    ]).then(([cList, eList, pList]) => {
      setCustomers(cList);
      setEquipments(eList);
      setProducts(pList);
      if (pList[0] && !equipForm.replacementProductId) {
        setEquipForm((f) => ({ ...f, replacementProductId: pList[0].id }));
      }
    });
  }, [refreshTrigger, equipForm.replacementProductId]);

  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!custForm.name) return;
    const now = new Date().toISOString();
    await enqueueTransactionalMutation(async () => {
      await db.transaction('rw', getAllTables(db), async () => {
        const code = await nextDocumentNumberInTx(db, 'customer');
        await db.customers.add({
          id: generateId(),
          code,
          ...custForm,
          whatsapp: custForm.whatsapp || custForm.phone,
          notes: '',
          balanceCents: 0,
          creditAvailableCents: 0,
          active: true,
          isDemo: false,
          createdAt: now,
          updatedAt: now,
        });
      });
    });
    setShowCreateCust(false);
    onChanged();
  };

  const handleAddEquipment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!showAddEquipForCust) return;
    await executeAddEquipmentAndSavReminder({
      customerId: showAddEquipForCust.id,
      ...equipForm,
    });
    setShowAddEquipForCust(null);
    onChanged();
    setFeedback(
      `Équipement installé ajouté pour ${showAddEquipForCust.name} avec rappel SAV automatique à ${equipForm.intervalMonths} mois.`
    );
  };

  const handleDeactivateCust = async (c: Customer) => {
    const res = await executeDeleteOrDeactivateCustomer(c.id);
    onChanged();
    setFeedback(
      res.mode === 'DEACTIVATED'
        ? `Arbitrage Règles 15 & 18 : Client "${c.name}" désactivé logiquement. Ses ventes, factures, équipements et suivis SAV restent intacts.`
        : `Client "${c.name}" supprimé.`
    );
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between bg-white border border-slate-200 rounded-lg p-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900">
            Fichier Clients & Parc d&apos;Équipements Installés
          </h1>
          <p className="text-xs text-slate-500">
            Règles 15 & 18 : Chaîne Client → Équipement → Intervention SAV → Pièces → Paiement
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => downloadExcelImportTemplate('CUSTOMERS')}
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-emerald-300 bg-emerald-50 text-emerald-900 text-xs font-medium rounded-md hover:bg-emerald-100"
          >
            <Download className="w-3.5 h-3.5" /> Modèle .xlsx Clients
          </button>
          <button
            type="button"
            onClick={() => downloadExcelImportTemplate('EQUIPMENTS_SAV')}
            className="inline-flex items-center gap-1.5 px-3 py-2 border border-blue-300 bg-blue-50 text-blue-900 text-xs font-medium rounded-md hover:bg-blue-100"
          >
            <Download className="w-3.5 h-3.5" /> Modèle .xlsx Équipements SAV
          </button>
          <button
            type="button"
            onClick={() => setShowCreateCust((v) => !v)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#0F172A] text-white text-xs font-medium rounded-md"
          >
            <Plus className="w-4 h-4" /> Nouveau Client
          </button>
        </div>
      </div>

      {feedback && (
        <div className="p-3 bg-blue-50 border border-blue-200 text-blue-900 rounded text-xs">
          {feedback}
        </div>
      )}

      {showCreateCust && (
        <form
          onSubmit={handleCreateCustomer}
          className="bg-white border border-slate-300 rounded-lg p-5 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs"
        >
          <div>
            <label className="block font-medium mb-1">Nom complet / Société *</label>
            <input
              type="text"
              required
              value={custForm.name}
              onChange={(e) => setCustForm({ ...custForm, name: e.target.value })}
              className="w-full px-3 py-1.5 border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Type de client</label>
            <select
              value={custForm.type}
              onChange={(e) => setCustForm({ ...custForm, type: e.target.value as CustomerType })}
              className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
            >
              <option value="PARTICULIER">Particulier / Villa</option>
              <option value="PROFESSIONNEL">Professionnel / Clinique / Café</option>
              <option value="INSTALLATEUR">Installateur / Plombier</option>
              <option value="REVENDEUR">Revendeur</option>
            </select>
          </div>
          <div>
            <label className="block font-medium mb-1">Téléphone / WhatsApp</label>
            <input
              type="text"
              value={custForm.phone}
              onChange={(e) =>
                setCustForm({ ...custForm, phone: e.target.value, whatsapp: e.target.value })
              }
              className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Ville</label>
            <input
              type="text"
              value={custForm.city}
              onChange={(e) => setCustForm({ ...custForm, city: e.target.value })}
              className="w-full px-3 py-1.5 border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">ICE (si société)</label>
            <input
              type="text"
              value={custForm.ice}
              onChange={(e) => setCustForm({ ...custForm, ice: e.target.value })}
              className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
            />
          </div>
          <div className="flex items-end justify-end">
            <button
              type="submit"
              className="px-4 py-1.5 bg-[#0F172A] text-white font-medium rounded"
            >
              Créer la fiche client
            </button>
          </div>
        </form>
      )}

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between text-xs bg-slate-50/50">
          <span className="font-semibold text-slate-700">
            Répertoire Clients ({customers.length})
          </span>
          <div className="flex items-center gap-1.5">
            <ArrowUpDown className="w-3.5 h-3.5 text-[#1D4ED8]" />
            <span className="font-semibold text-slate-700">Trier par :</span>
            <select
              value={custSortBy}
              onChange={(e) => setCustSortBy(e.target.value as typeof custSortBy)}
              className="px-2.5 py-1 border border-blue-300 bg-blue-50/40 rounded font-medium text-slate-900"
            >
              <option value="NAME_ASC">Client (A → Z)</option>
              <option value="NAME_DESC">Client (Z → A)</option>
              <option value="BALANCE_DESC">Créance Reste Dû (Décroissant ↓)</option>
              <option value="CREDIT_DESC">Avoir Disponible (Décroissant ↓)</option>
              <option value="CITY_ASC">Ville (A → Z)</option>
            </select>
          </div>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
              <th className="py-3 px-4">Code</th>
              <th className="py-3 px-4">Client & Type</th>
              <th className="py-3 px-4">Téléphone / Ville</th>
              <th className="py-3 px-4 text-right">Créance (Reste dû)</th>
              <th className="py-3 px-4 text-right">Avoir / Crédit</th>
              <th className="py-3 px-4">Équipements liés</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {[...customers]
              .sort((a, b) => {
                switch (custSortBy) {
                  case 'NAME_ASC':
                    return a.name.localeCompare(b.name, 'fr');
                  case 'NAME_DESC':
                    return b.name.localeCompare(a.name, 'fr');
                  case 'BALANCE_DESC':
                    return b.balanceCents - a.balanceCents;
                  case 'CREDIT_DESC':
                    return b.creditAvailableCents - a.creditAvailableCents;
                  case 'CITY_ASC':
                    return a.city.localeCompare(b.city, 'fr');
                  default:
                    return 0;
                }
              })
              .map((c) => {
              const custEquips = equipments.filter((e) => e.customerId === c.id);
              return (
                <tr key={c.id} className={!c.active ? 'opacity-50 bg-slate-50' : ''}>
                  <td className="py-3 px-4 font-mono font-semibold">{c.code}</td>
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-900">{c.name}</div>
                    <div className="text-[11px] text-slate-500">
                      {c.type} {c.ice ? `· ICE ${c.ice}` : ''}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <span className="font-mono">{c.phone || '—'}</span> · {c.city}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular font-bold text-amber-800">
                    {formatMad(c.balanceCents)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular text-emerald-700">
                    {formatMad(c.creditAvailableCents)}
                  </td>
                  <td className="py-3 px-4">
                    {custEquips.length === 0 ? (
                      <span className="text-slate-400">Aucun</span>
                    ) : (
                      custEquips.map((eq) => (
                        <div key={eq.id} className="text-[11px]">
                          <strong>{eq.type}</strong> ({eq.serialNumber})
                        </div>
                      ))
                    )}
                  </td>
                  <td className="py-3 px-4 text-right space-x-2">
                    <button
                      type="button"
                      onClick={() => setShowAddEquipForCust(c)}
                      className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-100"
                    >
                      + Équipement / SAV
                    </button>
                    {c.active && c.code !== 'CLI-COMPTOIR' && (
                      <button
                        type="button"
                        onClick={() => handleDeactivateCust(c)}
                        className="px-2 py-1 border border-red-200 text-red-700 rounded hover:bg-red-50"
                      >
                        <Archive className="w-3.5 h-3.5 inline" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showAddEquipForCust && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleAddEquipment}
            className="bg-white border border-slate-300 rounded-lg max-w-lg w-full p-6 space-y-3 text-xs"
          >
            <h3 className="text-base font-bold text-slate-900">
              Ajouter un Équipement & Suivi SAV pour {showAddEquipForCust.name}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium mb-1">Type d&apos;appareil</label>
                <input
                  type="text"
                  required
                  value={equipForm.type}
                  onChange={(e) => setEquipForm({ ...equipForm, type: e.target.value })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Marque / Modèle</label>
                <input
                  type="text"
                  required
                  value={equipForm.model}
                  onChange={(e) => setEquipForm({ ...equipForm, model: e.target.value })}
                  className="w-full px-3 py-1.5 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Numéro de série</label>
                <input
                  type="text"
                  required
                  value={equipForm.serialNumber}
                  onChange={(e) => setEquipForm({ ...equipForm, serialNumber: e.target.value })}
                  className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Date d&apos;installation</label>
                <input
                  type="date"
                  value={equipForm.installDate}
                  onChange={(e) => setEquipForm({ ...equipForm, installDate: e.target.value })}
                  className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Consommable / Filtre à remplacer</label>
                <select
                  value={equipForm.replacementProductId}
                  onChange={(e) =>
                    setEquipForm({ ...equipForm, replacementProductId: e.target.value })
                  }
                  className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
                >
                  {products.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.reference} — {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">Périodicité rappel SAV (mois)</label>
                <select
                  value={equipForm.intervalMonths}
                  onChange={(e) =>
                    setEquipForm({ ...equipForm, intervalMonths: Number(e.target.value) })
                  }
                  className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded bg-white"
                >
                  <option value={3}>3 mois</option>
                  <option value={6}>6 mois (Semestriel)</option>
                  <option value={12}>12 mois (Annuel)</option>
                  <option value={24}>24 mois (Membrane RO)</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-3">
              <button
                type="button"
                onClick={() => setShowAddEquipForCust(null)}
                className="px-3 py-1.5 border border-slate-300 rounded"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-[#0F172A] text-white font-medium rounded"
              >
                Enregistrer Équipement & Rappel SAV
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

/**
 * SECTION 21 : MODULE SAV & REMPLACEMENT PÉRIODIQUE DES FILTRES (Règle 18)
 */
export const SavView: React.FC<{
  refreshTrigger: number;
  onChanged: () => void;
}> = ({ refreshTrigger, onChanged }) => {
  const [reminders, setReminders] = useState<SavReminder[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [activeModalRem, setActiveModalRem] = useState<SavReminder | null>(null);
  const [consumedProductId, setConsumedProductId] = useState('');
  const [consumedQty, setConsumedQty] = useState(1);
  const [serviceFeeDh, setServiceFeeDh] = useState('150');
  const [paymentMethod, setPaymentMethod] =
    useState<Exclude<PaymentMethod, 'CREDIT' | 'CREDIT_NOTE'>>('CASH');
  const [techNotes, setTechNotes] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      db.reminders.orderBy('dueDate').toArray(),
      db.products.filter((p) => p.active).toArray(),
    ]).then(([rList, pList]) => {
      setReminders(rList);
      setProducts(pList);
    });
  }, [refreshTrigger]);

  const openInterventionModal = (r: SavReminder) => {
    setActiveModalRem(r);
    setConsumedProductId(r.productId || products[0]?.id || '');
    setConsumedQty(1);
    setServiceFeeDh('150');
    setTechNotes('Remplacement cartouches + contrôle TDS et pression ballon');
  };

  const handleCompleteSav = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeModalRem) return;
    try {
      const res = await executeCompleteSavReminder({
        reminderId: activeModalRem.id,
        consumedProductId,
        consumedQty,
        serviceFeeCents: dhToCents(serviceFeeDh),
        paymentMethod,
        technicianNotes: techNotes,
        scheduleNextReminder: true,
      });
      setActiveModalRem(null);
      onChanged();
      setFeedback(
        `Intervention SAV validée (Règle 18) : pièce déduite du stock, encaissement enregistré et prochain rappel planifié au ${formatBusinessDateFr(
          res.nextReminder?.dueDate
        )}.`
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h1 className="font-display text-2xl font-bold text-slate-900">
          Maintenance SAV & Remplacement Périodique des Filtres / Membranes
        </h1>
        <p className="text-xs text-slate-500">
          Règle 18 : Traçabilité Client → Équipement → Intervention → Pièce sortie du stock →
          Paiement → Prochaine échéance automatique
        </p>
      </div>

      {feedback && (
        <div className="p-3 bg-emerald-50 border border-emerald-300 text-emerald-900 rounded text-xs">
          {feedback}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
              <th className="py-3 px-4">Client & Téléphone</th>
              <th className="py-3 px-4">Équipement Installé</th>
              <th className="py-3 px-4">Consommable Prévu</th>
              <th className="py-3 px-4">Cycle</th>
              <th className="py-3 px-4">Échéance</th>
              <th className="py-3 px-4">Statut Urgence</th>
              <th className="py-3 px-4 text-right">Actions SAV</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {reminders.map((r) => {
              const st = computeSavReminderStatus(r.dueDate, r.completedAt);
              const cleanPhone = r.customerWhatsapp.replace(/\D/g, '');
              const waMessage = encodeURIComponent(
                `Bonjour ${r.customerName}, ici ATLAS SOFT WATER. Le remplacement périodique des filtres de votre ${r.equipmentName} arrive à échéance le ${formatBusinessDateFr(
                  r.dueDate
                )}. Souhaitez-vous planifier le passage du technicien ?`
              );
              return (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-900">{r.customerName}</div>
                    <div className="font-mono text-[11px] text-slate-500">{r.customerPhone}</div>
                  </td>
                  <td className="py-3 px-4 font-medium">{r.equipmentName}</td>
                  <td className="py-3 px-4">{r.productName}</td>
                  <td className="py-3 px-4 font-mono">{r.intervalMonths} mois</td>
                  <td className="py-3 px-4 font-mono-tabular font-semibold">
                    {formatBusinessDateFr(r.dueDate)}
                  </td>
                  <td className="py-3 px-4 font-mono font-bold">
                    <span
                      className={
                        st === 'DEPASSE' || st === 'URGENT'
                          ? 'text-red-700'
                          : st === 'ATTENTION' || st === 'PROCHE'
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                      }
                    >
                      {st}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right space-x-2">
                    {cleanPhone && (
                      <a
                        href={`https://wa.me/${cleanPhone}?text=${waMessage}`}
                        target="_blank"
                        rel="noreferrer"
                        className="px-2.5 py-1 border border-emerald-300 bg-emerald-50 text-emerald-800 rounded inline-flex items-center gap-1 hover:bg-emerald-100"
                      >
                        <MessageCircle className="w-3.5 h-3.5" /> WhatsApp
                      </a>
                    )}
                    {st !== 'EFFECTUE' && (
                      <button
                        type="button"
                        onClick={() => openInterventionModal(r)}
                        className="px-2.5 py-1 bg-[#1D4ED8] text-white rounded hover:bg-blue-800 inline-flex items-center gap-1"
                      >
                        <Wrench className="w-3.5 h-3.5" /> Effectuer & Renouveler
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {activeModalRem && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleCompleteSav}
            className="bg-white border border-slate-300 rounded-lg max-w-md w-full p-6 space-y-4 text-xs"
          >
            <h3 className="text-base font-bold text-slate-900">
              Valider l&apos;Intervention SAV — {activeModalRem.customerName}
            </h3>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Pièce / Kit Filtres consommé depuis le stock (Règle 18)
              </label>
              <select
                value={consumedProductId}
                onChange={(e) => setConsumedProductId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded bg-white"
              >
                <option value="">Aucune pièce sortie du stock</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.reference} — {p.name} (Dispo: {p.stock})
                  </option>
                ))}
              </select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Quantité consommée</label>
                <input
                  type="number"
                  min={0}
                  value={consumedQty}
                  onChange={(e) => setConsumedQty(parseInt(e.target.value, 10) || 0)}
                  className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Forfait Main-d&apos;œuvre / Déplacement (MAD)
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={serviceFeeDh}
                  onChange={(e) => setServiceFeeDh(e.target.value)}
                  className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
                />
              </div>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Mode de règlement</label>
              <select
                value={paymentMethod}
                onChange={(e) =>
                  setPaymentMethod(
                    e.target.value as Exclude<PaymentMethod, 'CREDIT' | 'CREDIT_NOTE'>
                  )
                }
                className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
              >
                <option value="CASH">Espèces (Caisse)</option>
                <option value="TRANSFER">Virement (Banque)</option>
                <option value="CARD">Carte Bancaire</option>
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Rapport technique (TDS entrée/sortie, pression)
              </label>
              <input
                type="text"
                value={techNotes}
                onChange={(e) => setTechNotes(e.target.value)}
                className="w-full px-3 py-1.5 border border-slate-300 rounded"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setActiveModalRem(null)}
                className="px-3 py-1.5 border border-slate-300 rounded"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-emerald-700 text-white font-medium rounded flex items-center gap-1"
              >
                <CheckCircle2 className="w-4 h-4" /> Clôturer & Créer Prochain Rappel
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
