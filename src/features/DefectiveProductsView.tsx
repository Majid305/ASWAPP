import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowUpDown,
  Boxes,
  CheckCircle2,
  FileText,
  Filter,
  Package,
  Plus,
  Printer,
  RotateCcw,
  Search,
  ShieldAlert,
  Trash2,
  Truck,
  Users,
  Wrench,
  X,
} from 'lucide-react';
import { formatMad } from '../domain/financialEngine';
import { db } from '../db/database';
import {
  executeDeclareDefectiveProduct,
  executeResolveDefectiveProduct,
} from '../services/commandService';
import {
  buildDefectiveProductSheetPrint,
  buildDefectiveRegisterPrint,
  PrintableDocument,
} from '../printing/printTemplates';
import {
  CompanyInfo,
  Customer,
  DefectiveProduct,
  DefectiveSourceType,
  DefectiveStatus,
  Product,
  Supplier,
  UserProfile,
} from '../types/domain';
import { formatBusinessDateFr } from '../utils/dateUtils';

const STATUS_LABELS: Record<DefectiveStatus, { label: string; badgeClass: string }> = {
  EN_QUARANTAINE: {
    label: 'En Quarantaine',
    badgeClass: 'bg-red-100 text-red-800 border-red-200 dark:bg-red-950/60 dark:text-red-300 dark:border-red-800',
  },
  RETOURNE_FOURNISSEUR: {
    label: 'Retourné Fournisseur (RMA)',
    badgeClass: 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800',
  },
  REMPLACE_FOURNISSEUR: {
    label: 'Remplacé Fournisseur',
    badgeClass: 'bg-indigo-100 text-indigo-800 border-indigo-200 dark:bg-indigo-950/60 dark:text-indigo-300 dark:border-indigo-800',
  },
  AVOIR_FOURNISSEUR: {
    label: 'Avoir Fournisseur',
    badgeClass: 'bg-purple-100 text-purple-800 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800',
  },
  REPARE_REMIS_EN_STOCK: {
    label: 'Réparé & Re-stocké',
    badgeClass: 'bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800',
  },
  REBUTE_PERTE: {
    label: 'Rebut / Perte',
    badgeClass: 'bg-slate-200 text-slate-700 border-slate-300 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700',
  },
};

const SOURCE_LABELS: Record<DefectiveSourceType, { label: string; icon: React.ComponentType<{ className?: string }> }> = {
  PURCHASE_RECEIPT: { label: 'Réception Commande Achat', icon: Truck },
  CUSTOMER_RETURN: { label: 'Retour Client Défectueux', icon: RotateCcw },
  MANUAL_INSPECTION: { label: 'Inspection / Magasin', icon: ShieldAlert },
  SAV_INTERVENTION: { label: 'Atelier SAV', icon: Wrench },
};

export const DefectiveProductsView: React.FC<{
  company: CompanyInfo;
  currentProfile: UserProfile | null;
  refreshTrigger: number;
  onChanged: () => void;
  onOpenPrintPreview: (doc: PrintableDocument) => void;
}> = ({ company, currentProfile, refreshTrigger, onChanged, onOpenPrintPreview }) => {
  const [items, setItems] = useState<DefectiveProduct[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);

  // Filtres
  const [search, setSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState<'ALL' | DefectiveSourceType>('ALL');
  const [statusFilter, setStatusFilter] = useState<'ALL' | DefectiveStatus>('ALL');
  const [sortBy, setSortBy] = useState<'DATE_DESC' | 'DATE_ASC' | 'QTY_DESC' | 'COST_DESC' | 'PRODUCT_ASC'>('DATE_DESC');

  // Modale Déclaration Manuelle
  const [showDeclareModal, setShowDeclareModal] = useState(false);
  const [newProductId, setNewProductId] = useState('');
  const [newQty, setNewQty] = useState(1);
  const [newSourceType, setNewSourceType] = useState<DefectiveSourceType>('PURCHASE_RECEIPT');
  const [newSourceDocNumber, setNewSourceDocNumber] = useState('');
  const [newSupplierId, setNewSupplierId] = useState('');
  const [newCustomerId, setNewCustomerId] = useState('');
  const [newReason, setNewReason] = useState('');
  const [newSeverity, setNewSeverity] = useState<'CRITIQUE' | 'MAJEUR' | 'MINEUR'>('MAJEUR');
  const [newDeductFromStock, setNewDeductFromStock] = useState(false);

  // Modale Résolution / Traitement
  const [resolvingItem, setResolvingItem] = useState<DefectiveProduct | null>(null);
  const [resolveStatus, setResolveStatus] = useState<DefectiveStatus>('REPARE_REMIS_EN_STOCK');
  const [resolveNotes, setResolveNotes] = useState('');

  // Modale Détails
  const [detailItem, setDetailItem] = useState<DefectiveProduct | null>(null);

  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  useEffect(() => {
    Promise.all([
      db.defectiveProducts.orderBy('createdAt').reverse().toArray(),
      db.products.filter((p) => p.active).toArray(),
      db.suppliers.filter((s) => s.active).toArray(),
      db.customers.filter((c) => c.active).toArray(),
    ]).then(([dList, pList, sList, cList]) => {
      setItems(dList);
      setProducts(pList);
      setSuppliers(sList);
      setCustomers(cList);
      if (pList[0] && !newProductId) setNewProductId(pList[0].id);
      if (sList[0] && !newSupplierId) setNewSupplierId(sList[0].id);
      if (cList[0] && !newCustomerId) setNewCustomerId(cList[0].id);
    });
  }, [refreshTrigger]);

  // Statistiques KPIs
  const kpis = useMemo(() => {
    const inQuarantine = items.filter((i) => i.status === 'EN_QUARANTAINE');
    const totalQuarantineUnits = inQuarantine.reduce((acc, i) => acc + i.quantity, 0);
    const totalQuarantineCostCents = inQuarantine.reduce((acc, i) => acc + i.totalCostCents, 0);

    const fromReceiptUnits = items
      .filter((i) => i.sourceType === 'PURCHASE_RECEIPT')
      .reduce((acc, i) => acc + i.quantity, 0);

    const fromReturnUnits = items
      .filter((i) => i.sourceType === 'CUSTOMER_RETURN')
      .reduce((acc, i) => acc + i.quantity, 0);

    const resolvedCount = items.filter((i) => i.status !== 'EN_QUARANTAINE').length;

    return {
      quarantineCount: inQuarantine.length,
      totalQuarantineUnits,
      totalQuarantineCostCents,
      fromReceiptUnits,
      fromReturnUnits,
      resolvedCount,
    };
  }, [items]);

  // Liste filtrée et triée
  const filteredItems = useMemo(() => {
    return items
      .filter((item) => {
        if (sourceFilter !== 'ALL' && item.sourceType !== sourceFilter) return false;
        if (statusFilter !== 'ALL' && item.status !== statusFilter) return false;
        if (!search.trim()) return true;

        const q = search.toLowerCase();
        return (
          item.number.toLowerCase().includes(q) ||
          item.productRef.toLowerCase().includes(q) ||
          item.productName.toLowerCase().includes(q) ||
          item.defectReason.toLowerCase().includes(q) ||
          (item.supplierName && item.supplierName.toLowerCase().includes(q)) ||
          (item.customerName && item.customerName.toLowerCase().includes(q)) ||
          (item.sourceDocNumber && item.sourceDocNumber.toLowerCase().includes(q))
        );
      })
      .sort((a, b) => {
        switch (sortBy) {
          case 'DATE_DESC':
            return b.createdAt.localeCompare(a.createdAt);
          case 'DATE_ASC':
            return a.createdAt.localeCompare(b.createdAt);
          case 'QTY_DESC':
            return b.quantity - a.quantity;
          case 'COST_DESC':
            return b.totalCostCents - a.totalCostCents;
          case 'PRODUCT_ASC':
            return a.productName.localeCompare(b.productName, 'fr');
          default:
            return 0;
        }
      });
  }, [items, sourceFilter, statusFilter, search, sortBy]);

  const handleCreateDeclaration = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProductId || newQty <= 0 || !newReason.trim()) return;

    try {
      const selectedProd = products.find((p) => p.id === newProductId);
      const selectedSup = suppliers.find((s) => s.id === newSupplierId);
      const selectedCust = customers.find((c) => c.id === newCustomerId);

      const def = await executeDeclareDefectiveProduct({
        productId: newProductId,
        quantity: newQty,
        sourceType: newSourceType,
        sourceDocNumber: newSourceDocNumber.trim() || undefined,
        supplierId: newSourceType === 'PURCHASE_RECEIPT' ? selectedSup?.id : undefined,
        supplierName: newSourceType === 'PURCHASE_RECEIPT' ? selectedSup?.name : undefined,
        customerId: newSourceType === 'CUSTOMER_RETURN' ? selectedCust?.id : undefined,
        customerName: newSourceType === 'CUSTOMER_RETURN' ? selectedCust?.name : undefined,
        defectReason: newReason.trim(),
        severity: newSeverity,
        deductFromStock: newDeductFromStock,
        actor: currentProfile
          ? {
              userId: currentProfile.id,
              userName: currentProfile.name,
              userRole: currentProfile.role,
            }
          : undefined,
      });

      setShowDeclareModal(false);
      setNewReason('');
      setNewSourceDocNumber('');
      setNewQty(1);
      setNewDeductFromStock(false);
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Fiche Défectueux ${def.number} enregistrée pour ${selectedProd?.name}. Les ${newQty} unité(s) sont isolées en Quarantaine.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleResolveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resolvingItem || !resolveNotes.trim()) return;

    try {
      const updated = await executeResolveDefectiveProduct({
        defectiveId: resolvingItem.id,
        status: resolveStatus,
        resolutionNotes: resolveNotes.trim(),
        actor: currentProfile
          ? {
              userId: currentProfile.id,
              userName: currentProfile.name,
              userRole: currentProfile.role,
            }
          : undefined,
      });

      setResolvingItem(null);
      setResolveNotes('');
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Dossier ${updated.number} mis à jour : Statut -> ${STATUS_LABELS[updated.status]?.label || updated.status}${
          updated.status === 'REPARE_REMIS_EN_STOCK' ? ' (+ stock réintégré automatiquement)' : ''
        }.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="space-y-5">
      {/* Header Bar */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="p-2 bg-red-100 dark:bg-red-950/60 text-red-700 dark:text-red-400 rounded-lg">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
                Suivi des Produits Défectueux & Quarantaine
              </h1>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Gestion des anomalies : défectueux constatés à la réception d'une commande fournisseur ou retournés par un client
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              onOpenPrintPreview(
                buildDefectiveRegisterPrint(
                  company,
                  filteredItems,
                  sourceFilter !== 'ALL' || statusFilter !== 'ALL'
                    ? `Origine: ${sourceFilter}, Statut: ${statusFilter}`
                    : 'Registre complet'
                )
              )
            }
            className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-md hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors shadow-xs"
          >
            <Printer className="w-3.5 h-3.5 text-[#1D4ED8]" />
            Imprimer Registre A4 ({filteredItems.length})
          </button>

          <button
            type="button"
            onClick={() => setShowDeclareModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-red-700 hover:bg-red-800 text-white text-xs font-semibold rounded-md transition-colors shadow-xs"
          >
            <Plus className="w-4 h-4" />
            Déclarer un Défectueux
          </button>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-md border text-xs flex items-start justify-between gap-3 ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900 dark:bg-emerald-950/40 dark:border-emerald-800 dark:text-emerald-300'
              : 'bg-red-50 border-red-300 text-red-900 dark:bg-red-950/40 dark:border-red-800 dark:text-red-300'
          }`}
        >
          <span>{feedback.msg}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-xs underline shrink-0 font-medium"
          >
            Fermer
          </button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>En Quarantaine Actuelle</span>
            <ShieldAlert className="w-4 h-4 text-red-600" />
          </div>
          <div className="text-2xl font-bold font-mono-tabular text-red-700 dark:text-red-400">
            {kpis.totalQuarantineUnits}{' '}
            <span className="text-xs font-normal text-slate-500">
              unité(s) · {kpis.quarantineCount} dossier(s)
            </span>
          </div>
          <div className="text-[11px] text-slate-400">Articles isolés du stock vendable</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Coût Immobilisé HT</span>
            <Boxes className="w-4 h-4 text-[#1D4ED8]" />
          </div>
          <div className="text-2xl font-bold font-mono-tabular text-slate-900 dark:text-white">
            {formatMad(kpis.totalQuarantineCostCents)}
          </div>
          <div className="text-[11px] text-slate-400">Valeur d'achat en attente d'action</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Réceptions Fournisseurs</span>
            <Truck className="w-4 h-4 text-blue-600" />
          </div>
          <div className="text-2xl font-bold font-mono-tabular text-blue-700 dark:text-blue-400">
            {kpis.fromReceiptUnits}{' '}
            <span className="text-xs font-normal text-slate-500">unité(s)</span>
          </div>
          <div className="text-[11px] text-slate-400">Constatés lors des livraisons</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
            <span>Retours Clients Défectueux</span>
            <RotateCcw className="w-4 h-4 text-amber-600" />
          </div>
          <div className="text-2xl font-bold font-mono-tabular text-amber-700 dark:text-amber-400">
            {kpis.fromReturnUnits}{' '}
            <span className="text-xs font-normal text-slate-500">unité(s)</span>
          </div>
          <div className="text-[11px] text-slate-400">Retournés après vente (Règle 12)</div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-slate-400" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="N° DEF, article, motif, tiers, bon..."
                className="pl-8 pr-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 w-64"
              />
            </div>

            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as any)}
              className="px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800"
            >
              <option value="ALL">Toutes les origines</option>
              <option value="PURCHASE_RECEIPT">📦 Réception Commande Fournisseur</option>
              <option value="CUSTOMER_RETURN">👤 Retour Client Défectueux</option>
              <option value="MANUAL_INSPECTION">🛡️ Inspection Magasin / Stock</option>
              <option value="SAV_INTERVENTION">🔧 Atelier SAV</option>
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as any)}
              className="px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 font-medium"
            >
              <option value="ALL">Tous les statuts ({items.length})</option>
              <option value="EN_QUARANTAINE">En Quarantaine (Actifs)</option>
              <option value="RETOURNE_FOURNISSEUR">Retourné Fournisseur</option>
              <option value="REMPLACE_FOURNISSEUR">Remplacé par Fournisseur</option>
              <option value="AVOIR_FOURNISSEUR">Avoir Fournisseur Reçu</option>
              <option value="REPARE_REMIS_EN_STOCK">Réparé & Re-stocké</option>
              <option value="REBUTE_PERTE">Rebuté / Perte</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <ArrowUpDown className="w-3.5 h-3.5 text-[#1D4ED8]" />
            <span className="font-semibold text-slate-700 dark:text-slate-300">Trier par :</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as any)}
              className="px-2.5 py-1.5 border border-blue-300 bg-blue-50/40 rounded-md font-medium text-slate-900"
            >
              <option value="DATE_DESC">Date (Plus récent → Plus ancien)</option>
              <option value="DATE_ASC">Date (Plus ancien → Plus récent)</option>
              <option value="QTY_DESC">Quantité (Décroissant ↓)</option>
              <option value="COST_DESC">Coût Immobilisé (Décroissant ↓)</option>
              <option value="PRODUCT_ASC">Article (A → Z)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-left">
                <th className="py-3 px-4 font-semibold">N° Fiche</th>
                <th className="py-3 px-4 font-semibold">Date Constat</th>
                <th className="py-3 px-4 font-semibold">Origine & Tiers Associé</th>
                <th className="py-3 px-4 font-semibold">Article & Motif du Défaut</th>
                <th className="py-3 px-4 font-semibold text-right">Qté Isolé</th>
                <th className="py-3 px-4 font-semibold text-right">Coût HT (Total)</th>
                <th className="py-3 px-4 font-semibold">Statut Traitement</th>
                <th className="py-3 px-4 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {filteredItems.map((item) => {
                const srcMeta = SOURCE_LABELS[item.sourceType] || {
                  label: item.sourceType,
                  icon: Package,
                };
                const SrcIcon = srcMeta.icon;
                const statusMeta = STATUS_LABELS[item.status] || {
                  label: item.status,
                  badgeClass: 'bg-slate-100 text-slate-700',
                };

                return (
                  <tr key={item.id} className="hover:bg-slate-50/80 dark:hover:bg-slate-800/50">
                    <td className="py-3 px-4 font-mono font-bold text-red-700 dark:text-red-400">
                      {item.number}
                    </td>

                    <td className="py-3 px-4 font-mono-tabular text-slate-600 dark:text-slate-300">
                      {formatBusinessDateFr(item.reportedDate)}
                    </td>

                    <td className="py-3 px-4">
                      <div className="inline-flex items-center gap-1.5 font-medium text-slate-900 dark:text-slate-100">
                        <SrcIcon className="w-3.5 h-3.5 text-[#1D4ED8]" />
                        <span>{srcMeta.label}</span>
                      </div>
                      {item.supplierName && (
                        <div className="text-[11px] text-slate-500 font-normal">
                          Fournisseur : <strong>{item.supplierName}</strong>
                        </div>
                      )}
                      {item.customerName && (
                        <div className="text-[11px] text-slate-500 font-normal">
                          Client : <strong>{item.customerName}</strong>
                        </div>
                      )}
                      {item.sourceDocNumber && (
                        <div className="text-[10.5px] font-mono text-slate-500">
                          Réf Doc : {item.sourceDocNumber}
                        </div>
                      )}
                    </td>

                    <td className="py-3 px-4 max-w-xs">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        <span className="font-mono text-slate-500 mr-1.5">{item.productRef}</span>
                        {item.productName}
                      </div>
                      <div className="text-[11.5px] text-red-700 dark:text-red-400 mt-0.5 line-clamp-2">
                        {item.defectReason}
                      </div>
                      {item.resolutionNotes && (
                        <div className="text-[10.5px] text-emerald-700 dark:text-emerald-400 mt-0.5 italic">
                          Résolution : {item.resolutionNotes}
                        </div>
                      )}
                    </td>

                    <td className="py-3 px-4 text-right font-mono-tabular font-bold text-red-700 dark:text-red-400 text-sm">
                      {item.quantity}
                    </td>

                    <td className="py-3 px-4 text-right font-mono-tabular">
                      <div className="font-semibold text-slate-900 dark:text-white">
                        {formatMad(item.totalCostCents)}
                      </div>
                      <div className="text-[10.5px] text-slate-400">
                        {formatMad(item.unitCostCents)} / u
                      </div>
                    </td>

                    <td className="py-3 px-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold border ${statusMeta.badgeClass}`}
                      >
                        {statusMeta.label}
                      </span>
                    </td>

                    <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                      <button
                        type="button"
                        onClick={() =>
                          onOpenPrintPreview(buildDefectiveProductSheetPrint(company, item))
                        }
                        className="px-2 py-1 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300"
                        title="Imprimer Fiche de Quarantaine / Réclamation A4"
                      >
                        Fiche A4
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setResolvingItem(item);
                          setResolveStatus(
                            item.status === 'EN_QUARANTAINE'
                              ? 'REPARE_REMIS_EN_STOCK'
                              : item.status
                          );
                          setResolveNotes(item.resolutionNotes || '');
                        }}
                        className="px-2.5 py-1 bg-[#1D4ED8] hover:bg-blue-800 text-white rounded font-medium"
                      >
                        Traiter / Résoudre
                      </button>
                    </td>
                  </tr>
                );
              })}

              {filteredItems.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-slate-500">
                    <ShieldAlert className="w-8 h-8 text-slate-300 mx-auto mb-2" />
                    Aucun produit défectueux répertorié pour ces critères.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modale Déclaration d'un produit défectueux */}
      {showDeclareModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handleCreateDeclaration}
            className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg max-w-lg w-full p-6 space-y-4 text-xs shadow-xl"
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <div className="flex items-center gap-2 text-red-700">
                <ShieldAlert className="w-5 h-5" />
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  Déclarer un Produit Défectueux (Zone Quarantaine)
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setShowDeclareModal(false)}
                className="p-1 text-slate-400 hover:text-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Article concerné *
              </label>
              <select
                required
                value={newProductId}
                onChange={(e) => setNewProductId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.reference} — {p.name} (Stock actuel : {p.stock} {p.unit} · P.A :{' '}
                    {formatMad(p.purchasePriceCents)})
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Quantité défectueuse *
                </label>
                <input
                  type="number"
                  min={1}
                  required
                  value={newQty}
                  onChange={(e) => setNewQty(Math.max(1, parseInt(e.target.value, 10) || 1))}
                  className="w-full px-3 py-2 font-mono border border-slate-300 dark:border-slate-700 rounded"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Origine du constat *
                </label>
                <select
                  value={newSourceType}
                  onChange={(e) => setNewSourceType(e.target.value as DefectiveSourceType)}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
                >
                  <option value="PURCHASE_RECEIPT">📦 Réception Commande Achat</option>
                  <option value="CUSTOMER_RETURN">👤 Retour Client Défectueux</option>
                  <option value="MANUAL_INSPECTION">🛡️ Inspection Magasin / Stock</option>
                  <option value="SAV_INTERVENTION">🔧 Atelier SAV</option>
                </select>
              </div>
            </div>

            {newSourceType === 'PURCHASE_RECEIPT' && (
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Fournisseur concerné
                </label>
                <select
                  value={newSupplierId}
                  onChange={(e) => setNewSupplierId(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
                >
                  {suppliers.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.city})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {newSourceType === 'CUSTOMER_RETURN' && (
              <div>
                <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Client concerné
                </label>
                <select
                  value={newCustomerId}
                  onChange={(e) => setNewCustomerId(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
                >
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.phone || c.city})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                N° Document associé (ex: N° bon commande, N° vente...)
              </label>
              <input
                type="text"
                placeholder="Ex: ACH-2026-0004 ou V-2026-0012"
                value={newSourceDocNumber}
                onChange={(e) => setNewSourceDocNumber(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Description précise de la défectuosité / Panne constatée *
              </label>
              <textarea
                required
                rows={2}
                placeholder="Ex: Membrane percée, carton écrasé avec fuite sur le carter, moteur de pompe grippé..."
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded"
              />
            </div>

            <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
              <label className="flex items-center gap-2 cursor-pointer font-medium text-slate-700 dark:text-slate-300">
                <input
                  type="checkbox"
                  checked={newDeductFromStock}
                  onChange={(e) => setNewDeductFromStock(e.target.checked)}
                  className="rounded border-slate-300 text-red-700 focus:ring-red-500"
                />
                <span>
                  Déduire immédiatement cette quantité ({newQty}) du stock vendable actif
                </span>
              </label>
              <p className="text-[11px] text-slate-500 ml-5 mt-0.5">
                Cochez cette case si l'article était déjà physiquement présent dans votre stock et doit être retiré pour entrer en Quarantaine.
              </p>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setShowDeclareModal(false)}
                className="px-3 py-2 border border-slate-300 rounded font-medium hover:bg-slate-100"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-red-700 text-white font-semibold rounded hover:bg-red-800"
              >
                Enregistrer la mise en Quarantaine
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modale Résolution / Traitement */}
      {resolvingItem && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handleResolveSubmit}
            className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg max-w-lg w-full p-6 space-y-4 text-xs shadow-xl"
          >
            <div className="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white">
                  Traitement du Dossier Défectueux {resolvingItem.number}
                </h3>
                <p className="text-slate-500 mt-0.5">
                  {resolvingItem.productName} · {resolvingItem.quantity} unité(s)
                </p>
              </div>
              <button
                type="button"
                onClick={() => setResolvingItem(null)}
                className="p-1 text-slate-400 hover:text-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded space-y-1">
              <div className="text-[11px] font-semibold text-red-900 dark:text-red-300">
                Motif constaté :
              </div>
              <div className="text-xs text-red-800 dark:text-red-400">
                {resolvingItem.defectReason}
              </div>
            </div>

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Décision / Nouveau Statut *
              </label>
              <select
                value={resolveStatus}
                onChange={(e) => setResolveStatus(e.target.value as DefectiveStatus)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800 font-semibold"
              >
                <option value="REPARE_REMIS_EN_STOCK">
                  ✅ Réparé par nos soins → Réintégrer automatiquement en stock vendable (+{resolvingItem.quantity})
                </option>
                <option value="RETOURNE_FOURNISSEUR">
                  🚚 Retourné au Fournisseur pour RMA / Échange
                </option>
                <option value="REMPLACE_FOURNISSEUR">
                  📦 Remplacé à neuf par le Fournisseur
                </option>
                <option value="AVOIR_FOURNISSEUR">
                  💰 Avoir / Note de crédit obtenue du Fournisseur
                </option>
                <option value="REBUTE_PERTE">
                  🗑️ Mis au Rebut / Destruction en perte d'exploitation
                </option>
                <option value="EN_QUARANTAINE">
                  ⏳ Maintenir en Quarantaine (en attente)
                </option>
              </select>
            </div>

            {resolveStatus === 'REPARE_REMIS_EN_STOCK' && (
              <div className="p-3 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900 rounded text-emerald-900 dark:text-emerald-300 text-[11px]">
                ℹ️ <strong>Restauration automatique du stock</strong> : En validant ce statut, les {resolvingItem.quantity} unité(s) seront réintégrées dans le stock physique vendable et un mouvement d'ajustement tracé sera généré.
              </div>
            )}

            <div>
              <label className="block font-medium text-slate-700 dark:text-slate-300 mb-1">
                Notes de traitement / Démarche effectuée *
              </label>
              <textarea
                required
                rows={3}
                placeholder="Ex: Remplacement du joint et test de pression réussi, ou colis expédié au fournisseur via CTM avec N° suivi..."
                value={resolveNotes}
                onChange={(e) => setResolveNotes(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded"
              />
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-200 dark:border-slate-800">
              <button
                type="button"
                onClick={() => setResolvingItem(null)}
                className="px-3 py-2 border border-slate-300 rounded font-medium hover:bg-slate-100"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-2 bg-[#1D4ED8] text-white font-semibold rounded hover:bg-blue-800"
              >
                Valider la décision
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
