import * as XLSX from 'xlsx';
import { ArbitrageError, buildArbitrageDecision } from '../domain/arbitrageEngine';
import {
  computeInvoiceStatus,
  computeSavReminderStatus,
  dhToCents,
} from '../domain/financialEngine';
import {
  AtlasSoftWaterDB,
  CURRENT_SCHEMA_VERSION,
  db,
  enqueueTransactionalMutation,
  getAllTables,
  recordAuditLogInTx,
} from '../db/database';
import {
  Customer,
  CustomerEquipment,
  DiagnosticIssue,
  DiagnosticReport,
  Product,
  SavReminder,
  Supplier,
} from '../types/domain';
import { getMoroccoBusinessDate } from '../utils/dateUtils';
import {
  decryptBackupPayload,
  encryptBackupPayload,
  generateId,
  verifyPin,
} from '../utils/securityUtils';

/**
 * SECTION 42 & RÈGLE 26 : Diagnostic complet d'intégrité de la base de données
 */
export async function runDatabaseDiagnostic(
  targetDb: AtlasSoftWaterDB = db
): Promise<DiagnosticReport> {
  const issues: DiagnosticIssue[] = [];
  const now = new Date().toISOString();

  const [
    products,
    stockMovements,
    customers,
    suppliers,
    sales,
    saleItems,
    invoices,
    payments,
    purchases,
    sequences,
  ] = await Promise.all([
    targetDb.products.toArray(),
    targetDb.stockMovements.toArray(),
    targetDb.customers.toArray(),
    targetDb.suppliers.toArray(),
    targetDb.sales.toArray(),
    targetDb.saleItems.toArray(),
    targetDb.invoices.toArray(),
    targetDb.payments.toArray(),
    targetDb.purchases.toArray(),
    targetDb.sequences.toArray(),
  ]);

  const totalEntitiesChecked =
    products.length +
    stockMovements.length +
    customers.length +
    suppliers.length +
    sales.length +
    invoices.length +
    payments.length +
    purchases.length;

  const productMap = new Map(products.map((p) => [p.id, p]));
  const customerMap = new Map(customers.map((c) => [c.id, c]));
  const supplierMap = new Map(suppliers.map((s) => [s.id, s]));
  const invoiceMap = new Map(invoices.map((i) => [i.id, i]));

  // 1. Vérification des mouvements de stock (stockBefore + quantity === stockAfter)
  for (const mv of stockMovements) {
    if (mv.stockBefore + mv.quantity !== mv.stockAfter) {
      issues.push({
        id: generateId(),
        severity: 'CRITICAL',
        category: 'INCONSISTENT_STOCK',
        entityType: 'STOCK_MOVEMENT',
        entityId: mv.id,
        description: `Mouvement stock incohérent sur "${mv.productName}" : Avant (${mv.stockBefore}) + Mouvement (${mv.quantity}) ≠ Après (${mv.stockAfter}).`,
        autoRepairSafe: false,
      });
    }
    if (!productMap.has(mv.productId)) {
      issues.push({
        id: generateId(),
        severity: 'WARNING',
        category: 'MISSING_PRODUCT',
        entityType: 'STOCK_MOVEMENT',
        entityId: mv.id,
        description: `Mouvement stock lié à un produit supprimé ou introuvable (${mv.productName} #${mv.productId}).`,
        autoRepairSafe: false,
      });
    }
  }

  // 2. Vérification des lignes de vente et clients
  for (const s of sales) {
    if (!customerMap.has(s.customerId)) {
      issues.push({
        id: generateId(),
        severity: 'WARNING',
        category: 'BROKEN_REFERENCE',
        entityType: 'SALE',
        entityId: s.id,
        description: `Vente ${s.number} liée à un client introuvable (#${s.customerId}).`,
        autoRepairSafe: false,
      });
    }
  }

  for (const si of saleItems) {
    if (!productMap.has(si.productId)) {
      issues.push({
        id: generateId(),
        severity: 'WARNING',
        category: 'MISSING_PRODUCT',
        entityType: 'SALE_ITEM',
        entityId: si.id,
        description: `Ligne de vente liée à un produit introuvable (${si.productName}).`,
        autoRepairSafe: false,
      });
    }
  }

  // 3. Vérification de cohérence Factures vs Paiements (Règle 3)
  for (const inv of invoices) {
    if (inv.type !== 'INVOICE') continue;
    const expectedStatus = computeInvoiceStatus(
      inv.totalTtcCents,
      inv.paidCents,
      inv.status === 'CANCELLED'
    );
    if (inv.status !== expectedStatus) {
      issues.push({
        id: generateId(),
        severity: 'CRITICAL',
        category: 'INCONSISTENT_PAYMENT',
        entityType: 'INVOICE',
        entityId: inv.id,
        description: `Facture ${inv.number} : Statut enregistré (${inv.status}) différent du statut calculé (${expectedStatus}).`,
        autoRepairSafe: true,
      });
    }

    if (inv.status !== 'CANCELLED') {
      const validInPayments = payments.filter(
        (p) =>
          p.targetId === inv.id &&
          p.targetType === 'INVOICE' &&
          p.direction === 'IN' &&
          p.status === 'VALIDATED'
      );
      const sumPaid = validInPayments.reduce((acc, p) => acc + p.amountCents, 0);
      if (sumPaid !== inv.paidCents) {
        issues.push({
          id: generateId(),
          severity: 'CRITICAL',
          category: 'INCONSISTENT_PAYMENT',
          entityType: 'INVOICE',
          entityId: inv.id,
          description: `Facture ${inv.number} : Cumul payé (${(inv.paidCents / 100).toFixed(2)} MAD) différent de la somme des paiements actifs (${(sumPaid / 100).toFixed(2)} MAD).`,
          autoRepairSafe: true,
        });
      }
    }
  }

  // 4. Vérification des créances clients vs factures actives
  for (const cust of customers) {
    const activeCustInvoices = invoices.filter(
      (i) => i.customerId === cust.id && i.type === 'INVOICE' && i.status !== 'CANCELLED'
    );
    const expectedBalance = activeCustInvoices.reduce(
      (acc, i) => acc + i.remainingDueCents,
      0
    );
    if (cust.balanceCents !== expectedBalance) {
      issues.push({
        id: generateId(),
        severity: 'WARNING',
        category: 'INCONSISTENT_RECEIVABLE',
        entityType: 'CUSTOMER',
        entityId: cust.id,
        description: `Client "${cust.name}" : Solde créance fiche (${(cust.balanceCents / 100).toFixed(2)} MAD) ≠ Somme des restes à payer factures (${(expectedBalance / 100).toFixed(2)} MAD).`,
        autoRepairSafe: true,
      });
    }
  }

  // 5. Vérification des dettes fournisseurs vs achats actifs
  for (const sup of suppliers) {
    const activeSupPurchases = purchases.filter(
      (p) => p.supplierId === sup.id && p.status !== 'ANNULE'
    );
    const expectedDebt = activeSupPurchases.reduce(
      (acc, p) => acc + p.remainingDueCents,
      0
    );
    if (sup.debtCents !== expectedDebt) {
      issues.push({
        id: generateId(),
        severity: 'WARNING',
        category: 'INCONSISTENT_DEBT',
        entityType: 'SUPPLIER',
        entityId: sup.id,
        description: `Fournisseur "${sup.name}" : Dette fiche (${(sup.debtCents / 100).toFixed(2)} MAD) ≠ Somme des restes à payer achats (${(expectedDebt / 100).toFixed(2)} MAD).`,
        autoRepairSafe: true,
      });
    }
  }

  // 6. Vérification des séquences
  const saleSeq = sequences.find((s) => s.docType === 'sale');
  if (sales.length > 0 && (!saleSeq || saleSeq.currentValue < sales.length)) {
    issues.push({
      id: generateId(),
      severity: 'WARNING',
      category: 'INCONSISTENT_SEQUENCE',
      entityType: 'SEQUENCE',
      entityId: saleSeq?.id ?? 'sale',
      description: `Compteur de séquence des ventes (${saleSeq?.currentValue ?? 0}) inférieur au nombre de ventes (${sales.length}).`,
      autoRepairSafe: true,
    });
  }

  // Ignorer l'avertissement non utilisé sur invoiceMap
  void invoiceMap;

  return {
    timestamp: now,
    schemaVersion: CURRENT_SCHEMA_VERSION,
    healthy: issues.length === 0,
    totalEntitiesChecked,
    issues,
  };
}

/**
 * Réparation automatique sécurisée (Section 42)
 * Crée automatiquement un backup d'urgence avant toute réparation.
 */
export async function executeAutoRepairDatabase(
  targetDb: AtlasSoftWaterDB = db
): Promise<{ repairedCount: number; postReport: DiagnosticReport }> {
  // 1. Sauvegarde d'urgence automatique avant réparation
  const emergencySnapshot = await createBackupPayloadObject(targetDb);
  await targetDb.appMetadata.put({
    key: 'last_emergency_backup_before_repair',
    value: JSON.stringify(emergencySnapshot),
    updatedAt: new Date().toISOString(),
  });

  let repairedCount = 0;

  await enqueueTransactionalMutation(async () => {
    await targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const now = new Date().toISOString();
      const [invoices, payments, customers, suppliers, purchases, sales] = await Promise.all([
        targetDb.invoices.toArray(),
        targetDb.payments.toArray(),
        targetDb.customers.toArray(),
        targetDb.suppliers.toArray(),
        targetDb.purchases.toArray(),
        targetDb.sales.toArray(),
      ]);

      // Recalculer les factures depuis les paiements réels
      for (const inv of invoices) {
        if (inv.type !== 'INVOICE' || inv.status === 'CANCELLED') continue;
        const validIn = payments.filter(
          (p) =>
            p.targetId === inv.id &&
            p.targetType === 'INVOICE' &&
            p.direction === 'IN' &&
            p.status === 'VALIDATED'
        );
        const sumPaid = Math.min(
          inv.totalTtcCents,
          validIn.reduce((acc, p) => acc + p.amountCents, 0)
        );
        const rem = Math.max(0, inv.totalTtcCents - sumPaid);
        const st = computeInvoiceStatus(inv.totalTtcCents, sumPaid, false);

        if (inv.paidCents !== sumPaid || inv.remainingDueCents !== rem || inv.status !== st) {
          await targetDb.invoices.update(inv.id, {
            paidCents: sumPaid,
            remainingDueCents: rem,
            status: st,
            updatedAt: now,
          });
          inv.paidCents = sumPaid;
          inv.remainingDueCents = rem;
          inv.status = st;
          repairedCount++;
        }
      }

      // Recalculer les soldes créances clients
      for (const cust of customers) {
        const activeCustInvoices = invoices.filter(
          (i) => i.customerId === cust.id && i.type === 'INVOICE' && i.status !== 'CANCELLED'
        );
        const expectedBalance = activeCustInvoices.reduce(
          (acc, i) => acc + i.remainingDueCents,
          0
        );
        if (cust.balanceCents !== expectedBalance) {
          await targetDb.customers.update(cust.id, {
            balanceCents: expectedBalance,
            updatedAt: now,
          });
          repairedCount++;
        }
      }

      // Recalculer les dettes fournisseurs
      for (const sup of suppliers) {
        const activeSupPurchases = purchases.filter(
          (p) => p.supplierId === sup.id && p.status !== 'ANNULE'
        );
        const expectedDebt = activeSupPurchases.reduce(
          (acc, p) => acc + p.remainingDueCents,
          0
        );
        if (sup.debtCents !== expectedDebt) {
          await targetDb.suppliers.update(sup.id, {
            debtCents: expectedDebt,
            updatedAt: now,
          });
          repairedCount++;
        }
      }

      // Synchroniser la séquence des ventes si nécessaire
      const year = new Date().getFullYear();
      const saleSeqId = `sale:${year}`;
      const existingSeq = await targetDb.sequences.get(saleSeqId);
      if (sales.length > 0 && (!existingSeq || existingSeq.currentValue < sales.length)) {
        await targetDb.sequences.put({
          id: saleSeqId,
          docType: 'sale',
          prefix: 'V',
          year,
          currentValue: sales.length,
          updatedAt: now,
        });
        repairedCount++;
      }

      await recordAuditLogInTx(targetDb, {
        action: 'DATABASE_AUTO_REPAIR',
        entityType: 'SYSTEM',
        entityId: 'DIAGNOSTIC',
        summary: `Diagnostic & Réparation automatique exécutés (${repairedCount} anomalies corrigées après backup d'urgence).`,
      });
    });
  });

  const postReport = await runDatabaseDiagnostic(targetDb);
  return { repairedCount, postReport };
}

export interface BackupPayload {
  app: 'ATLAS_SOFT_WATER';
  schemaVersion: number;
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

export async function createBackupPayloadObject(
  targetDb: AtlasSoftWaterDB = db
): Promise<BackupPayload> {
  const tables: Record<string, unknown[]> = {};
  for (const table of getAllTables(targetDb)) {
    tables[table.name] = await table.toArray();
  }
  return {
    app: 'ATLAS_SOFT_WATER',
    schemaVersion: CURRENT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    tables,
  };
}

export async function exportBackupString(
  passphrase?: string,
  targetDb: AtlasSoftWaterDB = db
): Promise<string> {
  const payload = await createBackupPayloadObject(targetDb);
  const rawJson = JSON.stringify(payload, null, 2);
  if (passphrase && passphrase.trim().length > 0) {
    return encryptBackupPayload(rawJson, passphrase.trim());
  }
  return rawJson;
}

/**
 * RÈGLE 26 : Restauration vérifiée et atomique d'une sauvegarde
 * Vérifie : version du schéma, intégrité, relations, doublons d'IDs, séquences, stock, paiements.
 * Exécute automatiquement un diagnostic d'intégrité après restauration.
 */
export async function validateAndRestoreBackup(
  rawBackupText: string,
  passphrase?: string,
  targetDb: AtlasSoftWaterDB = db,
  options?: {
    masterPinInput?: string;
    skipMasterPinCheck?: boolean;
    actor?: {
      userId?: string;
      userName?: string;
      userRole?: string;
    };
  }
): Promise<{ restoredTablesCount: number; diagnosticReport: DiagnosticReport }> {
  // 1. RÈGLE DE SÉCURITÉ CRITIQUE : Exigence stricte du Code PIN Maître Administrateur
  // Empêche toute écrasement ou restauration non autorisée de la base de données
  if (!options?.skipMasterPinCheck) {
    const allProfiles = await targetDb.profiles.toArray();
    const adminProfiles = allProfiles.filter((p) => p.role === 'ADMIN' && p.active !== false);
    if (adminProfiles.length > 0) {
      const cleanPin = options?.masterPinInput?.trim();
      if (!cleanPin) {
        throw new ArbitrageError(
          buildArbitrageDecision(
            'RULE_26_VERIFIED_BACKUP_RESTORE',
            false,
            'Arbitrage Sécurité Règle 26 : Le Code PIN Maître Administrateur est obligatoirement exigé pour autoriser la restauration.'
          )
        );
      }
      let isMasterValid = false;
      for (const admin of adminProfiles) {
        if (admin.masterPinSalt && admin.masterPinHash) {
          const match = await verifyPin(cleanPin, admin.masterPinSalt, admin.masterPinHash);
          if (match) {
            isMasterValid = true;
            break;
          }
        }
      }
      if (!isMasterValid) {
        throw new ArbitrageError(
          buildArbitrageDecision(
            'RULE_26_VERIFIED_BACKUP_RESTORE',
            false,
            'Arbitrage Sécurité Règle 26 : Code PIN Maître Administrateur incorrect. Restauration de la base de données refusée.'
          )
        );
      }
    }
  }

  let decodedText = rawBackupText;
  const parsedOuter = JSON.parse(rawBackupText) as Record<string, unknown>;
  if (parsedOuter.encrypted === true) {
    if (!passphrase) {
      throw new Error('Cette sauvegarde est chiffrée (AES-GCM). Veuillez saisir le mot de passe.');
    }
    decodedText = await decryptBackupPayload(rawBackupText, passphrase);
  }

  const backup = JSON.parse(decodedText) as BackupPayload;

  if (backup.app !== 'ATLAS_SOFT_WATER' || !backup.tables || typeof backup.tables !== 'object') {
    throw new ArbitrageError(
      buildArbitrageDecision(
        'RULE_26_VERIFIED_BACKUP_RESTORE',
        false,
        'Arbitrage Règle 26 [Sauvegarde Invalide] : Format de fichier non reconnu ou structure de tables absente.'
      )
    );
  }

  if (
    typeof backup.schemaVersion !== 'number' ||
    backup.schemaVersion < 1 ||
    backup.schemaVersion > CURRENT_SCHEMA_VERSION
  ) {
    throw new ArbitrageError(
      buildArbitrageDecision(
        'RULE_26_VERIFIED_BACKUP_RESTORE',
        false,
        `Arbitrage Règle 26 [Version Schéma Incompatible] : Version ${backup.schemaVersion} non supportée (version maximale attendue : ${CURRENT_SCHEMA_VERSION}).`
      )
    );
  }

  // Vérification des doublons d'identifiants et intégrité des mouvements de stock dans le fichier
  for (const [tableName, rows] of Object.entries(backup.tables)) {
    if (!Array.isArray(rows)) {
      throw new ArbitrageError(
        buildArbitrageDecision(
          'RULE_26_VERIFIED_BACKUP_RESTORE',
          false,
          `Arbitrage Règle 26 : La table "${tableName}" dans le fichier de sauvegarde est corrompue.`
        )
      );
    }

    const seenIds = new Set<string>();
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const idVal = String(r.id ?? r.key ?? '');
      if (idVal) {
        if (seenIds.has(idVal)) {
          throw new ArbitrageError(
            buildArbitrageDecision(
              'RULE_26_VERIFIED_BACKUP_RESTORE',
              false,
              `Arbitrage Règle 26 [Doublon d'Identifiant] : L'identifiant "${idVal}" est dupliqué dans la table "${tableName}". Restauration annulée.`
            )
          );
        }
        seenIds.add(idVal);
      }

      if (tableName === 'stockMovements') {
        const before = Number(r.stockBefore);
        const qty = Number(r.quantity);
        const after = Number(r.stockAfter);
        if (before + qty !== after) {
          throw new ArbitrageError(
            buildArbitrageDecision(
              'RULE_26_VERIFIED_BACKUP_RESTORE',
              false,
              `Arbitrage Règle 26 [Mouvement Stock Incohérent] : Le mouvement #${idVal} présente un écart (${before} + ${qty} ≠ ${after}).`
            )
          );
        }
      }
    }
  }

  // Vérification des relations critiques (Ventes -> Clients)
  const backupCustomers = (backup.tables.customers ?? []) as { id: string }[];
  const customerIdSet = new Set(backupCustomers.map((c) => c.id));
  const backupSales = (backup.tables.sales ?? []) as { id: string; number: string; customerId: string }[];
  for (const s of backupSales) {
    if (s.customerId && backupCustomers.length > 0 && !customerIdSet.has(s.customerId)) {
      throw new ArbitrageError(
        buildArbitrageDecision(
          'RULE_26_VERIFIED_BACKUP_RESTORE',
          false,
          `Arbitrage Règle 26 [Relation Cassée] : La vente ${s.number} référence un client inexistant (#${s.customerId}) dans la sauvegarde.`
        )
      );
    }
  }

  // Sauvegarde d'urgence de l'état courant avant restauration
  const preRestoreSnapshot = await createBackupPayloadObject(targetDb);

  await enqueueTransactionalMutation(async () => {
    await targetDb.transaction('rw', getAllTables(targetDb), async () => {
      for (const table of getAllTables(targetDb)) {
        await table.clear();
        const incomingRows = backup.tables[table.name];
        if (Array.isArray(incomingRows) && incomingRows.length > 0) {
          await table.bulkAdd(incomingRows as never[]);
        }
      }

      await targetDb.appMetadata.put({
        key: 'pre_restore_emergency_backup',
        value: JSON.stringify(preRestoreSnapshot),
        updatedAt: new Date().toISOString(),
      });

      await recordAuditLogInTx(targetDb, {
        action: 'BACKUP_RESTORED',
        entityType: 'SYSTEM',
        entityId: 'RESTORE',
        userId: options?.actor?.userId,
        userName: options?.actor?.userName,
        userRole: options?.actor?.userRole as never,
        summary: `Sauvegarde restaurée avec succès (Version schéma ${backup.schemaVersion}) validée sous Code PIN Maître par ${options?.actor?.userName || 'Administrateur'}. Diagnostic d'intégrité post-restauration exécuté.`,
        contradictionArbitrated: 'RULE_26_VERIFIED_BACKUP_RESTORE',
      });
    });
  });

  const diagnosticReport = await runDatabaseDiagnostic(targetDb);
  return {
    restoredTablesCount: Object.keys(backup.tables).length,
    diagnosticReport,
  };
}

/**
 * SECTION 30 & RÈGLE 25 : Import Excel / CSV avec validation préalable et transaction atomique
 */
export type ImportEntityType = 'PRODUCTS' | 'CUSTOMERS' | 'SUPPLIERS' | 'EQUIPMENTS_SAV';

export interface ImportValidationRowResult {
  rowIndex: number;
  valid: boolean;
  errors: string[];
  isDuplicate: boolean;
  parsedEntity: Record<string, unknown>;
}

export interface ImportValidationReport {
  entityType: ImportEntityType;
  totalRows: number;
  validRowsCount: number;
  errorRowsCount: number;
  duplicateRowsCount: number;
  rows: ImportValidationRowResult[];
}

const COLUMN_ALIASES: Record<string, string[]> = {
  reference: ['reference', 'Reference', 'Référence', 'Code', 'Ref', 'Réf', 'Code_Article'],
  barcode: ['barcode', 'Code_Barres', 'Code-barres', 'EAN', 'CodeBarres'],
  name: [
    'name',
    'Designation',
    'Désignation',
    'Nom',
    'Nom_Client',
    'Nom_Fournisseur',
    'Raison_Sociale',
    'Article',
  ],
  category: ['category', 'Categorie', 'Catégorie', 'Famille'],
  brand: ['brand', 'Marque', 'Fabricant'],
  purchasePriceDh: [
    'purchasePriceDh',
    'Prix_Achat_HT',
    'Prix Achat HT',
    'Prix Achat HT (MAD)',
    'PA_HT',
  ],
  salePriceDh: [
    'salePriceDh',
    'Prix_Vente_HT',
    'Prix Vente HT',
    'Prix Vente HT (MAD)',
    'PV_HT',
    'Prix_HT',
  ],
  minSalePriceDh: [
    'minSalePriceDh',
    'Prix_Min_HT',
    'Prix Minimum HT',
    'Prix Minimum HT (MAD)',
  ],
  vatRate: ['vatRate', 'TVA', 'Taux_TVA', 'Taux TVA (%)', 'TVA (%)'],
  stock: ['stock', 'Stock_Initial', 'Stock', 'Quantite', 'Quantité'],
  minStock: ['minStock', 'Stock_Min', 'Seuil_Alerte', 'Stock Min'],
  unit: ['unit', 'Unite', 'Unité'],
  location: ['location', 'Emplacement', 'Rayon', 'Lieu_Installation'],
  replacementMonths: ['replacementMonths', 'Periodicite_SAV_Mois', 'Périodicité SAV (Mois)'],
  compatibleModels: ['compatibleModels', 'Modeles_Compatibles', 'Modèles Compatibles'],
  code: ['code', 'Code_Client', 'Code_Fournisseur'],
  type: ['type', 'Type_Client', 'Type'],
  phone: ['phone', 'Telephone', 'Téléphone', 'Tel', 'Tél', 'Telephone_Client'],
  whatsapp: ['whatsapp', 'WhatsApp', 'Whatsapp'],
  email: ['email', 'Email', 'E-mail', 'Courriel'],
  city: ['city', 'Ville', 'Ville_Client'],
  address: ['address', 'Adresse'],
  ice: ['ice', 'ICE'],
  ifNumber: ['ifNumber', 'IF', 'Identifiant_Fiscal'],
  rc: ['rc', 'RC', 'Registre_Commerce'],
  contactName: ['contactName', 'Contact', 'Interlocuteur'],
  paymentTerms: ['paymentTerms', 'Conditions_Paiement', 'Delai_Paiement'],
  notes: ['notes', 'Notes', 'Observations'],
  customerName: ['customerName', 'Nom_Client', 'Client'],
  equipmentType: ['equipmentType', 'Type_Equipement', 'Equipement', 'Équipement'],
  brandModel: ['brandModel', 'Marque_Modele', 'Modele', 'Modèle'],
  serialNumber: ['serialNumber', 'Numero_Serie', 'N_Serie', 'Numéro de série'],
  installDate: ['installDate', 'Date_Installation'],
  nextSavDate: ['nextSavDate', 'Prochaine_Echeance_SAV', 'Date_Prochain_SAV'],
  serviceType: ['serviceType', 'Type_Intervention_SAV', 'Prestation_SAV'],
  waterSource: ['waterSource', 'Source_Eau'],
  rawTdsPpm: ['rawTdsPpm', 'TDS_Brut_PPM', 'TDS Brut'],
  treatedTdsPpm: ['treatedTdsPpm', 'TDS_Sortie_PPM', 'TDS Sortie'],
  pressureBar: ['pressureBar', 'Pression_Bar', 'Pression'],
  hardnessTh: ['hardnessTh', 'Durete_TH', 'Dureté TH'],
};

export async function validateImportData(
  entityType: ImportEntityType,
  rawRows: Record<string, unknown>[],
  columnMapping: Record<string, string>,
  targetDb: AtlasSoftWaterDB = db
): Promise<ImportValidationReport> {
  const results: ImportValidationRowResult[] = [];
  const existingProducts = await targetDb.products.toArray();
  const existingProductRefs = new Set(existingProducts.map((p) => p.reference.toLowerCase()));
  const seenRefsInBatch = new Set<string>();

  const existingCustomers = await targetDb.customers.toArray();
  const existingCustNames = new Set(existingCustomers.map((c) => c.name.toLowerCase()));

  const existingSuppliers = await targetDb.suppliers.toArray();
  const existingSupNames = new Set(existingSuppliers.map((s) => s.name.toLowerCase()));

  const existingEquipments = await targetDb.customerEquipments.toArray();
  const existingSerials = new Set(
    existingEquipments.map((eq) => eq.serialNumber.toLowerCase()).filter(Boolean)
  );

  rawRows.forEach((raw, idx) => {
    const errors: string[] = [];
    let isDuplicate = false;
    const getVal = (fieldKey: string): string => {
      if (columnMapping[fieldKey] && raw[columnMapping[fieldKey]] !== undefined) {
        const mapped = raw[columnMapping[fieldKey]];
        return mapped !== null && mapped !== undefined ? String(mapped).trim() : '';
      }
      const candidates = COLUMN_ALIASES[fieldKey] || [fieldKey];
      for (const candidate of candidates) {
        if (raw[candidate] !== undefined && raw[candidate] !== null) {
          return String(raw[candidate]).trim();
        }
        const foundKey = Object.keys(raw).find(
          (k) => k.trim().toLowerCase() === candidate.toLowerCase()
        );
        if (foundKey && raw[foundKey] !== undefined && raw[foundKey] !== null) {
          return String(raw[foundKey]).trim();
        }
      }
      return '';
    };

    if (entityType === 'PRODUCTS') {
      const reference = getVal('reference');
      const name = getVal('name');
      const salePriceStr = getVal('salePriceDh');
      const purchasePriceStr = getVal('purchasePriceDh');
      const minSalePriceStr = getVal('minSalePriceDh');
      const vatStr = getVal('vatRate') || '20';
      const stockStr = getVal('stock') || '0';

      if (!reference) errors.push('Référence produit manquante');
      if (!name) errors.push('Désignation produit manquante');

      const salePriceCents = dhToCents(salePriceStr);
      const purchasePriceCents = dhToCents(purchasePriceStr || '0');
      const minSalePriceCents = minSalePriceStr ? dhToCents(minSalePriceStr) : salePriceCents;
      const vatRate = parseFloat(vatStr);
      const stock = parseFloat(stockStr);

      if (
        !salePriceStr ||
        salePriceCents < 0 ||
        Number.isNaN(Number(salePriceStr.replace(',', '.')))
      ) {
        errors.push('Prix de vente HT invalide');
      }
      if (Number.isNaN(vatRate) || vatRate < 0 || vatRate > 100) {
        errors.push('Taux de TVA invalide');
      }
      if (Number.isNaN(stock)) {
        errors.push('Quantité en stock invalide');
      }

      if (reference) {
        const refLower = reference.toLowerCase();
        if (existingProductRefs.has(refLower) || seenRefsInBatch.has(refLower)) {
          isDuplicate = true;
          errors.push(`Doublon de référence "${reference}"`);
        }
        seenRefsInBatch.add(refLower);
      }

      results.push({
        rowIndex: idx + 1,
        valid: errors.length === 0,
        errors,
        isDuplicate,
        parsedEntity: {
          reference,
          barcode: getVal('barcode') || reference,
          name,
          categoryName: getVal('category') || 'Filtration & Osmose',
          brandName: getVal('brand') || 'Atlas Water',
          purchasePriceCents,
          salePriceHtCents: salePriceCents,
          minSalePriceHtCents: minSalePriceCents,
          vatRate: Number.isNaN(vatRate) ? 20 : vatRate,
          stock: Number.isNaN(stock) ? 0 : stock,
          minStock: parseInt(getVal('minStock') || '5', 10) || 5,
          unit: getVal('unit') || 'Unité',
          location: getVal('location') || 'Rayon A1',
          replacementMonths: parseInt(getVal('replacementMonths') || '6', 10) || 6,
          compatibleModels: getVal('compatibleModels') || 'Standard 10"',
        },
      });
    } else if (entityType === 'CUSTOMERS') {
      const name = getVal('name');
      const phone = getVal('phone');
      const city = getVal('city') || 'Casablanca';
      const rawType = (getVal('type') || 'PARTICULIER').toUpperCase();
      const allowedTypes = [
        'PARTICULIER',
        'ENTREPRISE',
        'INDUSTRIE',
        'ADMINISTRATION',
        'REVENDEUR',
        'INSTALLATEUR',
      ];
      const custType = allowedTypes.includes(rawType) ? rawType : 'PARTICULIER';

      if (!name) errors.push('Nom du client manquant');
      if (name && existingCustNames.has(name.toLowerCase())) {
        isDuplicate = true;
        errors.push(`Client "${name}" déjà existant`);
      }

      results.push({
        rowIndex: idx + 1,
        valid: errors.length === 0,
        errors,
        isDuplicate,
        parsedEntity: {
          code: getVal('code'),
          name,
          phone,
          whatsapp: getVal('whatsapp') || phone,
          email: getVal('email'),
          city,
          address: getVal('address'),
          ice: getVal('ice'),
          notes: getVal('notes') || 'Importé via Excel',
          type: custType,
        },
      });
    } else if (entityType === 'SUPPLIERS') {
      const name = getVal('name');
      if (!name) errors.push('Nom du fournisseur manquant');
      if (name && existingSupNames.has(name.toLowerCase())) {
        isDuplicate = true;
        errors.push(`Fournisseur "${name}" déjà existant`);
      }
      results.push({
        rowIndex: idx + 1,
        valid: errors.length === 0,
        errors,
        isDuplicate,
        parsedEntity: {
          code: getVal('code'),
          name,
          contactName: getVal('contactName'),
          phone: getVal('phone'),
          whatsapp: getVal('whatsapp') || getVal('phone'),
          email: getVal('email'),
          city: getVal('city') || 'Casablanca',
          address: getVal('address'),
          ice: getVal('ice'),
          ifNumber: getVal('ifNumber'),
          rc: getVal('rc'),
          paymentTerms: getVal('paymentTerms') || '30 jours',
          notes: getVal('notes') || 'Importé via Excel',
        },
      });
    } else if (entityType === 'EQUIPMENTS_SAV') {
      const customerName = getVal('customerName');
      const equipmentType = getVal('equipmentType');
      const brandModel = getVal('brandModel');
      const serialNumber = getVal('serialNumber');
      const nextSavDate = getVal('nextSavDate');

      if (!customerName) errors.push('Nom du client manquant');
      if (!equipmentType) errors.push("Type d'équipement manquant");
      if (!brandModel) errors.push('Marque / Modèle manquant');
      if (!serialNumber) errors.push('Numéro de série manquant');
      if (!nextSavDate || !/^\d{4}-\d{2}-\d{2}$/.test(nextSavDate)) {
        errors.push('Date prochain SAV invalide (format attendu : YYYY-MM-DD)');
      }

      if (serialNumber && existingSerials.has(serialNumber.toLowerCase())) {
        isDuplicate = true;
        errors.push(`Équipement N° série "${serialNumber}" déjà existant`);
      }

      results.push({
        rowIndex: idx + 1,
        valid: errors.length === 0,
        errors,
        isDuplicate,
        parsedEntity: {
          name: `${equipmentType} - ${customerName}`,
          customerName,
          customerPhone: getVal('phone'),
          customerCity: getVal('city') || 'Casablanca',
          equipmentType,
          brandModel,
          serialNumber,
          installDate: getVal('installDate') || getMoroccoBusinessDate(),
          nextSavDate,
          serviceType: getVal('serviceType') || 'Entretien périodique & remplacement filtres',
          waterSource: getVal('waterSource') || 'RESEAU',
          rawTdsPpm: Number(getVal('rawTdsPpm')) || 450,
          treatedTdsPpm: Number(getVal('treatedTdsPpm')) || 30,
          pressureBar: Number(getVal('pressureBar')) || 3.5,
          hardnessTh: Number(getVal('hardnessTh')) || 25,
          location: getVal('location') || 'Sous évier',
        },
      });
    }
  });

  return {
    entityType,
    totalRows: results.length,
    validRowsCount: results.filter((r) => r.valid).length,
    errorRowsCount: results.filter((r) => !r.valid).length,
    duplicateRowsCount: results.filter((r) => r.isDuplicate).length,
    rows: results,
  };
}

/**
 * RÈGLE 25 : Transaction d'importation
 * En mode strict (allowSkipErrors = false), toute erreur critique bloque l'ensemble de l'import
 * afin qu'aucune donnée partielle ne soit enregistrée.
 */
export async function executeCommitValidatedImport(
  report: ImportValidationReport,
  options: { allowSkipErrors?: boolean } = { allowSkipErrors: false },
  targetDb: AtlasSoftWaterDB = db
): Promise<{ importedCount: number }> {
  if (report.errorRowsCount > 0 && !options.allowSkipErrors) {
    throw new ArbitrageError(
      buildArbitrageDecision(
        'RULE_25_VALIDATED_IMPORT_PIPELINE',
        false,
        `Arbitrage Règle 25 [Import Bloqué] : Le fichier contient ${report.errorRowsCount} ligne(s) en erreur sur ${report.totalRows}. Aucune donnée partielle n'a été enregistrée.`
      )
    );
  }

  const validRows = report.rows.filter((r) => r.valid);
  if (validRows.length === 0) {
    throw new Error('Aucune ligne valide à importer.');
  }

  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      if (report.entityType === 'PRODUCTS') {
        const existingCats = await targetDb.categories.toArray();
        const catByNameLower = new Map(
          existingCats.map((c) => [c.name.trim().toLowerCase(), c])
        );

        for (const r of validRows) {
          const p = r.parsedEntity;
          const prodId = generateId();
          const initialStock = Number(p.stock) || 0;
          const catNameClean = String(p.categoryName || 'Filtration').trim() || 'Filtration';
          let matchedCat = catByNameLower.get(catNameClean.toLowerCase());
          if (!matchedCat) {
            const newCatId = `cat-${generateId().slice(0, 8)}`;
            const createdCat = {
              id: newCatId,
              name: catNameClean,
              parentCategory: '',
              description: `Catégorie ${catNameClean}`,
              active: true,
              createdAt: now,
            };
            await targetDb.categories.add(createdCat);
            catByNameLower.set(catNameClean.toLowerCase(), createdCat);
            matchedCat = createdCat;
          }

          const newProd: Product = {
            id: prodId,
            reference: String(p.reference),
            barcode: String(p.barcode || p.reference),
            name: String(p.name),
            categoryId: matchedCat.id,
            categoryName: matchedCat.name,
            subCategory: '',
            brandId: 'brand-default',
            brandName: String(p.brandName || 'Atlas'),
            description: '',
            photoUrl: '',
            purchasePriceCents: Number(p.purchasePriceCents) || 0,
            salePriceHtCents: Number(p.salePriceHtCents) || 0,
            minSalePriceHtCents: Number(p.minSalePriceHtCents) || 0,
            vatRate: Number(p.vatRate) || 20,
            stock: initialStock,
            minStock: Number(p.minStock) || 5,
            maxStock: 100,
            unit: String(p.unit || 'Unité'),
            supplierId: '',
            supplierName: '',
            location: String(p.location || 'Rayon A1'),
            replacementMonths: Number(p.replacementMonths) || 6,
            compatibleModels: String(p.compatibleModels || 'Standard 10"'),
            notes: 'Importé via assistant Excel/CSV',
            active: true,
            isDemo: false,
            createdAt: now,
            updatedAt: now,
          };
          await targetDb.products.add(newProd);

          if (initialStock !== 0) {
            await targetDb.stockMovements.add({
              id: generateId(),
              date: now,
              businessDate,
              productId: prodId,
              productRef: newProd.reference,
              productName: newProd.name,
              quantity: initialStock,
              stockBefore: 0,
              stockAfter: initialStock,
              type: 'MANUAL_ADJUST',
              sourceDocType: 'MANUAL',
              sourceDocId: prodId,
              sourceDocNumber: 'IMPORT-EXCEL',
              reason: 'Stock initial import Excel/CSV validé',
              userId: 'admin',
              userName: 'Administrateur',
              status: 'ACTIVE',
              createdAt: now,
            });
          }
        }
      } else if (report.entityType === 'CUSTOMERS') {
        for (const r of validRows) {
          const c = r.parsedEntity;
          const cust: Customer = {
            id: generateId(),
            code: String(c.code || `CLI-IMP-${Math.floor(1000 + Math.random() * 9000)}`),
            name: String(c.name),
            type: (c.type as Customer['type']) || 'PARTICULIER',
            phone: String(c.phone || ''),
            whatsapp: String(c.whatsapp || ''),
            email: String(c.email || ''),
            address: String(c.address || ''),
            city: String(c.city || 'Casablanca'),
            ice: String(c.ice || ''),
            notes: String(c.notes || 'Importé via Excel'),
            balanceCents: 0,
            creditAvailableCents: 0,
            active: true,
            isDemo: false,
            createdAt: now,
            updatedAt: now,
          };
          await targetDb.customers.add(cust);
        }
      } else if (report.entityType === 'SUPPLIERS') {
        for (const r of validRows) {
          const s = r.parsedEntity;
          const sup: Supplier = {
            id: generateId(),
            code: String(s.code || `FOUR-IMP-${Math.floor(1000 + Math.random() * 9000)}`),
            name: String(s.name),
            contactName: String(s.contactName || ''),
            phone: String(s.phone || ''),
            whatsapp: String(s.whatsapp || ''),
            email: String(s.email || ''),
            city: String(s.city || 'Casablanca'),
            address: String(s.address || ''),
            ice: String(s.ice || ''),
            ifNumber: String(s.ifNumber || ''),
            rc: String(s.rc || ''),
            paymentTerms: String(s.paymentTerms || '30 jours'),
            totalPurchasesCents: 0,
            debtCents: 0,
            notes: String(s.notes || 'Importé via Excel'),
            active: true,
            isDemo: false,
            createdAt: now,
            updatedAt: now,
          };
          await targetDb.suppliers.add(sup);
        }
      } else if (report.entityType === 'EQUIPMENTS_SAV') {
        const allCustomers = await targetDb.customers.toArray();
        for (const r of validRows) {
          const eqData = r.parsedEntity;
          const custName = String(eqData.customerName);
          let matchedCustomer = allCustomers.find(
            (c) => c.name.toLowerCase() === custName.toLowerCase()
          );
          if (!matchedCustomer) {
            matchedCustomer = {
              id: generateId(),
              code: `CLI-SAV-${Math.floor(1000 + Math.random() * 9000)}`,
              name: custName,
              type: 'PARTICULIER',
              phone: String(eqData.customerPhone || ''),
              whatsapp: String(eqData.customerPhone || ''),
              email: '',
              address: '',
              city: String(eqData.customerCity || 'Casablanca'),
              ice: '',
              notes: 'Créé automatiquement lors de l’import Équipement SAV',
              balanceCents: 0,
              creditAvailableCents: 0,
              active: true,
              isDemo: false,
              createdAt: now,
              updatedAt: now,
            };
            await targetDb.customers.add(matchedCustomer);
            allCustomers.push(matchedCustomer);
          }

          const eqId = generateId();
          const dueDate = String(eqData.nextSavDate);
          const eqRecord: CustomerEquipment = {
            id: eqId,
            customerId: matchedCustomer.id,
            customerName: matchedCustomer.name,
            type: String(eqData.equipmentType),
            brand: String(eqData.brandModel),
            model: String(eqData.brandModel),
            serialNumber: String(eqData.serialNumber),
            installDate: String(eqData.installDate || businessDate),
            capacity: String(eqData.location || 'Sous évier'),
            membraneType: String(eqData.waterSource || 'RESEAU'),
            notes: 'Importé via Modèle Excel SAV',
            active: true,
            createdAt: now,
            updatedAt: now,
          };
          await targetDb.customerEquipments.add(eqRecord);

          const remRecord: SavReminder = {
            id: generateId(),
            customerId: matchedCustomer.id,
            customerName: matchedCustomer.name,
            customerPhone: matchedCustomer.phone,
            customerWhatsapp: matchedCustomer.whatsapp || matchedCustomer.phone,
            equipmentId: eqId,
            equipmentName: `${eqRecord.type} (${eqRecord.brand})`,
            productId: '',
            productName: String(eqData.serviceType || 'Entretien & Remplacement Filtres'),
            installDate: eqRecord.installDate,
            intervalMonths: 6,
            dueDate,
            status: computeSavReminderStatus(dueDate, null, businessDate),
            completedAt: null,
            technicianNotes: `N° Série : ${eqRecord.serialNumber}`,
            consumedProductId: null,
            consumedQty: 0,
            serviceFeeCents: 0,
            paymentId: null,
            isDemo: false,
            createdAt: now,
            updatedAt: now,
          };
          await targetDb.reminders.add(remRecord);
        }
      }

      await recordAuditLogInTx(targetDb, {
        action: 'EXCEL_IMPORT_COMMITTED',
        entityType: report.entityType,
        entityId: 'BATCH_IMPORT',
        summary: `Import Excel/CSV validé : ${validRows.length} enregistrements (${report.entityType}) importés.`,
        contradictionArbitrated: 'RULE_25_VALIDATED_IMPORT_PIPELINE',
        businessDate,
      });

      return { importedCount: validRows.length };
    });
  });
}

function sanitizeRowForExcel(row: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(row)) {
    if (val === null || val === undefined) {
      clean[key] = '';
    } else if (typeof val === 'string') {
      // Excel a une limite stricte de 32 767 caractères par cellule
      if (val.length > 32000) {
        if (val.startsWith('data:image')) {
          clean[key] = `[Image Base64 (${Math.round(val.length / 1024)} Ko)]`;
        } else {
          clean[key] = val.slice(0, 32000) + '... [tronqué pour Excel]';
        }
      } else {
        clean[key] = val;
      }
    } else if (typeof val === 'number' || typeof val === 'boolean') {
      clean[key] = val;
    } else if (Array.isArray(val) || typeof val === 'object') {
      const serialized = JSON.stringify(val);
      clean[key] = serialized.length > 32000 ? serialized.slice(0, 32000) + '... [tronqué]' : serialized;
    } else {
      clean[key] = String(val);
    }
  }
  return clean;
}

export function downloadWorkbookFile(wb: XLSX.WorkBook, filename: string): void {
  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    const blob = new Blob([wbout], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

export async function exportDatabaseToExcelFile(targetDb: AtlasSoftWaterDB = db): Promise<void> {
  const payload = await createBackupPayloadObject(targetDb);
  const wb = XLSX.utils.book_new();

  const sheetMap: [string, string][] = [
    ['Entreprise', 'company'],
    ['Parametres', 'settings'],
    ['Produits', 'products'],
    ['Categories', 'categories'],
    ['MouvementsStock', 'stockMovements'],
    ['Fournisseurs', 'suppliers'],
    ['Achats', 'purchases'],
    ['Clients', 'customers'],
    ['Equipements', 'customerEquipments'],
    ['Ventes', 'sales'],
    ['Devis', 'quotes'],
    ['Factures', 'invoices'],
    ['Paiements', 'payments'],
    ['RappelsSAV', 'reminders'],
    ['Inventaires', 'inventories'],
    ['Caisse', 'cashEntries'],
    ['Depenses', 'expenses'],
    ['Audit', 'auditLogs'],
    ['VeilleMarche', 'marketResearch'],
  ];

  for (const [sheetName, tableName] of sheetMap) {
    const rawRows = (payload.tables[tableName] ?? []) as Record<string, unknown>[];
    const sanitizedRows = rawRows.map((r) => sanitizeRowForExcel(r));
    const ws =
      sanitizedRows.length > 0
        ? XLSX.utils.json_to_sheet(sanitizedRows)
        : XLSX.utils.aoa_to_sheet([['Aucune donnée enregistrée']]);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }

  const dateStr = getMoroccoBusinessDate();
  downloadWorkbookFile(wb, `ATLAS_SOFT_WATER_Export_${dateStr}.xlsx`);
}

/**
 * MODÈLES EXCEL OFFICIELS (.XLSX) À TÉLÉCHARGER ET IMPORTER
 */
export const EXCEL_TEMPLATE_DATA = {
  PRODUCTS: [
    {
      Reference: 'OSM-RO-75G-PRO',
      Code_Barres: '6111000910011',
      Designation: 'Osmoseur Domestique 6 Étapes 75 GPD Avec Pompe Booster & Manomètre',
      Categorie: 'Osmoseurs Domestiques',
      Marque: 'Atlas Water',
      Prix_Achat_HT: 950,
      Prix_Vente_HT: 1650,
      Prix_Min_HT: 1450,
      TVA: 20,
      Stock_Initial: 15,
      Stock_Min: 4,
      Unite: 'Unité',
      Emplacement: 'Rayon A1',
      Periodicite_SAV_Mois: 6,
      Modeles_Compatibles: 'Standard 10 pouces / Membrane 75 GPD',
    },
    {
      Reference: 'KIT-FILT-10P-3S',
      Code_Barres: '6111000910028',
      Designation: 'Kit 3 Cartouches Préfiltration 10" (PP 5µm + GAC + CTO)',
      Categorie: 'Cartouches & Filtres',
      Marque: 'HydraPure',
      Prix_Achat_HT: 35,
      Prix_Vente_HT: 90,
      Prix_Min_HT: 75,
      TVA: 20,
      Stock_Initial: 80,
      Stock_Min: 20,
      Unite: 'Kit',
      Emplacement: 'Rayon B2',
      Periodicite_SAV_Mois: 6,
      Modeles_Compatibles: 'Tous osmoseurs 10 pouces standard',
    },
    {
      Reference: 'MEM-VONTRON-75G',
      Code_Barres: '6111000910035',
      Designation: 'Membrane Osmose Inverse 75 GPD Haute Réjection 97%',
      Categorie: 'Membranes RO',
      Marque: 'Vontron',
      Prix_Achat_HT: 85,
      Prix_Vente_HT: 210,
      Prix_Min_HT: 180,
      TVA: 20,
      Stock_Initial: 30,
      Stock_Min: 10,
      Unite: 'Unité',
      Emplacement: 'Rayon B3',
      Periodicite_SAV_Mois: 24,
      Modeles_Compatibles: 'Porte-membrane 1812 / 2012',
    },
    {
      Reference: 'ADOUC-CAB-25L-FLECK',
      Code_Barres: '6111000910042',
      Designation: 'Adoucisseur Monobloc 25 Litres Vanne Volumétrique Fleck 5600 SXT',
      Categorie: 'Adoucisseurs',
      Marque: 'Pentair Fleck',
      Prix_Achat_HT: 3800,
      Prix_Vente_HT: 5900,
      Prix_Min_HT: 5200,
      TVA: 20,
      Stock_Initial: 5,
      Stock_Min: 2,
      Unite: 'Unité',
      Emplacement: 'Zone C1',
      Periodicite_SAV_Mois: 12,
      Modeles_Compatibles: 'Résine Cationique 25L / Sel Pastilles',
    },
  ],
  CUSTOMERS: [
    {
      Code_Client: 'CLI-CASA-201',
      Nom_Client: 'Clinique Dentaire Anfa Sourire',
      Type_Client: 'ENTREPRISE',
      Telephone: '0522364455',
      WhatsApp: '0661364455',
      Email: 'contact@anfasourire.ma',
      Ville: 'Casablanca',
      Adresse: '142 Boulevard d’Anfa, Casablanca',
      ICE: '002684910000054',
      Notes: 'Contrat maintenance semestriel stérilisation',
    },
    {
      Code_Client: 'CLI-RABAT-202',
      Nom_Client: 'M. Karim El Mansouri',
      Type_Client: 'PARTICULIER',
      Telephone: '0662889900',
      WhatsApp: '0662889900',
      Email: 'k.elmansouri@gmail.com',
      Ville: 'Rabat',
      Adresse: 'Quartier Hay Riad, Villa 18, Rabat',
      ICE: '',
      Notes: 'Villa équipée adoucisseur 25L + osmoseur cuisine',
    },
    {
      Code_Client: 'CLI-KECH-203',
      Nom_Client: 'Riad Palais des Oliviers SARL',
      Type_Client: 'ENTREPRISE',
      Telephone: '0524441122',
      WhatsApp: '0661441122',
      Email: 'direction@riadoliviers.ma',
      Ville: 'Marrakech',
      Adresse: 'Médina Bab Doukkala, Marrakech',
      ICE: '001938475000091',
      Notes: 'Station UV + Filtration centrale',
    },
  ],
  SUPPLIERS: [
    {
      Code_Fournisseur: 'FOUR-CASA-01',
      Nom_Fournisseur: 'Maghreb Water Technologies SARL',
      Contact: 'M. Youssef Berrada',
      Telephone: '0522351020',
      WhatsApp: '0661351020',
      Email: 'commandes@maghrebwater.ma',
      Ville: 'Casablanca',
      Adresse: 'Zone Industrielle Ain Sebaa, Rue 12',
      ICE: '001528394000073',
      IF: '40291822',
      RC: '310455',
      Conditions_Paiement: '60 jours fin de mois',
      Notes: 'Importateur officiel membranes & pompes booster',
    },
    {
      Code_Fournisseur: 'FOUR-TANG-02',
      Nom_Fournisseur: 'Nord Filtration & Résines Industrielles',
      Contact: 'Mme Salma Tazi',
      Telephone: '0539324455',
      WhatsApp: '0663324455',
      Email: 'sales@nordfiltration.ma',
      Ville: 'Tanger',
      Adresse: 'Zone Franche Gzenaya, Lot 44',
      ICE: '002193847000038',
      IF: '50192834',
      RC: '98231',
      Conditions_Paiement: '30 jours',
      Notes: 'Fournisseur adoucisseurs, vannes Fleck/Clack et résines',
    },
  ],
  EQUIPMENTS_SAV: [
    {
      Nom_Client: 'Clinique Dentaire Anfa Sourire',
      Telephone_Client: '0661364455',
      Ville_Client: 'Casablanca',
      Type_Equipement: 'Osmoseur 75 GPD Pompe Booster',
      Marque_Modele: 'Atlas Water RO-600 Pro',
      Numero_Serie: 'SN-RO-2026-9012',
      Date_Installation: '2026-04-15',
      Prochaine_Echeance_SAV: '2026-10-15',
      Type_Intervention_SAV: 'Remplacement Kit 3 Filtres 10" + Contrôle TDS',
      Source_Eau: 'RESEAU',
      TDS_Brut_PPM: 540,
      TDS_Sortie_PPM: 24,
      Pression_Bar: 3.8,
      Durete_TH: 28,
      Lieu_Installation: 'Salle de stérilisation bloc B',
    },
    {
      Nom_Client: 'M. Karim El Mansouri',
      Telephone_Client: '0662889900',
      Ville_Client: 'Rabat',
      Type_Equipement: 'Adoucisseur Cabine 25L + Osmoseur',
      Marque_Modele: 'Pentair Fleck 5600 SXT',
      Numero_Serie: 'SN-FLK-2026-4410',
      Date_Installation: '2026-01-10',
      Prochaine_Echeance_SAV: '2027-01-10',
      Type_Intervention_SAV: 'Entretien annuel résine, saumure & cartouche sédiment 20"',
      Source_Eau: 'RESEAU',
      TDS_Brut_PPM: 410,
      TDS_Sortie_PPM: 22,
      Pression_Bar: 4.0,
      Durete_TH: 34,
      Lieu_Installation: 'Garage technique + Sous évier cuisine',
    },
  ],
};

export function downloadExcelImportTemplate(
  templateType: ImportEntityType | 'ALL_IN_ONE'
): void {
  const wb = XLSX.utils.book_new();

  const appendTemplateWithGuide = (
    sheetName: string,
    rows: Record<string, unknown>[],
    guideRows: Record<string, string>[]
  ) => {
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0] || {}).map((key) => ({
      wch: Math.max(key.length + 6, 22),
    }));
    XLSX.utils.book_append_sheet(wb, ws, sheetName);

    const guideWs = XLSX.utils.json_to_sheet(guideRows);
    guideWs['!cols'] = [{ wch: 26 }, { wch: 16 }, { wch: 52 }, { wch: 28 }];
    XLSX.utils.book_append_sheet(wb, guideWs, `Guide_${sheetName}`);
  };

  if (templateType === 'PRODUCTS' || templateType === 'ALL_IN_ONE') {
    appendTemplateWithGuide('Produits', EXCEL_TEMPLATE_DATA.PRODUCTS, [
      {
        Colonne: 'Reference',
        Obligatoire: 'OUI *',
        Description: 'Code unique de l’article (aucun doublon autorisé)',
        Exemple: 'OSM-RO-75G-PRO',
      },
      {
        Colonne: 'Code_Barres',
        Obligatoire: 'Non',
        Description: 'Code-barres EAN13 ou code interne pour lecteur POS',
        Exemple: '6111000910011',
      },
      {
        Colonne: 'Designation',
        Obligatoire: 'OUI *',
        Description: 'Nom complet du produit ou pièce détachée',
        Exemple: 'Osmoseur Domestique 6 Étapes 75 GPD',
      },
      {
        Colonne: 'Categorie',
        Obligatoire: 'Non',
        Description: 'Famille d’article (Osmoseurs, Filtres, Membranes, Adoucisseurs, UV...)',
        Exemple: 'Osmoseurs Domestiques',
      },
      {
        Colonne: 'Marque',
        Obligatoire: 'Non',
        Description: 'Marque commerciale du produit',
        Exemple: 'Atlas Water',
      },
      {
        Colonne: 'Prix_Achat_HT',
        Obligatoire: 'Non',
        Description: 'Prix d’achat HT en Dirhams (MAD)',
        Exemple: '950',
      },
      {
        Colonne: 'Prix_Vente_HT',
        Obligatoire: 'OUI *',
        Description: 'Prix de vente HT en Dirhams (MAD) >= 0',
        Exemple: '1650',
      },
      {
        Colonne: 'Prix_Min_HT',
        Obligatoire: 'Non',
        Description: 'Prix minimum autorisé hors taxe en MAD',
        Exemple: '1450',
      },
      {
        Colonne: 'TVA',
        Obligatoire: 'Non',
        Description: 'Taux de TVA en % (0, 7, 10, 14, 20)',
        Exemple: '20',
      },
      {
        Colonne: 'Stock_Initial',
        Obligatoire: 'Non',
        Description: 'Quantité initiale en stock (génère un mouvement tracé)',
        Exemple: '15',
      },
      {
        Colonne: 'Stock_Min',
        Obligatoire: 'Non',
        Description: 'Seuil d’alerte de réapprovisionnement',
        Exemple: '5',
      },
      {
        Colonne: 'Unite',
        Obligatoire: 'Non',
        Description: 'Unité de mesure (Unité, Kit, Sac 25L, Mètre)',
        Exemple: 'Unité',
      },
      {
        Colonne: 'Emplacement',
        Obligatoire: 'Non',
        Description: 'Emplacement dépôt / rayon',
        Exemple: 'Rayon A1',
      },
      {
        Colonne: 'Periodicite_SAV_Mois',
        Obligatoire: 'Non',
        Description: 'Fréquence de remplacement recommandée en mois',
        Exemple: '6',
      },
    ]);
  }

  if (templateType === 'CUSTOMERS' || templateType === 'ALL_IN_ONE') {
    appendTemplateWithGuide('Clients', EXCEL_TEMPLATE_DATA.CUSTOMERS, [
      {
        Colonne: 'Code_Client',
        Obligatoire: 'Non',
        Description: 'Code client (généré automatiquement si vide)',
        Exemple: 'CLI-CASA-201',
      },
      {
        Colonne: 'Nom_Client',
        Obligatoire: 'OUI *',
        Description: 'Nom complet du particulier ou raison sociale société',
        Exemple: 'Clinique Dentaire Anfa Sourire',
      },
      {
        Colonne: 'Type_Client',
        Obligatoire: 'Non',
        Description: 'PARTICULIER, ENTREPRISE, INDUSTRIE, ADMINISTRATION, REVENDEUR, INSTALLATEUR',
        Exemple: 'ENTREPRISE',
      },
      {
        Colonne: 'Telephone',
        Obligatoire: 'Non',
        Description: 'Numéro de téléphone principal',
        Exemple: '0522364455',
      },
      {
        Colonne: 'WhatsApp',
        Obligatoire: 'Non',
        Description: 'Numéro WhatsApp pour relances SAV et factures',
        Exemple: '0661364455',
      },
      {
        Colonne: 'Ville',
        Obligatoire: 'Non',
        Description: 'Ville du client (Casablanca par défaut)',
        Exemple: 'Casablanca',
      },
      {
        Colonne: 'ICE',
        Obligatoire: 'Non',
        Description: 'Identifiant Commun de l’Entreprise (15 chiffres)',
        Exemple: '002684910000054',
      },
    ]);
  }

  if (templateType === 'SUPPLIERS' || templateType === 'ALL_IN_ONE') {
    appendTemplateWithGuide('Fournisseurs', EXCEL_TEMPLATE_DATA.SUPPLIERS, [
      {
        Colonne: 'Code_Fournisseur',
        Obligatoire: 'Non',
        Description: 'Code fournisseur (auto-généré si vide)',
        Exemple: 'FOUR-CASA-01',
      },
      {
        Colonne: 'Nom_Fournisseur',
        Obligatoire: 'OUI *',
        Description: 'Raison sociale du fournisseur',
        Exemple: 'Maghreb Water Technologies SARL',
      },
      {
        Colonne: 'Contact',
        Obligatoire: 'Non',
        Description: 'Nom du responsable commercial',
        Exemple: 'M. Youssef Berrada',
      },
      {
        Colonne: 'Telephone',
        Obligatoire: 'Non',
        Description: 'Téléphone standard ou mobile',
        Exemple: '0522351020',
      },
      {
        Colonne: 'Ville',
        Obligatoire: 'Non',
        Description: 'Ville du fournisseur',
        Exemple: 'Casablanca',
      },
      {
        Colonne: 'ICE',
        Obligatoire: 'Non',
        Description: 'Numéro ICE du fournisseur',
        Exemple: '001528394000073',
      },
      {
        Colonne: 'Conditions_Paiement',
        Obligatoire: 'Non',
        Description: 'Modalités de règlement habituelles',
        Exemple: '60 jours fin de mois',
      },
    ]);
  }

  if (templateType === 'EQUIPMENTS_SAV' || templateType === 'ALL_IN_ONE') {
    appendTemplateWithGuide('Equipements_SAV', EXCEL_TEMPLATE_DATA.EQUIPMENTS_SAV, [
      {
        Colonne: 'Nom_Client',
        Obligatoire: 'OUI *',
        Description: 'Nom du client (associé automatiquement ou créé s’il n’existe pas)',
        Exemple: 'Clinique Dentaire Anfa Sourire',
      },
      {
        Colonne: 'Type_Equipement',
        Obligatoire: 'OUI *',
        Description: 'Catégorie d’appareil installé (Osmoseur, Adoucisseur, UV...)',
        Exemple: 'Osmoseur 75 GPD Pompe Booster',
      },
      {
        Colonne: 'Marque_Modele',
        Obligatoire: 'OUI *',
        Description: 'Marque et modèle exact de l’équipement',
        Exemple: 'Atlas Water RO-600 Pro',
      },
      {
        Colonne: 'Numero_Serie',
        Obligatoire: 'OUI *',
        Description: 'Numéro de série unique pour la traçabilité garantie & SAV',
        Exemple: 'SN-RO-2026-9012',
      },
      {
        Colonne: 'Date_Installation',
        Obligatoire: 'Non',
        Description: 'Date de mise en service au format AAAA-MM-JJ',
        Exemple: '2026-04-15',
      },
      {
        Colonne: 'Prochaine_Echeance_SAV',
        Obligatoire: 'OUI *',
        Description: 'Date du prochain entretien obligatoire au format AAAA-MM-JJ',
        Exemple: '2026-10-15',
      },
      {
        Colonne: 'Type_Intervention_SAV',
        Obligatoire: 'Non',
        Description: 'Nature de l’entretien à effectuer',
        Exemple: 'Remplacement Kit 3 Filtres 10" + Contrôle TDS',
      },
    ]);
  }

  const fileNames: Record<ImportEntityType | 'ALL_IN_ONE', string> = {
    PRODUCTS: 'Modele_Import_Produits_AtlasSoftWater.xlsx',
    CUSTOMERS: 'Modele_Import_Clients_AtlasSoftWater.xlsx',
    SUPPLIERS: 'Modele_Import_Fournisseurs_AtlasSoftWater.xlsx',
    EQUIPMENTS_SAV: 'Modele_Import_Equipements_SAV_AtlasSoftWater.xlsx',
    ALL_IN_ONE: 'Pack_Complet_Modeles_Import_AtlasSoftWater.xlsx',
  };

  downloadWorkbookFile(wb, fileNames[templateType]);
}
