import React, { useEffect, useState } from 'react';
import {
  Archive,
  ArrowUpDown,
  CheckCircle2,
  Download,
  Edit,
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
  executeUpdateCustomer,
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
import { WhatsAppMessageModal } from '../components/WhatsAppMessageModal';

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

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            Commandes Fournisseurs & Réceptions
          </h1>
          <p className="text-xs text-slate-500">
            Règle 6 : Le stock n&apos;augmente qu&apos;à la réception physique
          </p>
        </div>
      </div>

      <div className="bg-white border rounded-lg overflow-hidden text-xs">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50 border-b text-left text-slate-600">
              <th className="py-3 px-4">N° Achat</th>
              <th className="py-3 px-4">Date</th>
              <th className="py-3 px-4">Fournisseur</th>
              <th className="py-3 px-4 text-right">Total TTC</th>
              <th className="py-3 px-4 text-right">Payé</th>
              <th className="py-3 px-4">Statut</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {purchases.map((po) => (
              <tr key={po.id}>
                <td className="py-3 px-4 font-mono font-semibold">{po.number}</td>
                <td className="py-3 px-4">{formatBusinessDateFr(po.businessDate)}</td>
                <td className="py-3 px-4">{po.supplierName}</td>
                <td className="py-3 px-4 text-right font-bold">{formatMad(po.totalTtcCents)}</td>
                <td className="py-3 px-4 text-right text-emerald-700">{formatMad(po.paidCents)}</td>
                <td className="py-3 px-4 font-mono font-semibold">{po.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/**
 * SECTION 26 : FOURNISSEURS
 */
export const SuppliersView: React.FC<{
  refreshTrigger: number;
  onChanged: () => void;
}> = ({ refreshTrigger, onChanged }) => {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);

  useEffect(() => {
    db.suppliers.toArray().then(setSuppliers);
  }, [refreshTrigger]);

  return (
    <div className="space-y-5">
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h1 className="font-display text-2xl font-bold text-slate-900">
          Fournisseurs & Grossistes
        </h1>
        <p className="text-xs text-slate-500">
          Répertoire des partenaires ({suppliers.length} référencé(s))
        </p>
      </div>

      <div className="bg-white border rounded-lg overflow-hidden text-xs">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50 border-b text-left text-slate-600">
              <th className="py-3 px-4">Code</th>
              <th className="py-3 px-4">Nom</th>
              <th className="py-3 px-4">Ville</th>
              <th className="py-3 px-4 text-right">Dette Courante</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {suppliers.map((s) => (
              <tr key={s.id}>
                <td className="py-3 px-4 font-mono font-semibold">{s.code}</td>
                <td className="py-3 px-4 font-medium">{s.name}</td>
                <td className="py-3 px-4">{s.city}</td>
                <td className="py-3 px-4 text-right font-bold text-red-700">{formatMad(s.debtCents)}</td>
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
 * Avec modification complète des données client & intégration WhatsApp bi-canal
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

  // 1- MODIFICATION DE DONNÉES D'UN CLIENT
  const [editingCustomer, setEditingCustomer] = useState<Customer | null>(null);
  const [editForm, setEditForm] = useState({
    name: '',
    type: 'PARTICULIER' as CustomerType,
    phone: '',
    whatsapp: '',
    email: '',
    city: '',
    address: '',
    ice: '',
    notes: '',
  });

  // 2- MODULE WHATSAPP BI-CANAL NORMALISÉ
  const [whatsappModalData, setWhatsappModalData] = useState<{
    open: boolean;
    recipientName: string;
    recipientPhone: string;
    defaultMessage: string;
  }>({
    open: false,
    recipientName: '',
    recipientPhone: '',
    defaultMessage: '',
  });

  const [feedback, setFeedback] = useState<string | null>(null);
  const [searchCust, setSearchCust] = useState('');

  const [custForm, setCustForm] = useState({
    name: '',
    type: 'PARTICULIER' as CustomerType,
    phone: '',
    whatsapp: '',
    email: '',
    city: 'Casablanca',
    address: '',
    ice: '',
    notes: '',
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
          notes: custForm.notes || '',
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
    setCustForm({
      name: '',
      type: 'PARTICULIER',
      phone: '',
      whatsapp: '',
      email: '',
      city: 'Casablanca',
      address: '',
      ice: '',
      notes: '',
    });
    onChanged();
    setFeedback('Nouveau client ajouté avec succès.');
  };

  const openEditCustomerModal = (c: Customer) => {
    setEditingCustomer(c);
    setEditForm({
      name: c.name,
      type: c.type,
      phone: c.phone,
      whatsapp: c.whatsapp || c.phone,
      email: c.email || '',
      city: c.city || 'Casablanca',
      address: c.address || '',
      ice: c.ice || '',
      notes: c.notes || '',
    });
  };

  const handleSaveCustomerEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCustomer || !editForm.name.trim()) return;

    try {
      const updated = await executeUpdateCustomer({
        customerId: editingCustomer.id,
        name: editForm.name,
        type: editForm.type,
        phone: editForm.phone,
        whatsapp: editForm.whatsapp || editForm.phone,
        email: editForm.email,
        city: editForm.city,
        address: editForm.address,
        ice: editForm.ice,
        notes: editForm.notes,
      });

      setEditingCustomer(null);
      onChanged();
      setFeedback(`Données du client "${updated.name}" (${updated.code}) mises à jour avec succès.`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
    }
  };

  const openWhatsAppModal = (c: Customer) => {
    const targetPhone = c.whatsapp || c.phone;
    setWhatsappModalData({
      open: true,
      recipientName: c.name,
      recipientPhone: targetPhone,
      defaultMessage: `Bonjour ${c.name}, ici ATLAS SOFT WATER (Traitement de l'Eau). Nous restons à votre entière disposition pour tout renseignement, suivi d'équipement ou commande.`,
    });
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
        ? `Arbitrage Règles 15 & 18 : Client "${c.name}" désactivé logiquement. Ses ventes, factures et équipements restent préservés.`
        : `Client "${c.name}" supprimé.`
    );
  };

  const filteredCustomers = customers.filter((c) => {
    if (!searchCust.trim()) return true;
    const q = searchCust.toLowerCase();
    return (
      c.name.toLowerCase().includes(q) ||
      c.phone.toLowerCase().includes(q) ||
      c.city.toLowerCase().includes(q) ||
      c.code.toLowerCase().includes(q) ||
      (c.ice && c.ice.includes(q))
    );
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            Fichier Clients & Équipements Installés
          </h1>
          <p className="text-xs text-slate-500">
            Modification des données clients, suivi des équipements et messagerie WhatsApp bi-canal
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={searchCust}
            onChange={(e) => setSearchCust(e.target.value)}
            placeholder="Rechercher nom, tél, ICE, ville..."
            className="px-3 py-1.5 text-xs border border-slate-300 dark:border-slate-700 rounded-md bg-white dark:bg-slate-800 min-w-[220px]"
          />
          <button
            type="button"
            onClick={() => setShowCreateCust((v) => !v)}
            className="inline-flex items-center gap-1.5 px-4 py-2 bg-[#0F172A] text-white text-xs font-semibold rounded-md hover:bg-slate-800"
          >
            <Plus className="w-4 h-4" /> Nouveau Client
          </button>
        </div>
      </div>

      {feedback && (
        <div className="p-3 bg-blue-50 border border-blue-200 text-blue-900 rounded text-xs flex justify-between">
          <span>{feedback}</span>
          <button type="button" onClick={() => setFeedback(null)} className="underline">
            Fermer
          </button>
        </div>
      )}

      {/* Formulaire de Création Client */}
      {showCreateCust && (
        <form
          onSubmit={handleCreateCustomer}
          className="bg-white border border-slate-300 rounded-lg p-5 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs shadow-xs"
        >
          <div className="col-span-full font-bold text-slate-900 border-b pb-2">
            Créer une nouvelle fiche client
          </div>
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
            <label className="block font-medium mb-1">Téléphone</label>
            <input
              type="text"
              value={custForm.phone}
              onChange={(e) =>
                setCustForm({ ...custForm, phone: e.target.value, whatsapp: custForm.whatsapp || e.target.value })
              }
              placeholder="06... / 07... / 05..."
              className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">WhatsApp (pour notifications)</label>
            <input
              type="text"
              value={custForm.whatsapp}
              onChange={(e) => setCustForm({ ...custForm, whatsapp: e.target.value })}
              placeholder="06... / +212..."
              className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Email</label>
            <input
              type="email"
              value={custForm.email}
              onChange={(e) => setCustForm({ ...custForm, email: e.target.value })}
              className="w-full px-3 py-1.5 border border-slate-300 rounded"
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
            <label className="block font-medium mb-1">Adresse complète</label>
            <input
              type="text"
              value={custForm.address}
              onChange={(e) => setCustForm({ ...custForm, address: e.target.value })}
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
          <div>
            <label className="block font-medium mb-1">Notes / Instructions</label>
            <input
              type="text"
              value={custForm.notes}
              onChange={(e) => setCustForm({ ...custForm, notes: e.target.value })}
              className="w-full px-3 py-1.5 border border-slate-300 rounded"
            />
          </div>
          <div className="col-span-full flex justify-end gap-2 pt-2 border-t">
            <button
              type="button"
              onClick={() => setShowCreateCust(false)}
              className="px-3 py-1.5 border rounded"
            >
              Annuler
            </button>
            <button
              type="submit"
              className="px-4 py-1.5 bg-[#0F172A] text-white font-medium rounded"
            >
              Enregistrer le Client
            </button>
          </div>
        </form>
      )}

      {/* 1- MODALE DE MODIFICATION D'UN CLIENT */}
      {editingCustomer && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handleSaveCustomerEdit}
            className="bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-xl max-w-2xl w-full p-6 space-y-4 text-xs shadow-2xl my-6"
          >
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900 dark:text-white flex items-center gap-2">
                  <Edit className="w-4 h-4 text-[#1D4ED8]" />
                  <span>Modifier la fiche Client : {editingCustomer.name}</span>
                </h3>
                <p className="text-[11px] text-slate-500 font-mono">
                  Code Client : {editingCustomer.code}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingCustomer(null)}
                className="text-slate-400 hover:text-slate-700 text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
              <div className="md:col-span-2">
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Nom complet / Raison Sociale *
                </label>
                <input
                  type="text"
                  required
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-white font-medium"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Type de Client
                </label>
                <select
                  value={editForm.type}
                  onChange={(e) => setEditForm({ ...editForm, type: e.target.value as CustomerType })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                >
                  <option value="PARTICULIER">Particulier / Villa</option>
                  <option value="PROFESSIONNEL">Professionnel / Entreprise / Clinique</option>
                  <option value="INSTALLATEUR">Installateur / Plombier</option>
                  <option value="REVENDEUR">Revendeur</option>
                </select>
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Ville
                </label>
                <input
                  type="text"
                  value={editForm.city}
                  onChange={(e) => setEditForm({ ...editForm, city: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Numéro de Téléphone
                </label>
                <input
                  type="text"
                  value={editForm.phone}
                  onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                  placeholder="06... / 07... / 05..."
                  className="w-full px-3 py-2 font-mono border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Numéro WhatsApp (Notifications & SAV)
                </label>
                <input
                  type="text"
                  value={editForm.whatsapp}
                  onChange={(e) => setEditForm({ ...editForm, whatsapp: e.target.value })}
                  placeholder="06... / +212..."
                  className="w-full px-3 py-2 font-mono border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Email
                </label>
                <input
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
                />
              </div>

              <div>
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Identifiant Commun de l&apos;Entreprise (ICE)
                </label>
                <input
                  type="text"
                  value={editForm.ice}
                  onChange={(e) => setEditForm({ ...editForm, ice: e.target.value })}
                  placeholder="15 chiffres"
                  className="w-full px-3 py-2 font-mono border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Adresse de livraison / installation
                </label>
                <input
                  type="text"
                  value={editForm.address}
                  onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block font-semibold text-slate-700 dark:text-slate-300 mb-1">
                  Notes & Observations
                </label>
                <textarea
                  rows={2}
                  value={editForm.notes}
                  onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                  placeholder="Contrat maintenance, particularités d'accès..."
                  className="w-full px-3 py-2 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
                />
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t">
              <button
                type="button"
                onClick={() => setEditingCustomer(null)}
                className="px-4 py-2 border rounded font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-5 py-2 bg-[#1D4ED8] hover:bg-blue-800 text-white font-semibold rounded shadow-xs"
              >
                Enregistrer les Modifications
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Table des Clients */}
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg overflow-hidden text-xs">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 text-left text-slate-600">
              <th className="py-3 px-4">Code</th>
              <th className="py-3 px-4">Client</th>
              <th className="py-3 px-4">Téléphone & WhatsApp</th>
              <th className="py-3 px-4">Ville</th>
              <th className="py-3 px-4 text-right">Créance (Dû)</th>
              <th className="py-3 px-4">Équipements liés</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredCustomers.map((c) => {
              const custEquips = equipments.filter((e) => e.customerId === c.id);
              return (
                <tr key={c.id} className={!c.active ? 'opacity-50 bg-slate-50' : 'hover:bg-slate-50/70'}>
                  <td className="py-3 px-4 font-mono font-semibold">{c.code}</td>
                  <td className="py-3 px-4">
                    <div className="font-semibold text-slate-900 dark:text-white">{c.name}</div>
                    <div className="text-[11px] text-slate-500">
                      {c.type} {c.ice ? `• ICE ${c.ice}` : ''}
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono">
                    <div>{c.phone || '—'}</div>
                    {c.whatsapp && (
                      <button
                        type="button"
                        onClick={() => openWhatsAppModal(c)}
                        className="inline-flex items-center gap-1 text-[11px] text-emerald-700 hover:underline mt-0.5"
                        title="Ouvrir le module d'envoi WhatsApp bi-canal"
                      >
                        <MessageCircle className="w-3 h-3 text-emerald-600" />
                        <span>{c.whatsapp}</span>
                      </button>
                    )}
                  </td>
                  <td className="py-3 px-4">{c.city}</td>
                  <td className="py-3 px-4 text-right font-bold text-amber-800 font-mono-tabular">
                    {formatMad(c.balanceCents)}
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
                  <td className="py-3 px-4 text-right space-x-1.5 whitespace-nowrap">
                    {/* Bouton WhatsApp direct */}
                    <button
                      type="button"
                      onClick={() => openWhatsAppModal(c)}
                      className="px-2.5 py-1 border border-emerald-300 bg-emerald-50 text-emerald-800 rounded hover:bg-emerald-100 inline-flex items-center gap-1 font-medium"
                      title="Préparer et envoyer un message WhatsApp au client"
                    >
                      <MessageCircle className="w-3.5 h-3.5 text-emerald-600" />
                      <span>WhatsApp</span>
                    </button>
                    {/* 1- Bouton Modifier les données du client */}
                    <button
                      type="button"
                      onClick={() => openEditCustomerModal(c)}
                      className="px-2.5 py-1 border border-blue-300 bg-blue-50 text-blue-900 rounded hover:bg-blue-100 font-medium inline-flex items-center gap-1"
                      title="Modifier les coordonnées, le nom ou les informations du client"
                    >
                      <Edit className="w-3 h-3 text-[#1D4ED8]" />
                      <span>Modifier</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowAddEquipForCust(c)}
                      className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-100"
                    >
                      + Équipement
                    </button>
                    {c.active && c.code !== 'CLI-COMPTOIR' && (
                      <button
                        type="button"
                        onClick={() => handleDeactivateCust(c)}
                        className="px-2 py-1 border border-red-200 text-red-700 rounded hover:bg-red-50"
                        title="Archiver le client"
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
            className="bg-white border rounded-lg max-w-lg w-full p-6 space-y-3 text-xs"
          >
            <h3 className="font-bold text-sm">
              Ajouter un Équipement & Rappel SAV pour {showAddEquipForCust.name}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block mb-1">Type d&apos;appareil</label>
                <input
                  type="text"
                  required
                  value={equipForm.type}
                  onChange={(e) => setEquipForm({ ...equipForm, type: e.target.value })}
                  className="w-full p-2 border rounded"
                />
              </div>
              <div>
                <label className="block mb-1">Modèle</label>
                <input
                  type="text"
                  required
                  value={equipForm.model}
                  onChange={(e) => setEquipForm({ ...equipForm, model: e.target.value })}
                  className="w-full p-2 border rounded"
                />
              </div>
              <div>
                <label className="block mb-1">N° de série</label>
                <input
                  type="text"
                  required
                  value={equipForm.serialNumber}
                  onChange={(e) => setEquipForm({ ...equipForm, serialNumber: e.target.value })}
                  className="w-full p-2 border rounded font-mono"
                />
              </div>
              <div>
                <label className="block mb-1">Cycle SAV (mois)</label>
                <select
                  value={equipForm.intervalMonths}
                  onChange={(e) => setEquipForm({ ...equipForm, intervalMonths: Number(e.target.value) })}
                  className="w-full p-2 border rounded"
                >
                  <option value={6}>6 mois</option>
                  <option value={12}>12 mois</option>
                  <option value={24}>24 mois</option>
                </select>
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowAddEquipForCust(null)}
                className="px-3 py-1.5 border rounded"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-[#0F172A] text-white rounded font-medium"
              >
                Enregistrer
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modale d'envoi WhatsApp bi-canal */}
      <WhatsAppMessageModal
        open={whatsappModalData.open}
        onClose={() => setWhatsappModalData((prev) => ({ ...prev, open: false }))}
        recipientName={whatsappModalData.recipientName}
        recipientPhone={whatsappModalData.recipientPhone}
        defaultMessage={whatsappModalData.defaultMessage}
        title="Contact WhatsApp Client"
        subtitle="Envoi direct et normalisé au format marocain E.164 (+212...)"
      />
    </div>
  );
};

/**
 * SECTION 21 : MODULE SAV & REMPLACEMENT PÉRIODIQUE DES FILTRES (Règle 18)
 * Avec module WhatsApp bi-canal réparé et normalisé
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

  // 2- MODULE WHATSAPP BI-CANAL POUR RAPPELS SAV
  const [whatsappModalData, setWhatsappModalData] = useState<{
    open: boolean;
    recipientName: string;
    recipientPhone: string;
    defaultMessage: string;
  }>({
    open: false,
    recipientName: '',
    recipientPhone: '',
    defaultMessage: '',
  });

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

  const openWhatsAppForReminder = (r: SavReminder) => {
    const targetPhone = r.customerWhatsapp || r.customerPhone;
    const msg = `Bonjour ${r.customerName},\n\nIci ATLAS SOFT WATER. Le suivi périodique et le remplacement recommandé des filtres pour votre équipement ${r.equipmentName} arrive à échéance le ${formatBusinessDateFr(r.dueDate)}.\n\nSouhaitez-vous que nous planifiions le passage de notre technicien cette semaine pour le contrôle qualité de l'eau et le changement des cartouches ?\n\nCordialement,\nService Technique & SAV Atlas Soft Water`;

    setWhatsappModalData({
      open: true,
      recipientName: r.customerName,
      recipientPhone: targetPhone,
      defaultMessage: msg,
    });
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
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
            Maintenance SAV & Remplacement Périodique des Filtres
          </h1>
          <p className="text-xs text-slate-500">
            Suivi des échéances, relances WhatsApp sécurisées et consommation de pièces
          </p>
        </div>
      </div>

      {feedback && (
        <div className="p-3 bg-emerald-50 border border-emerald-300 text-emerald-900 rounded text-xs flex justify-between">
          <span>{feedback}</span>
          <button type="button" onClick={() => setFeedback(null)} className="underline">
            Fermer
          </button>
        </div>
      )}

      <div className="bg-white border rounded-lg overflow-hidden text-xs">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50 border-b text-left text-slate-600">
              <th className="py-3 px-4">Client</th>
              <th className="py-3 px-4">Équipement</th>
              <th className="py-3 px-4">Consommable</th>
              <th className="py-3 px-4">Échéance</th>
              <th className="py-3 px-4">Statut</th>
              <th className="py-3 px-4 text-right">Actions SAV</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {reminders.map((r) => {
              const st = computeSavReminderStatus(r.dueDate, r.completedAt);
              return (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="py-3 px-4 font-semibold">{r.customerName}</td>
                  <td className="py-3 px-4">{r.equipmentName}</td>
                  <td className="py-3 px-4">{r.productName}</td>
                  <td className="py-3 px-4 font-mono">{formatBusinessDateFr(r.dueDate)}</td>
                  <td className="py-3 px-4 font-bold">
                    <span
                      className={
                        st === 'DEPASSE' || st === 'URGENT'
                          ? 'text-red-700'
                          : st === 'ATTENTION'
                          ? 'text-amber-700'
                          : 'text-emerald-700'
                      }
                    >
                      {st}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right space-x-2">
                    {/* Bouton WhatsApp avec Modale de préparation bi-canal */}
                    <button
                      type="button"
                      onClick={() => openWhatsAppForReminder(r)}
                      className="px-2.5 py-1 border border-emerald-300 bg-emerald-50 text-emerald-800 rounded inline-flex items-center gap-1 hover:bg-emerald-100 font-semibold"
                      title="Préparer et envoyer le message WhatsApp bi-canal"
                    >
                      <MessageCircle className="w-3.5 h-3.5 text-emerald-600" />
                      <span>WhatsApp Bi-Canal</span>
                    </button>
                    {st !== 'EFFECTUE' && (
                      <button
                        type="button"
                        onClick={() => openInterventionModal(r)}
                        className="px-2.5 py-1 bg-[#1D4ED8] text-white rounded font-medium inline-flex items-center gap-1"
                      >
                        <Wrench className="w-3 h-3" />
                        <span>Effectuer SAV</span>
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
            className="bg-white border rounded-lg max-w-md w-full p-6 space-y-3 text-xs"
          >
            <h3 className="font-bold text-sm">
              Valider l&apos;intervention SAV pour {activeModalRem.customerName}
            </h3>
            <div>
              <label className="block mb-1">Pièce consommée du stock</label>
              <select
                value={consumedProductId}
                onChange={(e) => setConsumedProductId(e.target.value)}
                className="w-full p-2 border rounded"
              >
                <option value="">Aucune</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} (Stock: {p.stock})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block mb-1">Forfait Main d&apos;œuvre (MAD)</label>
              <input
                type="number"
                step="0.01"
                value={serviceFeeDh}
                onChange={(e) => setServiceFeeDh(e.target.value)}
                className="w-full p-2 border rounded font-mono"
              />
            </div>
            <div>
              <label className="block mb-1">Mode de règlement</label>
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as any)}
                className="w-full p-2 border rounded"
              >
                <option value="CASH">Espèces (Caisse)</option>
                <option value="TRANSFER">Virement</option>
                <option value="CARD">Carte</option>
              </select>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setActiveModalRem(null)}
                className="px-3 py-1.5 border rounded"
              >
                Annuler
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-emerald-700 text-white rounded font-medium"
              >
                Valider & Renouveler
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modale d'envoi WhatsApp bi-canal */}
      <WhatsAppMessageModal
        open={whatsappModalData.open}
        onClose={() => setWhatsappModalData((prev) => ({ ...prev, open: false }))}
        recipientName={whatsappModalData.recipientName}
        recipientPhone={whatsappModalData.recipientPhone}
        defaultMessage={whatsappModalData.defaultMessage}
        title="Rappel SAV WhatsApp Client"
        subtitle="Normalisation E.164 (+212...) & Envoi bi-canal Windows / Web"
      />
    </div>
  );
};
