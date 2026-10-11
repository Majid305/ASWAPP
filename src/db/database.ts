import Dexie, { Table, Transaction } from 'dexie';
import {
  AppMetadataEntry,
  AppSettings,
  AuditLog,
  BankDeposit,
  Brand,
  CashAudit,
  CashEntry,
  Category,
  CompanyInfo,
  ContradictionRuleCode,
  Customer,
  CustomerEquipment,
  DefectiveProduct,
  DocumentPrefixes,
  DocumentSequence,
  Expense,
  InventoryItem,
  InventorySession,
  Invoice,
  InvoiceItem,
  MarketObservation,
  Payment,
  Product,
  Purchase,
  PurchaseItem,
  Quote,
  QuoteItem,
  Sale,
  SaleItem,
  SavReminder,
  StockMovement,
  Supplier,
  UserProfile,
  UserRole,
} from '../types/domain';
import { getMoroccoBusinessDate, getMoroccoYear } from '../utils/dateUtils';
import { generateId } from '../utils/securityUtils';

export const CURRENT_SCHEMA_VERSION = 5;

export const DEFAULT_PREFIXES: DocumentPrefixes = {
  sale: 'V',
  quote: 'DEV',
  invoice: 'FAC',
  creditNote: 'AV',
  purchase: 'ACH',
  customer: 'CLI',
  supplier: 'FOUR',
  inventory: 'INV',
  payment: 'REG',
  expense: 'DEP',
  cashAudit: 'PV-CAISSE',
  defective: 'DEF',
  bankDeposit: 'VER',
};

export class AtlasSoftWaterDB extends Dexie {
  company!: Table<CompanyInfo, string>;
  settings!: Table<AppSettings, string>;
  profiles!: Table<UserProfile, string>;
  categories!: Table<Category, string>;
  brands!: Table<Brand, string>;
  products!: Table<Product, string>;
  stockMovements!: Table<StockMovement, string>;
  suppliers!: Table<Supplier, string>;
  purchases!: Table<Purchase, string>;
  purchaseItems!: Table<PurchaseItem, string>;
  customers!: Table<Customer, string>;
  customerEquipments!: Table<CustomerEquipment, string>;
  sales!: Table<Sale, string>;
  saleItems!: Table<SaleItem, string>;
  quotes!: Table<Quote, string>;
  quoteItems!: Table<QuoteItem, string>;
  invoices!: Table<Invoice, string>;
  invoiceItems!: Table<InvoiceItem, string>;
  payments!: Table<Payment, string>;
  reminders!: Table<SavReminder, string>;
  inventories!: Table<InventorySession, string>;
  inventoryItems!: Table<InventoryItem, string>;
  cashEntries!: Table<CashEntry, string>;
  cashAudits!: Table<CashAudit, string>;
  expenses!: Table<Expense, string>;
  bankDeposits!: Table<BankDeposit, string>;
  auditLogs!: Table<AuditLog, string>;
  marketResearch!: Table<MarketObservation, string>;
  defectiveProducts!: Table<DefectiveProduct, string>;
  sequences!: Table<DocumentSequence, string>;
  appMetadata!: Table<AppMetadataEntry, string>;

  constructor(dbName = 'AtlasSoftWaterDB') {
    super(dbName);

    // Version 1 -> 2 -> 3 Migrations (Section 9)
    this.version(1).stores({
      company: 'id',
      settings: 'id',
      profiles: 'id, role, active',
      categories: 'id, name, active',
      brands: 'id, name, active',
      products: 'id, reference, barcode, name, categoryId, brandId, supplierId, active, stock',
      stockMovements: 'id, businessDate, productId, type, sourceDocId, status, createdAt',
      suppliers: 'id, code, name, city, active',
      purchases: 'id, number, supplierId, businessDate, status, createdAt',
      purchaseItems: 'id, purchaseId, productId',
      customers: 'id, code, name, type, phone, city, active',
      customerEquipments: 'id, customerId, serialNumber, active',
      sales: 'id, number, quoteId, invoiceId, customerId, businessDate, status, createdAt',
      saleItems: 'id, saleId, productId',
      quotes: 'id, number, customerId, businessDate, status, convertedSaleId, createdAt',
      quoteItems: 'id, quoteId, productId',
      invoices: 'id, number, type, saleId, quoteId, customerId, businessDate, status, createdAt',
      invoiceItems: 'id, invoiceId, productId',
      payments: 'id, number, businessDate, direction, targetType, targetId, partyId, method, destination, status, createdAt',
      reminders: 'id, customerId, equipmentId, productId, dueDate, status',
      inventories: 'id, number, businessDate, status, createdAt',
      inventoryItems: 'id, inventoryId, productId',
      cashEntries: 'id, businessDate, direction, type, sourceId, auditId, isLockedByAudit, createdAt',
      cashAudits: 'id, number, businessDate, status, createdAt',
      expenses: 'id, number, businessDate, category, status, createdAt',
      auditLogs: 'id, timestamp, businessDate, action, entityType, entityId, contradictionArbitrated',
      marketResearch: 'id, productName, category, sellerName, sourceType, observedDate',
      sequences: 'id, docType, year',
      appMetadata: 'key',
    });

    this.version(2)
      .stores({
        sales: 'id, number, quoteId, invoiceId, parentSaleId, customerId, businessDate, status, createdAt',
        invoices: 'id, number, type, saleId, quoteId, parentInvoiceId, customerId, businessDate, status, createdAt',
      })
      .upgrade(async (tx) => {
        await tx.table('appMetadata').put({
          key: 'migration_v2',
          value: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      });

    this.version(3)
      .stores({
        customers: 'id, code, name, type, phone, city, active, balanceCents',
        suppliers: 'id, code, name, city, active, debtCents',
      })
      .upgrade(async (tx) => {
        await tx.table('appMetadata').put({
          key: 'schemaVersion',
          value: '3',
          updatedAt: new Date().toISOString(),
        });
      });

    this.version(4)
      .stores({
        defectiveProducts:
          'id, number, productId, productRef, sourceType, status, businessDate, supplierId, customerId, createdAt',
      })
      .upgrade(async (tx) => {
        await tx.table('appMetadata').put({
          key: 'schemaVersion',
          value: '4',
          updatedAt: new Date().toISOString(),
        });
      });

    this.version(5)
      .stores({
        bankDeposits: 'id, number, businessDate, status, createdAt',
      })
      .upgrade(async (tx) => {
        // Nettoyage de l'ancien fond de caisse initial de 2 000 DH afin que le solde de départ soit strictement 0
        const legacyFloats = await tx
          .table('cashEntries')
          .filter((e: any) => e.sourceId === 'INIT' || e.sourceNumber === 'OUV-CAISSE')
          .toArray();
        for (const f of legacyFloats) {
          await tx.table('cashEntries').delete(f.id);
        }
        await tx.table('appMetadata').put({
          key: 'schemaVersion',
          value: String(CURRENT_SCHEMA_VERSION),
          updatedAt: new Date().toISOString(),
        });
      });
  }
}

export const db = new AtlasSoftWaterDB();

/**
 * File d'attente de sérialisation des mutations concurrentes (Section 8 & Règle 21)
 * Garantit que deux appels lancés simultanément en mémoire s'exécutent de manière séquentielle
 * et transactionnelle sans jamais écraser un numéro de séquence ni un stock.
 */
let mutationQueue: Promise<unknown> = Promise.resolve();

export function enqueueTransactionalMutation<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutationQueue.then(fn, fn);
  mutationQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * RÈGLE 21 : Générateur transactionnel de numéros de documents
 * Format : PREFIX-YYYY-0001 (ex: V-2026-0001, FAC-2026-0001)
 */
export async function nextDocumentNumberInTx(
  targetDb: AtlasSoftWaterDB,
  docType: keyof DocumentPrefixes,
  businessDate?: string
): Promise<string> {
  const year = getMoroccoYear(businessDate);
  const settings = await targetDb.settings.get('default');
  const prefix = settings?.prefixes?.[docType] || DEFAULT_PREFIXES[docType] || 'DOC';
  const seqId = `${docType}:${year}`;

  const existing = await targetDb.sequences.get(seqId);
  const nextVal = (existing?.currentValue ?? 0) + 1;
  const now = new Date().toISOString();

  await targetDb.sequences.put({
    id: seqId,
    docType,
    prefix,
    year,
    currentValue: nextVal,
    updatedAt: now,
  });

  const padded = String(nextVal).padStart(4, '0');
  return `${prefix}-${year}-${padded}`;
}

export async function recordAuditLogInTx(
  targetDb: AtlasSoftWaterDB,
  params: {
    userId?: string;
    userName?: string;
    userRole?: UserRole;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    contradictionArbitrated?: ContradictionRuleCode;
    details?: Record<string, unknown>;
    businessDate?: string;
  }
): Promise<AuditLog> {
  const now = new Date().toISOString();
  const bDate = params.businessDate ?? getMoroccoBusinessDate(now);
  const log: AuditLog = {
    id: generateId(),
    timestamp: now,
    businessDate: bDate,
    userId: params.userId ?? 'admin',
    userName: params.userName ?? 'Administrateur',
    userRole: params.userRole ?? 'ADMIN',
    action: params.action,
    entityType: params.entityType,
    entityId: params.entityId,
    summary: params.summary,
    contradictionArbitrated: params.contradictionArbitrated,
    detailsJson: JSON.stringify(params.details ?? {}),
  };
  await targetDb.auditLogs.add(log);
  return log;
}

export function getAllTables(targetDb: AtlasSoftWaterDB = db): Table[] {
  return [
    targetDb.company,
    targetDb.settings,
    targetDb.profiles,
    targetDb.categories,
    targetDb.brands,
    targetDb.products,
    targetDb.stockMovements,
    targetDb.suppliers,
    targetDb.purchases,
    targetDb.purchaseItems,
    targetDb.customers,
    targetDb.customerEquipments,
    targetDb.sales,
    targetDb.saleItems,
    targetDb.quotes,
    targetDb.quoteItems,
    targetDb.invoices,
    targetDb.invoiceItems,
    targetDb.payments,
    targetDb.reminders,
    targetDb.inventories,
    targetDb.inventoryItems,
    targetDb.cashEntries,
    targetDb.cashAudits,
    targetDb.expenses,
    targetDb.bankDeposits,
    targetDb.auditLogs,
    targetDb.marketResearch,
    targetDb.defectiveProducts,
    targetDb.sequences,
    targetDb.appMetadata,
  ];
}

export type TransactionContext = Transaction;
