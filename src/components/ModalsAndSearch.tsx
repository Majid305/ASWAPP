import React, { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileDown,
  KeyRound,
  Lock,
  Power,
  Printer,
  Radio,
  Search,
  Server,
  ShieldAlert,
  Sparkles,
  Trash2,
  Upload,
  UserCheck,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { db } from '../db/database';
import { formatMad } from '../domain/financialEngine';
import { buildStandalonePrintableHtml, PrintableDocument } from '../printing/printTemplates';
import { FirstRunSetupInput, initializeWithSetupConfig } from '../services/seedService';
import {
  Customer,
  CustomerEquipment,
  DefectiveProduct,
  Invoice,
  Product,
  Purchase,
  Quote,
  Sale,
  SavReminder,
  Supplier,
  UserProfile,
} from '../types/domain';
import { fileToLogoDataUrl, verifyPin } from '../utils/securityUtils';

/**
 * 1. APERÇU AVANT IMPRESSION & EXPORT PDF (Section 36)
 */
export const PrintPreviewModal: React.FC<{
  doc: PrintableDocument | null;
  onClose: () => void;
}> = ({ doc, onClose }) => {
  const [zoom, setZoom] = useState<number>(100);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  if (!doc) return null;

  const triggerIframePrint = () => {
    const html = buildStandalonePrintableHtml(doc);
    const iframe = iframeRef.current;
    if (iframe && iframe.contentWindow) {
      const iframeDoc = iframe.contentWindow.document;
      iframeDoc.open();
      iframeDoc.write(html);
      iframeDoc.close();
      setTimeout(() => {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      }, 250);
    } else {
      window.print();
    }
  };

  const handleDownloadStandaloneHtml = () => {
    const html = buildStandalonePrintableHtml(doc);
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const safeName = (doc.filename || doc.title).replace(/[^a-zA-Z0-9_-]/g, '_');
    a.download = `${safeName}.html`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl max-w-5xl w-full max-h-[94vh] flex flex-col shadow-2xl overflow-hidden">
        {/* Barre d'outils d'aperçu */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 no-print">
          <div>
            <div className="flex items-center gap-2">
              <span className="px-2 py-0.5 text-[10px] font-mono font-bold uppercase tracking-wider bg-[#0F172A] text-[#D9A95B] rounded">
                {doc.format === 'TICKET_80MM' ? 'Ticket 80mm' : 'A4 Portrait'}
              </span>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">{doc.title}</h3>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">{doc.subtitle}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Contrôle du zoom */}
            <div className="inline-flex items-center border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 px-1.5 py-1 text-xs">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(75, z - 10))}
                className="p-1 text-slate-600 dark:text-slate-300 hover:text-slate-900"
                title="Réduire le zoom"
              >
                <ZoomOut className="w-3.5 h-3.5" />
              </button>
              <span className="px-2 font-mono text-[11px] font-semibold text-slate-700 dark:text-slate-200">
                {zoom}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(125, z + 10))}
                className="p-1 text-slate-600 dark:text-slate-300 hover:text-slate-900"
                title="Augmenter le zoom"
              >
                <ZoomIn className="w-3.5 h-3.5" />
              </button>
            </div>

            <button
              type="button"
              onClick={triggerIframePrint}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-emerald-700 text-white text-xs font-semibold rounded-md hover:bg-emerald-800 transition-colors whitespace-nowrap"
              title="Choisir 'Enregistrer au format PDF' dans la boîte de dialogue d'impression"
            >
              <FileDown className="w-4 h-4" />
              Télécharger / Enregistrer en PDF
            </button>

            <button
              type="button"
              onClick={triggerIframePrint}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#1D4ED8] text-white text-xs font-semibold rounded-md hover:bg-blue-800 transition-colors whitespace-nowrap"
            >
              <Printer className="w-4 h-4" />
              Imprimer ({doc.format === 'TICKET_80MM' ? '80mm' : 'A4'})
            </button>

            <button
              type="button"
              onClick={handleDownloadStandaloneHtml}
              className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 text-xs font-medium rounded-md hover:bg-slate-100 transition-colors whitespace-nowrap"
              title="Télécharger le document autonome"
            >
              <Download className="w-3.5 h-3.5" />
              Fichier .html
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white rounded-md"
              aria-label="Fermer l'aperçu"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Feuille de papier réaliste sur bureau sombre */}
        <div className="p-6 md:p-8 overflow-y-auto bg-slate-200/90 dark:bg-slate-950 flex-1 flex justify-center items-start">
          <div
            style={{ transform: `scale(${zoom / 100})`, transformOrigin: 'top center' }}
            className={`print-paper-sheet bg-white text-slate-900 border border-slate-300 shadow-xl transition-transform ${
              doc.format === 'TICKET_80MM'
                ? 'w-[330px] p-4 rounded-sm'
                : 'w-full max-w-[810px] min-h-[1040px] p-8 md:p-10 rounded-xs'
            }`}
            dangerouslySetInnerHTML={{ __html: doc.htmlContent }}
          />
        </div>

        {/* Iframe cachée dédiée à l'impression et à la génération PDF propre */}
        <iframe
          ref={iframeRef}
          title="Print Engine"
          className="hidden"
          style={{ width: 0, height: 0, border: 0, position: 'absolute' }}
        />
      </div>
    </div>
  );
};

/**
 * 2. RECHERCHE GLOBALE CTRL+K (Section 31)
 */
export const GlobalSearchModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onNavigate: (tab: string) => void;
}> = ({ open, onClose, onNavigate }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{
    products: Product[];
    customers: Customer[];
    suppliers: Supplier[];
    sales: Sale[];
    quotes: Quote[];
    invoices: Invoice[];
    purchases: Purchase[];
    reminders: SavReminder[];
    equipments: CustomerEquipment[];
    defective: DefectiveProduct[];
  }>({
    products: [],
    customers: [],
    suppliers: [],
    sales: [],
    quotes: [],
    invoices: [],
    purchases: [],
    reminders: [],
    equipments: [],
    defective: [],
  });

  useEffect(() => {
    if (!open) return;
    const q = query.trim().toLowerCase();
    if (!q) {
      setResults({
        products: [],
        customers: [],
        suppliers: [],
        sales: [],
        quotes: [],
        invoices: [],
        purchases: [],
        reminders: [],
        equipments: [],
        defective: [],
      });
      return;
    }

    let active = true;
    (async () => {
      const [
        products,
        customers,
        suppliers,
        sales,
        quotes,
        invoices,
        purchases,
        reminders,
        equipments,
        defective,
      ] = await Promise.all([
        db.products.toArray(),
        db.customers.toArray(),
        db.suppliers.toArray(),
        db.sales.toArray(),
        db.quotes.toArray(),
        db.invoices.toArray(),
        db.purchases.toArray(),
        db.reminders.toArray(),
        db.customerEquipments.toArray(),
        db.defectiveProducts.toArray(),
      ]);
      if (!active) return;

      setResults({
        products: products
          .filter(
            (p) =>
              p.name.toLowerCase().includes(q) ||
              p.reference.toLowerCase().includes(q) ||
              p.barcode.toLowerCase().includes(q)
          )
          .slice(0, 5),
        customers: customers
          .filter(
            (c) =>
              c.name.toLowerCase().includes(q) ||
              c.phone.toLowerCase().includes(q) ||
              c.code.toLowerCase().includes(q) ||
              c.city.toLowerCase().includes(q)
          )
          .slice(0, 5),
        suppliers: suppliers
          .filter((s) => s.name.toLowerCase().includes(q) || s.code.toLowerCase().includes(q))
          .slice(0, 4),
        sales: sales
          .filter(
            (s) => s.number.toLowerCase().includes(q) || s.customerName.toLowerCase().includes(q)
          )
          .slice(0, 4),
        quotes: quotes
          .filter(
            (d) => d.number.toLowerCase().includes(q) || d.customerName.toLowerCase().includes(q)
          )
          .slice(0, 4),
        invoices: invoices
          .filter(
            (i) => i.number.toLowerCase().includes(q) || i.customerName.toLowerCase().includes(q)
          )
          .slice(0, 4),
        purchases: purchases
          .filter(
            (p) => p.number.toLowerCase().includes(q) || p.supplierName.toLowerCase().includes(q)
          )
          .slice(0, 4),
        reminders: reminders
          .filter(
            (r) =>
              r.customerName.toLowerCase().includes(q) ||
              r.equipmentName.toLowerCase().includes(q)
          )
          .slice(0, 4),
        equipments: equipments
          .filter(
            (e) =>
              e.serialNumber.toLowerCase().includes(q) ||
              e.model.toLowerCase().includes(q) ||
              e.customerName.toLowerCase().includes(q)
          )
          .slice(0, 4),
        defective: defective
          .filter(
            (d) =>
              d.number.toLowerCase().includes(q) ||
              d.productRef.toLowerCase().includes(q) ||
              d.productName.toLowerCase().includes(q) ||
              d.defectReason.toLowerCase().includes(q) ||
              (d.supplierName && d.supplierName.toLowerCase().includes(q)) ||
              (d.customerName && d.customerName.toLowerCase().includes(q))
          )
          .slice(0, 4),
      });
    })();

    return () => {
      active = false;
    };
  }, [open, query]);

  if (!open) return null;

  const selectAndGo = (tab: string) => {
    onNavigate(tab);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-start justify-center pt-16 p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg max-w-2xl w-full overflow-hidden">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <Search className="w-5 h-5 text-slate-400" />
          <input
            type="text"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher produit, référence, code-barres, client, facture, devis, n° série équipement..."
            className="w-full text-sm bg-transparent text-slate-900 dark:text-slate-100 focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="text-xs text-slate-500 hover:text-slate-800 px-2 py-1 border border-slate-200 rounded"
          >
            Échap
          </button>
        </div>

        <div className="max-h-[68vh] overflow-y-auto p-4 space-y-4 text-xs">
          {!query.trim() && (
            <p className="text-slate-500 py-6 text-center">
              Tapez un mot-clé pour chercher simultanément dans les 9 modules (Produits, Clients,
              Fournisseurs, Ventes, Devis, Factures, Achats, SAV, Équipements).
            </p>
          )}

          {results.products.length > 0 && (
            <div>
              <div className="font-semibold text-slate-500 mb-1.5">Produits & Consommables</div>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                {results.products.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => selectAndGo('products')}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
                  >
                    <span>
                      <strong className="font-mono">{p.reference}</strong> — {p.name}
                    </span>
                    <span className="font-mono-tabular text-slate-600">
                      Stock: {p.stock} · {formatMad(p.salePriceHtCents)} HT
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.customers.length > 0 && (
            <div>
              <div className="font-semibold text-slate-500 mb-1.5">Clients</div>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                {results.customers.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => selectAndGo('customers')}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
                  >
                    <span>
                      <strong>{c.name}</strong> ({c.city})
                    </span>
                    <span className="font-mono-tabular text-slate-600">
                      {c.phone} · Solde: {formatMad(c.balanceCents)}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.sales.length > 0 && (
            <div>
              <div className="font-semibold text-slate-500 mb-1.5">Ventes</div>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                {results.sales.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => selectAndGo('sales')}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
                  >
                    <span>
                      <strong className="font-mono">{s.number}</strong> — {s.customerName}
                    </span>
                    <span className="font-mono-tabular">
                      {formatMad(s.totalTtcCents)} ({s.status})
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.invoices.length > 0 && (
            <div>
              <div className="font-semibold text-slate-500 mb-1.5">Factures & Avoirs</div>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                {results.invoices.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => selectAndGo('invoices')}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
                  >
                    <span>
                      <strong className="font-mono">{i.number}</strong> — {i.customerName}
                    </span>
                    <span className="font-mono-tabular">
                      {formatMad(i.totalTtcCents)} · {i.status}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.quotes.length > 0 && (
            <div>
              <div className="font-semibold text-slate-500 mb-1.5">Devis</div>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                {results.quotes.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => selectAndGo('quotes')}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
                  >
                    <span>
                      <strong className="font-mono">{d.number}</strong> — {d.customerName}
                    </span>
                    <span className="font-mono-tabular">{formatMad(d.totalTtcCents)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.suppliers.length > 0 && (
            <div>
              <div className="font-semibold text-slate-500 mb-1.5">Fournisseurs</div>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                {results.suppliers.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => selectAndGo('suppliers')}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
                  >
                    <span>
                      <strong>{s.name}</strong> ({s.city})
                    </span>
                    <span className="font-mono-tabular">Dette: {formatMad(s.debtCents)}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.purchases.length > 0 && (
            <div>
              <div className="font-semibold text-slate-500 mb-1.5">Achats</div>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                {results.purchases.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => selectAndGo('purchases')}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
                  >
                    <span>
                      <strong className="font-mono">{p.number}</strong> — {p.supplierName}
                    </span>
                    <span className="font-mono-tabular">
                      {formatMad(p.totalTtcCents)} ({p.status})
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.reminders.length > 0 && (
            <div>
              <div className="font-semibold text-slate-500 mb-1.5">Rappels SAV</div>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                {results.reminders.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => selectAndGo('sav')}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
                  >
                    <span>
                      <strong>{r.customerName}</strong> — {r.equipmentName}
                    </span>
                    <span className="font-mono-tabular">Échéance : {r.dueDate}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.equipments.length > 0 && (
            <div>
              <div className="font-semibold text-slate-500 mb-1.5">Équipements Installés</div>
              <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                {results.equipments.map((e) => (
                  <button
                    key={e.id}
                    type="button"
                    onClick={() => selectAndGo('customers')}
                    className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between"
                  >
                    <span>
                      <strong className="font-mono">{e.serialNumber}</strong> — {e.type} {e.model}
                    </span>
                    <span>{e.customerName}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {results.defective.length > 0 && (
            <div>
              <div className="font-semibold text-red-600 mb-1.5">Produits Défectueux (Quarantaine)</div>
              <div className="divide-y divide-slate-100 border border-red-200 rounded-md bg-red-50/20">
                {results.defective.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => selectAndGo('defective')}
                    className="w-full text-left px-3 py-2 hover:bg-red-50/50 flex items-center justify-between"
                  >
                    <div>
                      <span className="font-mono font-bold text-red-700">{d.number}</span> —{' '}
                      <strong>{d.productName}</strong> ({d.quantity} u)
                      <div className="text-[10px] text-slate-500">Motif : {d.defectReason}</div>
                    </div>
                    <span className="text-[10.5px] font-semibold text-red-700 px-2 py-0.5 rounded bg-red-100">
                      {d.status}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * 3. ÉCRAN DE VERROUILLAGE SÉCURISÉ PIN / PIN MAÎTRE (Section 37)
 */
export const PinLockModal: React.FC<{
  locked: boolean;
  profiles: UserProfile[];
  currentProfile: UserProfile | null;
  isDemoData?: boolean;
  onUnlock: (profile: UserProfile) => void;
}> = ({ locked, profiles, currentProfile, isDemoData = false, onUnlock }) => {
  const [selectedProfileId, setSelectedProfileId] = useState<string>(
    currentProfile?.id ?? profiles[0]?.id ?? 'admin'
  );
  const [pinInput, setPinInput] = useState('');
  const [useMasterPin, setUseMasterPin] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  const activeProfiles = profiles.filter((p) => p.active !== false);
  const selectableProfiles = activeProfiles.length > 0 ? activeProfiles : profiles;

  // Initialiser le profil sélectionné uniquement à l'ouverture de l'écran de verrouillage
  useEffect(() => {
    if (!locked) return;
    setPinInput('');
    setErrorMsg('');
    if (
      currentProfile &&
      profiles.some((p) => p.active !== false && p.id === currentProfile.id)
    ) {
      setSelectedProfileId(currentProfile.id);
    } else if (profiles.length > 0) {
      const firstActive = profiles.find((p) => p.active !== false) ?? profiles[0];
      setSelectedProfileId(firstActive.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locked]);

  // Si le profil sélectionné a été supprimé, basculer sur le premier profil disponible
  useEffect(() => {
    if (
      selectableProfiles.length > 0 &&
      !selectableProfiles.some((p) => p.id === selectedProfileId)
    ) {
      setSelectedProfileId(selectableProfiles[0].id);
    }
  }, [selectableProfiles, selectedProfileId]);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const timer = setInterval(() => {
      setCooldownSeconds((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldownSeconds]);

  if (!locked) return null;

  const targetProfile =
    selectableProfiles.find((p) => p.id === selectedProfileId) ??
    currentProfile ??
    selectableProfiles[0];

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!targetProfile || cooldownSeconds > 0) return;

    const valid = useMasterPin
      ? await verifyPin(pinInput, targetProfile.masterPinSalt, targetProfile.masterPinHash)
      : await verifyPin(pinInput, targetProfile.pinSalt, targetProfile.pinHash);

    if (valid) {
      await db.profiles.update(targetProfile.id, {
        failedAttempts: 0,
        lockedUntil: null,
      });
      setPinInput('');
      setErrorMsg('');
      onUnlock(targetProfile);
    } else {
      const nextFails = (targetProfile.failedAttempts || 0) + 1;
      await db.profiles.update(targetProfile.id, {
        failedAttempts: nextFails,
      });
      setPinInput('');
      if (nextFails >= 3) {
        setCooldownSeconds(10);
        setErrorMsg(
          `3 tentatives erronées. Verrouillage temporaire de sécurité pendant 10 secondes.`
        );
      } else {
        setErrorMsg(
          isDemoData
            ? `Code PIN incorrect (${nextFails}/3). En mode démo initial : PIN = 2468, PIN Maître = 135790.`
            : `Code PIN incorrect (${nextFails}/3) pour le profil « ${targetProfile.name} ».`
        );
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#0F172A]/95 zellige-pattern flex items-center justify-center p-4">
      <div className="bg-white border border-slate-300 rounded-lg max-w-md w-full p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-md bg-[#0F172A] text-[#D9A95B] flex items-center justify-center">
            <Lock className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-display text-2xl font-bold text-slate-900">
              Session Verrouillée
            </h2>
            <p className="text-xs text-slate-500">
              Authentification locale PBKDF2 / Web Crypto API
            </p>
          </div>
        </div>

        <form onSubmit={handleVerify} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1">
              Profil Opérateur ({selectableProfiles.length} disponible{selectableProfiles.length > 1 ? 's' : ''})
            </label>
            <select
              value={selectedProfileId}
              onChange={(e) => {
                setSelectedProfileId(e.target.value);
                setErrorMsg('');
                setPinInput('');
              }}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white text-slate-900 font-medium cursor-pointer"
            >
              {selectableProfiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — [{p.role}]
                </option>
              ))}
            </select>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-medium text-slate-700">
                {useMasterPin ? 'Code PIN Maître de Secours' : 'Code PIN Personnel'}
              </label>
              <button
                type="button"
                onClick={() => setUseMasterPin((v) => !v)}
                className="text-xs text-[#1D4ED8] hover:underline"
              >
                {useMasterPin ? 'Utiliser PIN standard' : 'Utiliser PIN Maître'}
              </button>
            </div>
            <input
              type="password"
              autoFocus
              disabled={cooldownSeconds > 0}
              value={pinInput}
              onChange={(e) => setPinInput(e.target.value)}
              placeholder={useMasterPin ? 'Saisir le PIN Maître...' : 'Saisir votre PIN...'}
              className="w-full px-3 py-2.5 text-center text-lg font-mono tracking-widest border border-slate-300 rounded-md focus:outline-none focus:border-[#1D4ED8]"
            />
          </div>

          {errorMsg && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md text-xs text-red-700 flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                {errorMsg}{' '}
                {cooldownSeconds > 0 && (
                  <strong className="font-mono">({cooldownSeconds}s)</strong>
                )}
              </span>
            </div>
          )}

          <button
            type="submit"
            disabled={cooldownSeconds > 0 || !pinInput}
            className="w-full py-2.5 px-4 bg-[#0F172A] text-white text-sm font-medium rounded-md hover:bg-slate-800 disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
          >
            <KeyRound className="w-4 h-4" />
            Déverrouiller l&apos;application
          </button>
        </form>
      </div>
    </div>
  );
};

/**
 * 4. ASSISTANT DE PREMIER DÉMARRAGE EN 9 ÉTAPES (Section 48)
 */
export const FirstStartWizardModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onCompleted: () => void;
}> = ({ open, onClose, onCompleted }) => {
  const [step, setStep] = useState(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<FirstRunSetupInput>({
    companyName: 'ATLAS SOFT WATER',
    legalName: 'ATLAS SOFT WATER MAROC SARL',
    ice: '003194827000054',
    ifNumber: '52849103',
    rc: '549201',
    patente: '34910284',
    cnss: '4829104',
    address: 'Bd Abdelmoumen, N° 142',
    city: 'Casablanca',
    phone: '+212 5 22 48 91 00',
    whatsapp: '+212 6 61 48 91 00',
    email: 'contact@atlassoftwater.ma',
    defaultVatRate: 20,
    currency: 'MAD',
    pin: '',
    masterPin: '',
    loadDemoData: true,
    adminName: 'Administrateur (Dirigeant)',
  });

  if (!open) return null;

  const handleFinish = async () => {
    if (form.pin.trim().length < 4) {
      setError('Étape 7 : Veuillez définir un code PIN personnel d’au moins 4 caractères.');
      setStep(7);
      return;
    }
    if (form.masterPin.trim().length < 4 || form.masterPin === form.pin) {
      setError(
        'Étape 8 : Veuillez définir un PIN Maître d’au moins 4 caractères différent du PIN standard.'
      );
      setStep(8);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await initializeWithSetupConfig(form);
      onCompleted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  const stepTitles = [
    '1. Nom commercial',
    '2. Informations légales (Maroc)',
    '3. Adresse & Ville',
    '4. Téléphone & WhatsApp',
    '5. Fiscalité & TVA',
    '6. Devise',
    '7. Code PIN Opérateur',
    '8. Code PIN Maître',
    '9. Mode de Base de Données',
  ];

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/75 flex items-center justify-center p-4">
      <div className="bg-white border border-slate-300 rounded-lg max-w-2xl w-full p-6">
        <div className="flex items-center justify-between pb-4 border-b border-slate-200 mb-5">
          <div>
            <h2 className="font-display text-2xl font-bold text-slate-900">
              Assistant de Configuration Initiale (9 Étapes)
            </h2>
            <p className="text-xs text-slate-500">
              Étape {step} sur 9 — {stepTitles[step - 1]}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-slate-700"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Barre de progression */}
        <div className="grid grid-cols-9 gap-1 mb-6">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStep(s)}
              className={`h-2 rounded-sm transition-colors ${
                s === step
                  ? 'bg-[#1D4ED8]'
                  : s < step
                  ? 'bg-emerald-600'
                  : 'bg-slate-200'
              }`}
              title={stepTitles[s - 1]}
            />
          ))}
        </div>

        <div className="min-h-[210px] space-y-4">
          {step === 1 && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Enseigne / Nom commercial *
                </label>
                <input
                  type="text"
                  value={form.companyName}
                  onChange={(e) => setForm({ ...form, companyName: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Raison sociale officielle
                </label>
                <input
                  type="text"
                  value={form.legalName}
                  onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-md flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  {form.logoDataUrl ? (
                    <img
                      src={form.logoDataUrl}
                      alt="Logo"
                      className="h-11 w-20 object-contain bg-white border border-slate-300 rounded p-1"
                    />
                  ) : (
                    <div className="w-11 h-11 rounded bg-[#0F172A] text-[#D9A95B] flex items-center justify-center font-display font-bold text-lg">
                      {(form.companyName || 'A').charAt(0).toUpperCase()}
                    </div>
                  )}
                  <div className="text-xs">
                    <div className="font-semibold text-slate-900">Logo de l&apos;entreprise</div>
                    <div className="text-slate-500">
                      Optionnel — apparaîtra sur vos factures, devis et tickets
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  <label className="cursor-pointer inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1D4ED8] text-white text-xs font-medium rounded hover:bg-blue-800">
                    <Upload className="w-3.5 h-3.5" />
                    {form.logoDataUrl ? 'Changer' : 'Importer Logo'}
                    <input
                      type="file"
                      accept="image/*"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        try {
                          const dataUrl = await fileToLogoDataUrl(file);
                          setForm((prev) => ({ ...prev, logoDataUrl: dataUrl }));
                        } catch (err) {
                          setError(err instanceof Error ? err.message : String(err));
                        }
                      }}
                      className="hidden"
                    />
                  </label>
                  {form.logoDataUrl && (
                    <button
                      type="button"
                      onClick={() => setForm((prev) => ({ ...prev, logoDataUrl: undefined }))}
                      className="p-1.5 text-rose-700 hover:bg-rose-50 border border-rose-200 rounded"
                      title="Supprimer le logo"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  ICE (15 chiffres)
                </label>
                <input
                  type="text"
                  value={form.ice}
                  onChange={(e) => setForm({ ...form, ice: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Identifiant Fiscal (IF)
                </label>
                <input
                  type="text"
                  value={form.ifNumber}
                  onChange={(e) => setForm({ ...form, ifNumber: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Registre de Commerce (RC)
                </label>
                <input
                  type="text"
                  value={form.rc}
                  onChange={(e) => setForm({ ...form, rc: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Patente / CNSS
                </label>
                <input
                  type="text"
                  value={form.patente}
                  onChange={(e) => setForm({ ...form, patente: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                />
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Adresse complète du siège / magasin
                </label>
                <input
                  type="text"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">Ville</label>
                <input
                  type="text"
                  value={form.city}
                  onChange={(e) => setForm({ ...form, city: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
            </div>
          )}

          {step === 4 && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Téléphone fixe / principal
                </label>
                <input
                  type="text"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Numéro WhatsApp SAV
                </label>
                <input
                  type="text"
                  value={form.whatsapp}
                  onChange={(e) => setForm({ ...form, whatsapp: e.target.value })}
                  className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md"
                />
              </div>
              <div className="col-span-2">
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Email professionnel
                </label>
                <input
                  type="email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
            </div>
          )}

          {step === 5 && (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-slate-700">
                Taux de TVA par défaut proposé sur les nouvelles fiches produits (%)
              </label>
              <select
                value={form.defaultVatRate}
                onChange={(e) => setForm({ ...form, defaultVatRate: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md bg-white"
              >
                <option value={20}>20 % (Taux normal Maroc)</option>
                <option value={14}>14 % (Taux intermédiaire)</option>
                <option value={10}>10 % (Taux réduit)</option>
                <option value={7}>7 % (Taux spécifique eau / équipements)</option>
                <option value={0}>0 % (Exonéré / Auto-entrepreneur)</option>
              </select>
              <p className="text-xs text-slate-500">
                Conformément à la Règle 10, chaque ligne de document conserve son propre taux de TVA
                indépendant.
              </p>
            </div>
          )}

          {step === 6 && (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-slate-700">
                Devise comptable principale
              </label>
              <select
                value={form.currency}
                onChange={(e) => setForm({ ...form, currency: e.target.value })}
                className="w-full px-3 py-2 text-sm font-mono border border-slate-300 rounded-md bg-white"
              >
                <option value="MAD">MAD — Dirham Marocain (DH)</option>
                <option value="DH">DH — Dirham Marocain</option>
                <option value="EUR">EUR — Euro (€)</option>
              </select>
            </div>
          )}

          {step === 7 && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Nom complet & Fonction de l&apos;Administrateur principal *
                </label>
                <input
                  type="text"
                  value={form.adminName ?? ''}
                  onChange={(e) => setForm({ ...form, adminName: e.target.value })}
                  placeholder="Ex: Mohammed Alami (Dirigeant)"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1">
                  Définissez votre Code PIN personnel (obligatoire, non stocké en clair) *
                </label>
                <input
                  type="password"
                  value={form.pin}
                  onChange={(e) => setForm({ ...form, pin: e.target.value })}
                  placeholder="Ex: 4 à 8 chiffres"
                  className="w-full px-3 py-2.5 text-lg font-mono border border-slate-300 rounded-md"
                />
              </div>
              <p className="text-xs text-slate-500">
                Aucun PIN universel n&apos;est imposé. Votre PIN est haché localement via PBKDF2
                (60 000 itérations + sel aléatoire). Vous pourrez ajouter ou modifier d&apos;autres
                utilisateurs à tout moment dans Paramètres.
              </p>
            </div>
          )}

          {step === 8 && (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-slate-700">
                Définissez votre Code PIN Maître de sécurité (différent du PIN opérateur)
              </label>
              <input
                type="password"
                value={form.masterPin}
                onChange={(e) => setForm({ ...form, masterPin: e.target.value })}
                placeholder="Ex: 6 à 10 chiffres"
                className="w-full px-3 py-2.5 text-lg font-mono border border-slate-300 rounded-md"
              />
              <p className="text-xs text-slate-500">
                Permet de débloquer l&apos;application en cas d&apos;oubli du PIN vendeur ou
                d&apos;autoriser les opérations sensibles.
              </p>
            </div>
          )}

          {step === 9 && (
            <div className="space-y-3">
              <label className="block text-xs font-medium text-slate-700 mb-2">
                Choisissez le mode d&apos;initialisation de la base IndexedDB :
              </label>
              <div className="grid grid-cols-2 gap-4">
                <button
                  type="button"
                  onClick={() => setForm({ ...form, loadDemoData: false })}
                  className={`p-4 border rounded-lg text-left transition-colors ${
                    !form.loadDemoData
                      ? 'border-[#1D4ED8] bg-blue-50/50'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="font-semibold text-sm text-slate-900 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    Base de Production Vierge
                  </div>
                  <p className="text-xs text-slate-600 mt-1">
                    Démarre avec 0 produit, 0 vente et 0 client (uniquement Client Comptoir et vos
                    paramètres). Idéal pour démarrer votre saisie réelle.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setForm({ ...form, loadDemoData: true })}
                  className={`p-4 border rounded-lg text-left transition-colors ${
                    form.loadDemoData
                      ? 'border-[#1D4ED8] bg-blue-50/50'
                      : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <div className="font-semibold text-sm text-slate-900 flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-amber-600" />
                    Données de Démonstration
                  </div>
                  <p className="text-xs text-slate-600 mt-1">
                    Charge un jeu complet (Osmoseurs, Membranes FilmTec, Adoucisseurs Fleck, SAV,
                    Ventes) explicitement marqué <strong>DONNÉES DE DÉMONSTRATION</strong>.
                  </p>
                </button>
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded text-xs text-red-700">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between pt-5 mt-5 border-t border-slate-200">
          <button
            type="button"
            disabled={step === 1}
            onClick={() => setStep((s) => Math.max(1, s - 1))}
            className="px-4 py-2 text-xs font-medium text-slate-700 border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-40"
          >
            Étape précédente
          </button>

          {step < 9 ? (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(9, s + 1))}
              className="px-4 py-2 text-xs font-medium bg-[#0F172A] text-white rounded-md hover:bg-slate-800"
            >
              Étape suivante ({step + 1}/9)
            </button>
          ) : (
            <button
              type="button"
              disabled={submitting}
              onClick={handleFinish}
              className="inline-flex items-center gap-2 px-5 py-2 text-xs font-medium bg-[#1D4ED8] text-white rounded-md hover:bg-blue-800 disabled:opacity-50"
            >
              <UserCheck className="w-4 h-4" />
              {submitting ? 'Initialisation...' : 'Valider et Initialiser la Base'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * 5. MODALE DE FERMETURE ET ARRÊT DU SERVEUR NODE.JS (OPTION 1)
 */
export const ShutdownModal: React.FC<{
  open: boolean;
  onClose: () => void;
  onRequestShutdown: () => Promise<void>;
  isShuttingDown: boolean;
  shutdownDone: boolean;
}> = ({ open, onClose, onRequestShutdown, isShuttingDown, shutdownDone }) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-2xl max-w-md w-full overflow-hidden text-slate-800 dark:text-slate-100">
        <div className="p-5 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-red-100 dark:bg-red-950/60 text-red-600 dark:text-red-400">
              <Power className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-semibold text-base">Fermeture & Arrêt Node.js</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Synchronisation automatique (Option 1)
              </p>
            </div>
          </div>
          {!shutdownDone && (
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded-md text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        <div className="p-5 space-y-4">
          {shutdownDone ? (
            <div className="text-center py-4 space-y-3">
              <div className="w-12 h-12 mx-auto rounded-full bg-emerald-100 dark:bg-emerald-950/60 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="w-6 h-6" />
              </div>
              <div className="space-y-1">
                <h4 className="font-bold text-base text-emerald-700 dark:text-emerald-400">
                  Serveur Node.js arrêté avec succès
                </h4>
                <p className="text-xs text-slate-600 dark:text-slate-400 max-w-xs mx-auto">
                  Le processus Node.js sur votre machine a été éteint proprement. L’application est désormais inactive.
                </p>
              </div>
              <div className="pt-2">
                <button
                  type="button"
                  onClick={() => {
                    try {
                      window.close();
                    } catch {
                      // ignore
                    }
                  }}
                  className="w-full py-2.5 px-4 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 dark:bg-slate-700 dark:hover:bg-slate-600 rounded-lg transition-colors cursor-pointer"
                >
                  Fermer cet onglet
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="p-3.5 rounded-lg bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-900/60 space-y-2 text-xs">
                <div className="flex items-center gap-2 font-semibold text-blue-900 dark:text-blue-300">
                  <Radio className="w-4 h-4 text-blue-600 animate-pulse" />
                  <span>Arrêt automatique actif (Option 1)</span>
                </div>
                <p className="text-blue-800 dark:text-blue-300/90 leading-relaxed">
                  Dès que vous <strong>fermez cet onglet ou la fenêtre de votre navigateur</strong>, le signal de fermeture est automatiquement transmis à Node.js (via le battement Heartbeat & Beacon), qui <strong>s’éteint de lui-même après quelques secondes</strong>.
                </p>
              </div>

              <div className="space-y-2 text-xs text-slate-600 dark:text-slate-300">
                <div className="flex items-start gap-2">
                  <Server className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                  <span>
                    Vous pouvez aussi forcer l’<strong>arrêt immédiat du serveur Node.js</strong> maintenant sans attendre la fermeture de la fenêtre.
                  </span>
                </div>
              </div>

              <div className="pt-3 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isShuttingDown}
                  className="px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                >
                  Annuler
                </button>
                <button
                  type="button"
                  onClick={onRequestShutdown}
                  disabled={isShuttingDown}
                  className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors shadow-sm disabled:opacity-60 cursor-pointer"
                >
                  <Power className="w-3.5 h-3.5" />
                  {isShuttingDown ? 'Arrêt en cours...' : 'Arrêter Node.js maintenant'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
