export type UserRole = 'ADMIN' | 'SELLER' | 'MANAGER' | 'ACCOUNTANT' | 'TECHNICIAN';

export type PermissionKey =
  | 'VIEW_DASHBOARD'
  | 'USE_POS'
  | 'MANAGE_SALES'
  | 'CANCEL_SALES'
  | 'MANAGE_QUOTES'
  | 'MANAGE_INVOICES'
  | 'RECORD_PAYMENTS'
  | 'MANAGE_PRODUCTS'
  | 'MANAGE_STOCK'
  | 'VALIDATE_INVENTORY'
  | 'MANAGE_PURCHASES'
  | 'RECEIVE_PURCHASES'
  | 'MANAGE_SUPPLIERS'
  | 'MANAGE_CUSTOMERS'
  | 'MANAGE_SAV'
  | 'MANAGE_FINANCE'
  | 'CLOSE_CASH'
  | 'MANAGE_EXPENSES'
  | 'VIEW_ANALYTICS'
  | 'MANAGE_MARKET_WATCH'
  | 'MANAGE_BACKUPS'
  | 'MANAGE_SETTINGS'
  | 'RUN_DIAGNOSTICS';

export interface CompanyInfo {
  id: string;
  name: string;
  legalName: string;
  ice: string;
  ifNumber: string;
  rc: string;
  patente: string;
  cnss: string;
  defaultVatRate: number;
  currency: string;
  address: string;
  city: string;
  phone: string;
  whatsapp: string;
  email: string;
  paymentTerms: string;
  legalMentions: string;
  logoText: string;
  logoDataUrl?: string;
  headerMentions?: string;
  watermarkDataUrl?: string;
  watermarkFileName?: string;
  watermarkEnabled?: boolean;
  watermarkOpacity?: number;
  hideTextHeaderWithWatermark?: boolean;
  rib?: string;
  isDemoData: boolean;
  setupCompleted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentPrefixes {
  sale: string;
  quote: string;
  invoice: string;
  creditNote: string;
  purchase: string;
  customer: string;
  supplier: string;
  inventory: string;
  payment: string;
  expense: string;
  cashAudit: string;
  defective: string;
  bankDeposit: string;
}

export type DefectiveSourceType =
  | 'PURCHASE_RECEIPT'
  | 'CUSTOMER_RETURN'
  | 'MANUAL_INSPECTION'
  | 'SAV_INTERVENTION';

export type DefectiveStatus =
  | 'EN_QUARANTAINE'
  | 'RETOURNE_FOURNISSEUR'
  | 'REMPLACE_FOURNISSEUR'
  | 'AVOIR_FOURNISSEUR'
  | 'REPARE_REMIS_EN_STOCK'
  | 'REBUTE_PERTE';

export interface DefectiveProduct {
  id: string;
  number: string; // e.g. DEF-2026-0001
  productId: string;
  productRef: string;
  productName: string;
  quantity: number;
  sourceType: DefectiveSourceType;
  sourceDocType: 'PURCHASE' | 'SALE' | 'SAV' | 'MANUAL';
  sourceDocId?: string;
  sourceDocNumber?: string;
  supplierId?: string;
  supplierName?: string;
  customerId?: string;
  customerName?: string;
  defectReason: string;
  severity?: 'CRITIQUE' | 'MAJEUR' | 'MINEUR';
  status: DefectiveStatus;
  unitCostCents: number;
  totalCostCents: number;
  reportedDate: string;
  businessDate: string;
  resolutionDate?: string;
  resolutionNotes?: string;
  actionTaken?: string;
  reportedBy?: string;
  isDemo?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AppSettings {
  id: string;
  schemaVersion: number;
  defaultVatRate: number;
  availableVatRates: number[];
  currency: string;
  allowNegativeStock: boolean;
  allowOverpayment: boolean;
  autoPrintTicket: boolean;
  defaultCounterCustomerId: string;
  lockTimeoutMinutes: number;
  theme: 'light' | 'dark' | 'green' | 'orange' | 'system';
  ollamaUrl: string;
  ollamaModel: string;
  enableExternalAi: boolean;
  prefixes: DocumentPrefixes;
  updatedAt: string;
}

export interface UserProfile {
  id: string;
  name: string;
  role: UserRole;
  pinHash: string;
  pinSalt: string;
  masterPinHash: string;
  masterPinSalt: string;
  active: boolean;
  failedAttempts: number;
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  parentCategory: string;
  description: string;
  active: boolean;
  createdAt: string;
}

export interface Brand {
  id: string;
  name: string;
  country: string;
  notes: string;
  active: boolean;
  createdAt: string;
}

export type StockStatus = 'NORMAL' | 'FAIBLE' | 'CRITIQUE' | 'RUPTURE' | 'SURSTOCK';

export interface Product {
  id: string;
  reference: string;
  barcode: string;
  name: string;
  categoryId: string;
  categoryName: string;
  subCategory: string;
  brandId: string;
  brandName: string;
  description: string;
  photoUrl: string;
  purchasePriceCents: number;
  salePriceHtCents: number;
  minSalePriceHtCents: number;
  vatRate: number;
  stock: number;
  minStock: number;
  maxStock: number;
  unit: string;
  supplierId: string;
  supplierName: string;
  location: string;
  replacementMonths: number;
  compatibleModels: string;
  notes: string;
  active: boolean;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export type StockMovementType =
  | 'SALE'
  | 'SALE_CANCEL'
  | 'CUSTOMER_RETURN'
  | 'PURCHASE_RECEIPT'
  | 'INVENTORY_ADJUST'
  | 'SAV_CONSUMPTION'
  | 'MANUAL_ADJUST';

export interface StockMovement {
  id: string;
  date: string;
  businessDate: string;
  productId: string;
  productRef: string;
  productName: string;
  quantity: number; // positive for entry, negative for exit
  stockBefore: number;
  stockAfter: number;
  type: StockMovementType;
  sourceDocType: 'SALE' | 'PURCHASE' | 'INVENTORY' | 'SAV' | 'MANUAL' | 'RETURN';
  sourceDocId: string;
  sourceDocNumber: string;
  reason: string;
  userId: string;
  userName: string;
  status: 'ACTIVE' | 'CANCELLED';
  createdAt: string;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  contactName: string;
  phone: string;
  whatsapp: string;
  email: string;
  city: string;
  address: string;
  ice: string;
  ifNumber: string;
  rc: string;
  paymentTerms: string;
  totalPurchasesCents: number;
  debtCents: number;
  notes: string;
  active: boolean;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export type PurchaseStatus =
  | 'BROUILLON'
  | 'COMMANDE'
  | 'EN_ATTENTE'
  | 'PARTIELLEMENT_RECU'
  | 'RECU'
  | 'ANNULE';

export interface Purchase {
  id: string;
  number: string;
  supplierId: string;
  supplierName: string;
  businessDate: string;
  status: PurchaseStatus;
  subtotalHtCents: number;
  globalDiscountPercent: number;
  globalDiscountCents: number;
  totalTaxableCents: number;
  totalVatCents: number;
  totalTtcCents: number;
  paidCents: number;
  remainingDueCents: number;
  notes: string;
  createdBy: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseItem {
  id: string;
  purchaseId: string;
  productId: string;
  productRef: string;
  productName: string;
  orderedQty: number;
  receivedQty: number;
  unitPriceHtCents: number;
  discountPercent: number;
  vatRate: number;
  lineSubtotalHtCents: number;
  lineTaxableCents: number;
  lineVatCents: number;
  lineTtcCents: number;
}

export type CustomerType = 'PARTICULIER' | 'PROFESSIONNEL' | 'INSTALLATEUR' | 'REVENDEUR';

export interface Customer {
  id: string;
  code: string;
  name: string;
  type: CustomerType;
  phone: string;
  whatsapp: string;
  email: string;
  address: string;
  city: string;
  ice: string;
  notes: string;
  balanceCents: number; // positive = customer owes company (créance)
  creditAvailableCents: number; // positive = company owes customer (avoir / trop-perçu)
  active: boolean;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerEquipment {
  id: string;
  customerId: string;
  customerName: string;
  type: string;
  brand: string;
  model: string;
  serialNumber: string;
  installDate: string;
  capacity: string;
  membraneType: string;
  notes: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export type SaleStatus = 'VALIDATED' | 'CANCELLED' | 'RETURNED' | 'PARTIAL_RETURN';

export type PaymentMethod = 'CASH' | 'CARD' | 'TRANSFER' | 'CHECK' | 'CREDIT' | 'CREDIT_NOTE';

export type FinancialDestination =
  | 'CAISSE_PHYSIQUE'
  | 'BANQUE'
  | 'PORTEFEUILLE_EFFETS'
  | 'COMPTE_AVOIR';

export interface Sale {
  id: string;
  number: string;
  quoteId: string | null;
  invoiceId: string | null;
  parentSaleId: string | null; // if return or recreation
  customerId: string;
  customerName: string;
  sellerId: string;
  sellerName: string;
  businessDate: string;
  status: SaleStatus;
  subtotalHtCents: number;
  lineDiscountTotalCents: number;
  globalDiscountPercent: number;
  globalDiscountCents: number;
  totalTaxableCents: number;
  totalVatCents: number;
  totalTtcCents: number;
  totalCostCents: number;
  marginCents: number;
  paidCents: number;
  remainingDueCents: number;
  amountReceivedCents: number;
  changeGivenCents: number;
  paymentMethodSummary: PaymentMethod;
  cancelReason: string;
  cancelledAt: string | null;
  notes: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SaleItem {
  id: string;
  saleId: string;
  productId: string;
  productRef: string;
  productName: string;
  quantity: number;
  returnedQty: number;
  unitCostCents: number;
  unitPriceHtCents: number;
  discountPercent: number;
  vatRate: number;
  lineGrossHtCents: number;
  lineDiscountCents: number;
  lineSubtotalHtCents: number;
  lineGlobalDiscountShareCents: number;
  lineTaxableCents: number;
  lineVatCents: number;
  lineTtcCents: number;
}

export type QuoteStatus = 'BROUILLON' | 'ENVOYE' | 'ACCEPTE' | 'REFUSE' | 'EXPIRE' | 'ANNULE';

export interface Quote {
  id: string;
  number: string;
  customerId: string;
  customerName: string;
  businessDate: string;
  validUntil: string;
  status: QuoteStatus;
  convertedSaleId: string | null;
  convertedInvoiceId: string | null;
  subtotalHtCents: number;
  lineDiscountTotalCents: number;
  globalDiscountPercent: number;
  globalDiscountCents: number;
  totalTaxableCents: number;
  totalVatCents: number;
  totalTtcCents: number;
  paymentTerms: string;
  notes: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuoteItem {
  id: string;
  quoteId: string;
  productId: string;
  productRef: string;
  productName: string;
  quantity: number;
  unitPriceHtCents: number;
  discountPercent: number;
  vatRate: number;
  lineSubtotalHtCents: number;
  lineTaxableCents: number;
  lineVatCents: number;
  lineTtcCents: number;
}

export type InvoiceStatus = 'UNPAID' | 'PARTIAL' | 'PAID' | 'CANCELLED';

export interface Invoice {
  id: string;
  number: string;
  type: 'INVOICE' | 'CREDIT_NOTE';
  saleId: string | null;
  quoteId: string | null;
  parentInvoiceId: string | null;
  customerId: string;
  customerName: string;
  customerIce: string;
  businessDate: string;
  dueDate: string;
  status: InvoiceStatus;
  subtotalHtCents: number;
  lineDiscountTotalCents: number;
  globalDiscountPercent: number;
  globalDiscountCents: number;
  totalTaxableCents: number;
  totalVatCents: number;
  totalTtcCents: number;
  paidCents: number;
  remainingDueCents: number;
  cancelReason: string;
  notes: string;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface InvoiceItem {
  id: string;
  invoiceId: string;
  productId: string;
  productRef: string;
  productName: string;
  quantity: number;
  unitPriceHtCents: number;
  discountPercent: number;
  vatRate: number;
  lineSubtotalHtCents: number;
  lineTaxableCents: number;
  lineVatCents: number;
  lineTtcCents: number;
}

export interface Payment {
  id: string;
  number: string;
  businessDate: string;
  direction: 'IN' | 'OUT';
  targetType: 'SALE' | 'INVOICE' | 'PURCHASE' | 'CUSTOMER_REFUND' | 'OVERPAYMENT_CREDIT' | 'SAV';
  targetId: string;
  targetNumber: string;
  partyId: string;
  partyName: string;
  amountCents: number;
  method: Exclude<PaymentMethod, 'CREDIT'>;
  destination: FinancialDestination;
  reference: string;
  status: 'VALIDATED' | 'REVERSED';
  reversedByPaymentId: string | null;
  reversalOfPaymentId: string | null;
  notes: string;
  userId: string;
  isDemo: boolean;
  createdAt: string;
}

export type ReminderStatus = 'NORMAL' | 'PROCHE' | 'ATTENTION' | 'URGENT' | 'DEPASSE' | 'EFFECTUE';

export interface SavReminder {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerWhatsapp: string;
  equipmentId: string;
  equipmentName: string;
  productId: string;
  productName: string;
  installDate: string;
  intervalMonths: number;
  dueDate: string;
  status: ReminderStatus;
  completedAt: string | null;
  technicianNotes: string;
  consumedProductId: string | null;
  consumedQty: number;
  serviceFeeCents: number;
  paymentId: string | null;
  isDemo: boolean;
  createdAt: string;
  updatedAt: string;
}

export type InventoryMode = 'COMPLET' | 'CATEGORIE' | 'EMPLACEMENT' | 'SELECTION';
export type InventoryStatus = 'BROUILLON' | 'COMPTAGE' | 'VALIDE' | 'ANNULE';

export interface InventorySession {
  id: string;
  number: string;
  businessDate: string;
  mode: InventoryMode;
  scopeFilter: string;
  status: InventoryStatus;
  totalTheoreticalValueCents: number;
  totalCountedValueCents: number;
  totalVarianceValueCents: number;
  notes: string;
  validatedBy: string | null;
  validatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InventoryItem {
  id: string;
  inventoryId: string;
  productId: string;
  productRef: string;
  productName: string;
  location: string;
  unitCostCents: number;
  theoreticalQty: number;
  countedQty: number;
  varianceQty: number;
  varianceValueCents: number;
  adjustmentMovementId: string | null;
}

export interface CashEntry {
  id: string;
  businessDate: string;
  direction: 'IN' | 'OUT';
  type:
    | 'SALE_CASH'
    | 'INVOICE_CASH'
    | 'REFUND_CASH'
    | 'EXPENSE_CASH'
    | 'SUPPLIER_CASH'
    | 'OPENING_FLOAT'
    | 'CLOSING_ADJUSTMENT'
    | 'BANK_DEPOSIT'
    | 'CORRECTION';
  amountCents: number;
  sourceId: string;
  sourceNumber: string;
  description: string;
  auditId: string | null;
  isLockedByAudit: boolean;
  userId: string;
  createdAt: string;
}

export interface CashAudit {
  id: string;
  number: string;
  businessDate: string;
  counts: Record<string, number>; // e.g. '200': 5, '100': 3, '0.5': 4
  theoreticalBalanceCents: number;
  countedBalanceCents: number;
  varianceCents: number;
  status: 'CONFORME' | 'EXCEDENT' | 'MANQUANT';
  notes: string;
  userId: string;
  userName: string;
  createdAt: string;
}

export type ExpenseCategory =
  | 'ELECTRICITE_EAU'
  | 'TELEPHONE_INTERNET'
  | 'ENTRETIEN'
  | 'LOYER'
  | 'TRANSPORT'
  | 'CARBURANT'
  | 'FOURNITURES'
  | 'SALAIRES_PRIMES'
  | 'COMPTABLE'
  | 'IMPOTS_TAXES'
  | 'FRAIS_BANCAIRES'
  | 'MARKETING'
  | 'ALIMENTATION_CAISSE'
  | 'DIVERS';

export interface Expense {
  id: string;
  number: string;
  businessDate: string;
  category: ExpenseCategory;
  label: string;
  beneficiary: string;
  amountHtCents: number;
  vatRate: number;
  amountVatCents: number;
  amountTtcCents: number;
  paymentMethod: 'CASH' | 'CARD' | 'TRANSFER' | 'CHECK';
  receiptRef: string;
  notes: string;
  status: 'VALIDATED' | 'CANCELLED';
  isDemo: boolean;
  createdAt: string;
}

export type BankDepositStatus = 'PREPARED' | 'CONFIRMED' | 'CANCELLED';

export interface BankDepositCheckItem {
  paymentId: string;
  checkNumber: string;
  bankName: string;
  amountCents: number;
  partyName: string;
  date: string;
}

export interface BankDeposit {
  id: string;
  number: string;
  businessDate: string;
  status: BankDepositStatus;
  cashAvailableCents: number;
  cashToDepositCents: number;
  cashRemainingInRegisterCents: number;
  checksSelected: BankDepositCheckItem[];
  totalChecksCents: number;
  totalDepositCents: number; // cashToDepositCents + totalChecksCents
  bankName: string; // ex: 'Attijariwafa bank', 'Banque Populaire', etc.
  bankAccountNumber?: string;
  reference?: string; // N° récépissé / bordereau banque
  notes: string;
  preparedByUserId: string;
  preparedByUserName: string;
  confirmedAt: string | null;
  confirmedByUserId: string | null;
  confirmedByUserName: string | null;
  cashEntryId: string | null; // Id écriture OUT de caisse quand confirmé
  createdAt: string;
  updatedAt: string;
}

export type ContradictionRuleCode =
  | 'RULE_01_INSUFFICIENT_STOCK'
  | 'RULE_01_NEGATIVE_STOCK_AUTHORIZED'
  | 'RULE_02_PAID_SALE_CANCELLATION'
  | 'RULE_03_INVOICE_STATUS_COMPUTED'
  | 'RULE_04_PAYMENT_DESTINATION_ROUTING'
  | 'RULE_05_QUOTE_NO_STOCK_IMPACT'
  | 'RULE_06_PURCHASE_STOCK_ON_RECEIPT_ONLY'
  | 'RULE_07_INVENTORY_EXPLICIT_VARIANCE'
  | 'RULE_08_PHYSICAL_DELETE_FORBIDDEN'
  | 'RULE_09_VALIDATED_DOC_IMMUTABLE'
  | 'RULE_10_LINE_LEVEL_VAT'
  | 'RULE_11_DISCOUNT_WATERFALL_ORDER'
  | 'RULE_12_LINKED_CUSTOMER_RETURN'
  | 'RULE_13_CLOSED_CASH_IMMUTABLE'
  | 'RULE_14_NEGATIVE_STOCK_INVENTORY_DELTA'
  | 'RULE_15_CUSTOMER_LOGICAL_DELETE_ONLY'
  | 'RULE_16_PRODUCT_LOGICAL_DELETE_ONLY'
  | 'RULE_17_SUPPLIER_LOGICAL_DELETE_ONLY'
  | 'RULE_18_SAV_EQUIPMENT_PRESERVATION_AND_STOCK'
  | 'RULE_19_OVERPAYMENT_ARBITRAGE'
  | 'RULE_20_MOROCCO_TIMEZONE_BUSINESS_DATE'
  | 'RULE_21_TRANSACTIONAL_SEQUENCE'
  | 'RULE_22_ATOMIC_MUTATION_ROLLBACK'
  | 'RULE_23_CENTRAL_DASHBOARD_METRICS'
  | 'RULE_24_EXCLUDE_CANCELLED_FROM_STATS'
  | 'RULE_25_VALIDATED_IMPORT_PIPELINE'
  | 'RULE_26_VERIFIED_BACKUP_RESTORE';

export interface AuditLog {
  id: string;
  timestamp: string;
  businessDate: string;
  userId: string;
  userName: string;
  userRole: UserRole;
  action: string;
  entityType: string;
  entityId: string;
  summary: string;
  contradictionArbitrated?: ContradictionRuleCode;
  detailsJson: string;
}

export interface MarketObservation {
  id: string;
  productName: string;
  category: string;
  sellerName: string;
  sourceType: 'VERIFIEE' | 'MANUELLE' | 'IMPORTEE' | 'EXEMPLE';
  sourceUrl: string;
  priceHtCents: number;
  priceTtcCents: number;
  observedDate: string;
  specs: string;
  notes: string;
  createdAt: string;
}

export interface DocumentSequence {
  id: string; // e.g., "SALE:2026"
  docType: string;
  prefix: string;
  year: number;
  currentValue: number;
  updatedAt: string;
}

export interface AppMetadataEntry {
  key: string;
  value: string;
  updatedAt: string;
}

export interface DiagnosticIssue {
  id: string;
  severity: 'CRITICAL' | 'WARNING' | 'INFO';
  category:
    | 'DUPLICATE_ID'
    | 'BROKEN_REFERENCE'
    | 'MISSING_PRODUCT'
    | 'INCONSISTENT_SALE'
    | 'INCONSISTENT_PAYMENT'
    | 'INCONSISTENT_STOCK'
    | 'INCONSISTENT_RECEIVABLE'
    | 'INCONSISTENT_DEBT'
    | 'INCONSISTENT_SEQUENCE'
    | 'CORRUPT_DATA';
  entityType: string;
  entityId: string;
  description: string;
  autoRepairSafe: boolean;
  repaired?: boolean;
}

export interface DiagnosticReport {
  timestamp: string;
  schemaVersion: number;
  healthy: boolean;
  totalEntitiesChecked: number;
  issues: DiagnosticIssue[];
}
