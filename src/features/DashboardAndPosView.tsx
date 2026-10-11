import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Barcode,
  Camera,
  CheckCircle2,
  CreditCard,
  FileText,
  Image as ImageIcon,
  Minus,
  Plus,
  Printer,
  ShoppingCart,
  Trash2,
  Wallet,
  X,
  ZoomIn,
} from 'lucide-react';
import { db } from '../db/database';
import {
  AnalyticsPeriodPreset,
  CentralFinancialSnapshot,
  computeCentralFinancialSnapshot,
} from '../domain/analyticsEngine';
import { ArbitrageError } from '../domain/arbitrageEngine';
import {
  calculateDocumentLinesAndTotals,
  centsToDh,
  dhToCents,
  DocumentLineInput,
  formatMad,
} from '../domain/financialEngine';
import {
  buildCashJournalPeriodPrint,
  buildExpensesPeriodPrint,
  buildInvoiceA4Print,
  buildSalesPeriodReportPrint,
  buildTicket80mmPrint,
  PrintableDocument,
} from '../printing/printTemplates';
import { executeCreateSale } from '../services/commandService';
import {
  AppSettings,
  Category,
  CompanyInfo,
  Customer,
  PaymentMethod,
  Product,
  UserProfile,
} from '../types/domain';
import { formatBusinessDateFr } from '../utils/dateUtils';
import { compressProductPhoto } from '../utils/securityUtils';

/**
 * SECTION 14 : TABLEAU DE BORD PROFESSIONNEL
 */
export const DashboardView: React.FC<{
  company: CompanyInfo;
  onNavigate: (tab: string) => void;
  refreshTrigger: number;
  onOpenPrintPreview: (doc: PrintableDocument) => void;
}> = ({ company, onNavigate, refreshTrigger, onOpenPrintPreview }) => {
  const [preset, setPreset] = useState<AnalyticsPeriodPreset>('30_DAYS');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [snapshot, setSnapshot] = useState<CentralFinancialSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    computeCentralFinancialSnapshot(preset, customStart, customEnd).then((res) => {
      if (active) setSnapshot(res);
    });
    return () => {
      active = false;
    };
  }, [preset, customStart, customEnd, refreshTrigger]);

  if (!snapshot) {
    return (
      <div className="p-8 space-y-4">
        <div className="h-8 w-64 bg-slate-200 animate-pulse rounded" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((n) => (
            <div key={n} className="h-28 bg-slate-200 animate-pulse rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  const periodOptions: { key: AnalyticsPeriodPreset; label: string }[] = [
    { key: 'TODAY', label: "Aujourd'hui" },
    { key: '7_DAYS', label: '7 jours' },
    { key: '30_DAYS', label: '30 jours' },
    { key: '3_MONTHS', label: '3 mois' },
    { key: '12_MONTHS', label: '12 mois' },
    { key: 'CUSTOM', label: 'Personnalisée' },
  ];

  const handlePrintPeriodReport = async (type: 'SALES' | 'CASH' | 'EXPENSES') => {
    const pStart = snapshot.periodStart;
    const pEnd = snapshot.periodEnd;
    if (type === 'SALES') {
      const allSales = await db.sales.toArray();
      const filtered = allSales.filter((s) => s.businessDate >= pStart && s.businessDate <= pEnd);
      onOpenPrintPreview(buildSalesPeriodReportPrint(company, filtered, pStart, pEnd));
    } else if (type === 'CASH') {
      const allCash = await db.cashEntries.toArray();
      const filtered = allCash.filter((c) => c.businessDate >= pStart && c.businessDate <= pEnd);
      onOpenPrintPreview(
        buildCashJournalPeriodPrint(
          company,
          filtered,
          pStart,
          pEnd,
          snapshot.physicalCashBalanceCents
        )
      );
    } else {
      const allExp = await db.expenses.toArray();
      const filtered = allExp.filter((e) => e.businessDate >= pStart && e.businessDate <= pEnd);
      onOpenPrintPreview(buildExpensesPeriodPrint(company, filtered, pStart, pEnd));
    }
  };

  return (
    <div className="space-y-6">
      {/* En-tête de filtre de période & États PDF */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-slate-100">
              Synthèse d&apos;Exploitation & Trésorerie
            </h1>
            <div className="flex items-center gap-2 text-xs text-slate-500 mt-0.5">
              <span>Fuseau Africa/Casablanca</span>
              <span aria-hidden="true">·</span>
              <span>Journée marocaine : {formatBusinessDateFr(snapshot.todayBusinessDate)}</span>
              <span aria-hidden="true">·</span>
              <span>
                Période : {formatBusinessDateFr(snapshot.periodStart)} au{' '}
                {formatBusinessDateFr(snapshot.periodEnd)}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
              {periodOptions.map((opt) => (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => setPreset(opt.key)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    preset === opt.key
                      ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-white shadow-xs'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {preset === 'CUSTOM' && (
              <div className="flex items-center gap-2 text-xs">
                <input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="px-2 py-1.5 border border-slate-300 rounded font-mono"
                />
                <span>→</span>
                <input
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="px-2 py-1.5 border border-slate-300 rounded font-mono"
                />
              </div>
            )}
          </div>
        </div>

        {/* Barre d'impression et téléchargement PDF rapide des 3 États de la période */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs">
          <span className="text-slate-500 font-medium">
            États imprimables &amp; PDF de la période ({formatBusinessDateFr(snapshot.periodStart)}{' '}
            → {formatBusinessDateFr(snapshot.periodEnd)}) :
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => handlePrintPeriodReport('CASH')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0F172A] text-white font-semibold rounded-md hover:bg-slate-800 transition-colors"
            >
              <Printer className="w-3.5 h-3.5 text-[#D9A95B]" />
              Journal de Caisse (PDF / A4)
            </button>
            <button
              type="button"
              onClick={() => handlePrintPeriodReport('EXPENSES')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-800 text-white font-semibold rounded-md hover:bg-amber-900 transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              Journal des Dépenses (PDF / A4)
            </button>
            <button
              type="button"
              onClick={() => handlePrintPeriodReport('SALES')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1D4ED8] text-white font-semibold rounded-md hover:bg-blue-800 transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              État des Ventes (PDF / A4)
            </button>
          </div>
        </div>
      </div>

      {/* Grille principale des indicateurs financiers (Règles 23 & 24) */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
          <div className="text-xs text-slate-500 font-medium">Chiffre d&apos;Affaires du Jour</div>
          <div className="text-2xl font-bold font-mono-tabular text-slate-900 dark:text-white mt-2">
            {formatMad(snapshot.todayCaTtcCents, company.currency)}
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mt-2 font-mono-tabular">
            <span>HT : {formatMad(snapshot.todayCaHtCents, company.currency)}</span>
            <span aria-hidden="true">·</span>
            <span>Hors annulations</span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
          <div className="text-xs text-slate-500 font-medium">
            CA Période ({snapshot.periodSalesCount} ventes)
          </div>
          <div className="text-2xl font-bold font-mono-tabular text-[#1D4ED8] dark:text-blue-400 mt-2">
            {formatMad(snapshot.periodCaTtcCents, company.currency)}
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mt-2 font-mono-tabular">
            <span>HT : {formatMad(snapshot.periodCaHtCents, company.currency)}</span>
            <span aria-hidden="true">·</span>
            <span>TVA : {formatMad(snapshot.periodVatCollectedCents, company.currency)}</span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
          <div className="text-xs text-slate-500 font-medium">Marge Brute Commerciale (HT)</div>
          <div className="text-2xl font-bold font-mono-tabular text-emerald-700 dark:text-emerald-400 mt-2">
            {formatMad(snapshot.periodGrossMarginCents, company.currency)}
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mt-2 font-mono-tabular">
            <span>Taux de marque : {snapshot.periodMarginRatePercent.toFixed(1)}%</span>
            <span aria-hidden="true">·</span>
            <span>Panier moy. : {formatMad(snapshot.averageBasketTtcCents, company.currency)}</span>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
          <div className="text-xs text-slate-500 font-medium">Trésorerie Globale Disponible</div>
          <div className="text-2xl font-bold font-mono-tabular text-slate-900 dark:text-white mt-2">
            {formatMad(snapshot.totalTreasuryCents, company.currency)}
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-500 mt-2 font-mono-tabular">
            <span>Caisse : {formatMad(snapshot.physicalCashBalanceCents, company.currency)}</span>
            <span aria-hidden="true">·</span>
            <span>Banque : {formatMad(snapshot.bankBalanceCents, company.currency)}</span>
          </div>
        </div>
      </div>

      {/* Deuxième ligne : Encaissements, Décaissements, Créances, Dettes, Valeur Stock */}
      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-4">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
          <div className="text-xs text-slate-500">Encaissements Période</div>
          <div className="text-lg font-bold font-mono-tabular text-emerald-700 mt-1">
            +{formatMad(snapshot.periodCollectionsCents, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1">Flux réels encaissés</div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
          <div className="text-xs text-slate-500">Décaissements Période</div>
          <div className="text-lg font-bold font-mono-tabular text-amber-800 mt-1">
            -{formatMad(snapshot.periodDisbursementsCents, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1 font-mono-tabular">
            Dont charges : {formatMad(snapshot.periodExpensesTtcCents, company.currency)}
          </div>
        </div>

        <button
          type="button"
          onClick={() => onNavigate('invoices')}
          className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-400 rounded-lg p-4 transition-colors"
        >
          <div className="text-xs text-slate-500">Créances Clients</div>
          <div className="text-lg font-bold font-mono-tabular text-amber-700 mt-1">
            {formatMad(snapshot.customerReceivablesCents, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {snapshot.unpaidInvoicesCount} facture(s) en attente →
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('suppliers')}
          className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-400 rounded-lg p-4 transition-colors"
        >
          <div className="text-xs text-slate-500">Dettes Fournisseurs</div>
          <div className="text-lg font-bold font-mono-tabular text-red-700 mt-1">
            {formatMad(snapshot.supplierDebtsCents, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1">
            {snapshot.pendingPurchasesCount} achat(s) en réception →
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('stock')}
          className="text-left bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 hover:border-slate-400 rounded-lg p-4 transition-colors"
        >
          <div className="text-xs text-slate-500">Valeur du Stock (Coût HT)</div>
          <div className="text-lg font-bold font-mono-tabular text-slate-900 dark:text-white mt-1">
            {formatMad(snapshot.stockValueCostCents, company.currency)}
          </div>
          <div className="text-xs text-slate-500 mt-1 font-mono-tabular">
            Vente HT : {formatMad(snapshot.stockValueSaleHtCents, company.currency)}
          </div>
        </button>
      </div>

      {/* Troisième ligne : Alertes opérationnelles & Meilleurs Produits */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">
              Vigilance Opérationnelle (Stock, SAV & Achats)
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('pos')}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-[#1D4ED8] hover:underline"
            >
              Ouvrir Caisse POS (F2) <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="divide-y divide-slate-100 dark:divide-slate-800 text-sm">
            <div className="py-3 flex items-center justify-between">
              <div>
                <div className="font-medium text-slate-900 dark:text-slate-100">
                  Ruptures de stock & Articles critiques
                </div>
                <div className="text-xs text-slate-500">
                  Membranes, cartouches ou équipements sous le seuil minimum
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('stock')}
                className="px-3 py-1.5 text-xs font-mono-tabular font-medium border border-red-200 bg-red-50 text-red-800 rounded hover:bg-red-100"
              >
                {snapshot.outOfStockCount} rupture(s) · {snapshot.criticalStockCount} critique(s)
              </button>
            </div>

            <div className="py-3 flex items-center justify-between">
              <div>
                <div className="font-medium text-slate-900 dark:text-slate-100">
                  Rappels SAV & Remplacement périodique des filtres
                </div>
                <div className="text-xs text-slate-500">
                  Échéances dépassées ou à moins de 15 jours
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('sav')}
                className="px-3 py-1.5 text-xs font-mono-tabular font-medium border border-amber-200 bg-amber-50 text-amber-900 rounded hover:bg-amber-100"
              >
                {snapshot.urgentSavCount} suivi(s) prioritaire(s)
              </button>
            </div>

            <div className="py-3 flex items-center justify-between">
              <div>
                <div className="font-medium text-slate-900 dark:text-slate-100">
                  Commandes fournisseurs en attente de réception
                </div>
                <div className="text-xs text-slate-500">
                  Règle 6 : Le stock augmente uniquement lors de la réception physique
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('purchases')}
                className="px-3 py-1.5 text-xs font-mono-tabular font-medium border border-slate-200 bg-slate-50 text-slate-800 rounded hover:bg-slate-100"
              >
                {snapshot.pendingPurchasesCount} commande(s)
              </button>
            </div>

            <div className="py-3 flex items-center justify-between">
              <div>
                <div className="font-medium text-slate-900 dark:text-slate-100">
                  Factures clients impayées ou partiellement réglées
                </div>
                <div className="text-xs text-slate-500">
                  Suivi des encaissements et relances clients
                </div>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('invoices')}
                className="px-3 py-1.5 text-xs font-mono-tabular font-medium border border-slate-200 bg-slate-50 text-slate-800 rounded hover:bg-slate-100"
              >
                {snapshot.unpaidInvoicesCount} facture(s)
              </button>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">
              Meilleurs Produits sur la Période
            </h2>
            <button
              type="button"
              onClick={() => onNavigate('intelligence')}
              className="text-xs text-[#1D4ED8] hover:underline"
            >
              Analyse complète →
            </button>
          </div>

          {snapshot.topProducts.length === 0 ? (
            <div className="py-12 text-center text-xs text-slate-500">
              Aucune vente validée sur la période sélectionnée.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500 text-left">
                    <th className="py-2 font-medium">Référence & Produit</th>
                    <th className="py-2 font-medium text-right">Qté</th>
                    <th className="py-2 font-medium text-right">CA TTC</th>
                    <th className="py-2 font-medium text-right">Marge HT</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {snapshot.topProducts.map((tp) => (
                    <tr key={tp.productId} className="hover:bg-slate-50/70">
                      <td className="py-2.5 pr-2">
                        <div className="font-medium text-slate-900 truncate max-w-[240px]">
                          {tp.productName}
                        </div>
                        <div className="font-mono text-[11px] text-slate-500">{tp.productRef}</div>
                      </td>
                      <td className="py-2.5 text-right font-mono-tabular font-semibold">
                        {tp.qtySold}
                      </td>
                      <td className="py-2.5 text-right font-mono-tabular">
                        {formatMad(tp.revenueTtcCents)}
                      </td>
                      <td className="py-2.5 text-right font-mono-tabular text-emerald-700 font-medium">
                        +{formatMad(tp.marginCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * SECTION 15 : CAISSE POS ULTRA-RAPIDE
 */
interface PosCartItem {
  product: Product;
  quantity: number;
  unitPriceHtCents: number;
  discountPercent: number;
  discountAmountHtCents?: number;
  discountAmountInput?: string;
  vatRate: number;
}

export const PosView: React.FC<{
  company: CompanyInfo;
  settings: AppSettings;
  currentProfile: UserProfile | null;
  onSaleCompleted: () => void;
  onOpenPrintPreview: (doc: PrintableDocument) => void;
}> = ({ company, settings, currentProfile, onSaleCompleted, onOpenPrintPreview }) => {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('ALL');
  const [cart, setCart] = useState<PosCartItem[]>([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>(
    settings.defaultCounterCustomerId || 'cust-1'
  );
  const [globalDiscountPercent, setGlobalDiscountPercent] = useState<number>(0);
  const [globalDiscountAmountCents, setGlobalDiscountAmountCents] = useState<number | undefined>(
    undefined
  );
  const [globalDiscountAmountInput, setGlobalDiscountAmountInput] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('CASH');
  const [amountReceivedDhInput, setAmountReceivedDhInput] = useState<string>('');
  const [paymentReference, setPaymentReference] = useState<string>('');
  const [confirmOverpaymentCredit, setConfirmOverpaymentCredit] = useState<boolean>(false);
  const [submitting, setSubmitting] = useState(false);
  const [previewPhotoProduct, setPreviewPhotoProduct] = useState<Product | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
    lastSaleNumber?: string;
  } | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && previewPhotoProduct) {
        setPreviewPhotoProduct(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewPhotoProduct]);

  const handlePosQuickPhotoUpload = async (
    product: Product,
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const compressed = await compressProductPhoto(file);
      const now = new Date().toISOString();
      await db.products.update(product.id, {
        photoUrl: compressed.dataUrl,
        updatedAt: now,
      });
      const freshProducts = await db.products.filter((p) => p.active).toArray();
      setProducts(freshProducts);
      setCart((prev) =>
        prev.map((c) =>
          c.product.id === product.id
            ? { ...c, product: { ...c.product, photoUrl: compressed.dataUrl } }
            : c
        )
      );
      const updated = freshProducts.find((p) => p.id === product.id);
      if (updated) setPreviewPhotoProduct(updated);
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      e.target.value = '';
    }
  };

  useEffect(() => {
    Promise.all([
      db.products.filter((p) => p.active).toArray(),
      db.categories.filter((c) => c.active).toArray(),
      db.customers.filter((c) => c.active).toArray(),
    ]).then(([prods, cats, custs]) => {
      setProducts(prods);
      setCategories(cats);
      setCustomers(custs);
      if (custs.length > 0 && !custs.some((c) => c.id === selectedCustomerId)) {
        const counter = custs.find((c) => c.code === 'CLI-COMPTOIR') ?? custs[0];
        setSelectedCustomerId(counter.id);
      }
    });
  }, [selectedCustomerId]);

  // Liste unifiée des catégories (base categories + catégories issues des produits importés) avec compteur d'articles
  const posCategoryOptions = useMemo(() => {
    const map = new Map<string, { key: string; id?: string; name: string; count: number }>();
    for (const c of categories) {
      const cleanName = (c.name || '').trim();
      if (cleanName) {
        map.set(cleanName.toLowerCase(), {
          key: c.id,
          id: c.id,
          name: cleanName,
          count: 0,
        });
      }
    }
    for (const p of products) {
      const cName = (p.categoryName || '').trim();
      const byId = Array.from(map.values()).find((entry) => entry.id && entry.id === p.categoryId);
      if (byId) {
        byId.count += 1;
      } else if (cName) {
        const lower = cName.toLowerCase();
        const existing = map.get(lower);
        if (existing) {
          existing.count += 1;
        } else {
          map.set(lower, {
            key: cName,
            name: cName,
            count: 1,
          });
        }
      }
    }
    return Array.from(map.values())
      .filter((c) => c.count > 0 || categories.some((dbCat) => dbCat.id === c.id))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }, [categories, products]);

  const filteredProducts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const selectedOpt = posCategoryOptions.find((o) => o.key === selectedCategoryId);
    return products.filter((p) => {
      if (selectedCategoryId !== 'ALL') {
        const matchesId = p.categoryId === selectedCategoryId;
        const matchesName =
          (p.categoryName || '').trim().toLowerCase() === selectedCategoryId.trim().toLowerCase() ||
          (selectedOpt &&
            (p.categoryName || '').trim().toLowerCase() === selectedOpt.name.toLowerCase());
        if (!matchesId && !matchesName) return false;
      }
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.reference.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q) ||
        (p.categoryName || '').toLowerCase().includes(q)
      );
    });
  }, [products, searchQuery, selectedCategoryId, posCategoryOptions]);

  const lineInputs: DocumentLineInput[] = useMemo(
    () =>
      cart.map((item) => ({
        productId: item.product.id,
        productRef: item.product.reference,
        productName: item.product.name,
        quantity: item.quantity,
        unitCostCents: item.product.purchasePriceCents,
        unitPriceHtCents: item.unitPriceHtCents,
        discountPercent: item.discountPercent,
        discountAmountHtCents: item.discountAmountHtCents,
        vatRate: item.vatRate,
      })),
    [cart]
  );

  const totals = useMemo(
    () =>
      calculateDocumentLinesAndTotals(
        lineInputs,
        globalDiscountPercent,
        globalDiscountAmountCents
      ),
    [lineInputs, globalDiscountPercent, globalDiscountAmountCents]
  );

  // Synchroniser automatiquement le montant reçu par défaut avec le total TTC quand le panier change
  useEffect(() => {
    if (paymentMethod === 'CREDIT') {
      setAmountReceivedDhInput('0');
    } else {
      setAmountReceivedDhInput(centsToDh(totals.totalTtcCents).toFixed(2));
    }
  }, [totals.totalTtcCents, paymentMethod]);

  const addToCart = (product: Product) => {
    setFeedback(null);
    setCart((prev) => {
      const existingIdx = prev.findIndex((i) => i.product.id === product.id);
      if (existingIdx >= 0) {
        const updated = [...prev];
        updated[existingIdx] = {
          ...updated[existingIdx],
          quantity: updated[existingIdx].quantity + 1,
        };
        return updated;
      }
      return [
        ...prev,
        {
          product,
          quantity: 1,
          unitPriceHtCents: product.salePriceHtCents,
          discountPercent: 0,
          discountAmountHtCents: undefined,
          discountAmountInput: '',
          vatRate: product.vatRate,
        },
      ];
    });
  };

  // Recherche code-barres directe avec Entrée
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && searchQuery.trim()) {
      e.preventDefault();
      const q = searchQuery.trim().toLowerCase();
      const exactMatch =
        products.find(
          (p) => p.barcode.toLowerCase() === q || p.reference.toLowerCase() === q
        ) ?? filteredProducts[0];
      if (exactMatch) {
        addToCart(exactMatch);
        setSearchQuery('');
      }
    }
  };

  const amountReceivedCents = dhToCents(amountReceivedDhInput);
  const changeGivenCents =
    paymentMethod === 'CASH' && !confirmOverpaymentCredit
      ? Math.max(0, amountReceivedCents - totals.totalTtcCents)
      : 0;
  const remainingDueCents =
    paymentMethod === 'CREDIT'
      ? totals.totalTtcCents
      : Math.max(0, totals.totalTtcCents - amountReceivedCents);

  // Détection en temps réel des dépassements de stock (Règle 1)
  const stockContradictions = cart.filter((item) => item.quantity > item.product.stock);

  const handleValidateSale = async (printFormatAfter: 'NONE' | 'TICKET_80MM' | 'A4') => {
    if (cart.length === 0 || submitting) return;
    setSubmitting(true);
    setFeedback(null);

    try {
      const result = await executeCreateSale({
        customerId: selectedCustomerId,
        lines: lineInputs,
        globalDiscountPercent: totals.globalDiscountPercent,
        globalDiscountAmountCents:
          totals.globalDiscountCents > 0 ? totals.globalDiscountCents : undefined,
        paymentMethod,
        amountPaidCents: paymentMethod === 'CREDIT' ? 0 : amountReceivedCents,
        amountReceivedCents,
        paymentReference,
        confirmOverpayment: confirmOverpaymentCredit,
        actor: currentProfile
          ? {
              userId: currentProfile.id,
              userName: currentProfile.name,
              userRole: currentProfile.role,
            }
          : undefined,
      });

      // Rafraîchir les stocks produits affichés
      const freshProducts = await db.products.filter((p) => p.active).toArray();
      setProducts(freshProducts);
      setCart([]);
      setGlobalDiscountPercent(0);
      setGlobalDiscountAmountCents(undefined);
      setGlobalDiscountAmountInput('');
      setPaymentReference('');
      setConfirmOverpaymentCredit(false);
      onSaleCompleted();

      setFeedback({
        type: 'success',
        message: `Vente ${result.sale.number} et Facture ${result.invoice.number} enregistrées (${formatMad(
          result.sale.totalTtcCents
        )}).`,
        lastSaleNumber: result.sale.number,
      });

      if (printFormatAfter === 'TICKET_80MM' || settings.autoPrintTicket) {
        const sItems = await db.saleItems.where('saleId').equals(result.sale.id).toArray();
        onOpenPrintPreview(buildTicket80mmPrint(company, result.sale, sItems));
      } else if (printFormatAfter === 'A4') {
        const invItems = await db.invoiceItems
          .where('invoiceId')
          .equals(result.invoice.id)
          .toArray();
        onOpenPrintPreview(buildInvoiceA4Print(company, result.invoice, invItems));
      }
    } catch (err) {
      if (err instanceof ArbitrageError) {
        setFeedback({
          type: 'error',
          message: err.decision.resolutionMessage,
        });
      } else {
        setFeedback({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
      {/* Colonne gauche : Catalogue Produits & Recherche Code-barres (7 cols) */}
      <div className="lg:col-span-7 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              Caisse POS & Comptoir
            </h1>
            <p className="text-xs text-slate-500">
              Scan code-barres direct (Entrée) · Filtre par catégorie · Remises en % ou en Montant décimal
            </p>
          </div>
          <div className="text-xs text-slate-500 font-mono">
            Stock négatif :{' '}
            <strong className={settings.allowNegativeStock ? 'text-amber-700' : 'text-slate-800'}>
              {settings.allowNegativeStock ? 'Autorisé (Audit)' : 'Bloqué (Règle 1)'}
            </strong>
          </div>
        </div>

        {/* Barre de recherche rapide + Filtre de recherche par catégorie */}
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-center">
          <div className="sm:col-span-7 relative">
            <Barcode className="w-5 h-5 text-slate-400 absolute left-3.5 top-2.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Scanner code-barres, réf., nom ou catégorie + Entrée..."
              className="w-full pl-11 pr-8 py-2 text-sm border border-slate-300 dark:border-slate-700 rounded-md focus:outline-none focus:border-[#1D4ED8] bg-white dark:bg-slate-800"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                title="Effacer la recherche"
                className="absolute right-2.5 top-2.5 text-slate-400 hover:text-slate-700"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>

          <div className="sm:col-span-5 flex items-center gap-1.5">
            <select
              value={selectedCategoryId}
              onChange={(e) => setSelectedCategoryId(e.target.value)}
              aria-label="Filtrer les produits par catégorie"
              className="w-full px-3 py-2 text-xs font-medium border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-100 focus:outline-none focus:border-[#1D4ED8]"
            >
              <option value="ALL">Toutes les catégories ({products.length})</option>
              {posCategoryOptions.map((cat) => (
                <option key={cat.key} value={cat.key}>
                  {cat.name} ({cat.count})
                </option>
              ))}
            </select>
            {(selectedCategoryId !== 'ALL' || searchQuery.trim() !== '') && (
              <button
                type="button"
                onClick={() => {
                  setSelectedCategoryId('ALL');
                  setSearchQuery('');
                }}
                title="Réinitialiser le filtre catégorie et la recherche"
                className="px-2.5 py-2 text-xs font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-200 shrink-0"
              >
                Tous
              </button>
            )}
          </div>
        </div>

        {/* Boutons rapides de filtrage par catégorie */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
          <button
            type="button"
            onClick={() => setSelectedCategoryId('ALL')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
              selectedCategoryId === 'ALL'
                ? 'bg-[#0F172A] text-white'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200'
            }`}
          >
            Toutes ({products.length})
          </button>
          {posCategoryOptions.map((cat) => (
            <button
              key={cat.key}
              type="button"
              onClick={() => setSelectedCategoryId(cat.key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                selectedCategoryId === cat.key
                  ? 'bg-[#0F172A] text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-200'
              }`}
            >
              {cat.name} ({cat.count})
            </button>
          ))}
        </div>

        {/* Grille Produits */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-[560px] overflow-y-auto pr-1">
          {filteredProducts.length === 0 ? (
            <div className="col-span-full py-12 text-center text-xs text-slate-500 border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
              Aucun produit trouvé pour cette catégorie ou cette recherche.
            </div>
          ) : (
            filteredProducts.map((p) => {
              const outOfStock = p.stock <= 0;
              const ttcCents = Math.round(p.salePriceHtCents * (1 + p.vatRate / 100));
              return (
                <div
                  key={p.id}
                  onClick={() => addToCart(p)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      addToCart(p);
                    }
                  }}
                  className="text-left p-3.5 border border-slate-200 dark:border-slate-800 rounded-lg hover:border-[#1D4ED8] hover:bg-blue-50/20 transition-colors flex flex-col justify-between cursor-pointer"
                >
                  <div className="flex items-start gap-3">
                    {/* Miniature photo produit cliquable pour ouvrir la fenêtre d'aperçu */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreviewPhotoProduct(p);
                      }}
                      title={
                        p.photoUrl
                          ? 'Cliquer pour agrandir la photo du produit'
                          : 'Cliquer pour voir / ajouter la photo du produit'
                      }
                      className="relative group w-12 h-12 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 overflow-hidden shrink-0 flex items-center justify-center hover:border-[#1D4ED8] transition-colors"
                    >
                      {p.photoUrl ? (
                        <>
                          <img
                            src={p.photoUrl}
                            alt={p.name}
                            className="w-full h-full object-cover"
                          />
                          <span className="absolute inset-0 bg-slate-900/45 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white">
                            <ZoomIn className="w-4 h-4" />
                          </span>
                        </>
                      ) : (
                        <span className="flex flex-col items-center justify-center text-slate-400 group-hover:text-[#1D4ED8]">
                          <ImageIcon className="w-4 h-4" />
                          <span className="text-[8px] font-mono leading-tight mt-0.5">Photo</span>
                        </span>
                      )}
                    </button>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-1 text-[11px] text-slate-500 font-mono mb-0.5">
                        <span className="truncate">{p.reference}</span>
                        <span
                          className={
                            outOfStock
                              ? 'text-red-700 font-semibold shrink-0'
                              : p.stock <= p.minStock
                              ? 'text-amber-700 font-semibold shrink-0'
                              : 'text-emerald-700 shrink-0'
                          }
                        >
                          Dispo : {p.stock} {p.unit}
                        </span>
                      </div>
                      {p.categoryName && (
                        <div className="text-[10px] text-blue-700 dark:text-blue-400 font-medium truncate mb-0.5">
                          {p.categoryName}
                        </div>
                      )}
                      <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 line-clamp-2">
                        {p.name}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 pt-2 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between">
                    <span className="text-[11px] text-slate-500 font-mono-tabular">
                      {formatMad(p.salePriceHtCents)} HT · TVA {p.vatRate}%
                    </span>
                    <span className="text-xs font-bold font-mono-tabular text-[#0F172A] dark:text-white">
                      {formatMad(ttcCents)} TTC
                    </span>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Colonne droite : Panier, Client, Arbitrage Stock & Règlement (5 cols) */}
      <div className="lg:col-span-5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <ShoppingCart className="w-5 h-5 text-[#1D4ED8]" />
            <h2 className="text-base font-semibold text-slate-900 dark:text-white">
              Panier en cours ({cart.reduce((a, c) => a + c.quantity, 0)} art.)
            </h2>
          </div>
          {cart.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setCart([]);
                setGlobalDiscountPercent(0);
                setGlobalDiscountAmountCents(undefined);
                setGlobalDiscountAmountInput('');
              }}
              className="text-xs text-red-600 hover:underline flex items-center gap-1"
            >
              <Trash2 className="w-3.5 h-3.5" /> Vider
            </button>
          )}
        </div>

        {/* Sélection Client */}
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">
            Client rattaché à la vente
          </label>
          <select
            value={selectedCustomerId}
            onChange={(e) => setSelectedCustomerId(e.target.value)}
            className="w-full px-3 py-2 text-xs border border-slate-300 rounded-md bg-white text-slate-900"
          >
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code}){' '}
                {c.balanceCents > 0 ? `— Créance: ${formatMad(c.balanceCents)}` : ''}
              </option>
            ))}
          </select>
        </div>

        {/* Alerte d'arbitrage Règle 1 si stock insuffisant dans le panier */}
        {stockContradictions.length > 0 && (
          <div
            className={`p-3 rounded-md border text-xs flex items-start gap-2.5 ${
              settings.allowNegativeStock
                ? 'bg-amber-50 border-amber-300 text-amber-900'
                : 'bg-red-50 border-red-300 text-red-800'
            }`}
          >
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-semibold">
                Arbitrage Règle 1 : Stock disponible insuffisant détecté
              </div>
              {stockContradictions.map((sc) => (
                <div key={sc.product.id} className="font-mono text-[11px]">
                  • {sc.product.reference} : Demandé <strong>{sc.quantity}</strong> / Disponible{' '}
                  <strong>{sc.product.stock}</strong>
                </div>
              ))}
              <div>
                {settings.allowNegativeStock
                  ? "Le paramètre « Autoriser stock négatif » est actif : la vente sera enregistrée dans le journal d'audit."
                  : 'La vente sera bloquée tant que la quantité demandée dépasse le stock disponible.'}
              </div>
            </div>
          </div>
        )}

        {/* Lignes du panier */}
        <div className="max-h-[280px] overflow-y-auto divide-y divide-slate-100 border border-slate-200 rounded-md">
          {cart.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-400">
              Cliquez sur un article ou scannez un code-barres pour l&apos;ajouter au panier.
            </div>
          ) : (
            cart.map((item, idx) => {
              const calcLine = totals.lines[idx];
              const lineGrossHtCents = Math.round(item.unitPriceHtCents * item.quantity);
              const displayedLineDiscountDh =
                item.discountAmountInput !== undefined && item.discountAmountInput !== ''
                  ? item.discountAmountInput
                  : calcLine && calcLine.lineDiscountCents > 0
                  ? centsToDh(calcLine.lineDiscountCents).toFixed(2)
                  : '';
              return (
                <div key={item.product.id} className="p-3 space-y-2 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <button
                        type="button"
                        onClick={() => setPreviewPhotoProduct(item.product)}
                        title="Cliquer pour agrandir la photo"
                        className="relative group w-9 h-9 rounded border border-slate-200 bg-slate-50 overflow-hidden shrink-0 flex items-center justify-center hover:border-[#1D4ED8]"
                      >
                        {item.product.photoUrl ? (
                          <img
                            src={item.product.photoUrl}
                            alt={item.product.name}
                            className="w-full h-full object-cover"
                          />
                        ) : (
                          <ImageIcon className="w-3.5 h-3.5 text-slate-400" />
                        )}
                      </button>
                      <div className="min-w-0">
                        <div className="font-medium text-slate-900 dark:text-slate-100 truncate">
                          {item.product.name}
                        </div>
                        <div className="text-[11px] text-slate-500 font-mono">
                          {item.product.reference} · {formatMad(item.unitPriceHtCents)} HT · TVA{' '}
                          {item.vatRate}%
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCart((prev) => prev.filter((_, i) => i !== idx))}
                      className="text-slate-400 hover:text-red-600 p-1 shrink-0"
                      aria-label="Supprimer la ligne"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    {/* Quantité */}
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() =>
                          setCart((prev) =>
                            prev.map((c, i) =>
                              i === idx ? { ...c, quantity: Math.max(1, c.quantity - 1) } : c
                            )
                          )
                        }
                        className="p-1 border border-slate-300 rounded hover:bg-slate-100"
                      >
                        <Minus className="w-3 h-3" />
                      </button>
                      <input
                        type="number"
                        min={1}
                        value={item.quantity}
                        onChange={(e) => {
                          const val = Math.max(1, parseInt(e.target.value, 10) || 1);
                          setCart((prev) =>
                            prev.map((c, i) => (i === idx ? { ...c, quantity: val } : c))
                          );
                        }}
                        className="w-11 text-center font-mono border border-slate-300 rounded py-0.5"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setCart((prev) =>
                            prev.map((c, i) =>
                              i === idx ? { ...c, quantity: c.quantity + 1 } : c
                            )
                          )
                        }
                        className="p-1 border border-slate-300 rounded hover:bg-slate-100"
                      >
                        <Plus className="w-3 h-3" />
                      </button>
                    </div>

                    {/* Remise ligne en % et en Montant avec décimales */}
                    <div className="flex items-center gap-1.5">
                      <div className="flex items-center gap-1" title="Remise ligne en pourcentage (%)">
                        <span className="text-[10px] text-slate-500">Rem.%</span>
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          max={100}
                          value={calcLine ? calcLine.discountPercent : item.discountPercent}
                          onChange={(e) => {
                            const disc = Math.max(
                              0,
                              Math.min(100, parseFloat(e.target.value) || 0)
                            );
                            setCart((prev) =>
                              prev.map((c, i) =>
                                i === idx
                                  ? {
                                      ...c,
                                      discountPercent: disc,
                                      discountAmountHtCents: undefined,
                                      discountAmountInput: '',
                                    }
                                  : c
                              )
                            );
                          }}
                          className="w-14 px-1.5 py-0.5 text-right font-mono border border-slate-300 rounded bg-white text-slate-900"
                        />
                      </div>

                      <div
                        className="flex items-center gap-1"
                        title="Remise ligne en montant avec décimales (HT)"
                      >
                        <span className="text-[10px] text-slate-500">Rem.{company.currency}</span>
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          placeholder="0.00"
                          value={displayedLineDiscountDh}
                          onChange={(e) => {
                            const rawVal = e.target.value;
                            if (rawVal.trim() === '') {
                              setCart((prev) =>
                                prev.map((c, i) =>
                                  i === idx
                                    ? {
                                        ...c,
                                        discountPercent: 0,
                                        discountAmountHtCents: undefined,
                                        discountAmountInput: '',
                                      }
                                    : c
                                )
                              );
                              return;
                            }
                            const cents = Math.max(
                              0,
                              Math.min(lineGrossHtCents, dhToCents(rawVal))
                            );
                            const pct =
                              lineGrossHtCents > 0
                                ? Math.round((cents / lineGrossHtCents) * 10000) / 100
                                : 0;
                            setCart((prev) =>
                              prev.map((c, i) =>
                                i === idx
                                  ? {
                                      ...c,
                                      discountPercent: pct,
                                      discountAmountHtCents: cents,
                                      discountAmountInput: rawVal,
                                    }
                                  : c
                              )
                            );
                          }}
                          className="w-16 px-1.5 py-0.5 text-right font-mono border border-amber-300 bg-amber-50/40 rounded text-slate-900"
                        />
                      </div>
                    </div>

                    {/* Total ligne TTC */}
                    <div className="text-right font-mono-tabular font-semibold text-slate-900 dark:text-white ml-auto">
                      {formatMad(calcLine?.lineTtcCents ?? 0)}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Calculs de remise globale (% et Montant avec décimales) et ventilation TVA (Règles 10 & 11) */}
        <div className="bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-800 rounded-md p-3.5 space-y-2 text-xs">
          {totals.lineDiscountTotalCents > 0 && (
            <div className="flex items-center justify-between text-amber-800">
              <span>Total remises lignes HT</span>
              <span className="font-mono-tabular font-medium">
                -{formatMad(totals.lineDiscountTotalCents)}
              </span>
            </div>
          )}

          <div className="flex items-center justify-between">
            <span className="text-slate-600 dark:text-slate-300">
              Sous-total HT (net remises lignes)
            </span>
            <span className="font-mono-tabular font-medium">
              {formatMad(totals.subtotalHtCents)}
            </span>
          </div>

          {/* Remise globale : double saisie synchronisée en % OU en Montant avec décimales */}
          <div className="py-1.5 border-y border-slate-200 dark:border-slate-700 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="font-medium text-slate-700 dark:text-slate-200">
                Remise globale (% ou Montant décimal)
              </span>
              <span className="font-mono-tabular font-semibold text-amber-800 dark:text-amber-400">
                -{formatMad(totals.globalDiscountCents)}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center justify-between gap-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-2 py-1">
                <label className="text-[11px] text-slate-500 whitespace-nowrap">En % :</label>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  max={100}
                  value={totals.globalDiscountPercent}
                  onChange={(e) => {
                    const pct = Math.max(0, Math.min(100, parseFloat(e.target.value) || 0));
                    setGlobalDiscountPercent(pct);
                    setGlobalDiscountAmountCents(undefined);
                    setGlobalDiscountAmountInput('');
                  }}
                  className="w-full text-right font-mono text-xs bg-transparent focus:outline-none text-slate-900 dark:text-white"
                />
                <span className="text-[11px] font-mono text-slate-400">%</span>
              </div>

              <div className="flex items-center justify-between gap-1.5 bg-amber-50/60 dark:bg-slate-900 border border-amber-300 dark:border-amber-700 rounded px-2 py-1">
                <label className="text-[11px] font-medium text-amber-900 dark:text-amber-300 whitespace-nowrap">
                  Montant :
                </label>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  placeholder="0.00"
                  value={
                    globalDiscountAmountInput !== ''
                      ? globalDiscountAmountInput
                      : totals.globalDiscountCents > 0
                      ? centsToDh(totals.globalDiscountCents).toFixed(2)
                      : ''
                  }
                  onChange={(e) => {
                    const raw = e.target.value;
                    setGlobalDiscountAmountInput(raw);
                    if (raw.trim() === '') {
                      setGlobalDiscountAmountCents(undefined);
                      setGlobalDiscountPercent(0);
                      return;
                    }
                    const cents = Math.max(
                      0,
                      Math.min(totals.subtotalHtCents, dhToCents(raw))
                    );
                    setGlobalDiscountAmountCents(cents);
                  }}
                  className="w-full text-right font-mono text-xs bg-transparent focus:outline-none font-semibold text-slate-900 dark:text-white"
                />
                <span className="text-[10px] font-mono text-amber-800 dark:text-amber-400">
                  {company.currency}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-slate-600">Base Taxable HT</span>
            <span className="font-mono-tabular font-medium">
              {formatMad(totals.totalTaxableCents)}
            </span>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-slate-600">Total TVA (calculée ligne par ligne)</span>
            <span className="font-mono-tabular font-medium">
              {formatMad(totals.totalVatCents)}
            </span>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-300 text-base font-bold text-slate-900 dark:text-white">
            <span>NET À PAYER TTC</span>
            <span className="font-mono-tabular text-[#1D4ED8] dark:text-blue-400">
              {formatMad(totals.totalTtcCents)}
            </span>
          </div>
        </div>

        {/* Mode de paiement (Règle 4 : Séparation Caisse vs Banque) */}
        <div className="space-y-3">
          <div className="grid grid-cols-5 gap-1.5">
            {(
              [
                { id: 'CASH', label: 'Espèces' },
                { id: 'CARD', label: 'Carte' },
                { id: 'TRANSFER', label: 'Virement' },
                { id: 'CHECK', label: 'Chèque' },
                { id: 'CREDIT', label: 'Crédit' },
              ] as { id: PaymentMethod; label: string }[]
            ).map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setPaymentMethod(m.id)}
                className={`py-2 px-2 text-xs font-medium rounded border text-center transition-colors whitespace-nowrap ${
                  paymentMethod === m.id
                    ? 'bg-[#0F172A] text-white border-[#0F172A]'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          {paymentMethod !== 'CREDIT' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  Montant reçu ({company.currency})
                </label>
                <input
                  type="number"
                  step="0.01"
                  value={amountReceivedDhInput}
                  onChange={(e) => setAmountReceivedDhInput(e.target.value)}
                  className="w-full px-3 py-1.5 text-sm font-mono border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-600 mb-1">
                  {changeGivenCents > 0 ? 'Rendu monnaie espèces' : 'Reste à payer (Créance)'}
                </label>
                <div
                  className={`px-3 py-1.5 text-sm font-mono-tabular font-bold rounded-md border ${
                    changeGivenCents > 0
                      ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                      : remainingDueCents > 0
                      ? 'bg-amber-50 border-amber-200 text-amber-800'
                      : 'bg-slate-50 border-slate-200 text-slate-700'
                  }`}
                >
                  {changeGivenCents > 0
                    ? formatMad(changeGivenCents)
                    : formatMad(remainingDueCents)}
                </div>
              </div>
            </div>
          )}

          {paymentMethod !== 'CASH' && paymentMethod !== 'CREDIT' && (
            <div>
              <label className="block text-[11px] font-medium text-slate-600 mb-1">
                Référence Virement / Chèque / TPE (Destination : Banque / Effets — Règle 4)
              </label>
              <input
                type="text"
                value={paymentReference}
                onChange={(e) => setPaymentReference(e.target.value)}
                placeholder="Ex: N° Chèque ou Réf Virement..."
                className="w-full px-3 py-1.5 text-xs font-mono border border-slate-300 rounded-md"
              />
            </div>
          )}
        </div>

        {/* Message de retour / Arbitrage */}
        {feedback && (
          <div
            className={`p-3 rounded-md border text-xs flex items-start gap-2 ${
              feedback.type === 'success'
                ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                : 'bg-red-50 border-red-300 text-red-900'
            }`}
          >
            {feedback.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5 text-emerald-700" />
            ) : (
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-700" />
            )}
            <span>{feedback.message}</span>
          </div>
        )}

        {/* Boutons d'action de validation */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-2">
          <button
            type="button"
            disabled={cart.length === 0 || submitting}
            onClick={() => handleValidateSale('NONE')}
            className="py-2.5 px-3 bg-[#0F172A] text-white text-xs font-semibold rounded-md hover:bg-slate-800 disabled:opacity-40 flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            <Wallet className="w-4 h-4" />
            Encaisser
          </button>

          <button
            type="button"
            disabled={cart.length === 0 || submitting}
            onClick={() => handleValidateSale('TICKET_80MM')}
            className="py-2.5 px-3 bg-[#1D4ED8] text-white text-xs font-semibold rounded-md hover:bg-blue-800 disabled:opacity-40 flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            <Printer className="w-4 h-4" />
            Ticket 80mm
          </button>

          <button
            type="button"
            disabled={cart.length === 0 || submitting}
            onClick={() => handleValidateSale('A4')}
            className="py-2.5 px-3 bg-emerald-700 text-white text-xs font-semibold rounded-md hover:bg-emerald-800 disabled:opacity-40 flex items-center justify-center gap-1.5 whitespace-nowrap"
          >
            <FileText className="w-4 h-4" />
            Facture A4
          </button>
        </div>
      </div>

      {/* Fenêtre modale d'aperçu Photo Produit au clic sur la miniature dans la Caisse */}
      {previewPhotoProduct && (
        <div
          onClick={() => setPreviewPhotoProduct(null)}
          className="fixed inset-0 z-50 bg-slate-950/75 flex items-center justify-center p-4 overflow-y-auto"
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg max-w-lg w-full overflow-hidden shadow-2xl text-xs"
          >
            <div className="px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-bold text-slate-900 dark:text-white">
                  {previewPhotoProduct.name}
                </h3>
                <div className="font-mono text-[11px] text-slate-500">
                  Réf : {previewPhotoProduct.reference} · Code-barres :{' '}
                  {previewPhotoProduct.barcode}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPreviewPhotoProduct(null)}
                className="p-1.5 text-slate-400 hover:text-slate-800 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 bg-slate-50 dark:bg-slate-950 flex items-center justify-center min-h-[260px] max-h-[65vh]">
              {previewPhotoProduct.photoUrl ? (
                <img
                  src={previewPhotoProduct.photoUrl}
                  alt={previewPhotoProduct.name}
                  className="max-h-[58vh] max-w-full w-auto h-auto object-contain rounded border border-slate-200 bg-white shadow-xs"
                />
              ) : (
                <div className="text-center py-10 space-y-2 text-slate-500">
                  <ImageIcon className="w-10 h-10 mx-auto text-slate-300" />
                  <div>Aucune photo enregistrée pour cet article.</div>
                </div>
              )}
            </div>

            <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-slate-900">
              <div className="font-mono-tabular text-slate-700 dark:text-slate-300">
                Prix TTC :{' '}
                <strong className="text-slate-900 dark:text-white">
                  {formatMad(
                    Math.round(
                      previewPhotoProduct.salePriceHtCents *
                        (1 + previewPhotoProduct.vatRate / 100)
                    )
                  )}
                </strong>{' '}
                · Dispo : <strong>{previewPhotoProduct.stock}</strong> {previewPhotoProduct.unit}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-slate-300 bg-slate-50 text-slate-800 font-medium rounded cursor-pointer hover:bg-slate-100">
                  <Camera className="w-3.5 h-3.5" />
                  {previewPhotoProduct.photoUrl ? 'Changer photo' : 'Ajouter photo'}
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    onChange={(e) => handlePosQuickPhotoUpload(previewPhotoProduct, e)}
                    className="hidden"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => {
                    addToCart(previewPhotoProduct);
                    setPreviewPhotoProduct(null);
                  }}
                  className="px-3 py-1.5 bg-[#1D4ED8] text-white font-semibold rounded hover:bg-blue-800"
                >
                  + Ajouter au panier
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewPhotoProduct(null)}
                  className="px-3 py-1.5 bg-[#0F172A] text-white font-medium rounded"
                >
                  Fermer
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
