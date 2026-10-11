import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  Archive,
  ArrowUpDown,
  Camera,
  CheckCircle2,
  ClipboardCheck,
  Download,
  Image as ImageIcon,
  PackagePlus,
  Plus,
  Printer,
  ShieldAlert,
  Trash2,
  Upload,
  X,
  ZoomIn,
} from 'lucide-react';
import { db, enqueueTransactionalMutation, getAllTables, recordAuditLogInTx } from '../db/database';
import { ArbitrageError } from '../domain/arbitrageEngine';
import {
  centsToDh,
  computeStockStatus,
  dhToCents,
  formatMad,
} from '../domain/financialEngine';
import {
  buildInventoryPvPrint,
  buildProductsAndStockReportPrint,
  PrintableDocument,
} from '../printing/printTemplates';
import {
  downloadExcelImportTemplate,
  executeCommitValidatedImport,
  validateImportData,
} from '../services/backupAndDiagnosticService';
import {
  executeCreateInventorySession,
  executeDeleteOrDeactivateProduct,
  executeUpdateInventoryCounts,
  executeValidateInventorySession,
} from '../services/commandService';
import {
  Category,
  CompanyInfo,
  InventoryItem,
  InventoryMode,
  InventorySession,
  Product,
  StockMovement,
  Supplier,
} from '../types/domain';
import { formatBusinessDateFr, getMoroccoBusinessDate } from '../utils/dateUtils';
import { compressProductPhoto, generateId } from '../utils/securityUtils';

export type ProductSortKey =
  | 'NAME_ASC'
  | 'NAME_DESC'
  | 'REF_ASC'
  | 'REF_DESC'
  | 'CATEGORY_ASC'
  | 'STOCK_ASC'
  | 'STOCK_DESC'
  | 'PA_ASC'
  | 'PA_DESC'
  | 'PV_ASC'
  | 'PV_DESC'
  | 'LOCATION_ASC';

const PRODUCT_SORT_LABELS: Record<ProductSortKey, string> = {
  NAME_ASC: 'Désignation (A → Z)',
  NAME_DESC: 'Désignation (Z → A)',
  REF_ASC: 'Référence (A → Z)',
  REF_DESC: 'Référence (Z → A)',
  CATEGORY_ASC: 'Catégorie (A → Z)',
  STOCK_ASC: 'Stock (Croissant ↑)',
  STOCK_DESC: 'Stock (Décroissant ↓)',
  PA_ASC: 'Prix Achat HT (Croissant ↑)',
  PA_DESC: 'Prix Achat HT (Décroissant ↓)',
  PV_ASC: 'Prix Vente HT/TTC (Croissant ↑)',
  PV_DESC: 'Prix Vente HT/TTC (Décroissant ↓)',
  LOCATION_ASC: 'Emplacement (A → Z)',
};

/**
 * SECTION 22 : CATALOGUE PRODUITS & CONSOMMABLES (Règle 16)
 */
export const ProductsView: React.FC<{
  company?: CompanyInfo;
  refreshTrigger: number;
  onChanged: () => void;
  onOpenPrintPreview?: (doc: PrintableDocument) => void;
}> = ({ company, refreshTrigger, onChanged, onOpenPrintPreview }) => {
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [sortBy, setSortBy] = useState<ProductSortKey>('NAME_ASC');
  const [editingProduct, setEditingProduct] = useState<Partial<Product> | null>(null);
  const [photoCompressionInfo, setPhotoCompressionInfo] = useState<string | null>(null);
  const [previewPhotoProduct, setPreviewPhotoProduct] = useState<Product | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && previewPhotoProduct) {
        setPreviewPhotoProduct(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [previewPhotoProduct]);

  useEffect(() => {
    Promise.all([
      db.products.toArray(),
      db.categories.toArray(),
      db.suppliers.toArray(),
    ]).then(([pList, cList, sList]) => {
      setProducts(pList);
      setCategories(cList);
      setSuppliers(sList);
    });
  }, [refreshTrigger]);

  const openNewProduct = () => {
    setPhotoCompressionInfo(null);
    setEditingProduct({
      reference: `ASW-${Math.floor(1000 + Math.random() * 9000)}`,
      barcode: `61112400${Math.floor(10000 + Math.random() * 89999)}`,
      name: '',
      categoryId: categories[0]?.id ?? 'cat-ro',
      categoryName: categories[0]?.name ?? 'Osmose Inverse',
      subCategory: 'Filtration',
      brandId: 'br-aquapro',
      brandName: 'AquaPro Maroc',
      photoUrl: '',
      purchasePriceCents: 10000,
      salePriceHtCents: 18000,
      minSalePriceHtCents: 15000,
      vatRate: 20,
      stock: 0,
      minStock: 5,
      maxStock: 50,
      unit: 'Unité',
      supplierId: suppliers[0]?.id ?? '',
      supplierName: suppliers[0]?.name ?? '',
      location: 'Allée A - Rack 01',
      replacementMonths: 6,
      compatibleModels: 'Standard 10"',
      notes: '',
    });
  };

  const handleFormPhotoSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !editingProduct) return;
    try {
      const compressed = await compressProductPhoto(file);
      setEditingProduct((prev) => (prev ? { ...prev, photoUrl: compressed.dataUrl } : prev));
      setPhotoCompressionInfo(
        `Compressée automatiquement : ${compressed.originalSizeKb} Ko → ${compressed.compressedSizeKb} Ko (${compressed.width}×${compressed.height} px)`
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      e.target.value = '';
    }
  };

  const handleDirectProductPhotoUpload = async (
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
      onChanged();
      const updatedProd = await db.products.get(product.id);
      if (updatedProd && previewPhotoProduct?.id === product.id) {
        setPreviewPhotoProduct(updatedProd);
      }
      setFeedback(
        `Photo de "${product.name}" enregistrée et compressée (${compressed.originalSizeKb} Ko → ${compressed.compressedSizeKb} Ko).`
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      e.target.value = '';
    }
  };

  const handleRemoveProductPhoto = async (product: Product) => {
    const now = new Date().toISOString();
    await db.products.update(product.id, {
      photoUrl: '',
      updatedAt: now,
    });
    onChanged();
    setPreviewPhotoProduct(null);
    setFeedback(`Photo retirée pour "${product.name}".`);
  };

  const handleSaveProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingProduct || !editingProduct.name || !editingProduct.reference) return;

    const now = new Date().toISOString();
    const bDate = getMoroccoBusinessDate(now);
    const cat = categories.find((c) => c.id === editingProduct.categoryId);
    const sup = suppliers.find((s) => s.id === editingProduct.supplierId);

    await enqueueTransactionalMutation(async () => {
      await db.transaction('rw', getAllTables(db), async () => {
        if (editingProduct.id) {
          await db.products.update(editingProduct.id, {
            ...editingProduct,
            categoryName: cat?.name ?? editingProduct.categoryName ?? '',
            supplierName: sup?.name ?? editingProduct.supplierName ?? '',
            updatedAt: now,
          });
        } else {
          const newId = generateId();
          const initialStock = Number(editingProduct.stock) || 0;
          const prod: Product = {
            id: newId,
            reference: editingProduct.reference!,
            barcode: editingProduct.barcode || editingProduct.reference!,
            name: editingProduct.name!,
            categoryId: editingProduct.categoryId || 'cat-ro',
            categoryName: cat?.name || 'Filtration',
            subCategory: editingProduct.subCategory || '',
            brandId: editingProduct.brandId || 'br-aquapro',
            brandName: editingProduct.brandName || 'AquaPro',
            description: editingProduct.description || '',
            photoUrl: editingProduct.photoUrl || '',
            purchasePriceCents: Number(editingProduct.purchasePriceCents) || 0,
            salePriceHtCents: Number(editingProduct.salePriceHtCents) || 0,
            minSalePriceHtCents: Number(editingProduct.minSalePriceHtCents) || 0,
            vatRate: Number(editingProduct.vatRate) ?? 20,
            stock: initialStock,
            minStock: Number(editingProduct.minStock) || 5,
            maxStock: Number(editingProduct.maxStock) || 50,
            unit: editingProduct.unit || 'Unité',
            supplierId: editingProduct.supplierId || '',
            supplierName: sup?.name || '',
            location: editingProduct.location || 'A1',
            replacementMonths: Number(editingProduct.replacementMonths) || 6,
            compatibleModels: editingProduct.compatibleModels || '',
            notes: editingProduct.notes || '',
            active: true,
            isDemo: false,
            createdAt: now,
            updatedAt: now,
          };
          await db.products.add(prod);

          if (initialStock !== 0) {
            await db.stockMovements.add({
              id: generateId(),
              date: now,
              businessDate: bDate,
              productId: newId,
              productRef: prod.reference,
              productName: prod.name,
              quantity: initialStock,
              stockBefore: 0,
              stockAfter: initialStock,
              type: 'MANUAL_ADJUST',
              sourceDocType: 'MANUAL',
              sourceDocId: newId,
              sourceDocNumber: 'CREATION-PRODUIT',
              reason: 'Stock initial à la création de la fiche produit',
              userId: 'admin',
              userName: 'Administrateur',
              status: 'ACTIVE',
              createdAt: now,
            });
          }
        }
      });
    });

    setEditingProduct(null);
    onChanged();
    setFeedback('Fiche produit enregistrée avec succès.');
  };

  const handleDeleteOrArchive = async (p: Product) => {
    const res = await executeDeleteOrDeactivateProduct(p.id);
    onChanged();
    if (res.mode === 'DEACTIVATED') {
      setFeedback(
        `Arbitrage Règle 16 : Le produit "${p.name}" possède un historique de ventes ou mouvements. Il a été désactivé logiquement (archivé) afin de préserver l'historique.`
      );
    } else {
      setFeedback(`Produit "${p.name}" supprimé (aucun historique lié).`);
    }
  };

  const handleQuickExcelImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      const sheetName =
        wb.SheetNames.find((n) => n.toLowerCase().includes('produit')) || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[sheetName]);
      const report = await validateImportData('PRODUCTS', rows, {});
      const res = await executeCommitValidatedImport(report, { allowSkipErrors: false });
      onChanged();
      setFeedback(
        `Import Excel Produits validé (Règle 25) : ${res.importedCount} article(s) importé(s) avec succès.`
      );
    } catch (err) {
      if (err instanceof ArbitrageError) {
        setFeedback(err.decision.resolutionMessage);
      } else {
        setFeedback(err instanceof Error ? err.message : String(err));
      }
    } finally {
      e.target.value = '';
    }
  };

  const toggleHeaderSort = (ascKey: ProductSortKey, descKey: ProductSortKey) => {
    setSortBy((prev) => (prev === ascKey ? descKey : ascKey));
  };

  const availableCategoryOptions = useMemo(() => {
    const map = new Map<string, { key: string; name: string }>();
    for (const c of categories) {
      if (c.name?.trim()) {
        map.set(c.name.trim().toLowerCase(), { key: c.id, name: c.name.trim() });
      }
    }
    for (const p of products) {
      const cName = (p.categoryName || '').trim();
      if (cName && !map.has(cName.toLowerCase())) {
        map.set(cName.toLowerCase(), { key: cName, name: cName });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }, [categories, products]);

  const filtered = products
    .filter((p) => {
      if (!showArchived && !p.active) return false;
      if (categoryFilter !== 'ALL') {
        const selectedOpt = availableCategoryOptions.find((o) => o.key === categoryFilter);
        const matchesId = p.categoryId === categoryFilter;
        const matchesName =
          p.categoryName.trim().toLowerCase() === categoryFilter.trim().toLowerCase() ||
          (selectedOpt &&
            p.categoryName.trim().toLowerCase() === selectedOpt.name.toLowerCase());
        if (!matchesId && !matchesName) {
          return false;
        }
      }
      if (statusFilter !== 'ALL') {
        const st = computeStockStatus(p.stock, p.minStock, p.maxStock);
        if (statusFilter === 'ALERT_ONLY') {
          if (st !== 'RUPTURE' && st !== 'CRITIQUE' && st !== 'FAIBLE') return false;
        } else if (st !== statusFilter) {
          return false;
        }
      }
      if (!search.trim()) return true;
      const q = search.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.reference.toLowerCase().includes(q) ||
        p.barcode.toLowerCase().includes(q) ||
        p.categoryName.toLowerCase().includes(q) ||
        p.location.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'NAME_ASC':
          return a.name.localeCompare(b.name, 'fr');
        case 'NAME_DESC':
          return b.name.localeCompare(a.name, 'fr');
        case 'REF_ASC':
          return a.reference.localeCompare(b.reference, 'fr', { numeric: true });
        case 'REF_DESC':
          return b.reference.localeCompare(a.reference, 'fr', { numeric: true });
        case 'CATEGORY_ASC':
          return (
            a.categoryName.localeCompare(b.categoryName, 'fr') ||
            a.name.localeCompare(b.name, 'fr')
          );
        case 'STOCK_ASC':
          return a.stock - b.stock;
        case 'STOCK_DESC':
          return b.stock - a.stock;
        case 'PA_ASC':
          return a.purchasePriceCents - b.purchasePriceCents;
        case 'PA_DESC':
          return b.purchasePriceCents - a.purchasePriceCents;
        case 'PV_ASC':
          return a.salePriceHtCents - b.salePriceHtCents;
        case 'PV_DESC':
          return b.salePriceHtCents - a.salePriceHtCents;
        case 'LOCATION_ASC':
          return a.location.localeCompare(b.location, 'fr', { numeric: true });
        default:
          return 0;
      }
    });

  return (
    <div className="space-y-5">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              Catalogue Produits, Membranes & Pièces Détachées
            </h1>
            <p className="text-xs text-slate-500">
              Règles 10 & 16 : Taux de TVA par produit · Périodicité remplacement SAV · Désactivation
              logique si historique ({filtered.length} affiché(s))
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {company && onOpenPrintPreview && (
              <button
                type="button"
                onClick={() =>
                  onOpenPrintPreview(
                    buildProductsAndStockReportPrint(company, filtered, {
                      mode: 'CATALOG',
                      sortLabel: PRODUCT_SORT_LABELS[sortBy],
                      filterLabel:
                        categoryFilter !== 'ALL' || statusFilter !== 'ALL' || search
                          ? `Cat: ${categoryFilter}, Statut: ${statusFilter}${search ? `, Rech: "${search}"` : ''}`
                          : 'Tous les produits actifs',
                    })
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-2 border border-blue-300 bg-blue-50 text-blue-900 text-xs font-medium rounded-md hover:bg-blue-100"
              >
                <Printer className="w-3.5 h-3.5" /> Imprimer / PDF État Produits
              </button>
            )}
            <button
              type="button"
              onClick={() => downloadExcelImportTemplate('PRODUCTS')}
              className="inline-flex items-center gap-1.5 px-3 py-2 border border-emerald-300 bg-emerald-50 text-emerald-900 text-xs font-medium rounded-md hover:bg-emerald-100"
            >
              <Download className="w-3.5 h-3.5" /> Modèle .xlsx
            </button>
            <label className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-300 bg-white text-slate-800 text-xs font-medium rounded-md hover:bg-slate-50 cursor-pointer">
              <Upload className="w-3.5 h-3.5" /> Importer .xlsx
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={handleQuickExcelImport}
                className="hidden"
              />
            </label>
            <button
              type="button"
              onClick={openNewProduct}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#0F172A] text-white text-xs font-medium rounded-md hover:bg-slate-800"
            >
              <Plus className="w-4 h-4" /> Nouveau Produit
            </button>
          </div>
        </div>

        {/* Barre de Recherche, Filtres et Tri */}
        <div className="pt-3 border-t border-slate-100 dark:border-slate-800 flex flex-wrap items-center gap-2.5 text-xs">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher référence, code-barres, désignation, emplacement..."
            className="px-3 py-1.5 text-xs border border-slate-300 rounded-md min-w-[240px] flex-1"
          />

          <div className="flex items-center gap-1.5">
            <span className="text-slate-500 font-medium">Catégorie :</span>
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className="px-2.5 py-1.5 border border-slate-300 rounded-md bg-white"
            >
              <option value="ALL">Toutes les catégories ({products.length})</option>
              {availableCategoryOptions.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-slate-500 font-medium">Statut Stock :</span>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="px-2.5 py-1.5 border border-slate-300 rounded-md bg-white"
            >
              <option value="ALL">Tous les statuts</option>
              <option value="ALERT_ONLY">En alerte (Rupture / Critique / Faible)</option>
              <option value="RUPTURE">Rupture (≤ 0)</option>
              <option value="CRITIQUE">Critique</option>
              <option value="FAIBLE">Faible</option>
              <option value="NORMAL">Normal</option>
              <option value="SURSTOCK">Surstock</option>
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <ArrowUpDown className="w-3.5 h-3.5 text-[#1D4ED8]" />
            <span className="text-slate-700 dark:text-slate-200 font-semibold">Trier par :</span>
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as ProductSortKey)}
              className="px-2.5 py-1.5 border border-blue-300 bg-blue-50/40 rounded-md font-medium text-slate-900"
            >
              {(Object.entries(PRODUCT_SORT_LABELS) as [ProductSortKey, string][]).map(
                ([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                )
              )}
            </select>
          </div>

          <label className="flex items-center gap-1.5 text-xs text-slate-600 px-2 cursor-pointer">
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Inclure archivés
          </label>
        </div>
      </div>

      {feedback && (
        <div className="p-3 bg-blue-50 border border-blue-200 text-blue-900 rounded-md text-xs flex justify-between">
          <span>{feedback}</span>
          <button type="button" onClick={() => setFeedback(null)} className="underline">
            Fermer
          </button>
        </div>
      )}

      {editingProduct && (
        <form
          onSubmit={handleSaveProduct}
          className="bg-white border border-slate-300 rounded-lg p-5 space-y-4 text-xs"
        >
          <h3 className="text-sm font-bold text-slate-900">
            {editingProduct.id ? 'Modifier le produit' : 'Nouvelle fiche produit'}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div>
              <label className="block font-medium text-slate-700 mb-1">Référence *</label>
              <input
                type="text"
                required
                value={editingProduct.reference || ''}
                onChange={(e) =>
                  setEditingProduct({ ...editingProduct, reference: e.target.value })
                }
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Code-barres EAN</label>
              <input
                type="text"
                value={editingProduct.barcode || ''}
                onChange={(e) =>
                  setEditingProduct({ ...editingProduct, barcode: e.target.value })
                }
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block font-medium text-slate-700 mb-1">Désignation *</label>
              <input
                type="text"
                required
                value={editingProduct.name || ''}
                onChange={(e) => setEditingProduct({ ...editingProduct, name: e.target.value })}
                className="w-full px-3 py-1.5 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Catégorie</label>
              <select
                value={editingProduct.categoryId || ''}
                onChange={(e) =>
                  setEditingProduct({ ...editingProduct, categoryId: e.target.value })
                }
                className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Prix d&apos;achat HT (MAD)</label>
              <input
                type="number"
                step="0.01"
                value={centsToDh(editingProduct.purchasePriceCents || 0)}
                onChange={(e) =>
                  setEditingProduct({
                    ...editingProduct,
                    purchasePriceCents: dhToCents(e.target.value),
                  })
                }
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Prix de vente HT (MAD)</label>
              <input
                type="number"
                step="0.01"
                value={centsToDh(editingProduct.salePriceHtCents || 0)}
                onChange={(e) =>
                  setEditingProduct({
                    ...editingProduct,
                    salePriceHtCents: dhToCents(e.target.value),
                  })
                }
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Taux TVA (%)</label>
              <select
                value={editingProduct.vatRate ?? 20}
                onChange={(e) =>
                  setEditingProduct({ ...editingProduct, vatRate: Number(e.target.value) })
                }
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded bg-white"
              >
                <option value={20}>20 %</option>
                <option value={14}>14 %</option>
                <option value={10}>10 %</option>
                <option value={7}>7 %</option>
                <option value={0}>0 % (Exonéré)</option>
              </select>
            </div>
            {!editingProduct.id && (
              <div>
                <label className="block font-medium text-slate-700 mb-1">Stock Initial</label>
                <input
                  type="number"
                  value={editingProduct.stock ?? 0}
                  onChange={(e) =>
                    setEditingProduct({
                      ...editingProduct,
                      stock: parseInt(e.target.value, 10) || 0,
                    })
                  }
                  className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
                />
              </div>
            )}
            <div>
              <label className="block font-medium text-slate-700 mb-1">Seuil Alerte Stock Min</label>
              <input
                type="number"
                value={editingProduct.minStock ?? 5}
                onChange={(e) =>
                  setEditingProduct({
                    ...editingProduct,
                    minStock: parseInt(e.target.value, 10) || 0,
                  })
                }
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Emplacement Dépôt</label>
              <input
                type="text"
                value={editingProduct.location || ''}
                onChange={(e) =>
                  setEditingProduct({ ...editingProduct, location: e.target.value })
                }
                className="w-full px-3 py-1.5 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Cycle remplacement SAV (mois)
              </label>
              <input
                type="number"
                value={editingProduct.replacementMonths ?? 6}
                onChange={(e) =>
                  setEditingProduct({
                    ...editingProduct,
                    replacementMonths: parseInt(e.target.value, 10) || 6,
                  })
                }
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
              />
            </div>

            <div className="md:col-span-3">
              <label className="block font-medium text-slate-700 mb-1">
                Photo du produit (compressée automatiquement au chargement)
              </label>
              <div className="flex flex-wrap items-center gap-3 p-2.5 bg-slate-50 border border-slate-200 rounded">
                {editingProduct.photoUrl ? (
                  <img
                    src={editingProduct.photoUrl}
                    alt={editingProduct.name || 'Aperçu'}
                    className="w-12 h-12 rounded object-cover border border-slate-300 bg-white shrink-0"
                  />
                ) : (
                  <div className="w-12 h-12 rounded border border-dashed border-slate-300 bg-white flex items-center justify-center text-slate-400 shrink-0">
                    <ImageIcon className="w-5 h-5" />
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1D4ED8] text-white font-medium rounded cursor-pointer hover:bg-blue-800">
                    <Camera className="w-3.5 h-3.5" />
                    {editingProduct.photoUrl ? 'Remplacer la photo' : 'Ajouter une photo'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/svg+xml"
                      onChange={handleFormPhotoSelect}
                      className="hidden"
                    />
                  </label>
                  {editingProduct.photoUrl && (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingProduct({ ...editingProduct, photoUrl: '' });
                        setPhotoCompressionInfo(null);
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-red-200 bg-white text-red-700 rounded hover:bg-red-50"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Retirer
                    </button>
                  )}
                </div>
                {photoCompressionInfo && (
                  <span className="text-[11px] font-mono text-emerald-700">
                    ✓ {photoCompressionInfo}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditingProduct(null)}
              className="px-3 py-1.5 border border-slate-300 rounded"
            >
              Annuler
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-[#0F172A] text-white font-medium rounded"
            >
              Enregistrer
            </button>
          </div>
        </form>
      )}

      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600 select-none">
              <th className="py-3 px-3 w-14 text-center">Photo</th>
              <th
                onClick={() => toggleHeaderSort('REF_ASC', 'REF_DESC')}
                className="py-3 px-4 cursor-pointer hover:text-slate-900"
                title="Cliquer pour trier par Référence"
              >
                Réf / Code-barres {sortBy === 'REF_ASC' ? '↑' : sortBy === 'REF_DESC' ? '↓' : '↕'}
              </th>
              <th
                onClick={() => toggleHeaderSort('NAME_ASC', 'NAME_DESC')}
                className="py-3 px-4 cursor-pointer hover:text-slate-900"
                title="Cliquer pour trier par Désignation"
              >
                Désignation & Catégorie{' '}
                {sortBy === 'NAME_ASC' ? '↑' : sortBy === 'NAME_DESC' ? '↓' : '↕'}
              </th>
              <th
                onClick={() => toggleHeaderSort('PA_ASC', 'PA_DESC')}
                className="py-3 px-4 text-right cursor-pointer hover:text-slate-900"
                title="Cliquer pour trier par Prix d'Achat HT"
              >
                P.A HT {sortBy === 'PA_ASC' ? '↑' : sortBy === 'PA_DESC' ? '↓' : '↕'}
              </th>
              <th
                onClick={() => toggleHeaderSort('PV_ASC', 'PV_DESC')}
                className="py-3 px-4 text-right cursor-pointer hover:text-slate-900"
                title="Cliquer pour trier par Prix de Vente HT"
              >
                P.V HT {sortBy === 'PV_ASC' ? '↑' : sortBy === 'PV_DESC' ? '↓' : '↕'}
              </th>
              <th className="py-3 px-4 text-right">TVA</th>
              <th
                onClick={() => toggleHeaderSort('PV_ASC', 'PV_DESC')}
                className="py-3 px-4 text-right cursor-pointer hover:text-slate-900"
                title="Cliquer pour trier par Prix de Vente TTC"
              >
                P.V TTC {sortBy === 'PV_ASC' ? '↑' : sortBy === 'PV_DESC' ? '↓' : '↕'}
              </th>
              <th
                onClick={() => toggleHeaderSort('STOCK_ASC', 'STOCK_DESC')}
                className="py-3 px-4 text-right cursor-pointer hover:text-slate-900"
                title="Cliquer pour trier par Stock"
              >
                Stock {sortBy === 'STOCK_ASC' ? '↑' : sortBy === 'STOCK_DESC' ? '↓' : '↕'}
              </th>
              <th
                onClick={() => toggleHeaderSort('LOCATION_ASC', 'REF_ASC')}
                className="py-3 px-4 cursor-pointer hover:text-slate-900"
                title="Cliquer pour trier par Emplacement"
              >
                Emplacement {sortBy === 'LOCATION_ASC' ? '↑' : '↕'}
              </th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((p) => {
              const ttc = Math.round(p.salePriceHtCents * (1 + p.vatRate / 100));
              const st = computeStockStatus(p.stock, p.minStock, p.maxStock);
              return (
                <tr
                  key={p.id}
                  className={`hover:bg-slate-50/70 ${!p.active ? 'opacity-50 bg-slate-50' : ''}`}
                >
                  <td className="py-2.5 px-3 text-center">
                    {p.photoUrl ? (
                      <button
                        type="button"
                        onClick={() => setPreviewPhotoProduct(p)}
                        className="relative group inline-flex items-center justify-center w-10 h-10 rounded-md border border-slate-200 overflow-hidden bg-white hover:border-[#1D4ED8] shadow-2xs"
                        title="Cliquer pour agrandir la photo"
                      >
                        <img
                          src={p.photoUrl}
                          alt={p.name}
                          className="w-full h-full object-cover"
                        />
                        <span className="absolute inset-0 bg-slate-900/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-white">
                          <ZoomIn className="w-3.5 h-3.5" />
                        </span>
                      </button>
                    ) : (
                      <label
                        className="inline-flex flex-col items-center justify-center w-10 h-10 rounded-md border border-dashed border-slate-300 bg-slate-50 text-slate-400 hover:text-[#1D4ED8] hover:border-[#1D4ED8] cursor-pointer transition-colors"
                        title="Ajouter une photo (compressée automatiquement)"
                      >
                        <Camera className="w-4 h-4" />
                        <input
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/svg+xml"
                          onChange={(e) => handleDirectProductPhotoUpload(p, e)}
                          className="hidden"
                        />
                      </label>
                    )}
                  </td>
                  <td className="py-3 px-4 font-mono">
                    <div className="font-semibold text-slate-900">{p.reference}</div>
                    <div className="text-[10px] text-slate-500">{p.barcode}</div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-medium text-slate-900">{p.name}</div>
                    <div className="text-[11px] text-slate-500">
                      {p.categoryName} · {p.brandName} · SAV {p.replacementMonths}m
                    </div>
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular">
                    {formatMad(p.purchasePriceCents)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular font-semibold">
                    {formatMad(p.salePriceHtCents)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular">{p.vatRate}%</td>
                  <td className="py-3 px-4 text-right font-mono-tabular font-bold">
                    {formatMad(ttc)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular">
                    <span
                      className={`font-bold ${
                        st === 'RUPTURE' || st === 'CRITIQUE'
                          ? 'text-red-700'
                          : st === 'FAIBLE'
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                      }`}
                    >
                      {p.stock} {p.unit}
                    </span>
                    <div className="text-[10px] text-slate-400">{st}</div>
                  </td>
                  <td className="py-3 px-4 font-mono text-[11px]">{p.location}</td>
                  <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => {
                        setPhotoCompressionInfo(null);
                        setEditingProduct(p);
                      }}
                      className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-100"
                    >
                      Modifier
                    </button>
                    {p.active && (
                      <button
                        type="button"
                        onClick={() => handleDeleteOrArchive(p)}
                        className="px-2.5 py-1 border border-red-200 text-red-700 rounded hover:bg-red-50"
                        title="Archiver ou supprimer (Règle 16)"
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

      {/* Fenêtre modale d'aperçu Photo Produit */}
      {previewPhotoProduct && (
        <div
          onClick={() => setPreviewPhotoProduct(null)}
          className="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-4 overflow-y-auto"
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
                  Réf : {previewPhotoProduct.reference} · {previewPhotoProduct.categoryName}
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
                <div className="text-slate-400 text-center py-12">Aucune photo enregistrée</div>
              )}
            </div>

            <div className="px-4 py-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-2 bg-white dark:bg-slate-900">
              <div className="font-mono-tabular text-slate-700 dark:text-slate-300">
                P.V TTC :{' '}
                <strong className="text-slate-900 dark:text-white">
                  {formatMad(
                    Math.round(
                      previewPhotoProduct.salePriceHtCents *
                        (1 + previewPhotoProduct.vatRate / 100)
                    )
                  )}
                </strong>{' '}
                · Stock : <strong>{previewPhotoProduct.stock}</strong> {previewPhotoProduct.unit}
              </div>
              <div className="flex items-center gap-2">
                <label className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-blue-300 bg-blue-50 text-blue-900 font-medium rounded cursor-pointer hover:bg-blue-100">
                  <Camera className="w-3.5 h-3.5" /> Remplacer
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    onChange={(e) => handleDirectProductPhotoUpload(previewPhotoProduct, e)}
                    className="hidden"
                  />
                </label>
                {previewPhotoProduct.photoUrl && (
                  <button
                    type="button"
                    onClick={() => handleRemoveProductPhoto(previewPhotoProduct)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 border border-red-200 text-red-700 rounded hover:bg-red-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Supprimer
                  </button>
                )}
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

export type StockTableSortKey =
  | 'URGENCY'
  | 'STOCK_ASC'
  | 'STOCK_DESC'
  | 'VAL_DESC'
  | 'VAL_ASC'
  | 'NAME_ASC'
  | 'NAME_DESC'
  | 'REF_ASC'
  | 'REF_DESC'
  | 'LOCATION_ASC';

const STOCK_SORT_LABELS: Record<StockTableSortKey, string> = {
  URGENCY: 'Priorité d’Alerte (Rupture → Critique → Normal)',
  STOCK_ASC: 'Quantité en Stock (Croissant ↑)',
  STOCK_DESC: 'Quantité en Stock (Décroissant ↓)',
  VAL_DESC: 'Valeur Coût HT (Décroissant ↓)',
  VAL_ASC: 'Valeur Coût HT (Croissant ↑)',
  NAME_ASC: 'Article (A → Z)',
  NAME_DESC: 'Article (Z → A)',
  REF_ASC: 'Référence (A → Z)',
  REF_DESC: 'Référence (Z → A)',
  LOCATION_ASC: 'Emplacement (A → Z)',
};

export type MovementSortKey =
  | 'DATE_DESC'
  | 'DATE_ASC'
  | 'PRODUCT_ASC'
  | 'PRODUCT_DESC'
  | 'QTY_DESC'
  | 'QTY_ASC'
  | 'STOCK_AFTER_ASC'
  | 'STOCK_AFTER_DESC';

/**
 * SECTION 23 & 56 : CENTRE DE STOCK & JOURNAL DES MOUVEMENTS (stockBefore + qty === stockAfter)
 */
export const StockCenterView: React.FC<{
  company?: CompanyInfo;
  refreshTrigger: number;
  onChanged: () => void;
  onOpenPrintPreview?: (doc: PrintableDocument) => void;
  onNavigateToDefective?: () => void;
}> = ({ company, refreshTrigger, onChanged, onOpenPrintPreview, onNavigateToDefective }) => {
  const [products, setProducts] = useState<Product[]>([]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [quarantineCount, setQuarantineCount] = useState<number>(0);
  const [adjustProductId, setAdjustProductId] = useState('');
  const [adjustDeltaQty, setAdjustDeltaQty] = useState(0);
  const [adjustReason, setAdjustReason] = useState('');
  const [showAdjustModal, setShowAdjustModal] = useState(false);

  // Filtres et Tris pour l'état du stock
  const [searchStock, setSearchStock] = useState('');
  const [stockStatusFilter, setStockStatusFilter] = useState<string>('ALL');
  const [stockSortBy, setStockSortBy] = useState<StockTableSortKey>('URGENCY');

  // Filtres et Tris pour le journal des mouvements
  const [searchMv, setSearchMv] = useState('');
  const [mvTypeFilter, setMvTypeFilter] = useState<string>('ALL');
  const [mvSortBy, setMvSortBy] = useState<MovementSortKey>('DATE_DESC');

  useEffect(() => {
    Promise.all([
      db.products.filter((p) => p.active).toArray(),
      db.stockMovements.orderBy('createdAt').reverse().toArray(),
      db.defectiveProducts.where('status').equals('EN_QUARANTAINE').count(),
    ]).then(([pList, mList, defCount]) => {
      setProducts(pList);
      setMovements(mList);
      setQuarantineCount(defCount);
      if (pList[0] && !adjustProductId) setAdjustProductId(pList[0].id);
    });
  }, [refreshTrigger, adjustProductId]);

  const handleManualAdjustment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!adjustProductId || adjustDeltaQty === 0 || !adjustReason.trim()) return;
    const now = new Date().toISOString();
    const bDate = getMoroccoBusinessDate(now);

    await enqueueTransactionalMutation(async () => {
      await db.transaction('rw', getAllTables(db), async () => {
        const prod = await db.products.get(adjustProductId);
        if (!prod) throw new Error('Produit introuvable.');
        const stockBefore = prod.stock;
        const stockAfter = stockBefore + adjustDeltaQty;

        await db.products.update(prod.id, {
          stock: stockAfter,
          updatedAt: now,
        });

        const mvId = generateId();
        await db.stockMovements.add({
          id: mvId,
          date: now,
          businessDate: bDate,
          productId: prod.id,
          productRef: prod.reference,
          productName: prod.name,
          quantity: adjustDeltaQty,
          stockBefore,
          stockAfter,
          type: 'MANUAL_ADJUST',
          sourceDocType: 'MANUAL',
          sourceDocId: mvId,
          sourceDocNumber: `AJUST-${mvId.slice(0, 6).toUpperCase()}`,
          reason: adjustReason,
          userId: 'admin',
          userName: 'Administrateur',
          status: 'ACTIVE',
          createdAt: now,
        });

        await recordAuditLogInTx(db, {
          action: 'MANUAL_STOCK_ADJUSTMENT',
          entityType: 'PRODUCT',
          entityId: prod.id,
          summary: `Ajustement stock tracé sur ${prod.reference} : ${stockBefore} + (${adjustDeltaQty}) = ${stockAfter} (${adjustReason})`,
          businessDate: bDate,
        });
      });
    });

    setShowAdjustModal(false);
    setAdjustDeltaQty(0);
    setAdjustReason('');
    onChanged();
  };

  const urgencyWeight = (p: Product): number => {
    const st = computeStockStatus(p.stock, p.minStock, p.maxStock);
    if (st === 'RUPTURE') return 0;
    if (st === 'CRITIQUE') return 1;
    if (st === 'FAIBLE') return 2;
    if (st === 'SURSTOCK') return 3;
    return 4;
  };

  const toggleStockHeaderSort = (ascKey: StockTableSortKey, descKey: StockTableSortKey) => {
    setStockSortBy((prev) => (prev === ascKey ? descKey : ascKey));
  };

  const sortedStockProducts = products
    .filter((p) => {
      if (stockStatusFilter !== 'ALL') {
        const st = computeStockStatus(p.stock, p.minStock, p.maxStock);
        if (stockStatusFilter === 'ALERT_ONLY') {
          if (st !== 'RUPTURE' && st !== 'CRITIQUE' && st !== 'FAIBLE') return false;
        } else if (st !== stockStatusFilter) {
          return false;
        }
      }
      if (!searchStock.trim()) return true;
      const q = searchStock.toLowerCase();
      return (
        p.name.toLowerCase().includes(q) ||
        p.reference.toLowerCase().includes(q) ||
        p.location.toLowerCase().includes(q) ||
        p.categoryName.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      const valA = Math.max(0, a.stock) * a.purchasePriceCents;
      const valB = Math.max(0, b.stock) * b.purchasePriceCents;
      switch (stockSortBy) {
        case 'URGENCY':
          return urgencyWeight(a) - urgencyWeight(b) || a.stock - b.stock;
        case 'STOCK_ASC':
          return a.stock - b.stock;
        case 'STOCK_DESC':
          return b.stock - a.stock;
        case 'VAL_DESC':
          return valB - valA;
        case 'VAL_ASC':
          return valA - valB;
        case 'NAME_ASC':
          return a.name.localeCompare(b.name, 'fr');
        case 'NAME_DESC':
          return b.name.localeCompare(a.name, 'fr');
        case 'REF_ASC':
          return a.reference.localeCompare(b.reference, 'fr', { numeric: true });
        case 'REF_DESC':
          return b.reference.localeCompare(a.reference, 'fr', { numeric: true });
        case 'LOCATION_ASC':
          return a.location.localeCompare(b.location, 'fr', { numeric: true });
        default:
          return 0;
      }
    });

  const sortedMovements = movements
    .filter((mv) => {
      if (mvTypeFilter !== 'ALL' && mv.type !== mvTypeFilter) return false;
      if (!searchMv.trim()) return true;
      const q = searchMv.toLowerCase();
      return (
        mv.productName.toLowerCase().includes(q) ||
        mv.productRef.toLowerCase().includes(q) ||
        mv.sourceDocNumber.toLowerCase().includes(q) ||
        mv.reason.toLowerCase().includes(q)
      );
    })
    .sort((a, b) => {
      switch (mvSortBy) {
        case 'DATE_DESC':
          return b.createdAt.localeCompare(a.createdAt);
        case 'DATE_ASC':
          return a.createdAt.localeCompare(b.createdAt);
        case 'PRODUCT_ASC':
          return a.productName.localeCompare(b.productName, 'fr');
        case 'PRODUCT_DESC':
          return b.productName.localeCompare(a.productName, 'fr');
        case 'QTY_DESC':
          return b.quantity - a.quantity;
        case 'QTY_ASC':
          return a.quantity - b.quantity;
        case 'STOCK_AFTER_ASC':
          return a.stockAfter - b.stockAfter;
        case 'STOCK_AFTER_DESC':
          return b.stockAfter - a.stockAfter;
        default:
          return 0;
      }
    });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            Centre de Stock & Traçabilité des Mouvements
          </h1>
          <p className="text-xs text-slate-500">
            Section 56 : Aucune modification silencieuse du stock · Équation garantie : Stock Avant
            + Mouvement = Stock Après
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onNavigateToDefective && (
            <button
              type="button"
              onClick={onNavigateToDefective}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-md border transition-colors shadow-xs ${
                quarantineCount > 0
                  ? 'bg-red-50 text-red-800 border-red-300 hover:bg-red-100 dark:bg-red-950/60 dark:text-red-300 dark:border-red-800'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'
              }`}
            >
              <ShieldAlert className="w-3.5 h-3.5 text-red-600" />
              <span>Produits Défectueux (Quarantaine)</span>
              {quarantineCount > 0 && (
                <span className="px-1.5 py-0.5 bg-red-700 text-white text-[10px] font-bold rounded-full ml-0.5">
                  {quarantineCount}
                </span>
              )}
            </button>
          )}

          {company && onOpenPrintPreview && (
            <button
              type="button"
              onClick={() =>
                onOpenPrintPreview(
                  buildProductsAndStockReportPrint(company, sortedStockProducts, {
                    mode: 'STOCK',
                    sortLabel: STOCK_SORT_LABELS[stockSortBy],
                    filterLabel:
                      stockStatusFilter !== 'ALL' || searchStock
                        ? `Statut: ${stockStatusFilter}${searchStock ? `, Rech: "${searchStock}"` : ''}`
                        : 'Tous les articles actifs',
                  })
                )
              }
              className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-blue-300 bg-blue-50 text-blue-900 text-xs font-medium rounded-md hover:bg-blue-100"
            >
              <Printer className="w-3.5 h-3.5" /> Imprimer / PDF État du Stock
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowAdjustModal(true)}
            className="inline-flex items-center gap-2 px-4 py-2 bg-[#0F172A] text-white text-xs font-medium rounded-md hover:bg-slate-800"
          >
            <ArrowUpDown className="w-4 h-4" />
            Mouvement d&apos;Ajustement Tracé
          </button>
        </div>
      </div>

      {/* État des stocks et seuils */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="font-semibold text-slate-800 dark:text-slate-100">
            Valorisation et Statuts des Articles Actifs ({sortedStockProducts.length} référence(s))
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={searchStock}
              onChange={(e) => setSearchStock(e.target.value)}
              placeholder="Filtrer réf, article, emplacement..."
              className="px-2.5 py-1 border border-slate-300 rounded"
            />
            <select
              value={stockStatusFilter}
              onChange={(e) => setStockStatusFilter(e.target.value)}
              className="px-2.5 py-1 border border-slate-300 rounded bg-white"
            >
              <option value="ALL">Tous les statuts</option>
              <option value="ALERT_ONLY">En alerte (Rupture / Critique / Faible)</option>
              <option value="RUPTURE">Rupture</option>
              <option value="CRITIQUE">Critique</option>
              <option value="FAIBLE">Faible</option>
              <option value="NORMAL">Normal</option>
            </select>
            <div className="flex items-center gap-1.5">
              <ArrowUpDown className="w-3.5 h-3.5 text-[#1D4ED8]" />
              <span className="font-semibold text-slate-700 dark:text-slate-200">Trier par :</span>
              <select
                value={stockSortBy}
                onChange={(e) => setStockSortBy(e.target.value as StockTableSortKey)}
                className="px-2.5 py-1 border border-blue-300 bg-blue-50/40 rounded font-medium text-slate-900"
              >
                {(Object.entries(STOCK_SORT_LABELS) as [StockTableSortKey, string][]).map(
                  ([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  )
                )}
              </select>
            </div>
          </div>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600 select-none">
              <th
                onClick={() => toggleStockHeaderSort('REF_ASC', 'REF_DESC')}
                className="py-2.5 px-4 cursor-pointer hover:text-slate-900"
              >
                Référence {stockSortBy === 'REF_ASC' ? '↑' : stockSortBy === 'REF_DESC' ? '↓' : '↕'}
              </th>
              <th
                onClick={() => toggleStockHeaderSort('NAME_ASC', 'NAME_DESC')}
                className="py-2.5 px-4 cursor-pointer hover:text-slate-900"
              >
                Article {stockSortBy === 'NAME_ASC' ? '↑' : stockSortBy === 'NAME_DESC' ? '↓' : '↕'}
              </th>
              <th
                onClick={() => toggleStockHeaderSort('LOCATION_ASC', 'REF_ASC')}
                className="py-2.5 px-4 cursor-pointer hover:text-slate-900"
              >
                Emplacement {stockSortBy === 'LOCATION_ASC' ? '↑' : '↕'}
              </th>
              <th
                onClick={() => toggleStockHeaderSort('STOCK_ASC', 'STOCK_DESC')}
                className="py-2.5 px-4 text-right cursor-pointer hover:text-slate-900"
              >
                Quantité{' '}
                {stockSortBy === 'STOCK_ASC' ? '↑' : stockSortBy === 'STOCK_DESC' ? '↓' : '↕'}
              </th>
              <th className="py-2.5 px-4 text-right">Seuil Min</th>
              <th
                onClick={() => toggleStockHeaderSort('VAL_DESC', 'VAL_ASC')}
                className="py-2.5 px-4 text-right cursor-pointer hover:text-slate-900"
              >
                Valeur Coût HT{' '}
                {stockSortBy === 'VAL_ASC' ? '↑' : stockSortBy === 'VAL_DESC' ? '↓' : '↕'}
              </th>
              <th
                onClick={() => setStockSortBy('URGENCY')}
                className="py-2.5 px-4 cursor-pointer hover:text-slate-900"
              >
                Statut {stockSortBy === 'URGENCY' ? '↑' : '↕'}
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sortedStockProducts.map((p) => {
              const st = computeStockStatus(p.stock, p.minStock, p.maxStock);
              const valCents = Math.max(0, p.stock) * p.purchasePriceCents;
              return (
                <tr key={p.id}>
                  <td className="py-2.5 px-4 font-mono font-semibold">{p.reference}</td>
                  <td className="py-2.5 px-4 font-medium">{p.name}</td>
                  <td className="py-2.5 px-4 font-mono text-[11px]">{p.location}</td>
                  <td className="py-2.5 px-4 text-right font-mono-tabular font-bold">
                    {p.stock} {p.unit}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono-tabular">{p.minStock}</td>
                  <td className="py-2.5 px-4 text-right font-mono-tabular">
                    {formatMad(valCents)}
                  </td>
                  <td className="py-2.5 px-4 font-mono font-semibold">
                    <span
                      className={
                        st === 'RUPTURE' || st === 'CRITIQUE'
                          ? 'text-red-700'
                          : st === 'FAIBLE'
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                      }
                    >
                      {st}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Journal complet des mouvements de stock */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="font-semibold text-slate-800 dark:text-slate-100">
            Journal Inaltérable des Mouvements de Stock ({sortedMovements.length} mouvement(s))
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="text"
              value={searchMv}
              onChange={(e) => setSearchMv(e.target.value)}
              placeholder="Rechercher produit, n° doc, motif..."
              className="px-2.5 py-1 border border-slate-300 rounded"
            />
            <select
              value={mvTypeFilter}
              onChange={(e) => setMvTypeFilter(e.target.value)}
              className="px-2.5 py-1 border border-slate-300 rounded bg-white"
            >
              <option value="ALL">Tous les types de mouvements</option>
              <option value="SALE_OUT">Sorties Vente (SALE_OUT)</option>
              <option value="PURCHASE_RECEIPT">Réceptions Achat (PURCHASE_RECEIPT)</option>
              <option value="MANUAL_ADJUST">Ajustements Manuels (MANUAL_ADJUST)</option>
              <option value="INVENTORY_ADJUST">Écarts Inventaire (INVENTORY_ADJUST)</option>
              <option value="SALE_RETURN_IN">Retours Clients (SALE_RETURN_IN)</option>
              <option value="SAV_CONSUMPTION">Consommations SAV (SAV_CONSUMPTION)</option>
            </select>
            <div className="flex items-center gap-1.5">
              <ArrowUpDown className="w-3.5 h-3.5 text-[#1D4ED8]" />
              <span className="font-semibold text-slate-700 dark:text-slate-200">Trier par :</span>
              <select
                value={mvSortBy}
                onChange={(e) => setMvSortBy(e.target.value as MovementSortKey)}
                className="px-2.5 py-1 border border-blue-300 bg-blue-50/40 rounded font-medium text-slate-900"
              >
                <option value="DATE_DESC">Date (Plus récent → Plus ancien)</option>
                <option value="DATE_ASC">Date (Plus ancien → Plus récent)</option>
                <option value="PRODUCT_ASC">Produit (A → Z)</option>
                <option value="PRODUCT_DESC">Produit (Z → A)</option>
                <option value="QTY_DESC">Variation Qté (Décroissant ↓)</option>
                <option value="QTY_ASC">Variation Qté (Croissant ↑)</option>
                <option value="STOCK_AFTER_DESC">Stock Après (Décroissant ↓)</option>
                <option value="STOCK_AFTER_ASC">Stock Après (Croissant ↑)</option>
              </select>
            </div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600 select-none">
                <th
                  onClick={() =>
                    setMvSortBy((p) => (p === 'DATE_DESC' ? 'DATE_ASC' : 'DATE_DESC'))
                  }
                  className="py-2.5 px-4 cursor-pointer hover:text-slate-900"
                >
                  Date Métier {mvSortBy === 'DATE_ASC' ? '↑' : mvSortBy === 'DATE_DESC' ? '↓' : '↕'}
                </th>
                <th
                  onClick={() =>
                    setMvSortBy((p) => (p === 'PRODUCT_ASC' ? 'PRODUCT_DESC' : 'PRODUCT_ASC'))
                  }
                  className="py-2.5 px-4 cursor-pointer hover:text-slate-900"
                >
                  Produit{' '}
                  {mvSortBy === 'PRODUCT_ASC' ? '↑' : mvSortBy === 'PRODUCT_DESC' ? '↓' : '↕'}
                </th>
                <th className="py-2.5 px-4">Type</th>
                <th className="py-2.5 px-4">Doc. Source</th>
                <th className="py-2.5 px-4 text-right">Stock Avant</th>
                <th
                  onClick={() => setMvSortBy((p) => (p === 'QTY_DESC' ? 'QTY_ASC' : 'QTY_DESC'))}
                  className="py-2.5 px-4 text-right cursor-pointer hover:text-slate-900"
                >
                  Mouvement {mvSortBy === 'QTY_ASC' ? '↑' : mvSortBy === 'QTY_DESC' ? '↓' : '↕'}
                </th>
                <th
                  onClick={() =>
                    setMvSortBy((p) =>
                      p === 'STOCK_AFTER_DESC' ? 'STOCK_AFTER_ASC' : 'STOCK_AFTER_DESC'
                    )
                  }
                  className="py-2.5 px-4 text-right cursor-pointer hover:text-slate-900"
                >
                  Stock Après{' '}
                  {mvSortBy === 'STOCK_AFTER_ASC'
                    ? '↑'
                    : mvSortBy === 'STOCK_AFTER_DESC'
                    ? '↓'
                    : '↕'}
                </th>
                <th className="py-2.5 px-4">Motif & Opérateur</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedMovements.map((mv) => (
                <tr key={mv.id}>
                  <td className="py-2.5 px-4 font-mono-tabular">
                    {formatBusinessDateFr(mv.businessDate)}
                  </td>
                  <td className="py-2.5 px-4">
                    <span className="font-mono font-semibold">{mv.productRef}</span> —{' '}
                    {mv.productName}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-[11px]">{mv.type}</td>
                  <td className="py-2.5 px-4 font-mono">{mv.sourceDocNumber}</td>
                  <td className="py-2.5 px-4 text-right font-mono-tabular">{mv.stockBefore}</td>
                  <td
                    className={`py-2.5 px-4 text-right font-mono-tabular font-bold ${
                      mv.quantity >= 0 ? 'text-emerald-700' : 'text-red-700'
                    }`}
                  >
                    {mv.quantity > 0 ? `+${mv.quantity}` : mv.quantity}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono-tabular font-bold">
                    {mv.stockAfter}
                  </td>
                  <td className="py-2.5 px-4 text-slate-600">
                    {mv.reason} <span className="text-slate-400">({mv.userName})</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {showAdjustModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleManualAdjustment}
            className="bg-white border border-slate-300 rounded-lg max-w-md w-full p-6 space-y-4 text-xs"
          >
            <h3 className="text-base font-bold text-slate-900">
              Créer un Mouvement d&apos;Ajustement de Stock
            </h3>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Produit</label>
              <select
                value={adjustProductId}
                onChange={(e) => setAdjustProductId(e.target.value)}
                className="w-full px-3 py-2 border border-slate-300 rounded bg-white"
              >
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.reference} — {p.name} (Stock actuel : {p.stock})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Variation de quantité (+ pour entrée, - pour sortie/casse)
              </label>
              <input
                type="number"
                required
                value={adjustDeltaQty}
                onChange={(e) => setAdjustDeltaQty(parseInt(e.target.value, 10) || 0)}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Motif justificatif obligatoire (Audit) *
              </label>
              <input
                type="text"
                required
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                placeholder="Ex: Casse manutention / Échantillon démonstration client..."
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAdjustModal(false)}
                className="px-3 py-1.5 border border-slate-300 rounded"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-[#0F172A] text-white font-medium rounded"
              >
                Valider le mouvement
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

export type InventoryItemSortKey =
  | 'REF_ASC'
  | 'REF_DESC'
  | 'NAME_ASC'
  | 'NAME_DESC'
  | 'LOCATION_ASC'
  | 'THEO_DESC'
  | 'THEO_ASC'
  | 'VAR_QTY_ASC'
  | 'VAR_QTY_DESC'
  | 'VAR_VAL_ASC'
  | 'VAR_VAL_DESC';

/**
 * SECTION 24 : INVENTAIRE PHYSIQUE VALORISÉ (Règles 7, 9 & 14)
 */
export const InventoryView: React.FC<{
  company: CompanyInfo;
  refreshTrigger: number;
  onChanged: () => void;
  onOpenPrintPreview: (doc: PrintableDocument) => void;
}> = ({ company, refreshTrigger, onChanged, onOpenPrintPreview }) => {
  const [sessions, setSessions] = useState<InventorySession[]>([]);
  const [activeSession, setActiveSession] = useState<InventorySession | null>(null);
  const [sessionItems, setSessionItems] = useState<InventoryItem[]>([]);
  const [mode, setMode] = useState<InventoryMode>('COMPLET');
  const [notes, setNotes] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const [itemSortBy, setItemSortBy] = useState<InventoryItemSortKey>('REF_ASC');
  const [sessionSortBy, setSessionSortBy] = useState<
    'DATE_DESC' | 'DATE_ASC' | 'VAR_DESC' | 'VAR_ASC'
  >('DATE_DESC');

  useEffect(() => {
    db.inventories.orderBy('createdAt').reverse().toArray().then(setSessions);
  }, [refreshTrigger]);

  const loadSession = async (s: InventorySession) => {
    setActiveSession(s);
    const items = await db.inventoryItems.where('inventoryId').equals(s.id).toArray();
    setSessionItems(items);
  };

  const handleCreateSession = async () => {
    const res = await executeCreateInventorySession({ mode, notes });
    setActiveSession(res.session);
    setSessionItems(res.items);
    onChanged();
    setFeedback(
      `Session d'inventaire ${res.session.number} ouverte : stock théorique figé pour ${res.items.length} produits.`
    );
  };

  const handleCountChange = async (itemId: string, countedQty: number) => {
    if (!activeSession) return;
    try {
      const updated = await executeUpdateInventoryCounts({
        inventoryId: activeSession.id,
        counts: [{ inventoryItemId: itemId, countedQty }],
      });
      setActiveSession(updated);
      const items = await db.inventoryItems
        .where('inventoryId')
        .equals(activeSession.id)
        .toArray();
      setSessionItems(items);
    } catch (err) {
      if (err instanceof ArbitrageError) {
        setFeedback(err.decision.resolutionMessage);
      }
    }
  };

  const handleValidateInventory = async () => {
    if (!activeSession) return;
    try {
      const validated = await executeValidateInventorySession({
        inventoryId: activeSession.id,
      });
      await loadSession(validated);
      onChanged();
      setFeedback(
        `Inventaire ${validated.number} validé (Règles 7 & 14) : mouvements d'ajustement explicites générés et session verrouillée.`
      );
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    }
  };

  const handlePrintPv = async (session: InventorySession) => {
    const items = await db.inventoryItems.where('inventoryId').equals(session.id).toArray();
    onOpenPrintPreview(buildInventoryPvPrint(company, session, items));
  };

  const sortedSessionItems = [...sessionItems].sort((a, b) => {
    switch (itemSortBy) {
      case 'REF_ASC':
        return a.productRef.localeCompare(b.productRef, 'fr', { numeric: true });
      case 'REF_DESC':
        return b.productRef.localeCompare(a.productRef, 'fr', { numeric: true });
      case 'NAME_ASC':
        return a.productName.localeCompare(b.productName, 'fr');
      case 'NAME_DESC':
        return b.productName.localeCompare(a.productName, 'fr');
      case 'LOCATION_ASC':
        return a.location.localeCompare(b.location, 'fr', { numeric: true });
      case 'THEO_DESC':
        return b.theoreticalQty - a.theoreticalQty;
      case 'THEO_ASC':
        return a.theoreticalQty - b.theoreticalQty;
      case 'VAR_QTY_ASC':
        return a.varianceQty - b.varianceQty;
      case 'VAR_QTY_DESC':
        return b.varianceQty - a.varianceQty;
      case 'VAR_VAL_ASC':
        return a.varianceValueCents - b.varianceValueCents;
      case 'VAR_VAL_DESC':
        return b.varianceValueCents - a.varianceValueCents;
      default:
        return 0;
    }
  });

  const sortedSessions = [...sessions].sort((a, b) => {
    switch (sessionSortBy) {
      case 'DATE_DESC':
        return b.createdAt.localeCompare(a.createdAt);
      case 'DATE_ASC':
        return a.createdAt.localeCompare(b.createdAt);
      case 'VAR_DESC':
        return Math.abs(b.totalVarianceValueCents) - Math.abs(a.totalVarianceValueCents);
      case 'VAR_ASC':
        return Math.abs(a.totalVarianceValueCents) - Math.abs(b.totalVarianceValueCents);
      default:
        return 0;
    }
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            Inventaires Physiques & Valorisation des Écarts
          </h1>
          <p className="text-xs text-slate-500">
            Règles 7, 9 & 14 : Conservation quantité théorique · Saisie comptage réel · Mouvements
            de régularisation explicites · PV imprimable
          </p>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as InventoryMode)}
            className="px-3 py-2 border border-slate-300 rounded-md bg-white"
          >
            <option value="COMPLET">Inventaire Complet</option>
            <option value="CATEGORIE">Par Catégorie</option>
            <option value="EMPLACEMENT">Par Emplacement</option>
          </select>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Note inventaire..."
            className="px-3 py-2 border border-slate-300 rounded-md"
          />
          <button
            type="button"
            onClick={handleCreateSession}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#0F172A] text-white font-medium rounded-md hover:bg-slate-800 whitespace-nowrap"
          >
            <ClipboardCheck className="w-4 h-4" /> Démarrer un Inventaire
          </button>
        </div>
      </div>

      {feedback && (
        <div className="p-3 bg-emerald-50 border border-emerald-300 text-emerald-900 rounded-md text-xs flex justify-between">
          <span>{feedback}</span>
          <button type="button" onClick={() => setFeedback(null)} className="underline">
            Fermer
          </button>
        </div>
      )}

      {activeSession && (
        <div className="bg-white border border-slate-300 rounded-lg p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Session {activeSession.number} — Statut : {activeSession.status}
              </h2>
              <div className="text-xs text-slate-500 font-mono-tabular">
                Valeur Théorique : {formatMad(activeSession.totalTheoreticalValueCents)} · Valeur
                Comptée : {formatMad(activeSession.totalCountedValueCents)} · Écart Valorisé :{' '}
                <strong>{formatMad(activeSession.totalVarianceValueCents)}</strong>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1.5 text-xs">
                <ArrowUpDown className="w-3.5 h-3.5 text-[#1D4ED8]" />
                <span className="font-semibold text-slate-700">Trier lignes :</span>
                <select
                  value={itemSortBy}
                  onChange={(e) => setItemSortBy(e.target.value as InventoryItemSortKey)}
                  className="px-2 py-1 border border-blue-300 bg-blue-50/40 rounded font-medium text-slate-900"
                >
                  <option value="REF_ASC">Référence (A → Z)</option>
                  <option value="REF_DESC">Référence (Z → A)</option>
                  <option value="NAME_ASC">Produit (A → Z)</option>
                  <option value="NAME_DESC">Produit (Z → A)</option>
                  <option value="LOCATION_ASC">Emplacement (A → Z)</option>
                  <option value="THEO_DESC">Stock Théorique (Décroissant ↓)</option>
                  <option value="VAR_QTY_ASC">Écart Qté (Déficits d&apos;abord ↑)</option>
                  <option value="VAR_QTY_DESC">Écart Qté (Excédents d&apos;abord ↓)</option>
                  <option value="VAR_VAL_ASC">Écart Valorisé HT (Croissant ↑)</option>
                  <option value="VAR_VAL_DESC">Écart Valorisé HT (Décroissant ↓)</option>
                </select>
              </div>
              <button
                type="button"
                onClick={() => handlePrintPv(activeSession)}
                className="px-3 py-1.5 text-xs border border-slate-300 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
              >
                <Printer className="w-3.5 h-3.5" /> PV d&apos;Inventaire A4
              </button>
              {activeSession.status === 'COMPTAGE' && (
                <button
                  type="button"
                  onClick={handleValidateInventory}
                  className="px-4 py-1.5 text-xs bg-emerald-700 text-white font-semibold rounded hover:bg-emerald-800 inline-flex items-center gap-1.5"
                >
                  <CheckCircle2 className="w-4 h-4" /> Confirmer & Générer les Mouvements
                </button>
              )}
            </div>
          </div>

          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600 select-none">
                <th
                  onClick={() =>
                    setItemSortBy((p) => (p === 'REF_ASC' ? 'REF_DESC' : 'REF_ASC'))
                  }
                  className="py-2 px-3 cursor-pointer hover:text-slate-900"
                >
                  Réf. {itemSortBy === 'REF_ASC' ? '↑' : itemSortBy === 'REF_DESC' ? '↓' : '↕'}
                </th>
                <th
                  onClick={() =>
                    setItemSortBy((p) => (p === 'NAME_ASC' ? 'NAME_DESC' : 'NAME_ASC'))
                  }
                  className="py-2 px-3 cursor-pointer hover:text-slate-900"
                >
                  Produit{' '}
                  {itemSortBy === 'NAME_ASC' ? '↑' : itemSortBy === 'NAME_DESC' ? '↓' : '↕'}
                </th>
                <th
                  onClick={() => setItemSortBy('LOCATION_ASC')}
                  className="py-2 px-3 cursor-pointer hover:text-slate-900"
                >
                  Emplacement {itemSortBy === 'LOCATION_ASC' ? '↑' : '↕'}
                </th>
                <th
                  onClick={() =>
                    setItemSortBy((p) => (p === 'THEO_DESC' ? 'THEO_ASC' : 'THEO_DESC'))
                  }
                  className="py-2 px-3 text-right cursor-pointer hover:text-slate-900"
                >
                  Stock Théorique{' '}
                  {itemSortBy === 'THEO_ASC' ? '↑' : itemSortBy === 'THEO_DESC' ? '↓' : '↕'}
                </th>
                <th className="py-2 px-3 text-right">Quantité Comptée</th>
                <th
                  onClick={() =>
                    setItemSortBy((p) => (p === 'VAR_QTY_ASC' ? 'VAR_QTY_DESC' : 'VAR_QTY_ASC'))
                  }
                  className="py-2 px-3 text-right cursor-pointer hover:text-slate-900"
                >
                  Écart Qté{' '}
                  {itemSortBy === 'VAR_QTY_ASC'
                    ? '↑'
                    : itemSortBy === 'VAR_QTY_DESC'
                    ? '↓'
                    : '↕'}
                </th>
                <th
                  onClick={() =>
                    setItemSortBy((p) => (p === 'VAR_VAL_ASC' ? 'VAR_VAL_DESC' : 'VAR_VAL_ASC'))
                  }
                  className="py-2 px-3 text-right cursor-pointer hover:text-slate-900"
                >
                  Écart Valorisé HT{' '}
                  {itemSortBy === 'VAR_VAL_ASC'
                    ? '↑'
                    : itemSortBy === 'VAR_VAL_DESC'
                    ? '↓'
                    : '↕'}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sortedSessionItems.map((item) => (
                <tr key={item.id}>
                  <td className="py-2 px-3 font-mono">{item.productRef}</td>
                  <td className="py-2 px-3 font-medium">{item.productName}</td>
                  <td className="py-2 px-3 font-mono text-[11px]">{item.location}</td>
                  <td className="py-2 px-3 text-right font-mono-tabular font-semibold">
                    {item.theoreticalQty}
                  </td>
                  <td className="py-2 px-3 text-right">
                    <input
                      type="number"
                      disabled={activeSession.status === 'VALIDE'}
                      value={item.countedQty}
                      onChange={(e) =>
                        handleCountChange(item.id, parseInt(e.target.value, 10) || 0)
                      }
                      className="w-24 px-2 py-1 text-right font-mono border border-slate-300 rounded disabled:bg-slate-100"
                    />
                  </td>
                  <td
                    className={`py-2 px-3 text-right font-mono-tabular font-bold ${
                      item.varianceQty > 0
                        ? 'text-emerald-700'
                        : item.varianceQty < 0
                        ? 'text-red-700'
                        : 'text-slate-500'
                    }`}
                  >
                    {item.varianceQty > 0 ? `+${item.varianceQty}` : item.varianceQty}
                  </td>
                  <td className="py-2 px-3 text-right font-mono-tabular">
                    {formatMad(item.varianceValueCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Historique des inventaires */}
      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-4 py-2.5 border-b border-slate-200 flex items-center justify-between text-xs bg-slate-50/50">
          <span className="font-semibold text-slate-700">
            Historique des Sessions d&apos;Inventaire ({sortedSessions.length})
          </span>
          <div className="flex items-center gap-1.5">
            <ArrowUpDown className="w-3.5 h-3.5 text-[#1D4ED8]" />
            <span className="font-semibold text-slate-700">Trier par :</span>
            <select
              value={sessionSortBy}
              onChange={(e) => setSessionSortBy(e.target.value as typeof sessionSortBy)}
              className="px-2 py-1 border border-blue-300 bg-blue-50/40 rounded font-medium text-slate-900"
            >
              <option value="DATE_DESC">Date (Plus récent → Plus ancien)</option>
              <option value="DATE_ASC">Date (Plus ancien → Plus récent)</option>
              <option value="VAR_DESC">Amplitude Écart Valorisé (Décroissant ↓)</option>
              <option value="VAR_ASC">Amplitude Écart Valorisé (Croissant ↑)</option>
            </select>
          </div>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
              <th className="py-3 px-4">N° Inventaire</th>
              <th className="py-3 px-4">Date</th>
              <th className="py-3 px-4">Mode</th>
              <th className="py-3 px-4 text-right">Valeur Théorique</th>
              <th className="py-3 px-4 text-right">Valeur Comptée</th>
              <th className="py-3 px-4 text-right">Écart Valorisé</th>
              <th className="py-3 px-4">Statut</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {sortedSessions.map((s) => (
              <tr key={s.id} className="hover:bg-slate-50">
                <td className="py-3 px-4 font-mono font-semibold">{s.number}</td>
                <td className="py-3 px-4 font-mono-tabular">
                  {formatBusinessDateFr(s.businessDate)}
                </td>
                <td className="py-3 px-4">{s.mode}</td>
                <td className="py-3 px-4 text-right font-mono-tabular">
                  {formatMad(s.totalTheoreticalValueCents)}
                </td>
                <td className="py-3 px-4 text-right font-mono-tabular">
                  {formatMad(s.totalCountedValueCents)}
                </td>
                <td className="py-3 px-4 text-right font-mono-tabular font-bold">
                  {formatMad(s.totalVarianceValueCents)}
                </td>
                <td className="py-3 px-4 font-mono font-semibold">{s.status}</td>
                <td className="py-3 px-4 text-right space-x-2">
                  <button
                    type="button"
                    onClick={() => loadSession(s)}
                    className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-100"
                  >
                    Ouvrir / Compter
                  </button>
                  <button
                    type="button"
                    onClick={() => handlePrintPv(s)}
                    className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-100"
                  >
                    PV A4
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
