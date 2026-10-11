import {
  ArbitrageError,
  arbitratePaymentAmount,
  arbitrateSaleStock,
  buildArbitrageDecision,
} from '../domain/arbitrageEngine';
import {
  calculateDocumentLinesAndTotals,
  computeInvoiceStatus,
  computeSavReminderStatus,
  DocumentLineInput,
  resolvePaymentDestination,
} from '../domain/financialEngine';
import {
  AtlasSoftWaterDB,
  db,
  enqueueTransactionalMutation,
  getAllTables,
  nextDocumentNumberInTx,
  recordAuditLogInTx,
} from '../db/database';
import {
  AuditLog,
  BankDeposit,
  BankDepositCheckItem,
  BankDepositStatus,
  CashAudit,
  CashEntry,
  Customer,
  CustomerEquipment,
  DefectiveProduct,
  DefectiveSourceType,
  DefectiveStatus,
  Expense,
  ExpenseCategory,
  InventoryItem,
  InventoryMode,
  InventorySession,
  Invoice,
  InvoiceItem,
  Payment,
  PaymentMethod,
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
  UserRole,
} from '../types/domain';
import {
  addDaysToBusinessDate,
  addMonthsToBusinessDate,
  getMoroccoBusinessDate,
} from '../utils/dateUtils';
import { generateId, verifyPin } from '../utils/securityUtils';

export interface ActorContext {
  userId: string;
  userName: string;
  userRole: UserRole;
}

const DEFAULT_ACTOR: ActorContext = {
  userId: 'admin',
  userName: 'Administrateur',
  userRole: 'ADMIN',
};

export interface CreateSaleInput {
  customerId: string;
  quoteId?: string | null;
  businessDate?: string;
  lines: DocumentLineInput[];
  globalDiscountPercent?: number;
  globalDiscountAmountCents?: number;
  paymentMethod: PaymentMethod;
  amountPaidCents: number;
  amountReceivedCents?: number;
  paymentReference?: string;
  generateInvoice?: boolean;
  confirmOverpayment?: boolean;
  notes?: string;
  actor?: ActorContext;
  simulateMidTransactionFailure?: boolean; // Pour le test obligatoire d'atomicité (Règle 22)
}

export interface CreateSaleResult {
  sale: Sale;
  invoice: Invoice;
  payments: Payment[];
  stockMovements: StockMovement[];
}

/**
 * RÈGLE 22 : Synchronisation atomique des modules
 * Validation vente -> création vente -> lignes -> mouvement stock -> facture -> paiement -> caisse -> audit
 */
export async function executeCreateSale(
  input: CreateSaleInput,
  targetDb: AtlasSoftWaterDB = db
): Promise<CreateSaleResult> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = input.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = input.businessDate ?? getMoroccoBusinessDate(now);
      const settings = await targetDb.settings.get('default');
      const allowNegativeStock = settings?.allowNegativeStock ?? false;
      const allowOverpayment = settings?.allowOverpayment ?? false;

      if (!input.lines || input.lines.length === 0) {
        throw new Error('Une vente doit contenir au moins une ligne de produit.');
      }

      const customer = await targetDb.customers.get(input.customerId);
      if (!customer) {
        throw new Error('Client introuvable pour cette vente.');
      }

      // 1. Vérification du stock et arbitrage (Règle 1)
      const negativeStockDecisions: string[] = [];
      const productsMap = new Map<string, Product>();

      for (const line of input.lines) {
        if (line.quantity <= 0) {
          throw new Error(`La quantité pour "${line.productName}" doit être supérieure à zéro.`);
        }
        const product = await targetDb.products.get(line.productId);
        if (!product) {
          throw new Error(`Produit introuvable : ${line.productName} (${line.productRef})`);
        }
        productsMap.set(product.id, product);

        const stockDecision = arbitrateSaleStock({
          productName: product.name,
          productRef: product.reference,
          availableStock: product.stock,
          requestedQty: line.quantity,
          allowNegativeStock,
        });

        if (!stockDecision.allowed) {
          await recordAuditLogInTx(targetDb, {
            ...actor,
            action: 'SALE_BLOCKED_INSUFFICIENT_STOCK',
            entityType: 'PRODUCT',
            entityId: product.id,
            summary: stockDecision.resolutionMessage,
            contradictionArbitrated: 'RULE_01_INSUFFICIENT_STOCK',
            businessDate,
          });
          throw new ArbitrageError(stockDecision);
        }

        if (stockDecision.ruleCode === 'RULE_01_NEGATIVE_STOCK_AUTHORIZED') {
          negativeStockDecisions.push(stockDecision.resolutionMessage);
        }
      }

      // 2. Calcul financier centralisé (Règles 10 & 11)
      const enrichedLines: DocumentLineInput[] = input.lines.map((l) => {
        const p = productsMap.get(l.productId)!;
        return {
          ...l,
          productRef: p.reference,
          productName: p.name,
          unitCostCents: l.unitCostCents ?? p.purchasePriceCents,
        };
      });

      const calc = calculateDocumentLinesAndTotals(
        enrichedLines,
        input.globalDiscountPercent ?? 0,
        input.globalDiscountAmountCents
      );

      // 3. Arbitrage du montant payé vs Total TTC (Règles 3 & 19)
      const requestedPaidCents =
        input.paymentMethod === 'CREDIT' ? 0 : Math.max(0, Math.round(input.amountPaidCents));
      const amountReceivedCents = Math.max(
        requestedPaidCents,
        Math.round(input.amountReceivedCents ?? requestedPaidCents)
      );

      // Si paiement espèces au POS avec rendu monnaie immédiat et sans demande d'avoir :
      let effectivePaidOnInvoiceCents = requestedPaidCents;
      let overpaymentCreditCents = 0;
      let changeGivenCents = 0;

      if (requestedPaidCents > calc.totalTtcCents) {
        if (input.paymentMethod === 'CASH' && !input.confirmOverpayment) {
          // Au comptoir espèces, le montant reçu > TTC correspond au rendu de monnaie physique
          changeGivenCents = requestedPaidCents - calc.totalTtcCents;
          effectivePaidOnInvoiceCents = calc.totalTtcCents;
        } else {
          const paymentDecision = arbitratePaymentAmount({
            documentNumber: 'Nouvelle Vente',
            remainingDueCents: calc.totalTtcCents,
            paymentAmountCents: requestedPaidCents,
            allowOverpayment,
            confirmedOverpayment: input.confirmOverpayment,
          });
          if (!paymentDecision.allowed) {
            throw new ArbitrageError(paymentDecision);
          }
          effectivePaidOnInvoiceCents = calc.totalTtcCents;
          overpaymentCreditCents = requestedPaidCents - calc.totalTtcCents;
        }
      } else if (amountReceivedCents > requestedPaidCents && input.paymentMethod === 'CASH') {
        changeGivenCents = amountReceivedCents - requestedPaidCents;
      }

      const remainingDueCents = Math.max(0, calc.totalTtcCents - effectivePaidOnInvoiceCents);

      // 4. Numérotation transactionnelle (Règle 21)
      const saleNumber = await nextDocumentNumberInTx(targetDb, 'sale', businessDate);
      const invoiceNumber = await nextDocumentNumberInTx(targetDb, 'invoice', businessDate);

      const saleId = generateId();
      const invoiceId = generateId();

      // 5. Création Vente & Lignes
      const sale: Sale = {
        id: saleId,
        number: saleNumber,
        quoteId: input.quoteId ?? null,
        invoiceId,
        parentSaleId: null,
        customerId: customer.id,
        customerName: customer.name,
        sellerId: actor.userId,
        sellerName: actor.userName,
        businessDate,
        status: 'VALIDATED',
        subtotalHtCents: calc.subtotalHtCents,
        lineDiscountTotalCents: calc.lineDiscountTotalCents,
        globalDiscountPercent: calc.globalDiscountPercent,
        globalDiscountCents: calc.globalDiscountCents,
        totalTaxableCents: calc.totalTaxableCents,
        totalVatCents: calc.totalVatCents,
        totalTtcCents: calc.totalTtcCents,
        totalCostCents: calc.totalCostCents,
        marginCents: calc.marginCents,
        paidCents: effectivePaidOnInvoiceCents,
        remainingDueCents,
        amountReceivedCents,
        changeGivenCents,
        paymentMethodSummary: input.paymentMethod,
        cancelReason: '',
        cancelledAt: null,
        notes: input.notes ?? '',
        isDemo: false,
        createdAt: now,
        updatedAt: now,
      };

      await targetDb.sales.add(sale);

      const saleItems: SaleItem[] = [];
      const invoiceItems: InvoiceItem[] = [];
      const stockMovements: StockMovement[] = [];

      for (const line of calc.lines) {
        const sItem: SaleItem = {
          id: generateId(),
          saleId,
          productId: line.productId,
          productRef: line.productRef,
          productName: line.productName,
          quantity: line.quantity,
          returnedQty: 0,
          unitCostCents: line.unitCostCents,
          unitPriceHtCents: line.unitPriceHtCents,
          discountPercent: line.discountPercent,
          vatRate: line.vatRate,
          lineGrossHtCents: line.lineGrossHtCents,
          lineDiscountCents: line.lineDiscountCents,
          lineSubtotalHtCents: line.lineSubtotalHtCents,
          lineGlobalDiscountShareCents: line.lineGlobalDiscountShareCents,
          lineTaxableCents: line.lineTaxableCents,
          lineVatCents: line.lineVatCents,
          lineTtcCents: line.lineTtcCents,
        };
        saleItems.push(sItem);

        const invItem: InvoiceItem = {
          id: generateId(),
          invoiceId,
          productId: line.productId,
          productRef: line.productRef,
          productName: line.productName,
          quantity: line.quantity,
          unitPriceHtCents: line.unitPriceHtCents,
          discountPercent: line.discountPercent,
          vatRate: line.vatRate,
          lineSubtotalHtCents: line.lineSubtotalHtCents,
          lineTaxableCents: line.lineTaxableCents,
          lineVatCents: line.lineVatCents,
          lineTtcCents: line.lineTtcCents,
        };
        invoiceItems.push(invItem);

        // Mise à jour du stock et création du mouvement (Section 56 : stockBefore + movement = stockAfter)
        const product = await targetDb.products.get(line.productId);
        if (!product) throw new Error('Produit disparu pendant la transaction.');
        const stockBefore = product.stock;
        const movementQty = -Math.abs(line.quantity);
        const stockAfter = stockBefore + movementQty;

        await targetDb.products.update(product.id, {
          stock: stockAfter,
          updatedAt: now,
        });

        const mv: StockMovement = {
          id: generateId(),
          date: now,
          businessDate,
          productId: product.id,
          productRef: product.reference,
          productName: product.name,
          quantity: movementQty,
          stockBefore,
          stockAfter,
          type: 'SALE',
          sourceDocType: 'SALE',
          sourceDocId: saleId,
          sourceDocNumber: saleNumber,
          reason: `Vente ${saleNumber} (${customer.name})`,
          userId: actor.userId,
          userName: actor.userName,
          status: 'ACTIVE',
          createdAt: now,
        };
        stockMovements.push(mv);
      }

      await targetDb.saleItems.bulkAdd(saleItems);
      await targetDb.stockMovements.bulkAdd(stockMovements);

      // 6. Création Facture liée (Règle 3 & Règle 5)
      const invoiceStatus = computeInvoiceStatus(
        calc.totalTtcCents,
        effectivePaidOnInvoiceCents,
        false
      );

      const invoice: Invoice = {
        id: invoiceId,
        number: invoiceNumber,
        type: 'INVOICE',
        saleId,
        quoteId: input.quoteId ?? null,
        parentInvoiceId: null,
        customerId: customer.id,
        customerName: customer.name,
        customerIce: customer.ice,
        businessDate,
        dueDate: addDaysToBusinessDate(businessDate, 30),
        status: invoiceStatus,
        subtotalHtCents: calc.subtotalHtCents,
        lineDiscountTotalCents: calc.lineDiscountTotalCents,
        globalDiscountPercent: calc.globalDiscountPercent,
        globalDiscountCents: calc.globalDiscountCents,
        totalTaxableCents: calc.totalTaxableCents,
        totalVatCents: calc.totalVatCents,
        totalTtcCents: calc.totalTtcCents,
        paidCents: effectivePaidOnInvoiceCents,
        remainingDueCents,
        cancelReason: '',
        notes: input.notes ?? '',
        isDemo: false,
        createdAt: now,
        updatedAt: now,
      };

      await targetDb.invoices.add(invoice);
      await targetDb.invoiceItems.bulkAdd(invoiceItems);

      // Test d'échec transactionnel forcé (Règle 22)
      if (input.simulateMidTransactionFailure) {
        throw new ArbitrageError(
          buildArbitrageDecision(
            'RULE_22_ATOMIC_MUTATION_ROLLBACK',
            false,
            'Simulation erreur critique en milieu de transaction : Rollback intégral Vente + Stock + Facture déclenché.'
          )
        );
      }

      // 7. Enregistrement du Paiement & Caisse (Règle 4)
      const createdPayments: Payment[] = [];
      if (effectivePaidOnInvoiceCents > 0 && input.paymentMethod !== 'CREDIT') {
        const payNumber = await nextDocumentNumberInTx(targetDb, 'payment', businessDate);
        const destination = resolvePaymentDestination(input.paymentMethod);

        const payment: Payment = {
          id: generateId(),
          number: payNumber,
          businessDate,
          direction: 'IN',
          targetType: 'INVOICE',
          targetId: invoiceId,
          targetNumber: invoiceNumber,
          partyId: customer.id,
          partyName: customer.name,
          amountCents: effectivePaidOnInvoiceCents,
          method: input.paymentMethod,
          destination,
          reference: input.paymentReference ?? saleNumber,
          status: 'VALIDATED',
          reversedByPaymentId: null,
          reversalOfPaymentId: null,
          notes: `Règlement vente ${saleNumber} / facture ${invoiceNumber}`,
          userId: actor.userId,
          isDemo: false,
          createdAt: now,
        };
        await targetDb.payments.add(payment);
        createdPayments.push(payment);

        // Règle 4 : Uniquement les espèces entrent dans la caisse physique
        if (input.paymentMethod === 'CASH') {
          const cashEntry: CashEntry = {
            id: generateId(),
            businessDate,
            direction: 'IN',
            type: 'SALE_CASH',
            amountCents: effectivePaidOnInvoiceCents,
            sourceId: payment.id,
            sourceNumber: payNumber,
            description: `Encaissement espèces ${saleNumber} (${customer.name})`,
            auditId: null,
            isLockedByAudit: false,
            userId: actor.userId,
            createdAt: now,
          };
          await targetDb.cashEntries.add(cashEntry);
        }
      }

      // Gestion du trop-perçu autorisé en avoir/crédit client (Règle 19)
      if (overpaymentCreditCents > 0 && input.paymentMethod !== 'CREDIT') {
        const creditPayNumber = await nextDocumentNumberInTx(targetDb, 'payment', businessDate);
        const destination = resolvePaymentDestination(input.paymentMethod);
        const creditPayment: Payment = {
          id: generateId(),
          number: creditPayNumber,
          businessDate,
          direction: 'IN',
          targetType: 'OVERPAYMENT_CREDIT',
          targetId: invoiceId,
          targetNumber: invoiceNumber,
          partyId: customer.id,
          partyName: customer.name,
          amountCents: overpaymentCreditCents,
          method: input.paymentMethod,
          destination,
          reference: input.paymentReference ?? saleNumber,
          status: 'VALIDATED',
          reversedByPaymentId: null,
          reversalOfPaymentId: null,
          notes: `Trop-perçu converti en crédit client sur ${invoiceNumber}`,
          userId: actor.userId,
          isDemo: false,
          createdAt: now,
        };
        await targetDb.payments.add(creditPayment);
        createdPayments.push(creditPayment);

        if (input.paymentMethod === 'CASH') {
          await targetDb.cashEntries.add({
            id: generateId(),
            businessDate,
            direction: 'IN',
            type: 'SALE_CASH',
            amountCents: overpaymentCreditCents,
            sourceId: creditPayment.id,
            sourceNumber: creditPayNumber,
            description: `Trop-perçu espèces (avoir client) ${saleNumber}`,
            auditId: null,
            isLockedByAudit: false,
            userId: actor.userId,
            createdAt: now,
          });
        }

        await recordAuditLogInTx(targetDb, {
          ...actor,
          action: 'OVERPAYMENT_CREDIT_CREATED',
          entityType: 'CUSTOMER',
          entityId: customer.id,
          summary: `Trop-perçu de ${(overpaymentCreditCents / 100).toFixed(2)} MAD enregistré en crédit client sur ${invoiceNumber}.`,
          contradictionArbitrated: 'RULE_19_OVERPAYMENT_ARBITRAGE',
          businessDate,
        });
      }

      // 8. Mise à jour du solde client (Créance + Crédit disponible)
      await targetDb.customers.update(customer.id, {
        balanceCents: customer.balanceCents + remainingDueCents,
        creditAvailableCents: customer.creditAvailableCents + overpaymentCreditCents,
        updatedAt: now,
      });

      // 9. Journal d'audit de stock négatif si applicable (Règle 1)
      if (negativeStockDecisions.length > 0) {
        await recordAuditLogInTx(targetDb, {
          ...actor,
          action: 'SALE_NEGATIVE_STOCK_AUTHORIZED',
          entityType: 'SALE',
          entityId: saleId,
          summary: negativeStockDecisions.join(' | '),
          contradictionArbitrated: 'RULE_01_NEGATIVE_STOCK_AUTHORIZED',
          businessDate,
        });
      }

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'SALE_CREATED',
        entityType: 'SALE',
        entityId: saleId,
        summary: `Vente ${saleNumber} validée (${(calc.totalTtcCents / 100).toFixed(2)} MAD TTC) — Facture ${invoiceNumber}`,
        businessDate,
      });

      return {
        sale,
        invoice,
        payments: createdPayments,
        stockMovements,
      };
    });
  });
}

/**
 * RÈGLE 2 : Annulation d'une vente déjà payée
 * Conserve la vente, conserve le paiement, génère l'opération financière inverse,
 * restitue le stock, régularise la caisse et trace dans l'audit.
 */
export async function executeCancelSale(
  params: {
    saleId: string;
    reason: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<Sale> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      if (!params.reason.trim()) {
        throw new Error("Le motif d'annulation est obligatoire pour le journal d'audit.");
      }

      const sale = await targetDb.sales.get(params.saleId);
      if (!sale) throw new Error('Vente introuvable.');
      if (sale.status === 'CANCELLED') {
        throw new Error('Cette vente est déjà annulée.');
      }

      const saleItems = await targetDb.saleItems.where('saleId').equals(sale.id).toArray();

      // 1. Restitution du stock pour chaque ligne (quantité non encore retournée)
      for (const item of saleItems) {
        const qtyToRestore = Math.max(0, item.quantity - item.returnedQty);
        if (qtyToRestore > 0) {
          const product = await targetDb.products.get(item.productId);
          if (product) {
            const stockBefore = product.stock;
            const stockAfter = stockBefore + qtyToRestore;
            await targetDb.products.update(product.id, {
              stock: stockAfter,
              updatedAt: now,
            });

            await targetDb.stockMovements.add({
              id: generateId(),
              date: now,
              businessDate,
              productId: product.id,
              productRef: product.reference,
              productName: product.name,
              quantity: qtyToRestore,
              stockBefore,
              stockAfter,
              type: 'SALE_CANCEL',
              sourceDocType: 'SALE',
              sourceDocId: sale.id,
              sourceDocNumber: sale.number,
              reason: `Annulation vente ${sale.number} : ${params.reason}`,
              userId: actor.userId,
              userName: actor.userName,
              status: 'ACTIVE',
              createdAt: now,
            });
          }
        }
      }

      // 2. Annulation de la facture liée et contre-passation des paiements (Règle 2)
      if (sale.invoiceId) {
        const invoice = await targetDb.invoices.get(sale.invoiceId);
        if (invoice && invoice.status !== 'CANCELLED') {
          const activePayments = await targetDb.payments
            .where('targetId')
            .equals(invoice.id)
            .filter((p) => p.status === 'VALIDATED' && p.direction === 'IN')
            .toArray();

          for (const origPay of activePayments) {
            const revNumber = await nextDocumentNumberInTx(targetDb, 'payment', businessDate);
            const reversalId = generateId();

            const reversalPayment: Payment = {
              id: reversalId,
              number: revNumber,
              businessDate,
              direction: 'OUT',
              targetType: 'CUSTOMER_REFUND',
              targetId: invoice.id,
              targetNumber: invoice.number,
              partyId: sale.customerId,
              partyName: sale.customerName,
              amountCents: origPay.amountCents,
              method: origPay.method,
              destination: origPay.destination,
              reference: `ANNUL-${origPay.number}`,
              status: 'VALIDATED',
              reversedByPaymentId: null,
              reversalOfPaymentId: origPay.id,
              notes: `Contre-écriture annulation vente ${sale.number} (${params.reason})`,
              userId: actor.userId,
              isDemo: false,
              createdAt: now,
            };

            await targetDb.payments.add(reversalPayment);
            await targetDb.payments.update(origPay.id, {
              status: 'REVERSED',
              reversedByPaymentId: reversalId,
            });

            if (origPay.method === 'CASH') {
              await targetDb.cashEntries.add({
                id: generateId(),
                businessDate,
                direction: 'OUT',
                type: 'REFUND_CASH',
                amountCents: origPay.amountCents,
                sourceId: reversalId,
                sourceNumber: revNumber,
                description: `Sortie caisse contre-écriture annulation ${sale.number}`,
                auditId: null,
                isLockedByAudit: false,
                userId: actor.userId,
                createdAt: now,
              });
            }
          }

          await targetDb.invoices.update(invoice.id, {
            status: 'CANCELLED',
            remainingDueCents: 0,
            cancelReason: params.reason,
            updatedAt: now,
          });
        }
      }

      // 3. Régularisation de la créance client
      const customer = await targetDb.customers.get(sale.customerId);
      if (customer && sale.remainingDueCents > 0) {
        await targetDb.customers.update(customer.id, {
          balanceCents: Math.max(0, customer.balanceCents - sale.remainingDueCents),
          updatedAt: now,
        });
      }

      // 4. Mise à jour du statut de la vente (interdiction de suppression physique)
      await targetDb.sales.update(sale.id, {
        status: 'CANCELLED',
        remainingDueCents: 0,
        cancelReason: params.reason,
        cancelledAt: now,
        updatedAt: now,
      });

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'SALE_CANCELLED',
        entityType: 'SALE',
        entityId: sale.id,
        summary: `Annulation vente ${sale.number} avec contre-écriture financière et retour stock. Motif : ${params.reason}`,
        contradictionArbitrated: 'RULE_02_PAID_SALE_CANCELLATION',
        businessDate,
      });

      return (await targetDb.sales.get(sale.id))!;
    });
  });
}

/**
 * RÈGLE 12 : Retour client lié à la vente d'origine
 */
export async function executeCustomerReturn(
  params: {
    saleId: string;
    itemsToReturn: {
      saleItemId: string;
      returnQty: number;
      isDefective?: boolean;
      defectReason?: string;
    }[];
    refundMethod: 'CASH' | 'TRANSFER' | 'CREDIT_NOTE';
    reason: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<{ creditNote: Invoice; updatedSale: Sale }> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const sale = await targetDb.sales.get(params.saleId);
      if (!sale) throw new Error("Vente d'origine introuvable.");
      if (sale.status === 'CANCELLED') {
        throw new Error('Impossible de faire un retour sur une vente annulée.');
      }

      const saleItems = await targetDb.saleItems.where('saleId').equals(sale.id).toArray();
      const returnLineInputs: DocumentLineInput[] = [];

      for (const req of params.itemsToReturn) {
        if (req.returnQty <= 0) continue;
        const sItem = saleItems.find((i) => i.id === req.saleItemId);
        if (!sItem) throw new Error('Ligne de vente introuvable.');
        const maxReturnable = sItem.quantity - sItem.returnedQty;
        if (req.returnQty > maxReturnable) {
          throw new Error(
            `Quantité retournée (${req.returnQty}) supérieure à la quantité retournable (${maxReturnable}) pour ${sItem.productName}.`
          );
        }

        returnLineInputs.push({
          productId: sItem.productId,
          productRef: sItem.productRef,
          productName: sItem.productName,
          quantity: req.returnQty,
          unitCostCents: sItem.unitCostCents,
          unitPriceHtCents: sItem.unitPriceHtCents,
          discountPercent: sItem.discountPercent,
          vatRate: sItem.vatRate,
        });

        await targetDb.saleItems.update(sItem.id, {
          returnedQty: sItem.returnedQty + req.returnQty,
        });

        const product = await targetDb.products.get(sItem.productId);
        if (product) {
          if (req.isDefective) {
            // Le produit est constaté défectueux au retour client :
            // Il est isolé en QUARANTAINE pour ne pas être revendu par erreur
            const defNumber = await nextDocumentNumberInTx(
              targetDb,
              'defective' as any,
              businessDate
            );
            const defId = generateId();
            const defReason =
              req.defectReason?.trim() ||
              params.reason ||
              'Produit constaté défectueux lors du retour client';

            await targetDb.defectiveProducts.add({
              id: defId,
              number: defNumber,
              productId: product.id,
              productRef: product.reference,
              productName: product.name,
              quantity: req.returnQty,
              sourceType: 'CUSTOMER_RETURN',
              sourceDocType: 'SALE',
              sourceDocId: sale.id,
              sourceDocNumber: sale.number,
              customerId: sale.customerId,
              customerName: sale.customerName,
              defectReason: defReason,
              severity: 'MAJEUR',
              status: 'EN_QUARANTAINE',
              unitCostCents: sItem.unitCostCents ?? product.purchasePriceCents,
              totalCostCents:
                (sItem.unitCostCents ?? product.purchasePriceCents) * req.returnQty,
              reportedDate: businessDate,
              businessDate,
              reportedBy: actor.userName,
              isDemo: false,
              createdAt: now,
              updatedAt: now,
            });

            await targetDb.stockMovements.add({
              id: generateId(),
              date: now,
              businessDate,
              productId: product.id,
              productRef: product.reference,
              productName: product.name,
              quantity: req.returnQty,
              stockBefore: product.stock,
              stockAfter: product.stock,
              type: 'CUSTOMER_RETURN',
              sourceDocType: 'RETURN',
              sourceDocId: sale.id,
              sourceDocNumber: sale.number,
              reason: `Retour client défectueux (Quarantaine ${defNumber}) : ${defReason}`,
              userId: actor.userId,
              userName: actor.userName,
              status: 'ACTIVE',
              createdAt: now,
            });
          } else {
            // Restauration du stock standard vendable (Règle 12)
            const stockBefore = product.stock;
            const stockAfter = stockBefore + req.returnQty;
            await targetDb.products.update(product.id, {
              stock: stockAfter,
              updatedAt: now,
            });
            await targetDb.stockMovements.add({
              id: generateId(),
              date: now,
              businessDate,
              productId: product.id,
              productRef: product.reference,
              productName: product.name,
              quantity: req.returnQty,
              stockBefore,
              stockAfter,
              type: 'CUSTOMER_RETURN',
              sourceDocType: 'RETURN',
              sourceDocId: sale.id,
              sourceDocNumber: sale.number,
              reason: `Retour client sur vente ${sale.number} : ${params.reason}`,
              userId: actor.userId,
              userName: actor.userName,
              status: 'ACTIVE',
              createdAt: now,
            });
          }
        }
      }

      if (returnLineInputs.length === 0) {
        throw new Error('Aucun article sélectionné pour le retour.');
      }

      const returnCalc = calculateDocumentLinesAndTotals(
        returnLineInputs,
        sale.globalDiscountPercent
      );

      // Génération de l'avoir (Credit Note) lié à la vente et la facture d'origine
      const creditNoteNumber = await nextDocumentNumberInTx(targetDb, 'creditNote', businessDate);
      const creditNoteId = generateId();

      const customer = await targetDb.customers.get(sale.customerId);

      const creditNote: Invoice = {
        id: creditNoteId,
        number: creditNoteNumber,
        type: 'CREDIT_NOTE',
        saleId: sale.id,
        quoteId: sale.quoteId,
        parentInvoiceId: sale.invoiceId,
        customerId: sale.customerId,
        customerName: sale.customerName,
        customerIce: customer?.ice ?? '',
        businessDate,
        dueDate: businessDate,
        status: 'PAID',
        subtotalHtCents: returnCalc.subtotalHtCents,
        lineDiscountTotalCents: returnCalc.lineDiscountTotalCents,
        globalDiscountPercent: returnCalc.globalDiscountPercent,
        globalDiscountCents: returnCalc.globalDiscountCents,
        totalTaxableCents: returnCalc.totalTaxableCents,
        totalVatCents: returnCalc.totalVatCents,
        totalTtcCents: returnCalc.totalTtcCents,
        paidCents: returnCalc.totalTtcCents,
        remainingDueCents: 0,
        cancelReason: '',
        notes: `Avoir retour client sur vente ${sale.number} — ${params.reason}`,
        isDemo: false,
        createdAt: now,
        updatedAt: now,
      };

      await targetDb.invoices.add(creditNote);

      // Mise à jour du restant dû de la vente et facture d'origine ou remboursement
      const returnTtc = returnCalc.totalTtcCents;
      const reductionOnDue = Math.min(sale.remainingDueCents, returnTtc);
      const refundOrCreditExcess = Math.max(0, returnTtc - reductionOnDue);
      const newRemainingDue = Math.max(0, sale.remainingDueCents - reductionOnDue);

      const updatedSaleItems = await targetDb.saleItems.where('saleId').equals(sale.id).toArray();
      const allReturned = updatedSaleItems.every((i) => i.returnedQty >= i.quantity);

      await targetDb.sales.update(sale.id, {
        status: allReturned ? 'RETURNED' : 'PARTIAL_RETURN',
        remainingDueCents: newRemainingDue,
        updatedAt: now,
      });

      if (sale.invoiceId) {
        const origInv = await targetDb.invoices.get(sale.invoiceId);
        if (origInv) {
          const newInvTotal = Math.max(0, origInv.totalTtcCents - returnTtc);
          const newInvStatus = computeInvoiceStatus(newInvTotal, origInv.paidCents, false);
          await targetDb.invoices.update(origInv.id, {
            remainingDueCents: newRemainingDue,
            status: newInvStatus,
            updatedAt: now,
          });
        }
      }

      if (refundOrCreditExcess > 0) {
        if (params.refundMethod === 'CASH' || params.refundMethod === 'TRANSFER') {
          const payNum = await nextDocumentNumberInTx(targetDb, 'payment', businessDate);
          const payId = generateId();
          await targetDb.payments.add({
            id: payId,
            number: payNum,
            businessDate,
            direction: 'OUT',
            targetType: 'CUSTOMER_REFUND',
            targetId: creditNoteId,
            targetNumber: creditNoteNumber,
            partyId: sale.customerId,
            partyName: sale.customerName,
            amountCents: refundOrCreditExcess,
            method: params.refundMethod,
            destination: resolvePaymentDestination(params.refundMethod),
            reference: creditNoteNumber,
            status: 'VALIDATED',
            reversedByPaymentId: null,
            reversalOfPaymentId: null,
            notes: `Remboursement retour client sur ${sale.number}`,
            userId: actor.userId,
            isDemo: false,
            createdAt: now,
          });

          if (params.refundMethod === 'CASH') {
            await targetDb.cashEntries.add({
              id: generateId(),
              businessDate,
              direction: 'OUT',
              type: 'REFUND_CASH',
              amountCents: refundOrCreditExcess,
              sourceId: payId,
              sourceNumber: payNum,
              description: `Remboursement espèces avoir ${creditNoteNumber}`,
              auditId: null,
              isLockedByAudit: false,
              userId: actor.userId,
              createdAt: now,
            });
          }
        } else if (customer) {
          await targetDb.customers.update(customer.id, {
            creditAvailableCents: customer.creditAvailableCents + refundOrCreditExcess,
            updatedAt: now,
          });
        }
      }

      if (customer && reductionOnDue > 0) {
        await targetDb.customers.update(customer.id, {
          balanceCents: Math.max(0, customer.balanceCents - reductionOnDue),
          updatedAt: now,
        });
      }

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'CUSTOMER_RETURN_PROCESSED',
        entityType: 'SALE',
        entityId: sale.id,
        summary: `Retour client enregistré sur ${sale.number} -> Avoir ${creditNoteNumber} (${(returnTtc / 100).toFixed(2)} MAD).`,
        contradictionArbitrated: 'RULE_12_LINKED_CUSTOMER_RETURN',
        businessDate,
      });

      return {
        creditNote,
        updatedSale: (await targetDb.sales.get(sale.id))!,
      };
    });
  });
}

/**
 * RÈGLES 3, 4 & 19 : Enregistrement d'un paiement sur facture
 */
export async function executeRecordInvoicePayment(
  params: {
    invoiceId: string;
    amountCents: number;
    method: Exclude<PaymentMethod, 'CREDIT'>;
    reference?: string;
    notes?: string;
    businessDate?: string;
    confirmOverpayment?: boolean;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<{ payment: Payment; invoice: Invoice }> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = params.businessDate ?? getMoroccoBusinessDate(now);
      const settings = await targetDb.settings.get('default');
      const allowOverpayment = settings?.allowOverpayment ?? false;

      const invoice = await targetDb.invoices.get(params.invoiceId);
      if (!invoice) throw new Error('Facture introuvable.');
      if (invoice.status === 'CANCELLED') {
        throw new Error("Impossible d'enregistrer un paiement sur une facture annulée.");
      }
      if (invoice.remainingDueCents <= 0) {
        throw new Error('Cette facture est déjà intégralement payée.');
      }

      const decision = arbitratePaymentAmount({
        documentNumber: invoice.number,
        remainingDueCents: invoice.remainingDueCents,
        paymentAmountCents: params.amountCents,
        allowOverpayment,
        confirmedOverpayment: params.confirmOverpayment,
      });

      if (!decision.allowed) {
        throw new ArbitrageError(decision);
      }

      const appliedToInvoiceCents = Math.min(invoice.remainingDueCents, params.amountCents);
      const excessCreditCents = Math.max(0, params.amountCents - invoice.remainingDueCents);

      const payNumber = await nextDocumentNumberInTx(targetDb, 'payment', businessDate);
      const destination = resolvePaymentDestination(params.method);
      const paymentId = generateId();

      const payment: Payment = {
        id: paymentId,
        number: payNumber,
        businessDate,
        direction: 'IN',
        targetType: 'INVOICE',
        targetId: invoice.id,
        targetNumber: invoice.number,
        partyId: invoice.customerId,
        partyName: invoice.customerName,
        amountCents: appliedToInvoiceCents,
        method: params.method,
        destination,
        reference: params.reference ?? '',
        status: 'VALIDATED',
        reversedByPaymentId: null,
        reversalOfPaymentId: null,
        notes: params.notes ?? `Règlement sur facture ${invoice.number}`,
        userId: actor.userId,
        isDemo: false,
        createdAt: now,
      };

      await targetDb.payments.add(payment);

      // Règle 4 : Seul le paiement espèces alimente la caisse physique
      if (params.method === 'CASH') {
        await targetDb.cashEntries.add({
          id: generateId(),
          businessDate,
          direction: 'IN',
          type: 'INVOICE_CASH',
          amountCents: appliedToInvoiceCents + excessCreditCents,
          sourceId: paymentId,
          sourceNumber: payNumber,
          description: `Règlement espèces facture ${invoice.number} (${invoice.customerName})`,
          auditId: null,
          isLockedByAudit: false,
          userId: actor.userId,
          createdAt: now,
        });
      }

      if (excessCreditCents > 0) {
        const creditPayNum = await nextDocumentNumberInTx(targetDb, 'payment', businessDate);
        await targetDb.payments.add({
          id: generateId(),
          number: creditPayNum,
          businessDate,
          direction: 'IN',
          targetType: 'OVERPAYMENT_CREDIT',
          targetId: invoice.id,
          targetNumber: invoice.number,
          partyId: invoice.customerId,
          partyName: invoice.customerName,
          amountCents: excessCreditCents,
          method: params.method,
          destination,
          reference: params.reference ?? '',
          status: 'VALIDATED',
          reversedByPaymentId: null,
          reversalOfPaymentId: null,
          notes: `Trop-perçu converti en crédit client sur ${invoice.number}`,
          userId: actor.userId,
          isDemo: false,
          createdAt: now,
        });
      }

      const newPaidCents = invoice.paidCents + appliedToInvoiceCents;
      const newRemainingCents = Math.max(0, invoice.totalTtcCents - newPaidCents);
      const newStatus = computeInvoiceStatus(invoice.totalTtcCents, newPaidCents, false);

      await targetDb.invoices.update(invoice.id, {
        paidCents: newPaidCents,
        remainingDueCents: newRemainingCents,
        status: newStatus,
        updatedAt: now,
      });

      if (invoice.saleId) {
        await targetDb.sales.update(invoice.saleId, {
          paidCents: newPaidCents,
          remainingDueCents: newRemainingCents,
          updatedAt: now,
        });
      }

      const customer = await targetDb.customers.get(invoice.customerId);
      if (customer) {
        await targetDb.customers.update(customer.id, {
          balanceCents: Math.max(0, customer.balanceCents - appliedToInvoiceCents),
          creditAvailableCents: customer.creditAvailableCents + excessCreditCents,
          updatedAt: now,
        });
      }

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'INVOICE_PAYMENT_RECORDED',
        entityType: 'INVOICE',
        entityId: invoice.id,
        summary: `Paiement ${payNumber} de ${(params.amountCents / 100).toFixed(2)} MAD (${params.method}) sur ${invoice.number} -> Statut: ${newStatus}`,
        contradictionArbitrated:
          excessCreditCents > 0 ? 'RULE_19_OVERPAYMENT_ARBITRAGE' : 'RULE_03_INVOICE_STATUS_COMPUTED',
        businessDate,
      });

      return {
        payment,
        invoice: (await targetDb.invoices.get(invoice.id))!,
      };
    });
  });
}

/**
 * RÈGLE 5 : Devis et Stock
 * La création d'un devis ne modifie jamais le stock réel.
 * La conversion en vente crée le lien explicite Devis -> Vente -> Facture -> Paiement.
 */
export async function executeCreateQuote(
  params: {
    customerId: string;
    lines: DocumentLineInput[];
    globalDiscountPercent?: number;
    globalDiscountAmountCents?: number;
    validDays?: number;
    paymentTerms?: string;
    notes?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<Quote> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const customer = await targetDb.customers.get(params.customerId);
      if (!customer) throw new Error('Client introuvable.');
      if (!params.lines.length) throw new Error('Le devis doit contenir au moins une ligne.');

      const calc = calculateDocumentLinesAndTotals(
        params.lines,
        params.globalDiscountPercent ?? 0,
        params.globalDiscountAmountCents
      );
      const quoteNumber = await nextDocumentNumberInTx(targetDb, 'quote', businessDate);
      const quoteId = generateId();

      const quote: Quote = {
        id: quoteId,
        number: quoteNumber,
        customerId: customer.id,
        customerName: customer.name,
        businessDate,
        validUntil: addDaysToBusinessDate(businessDate, params.validDays ?? 30),
        status: 'BROUILLON',
        convertedSaleId: null,
        convertedInvoiceId: null,
        subtotalHtCents: calc.subtotalHtCents,
        lineDiscountTotalCents: calc.lineDiscountTotalCents,
        globalDiscountPercent: calc.globalDiscountPercent,
        globalDiscountCents: calc.globalDiscountCents,
        totalTaxableCents: calc.totalTaxableCents,
        totalVatCents: calc.totalVatCents,
        totalTtcCents: calc.totalTtcCents,
        paymentTerms: params.paymentTerms ?? 'Paiement à la commande / livraison',
        notes: params.notes ?? '',
        isDemo: false,
        createdAt: now,
        updatedAt: now,
      };

      const quoteItems: QuoteItem[] = calc.lines.map((l) => ({
        id: generateId(),
        quoteId,
        productId: l.productId,
        productRef: l.productRef,
        productName: l.productName,
        quantity: l.quantity,
        unitPriceHtCents: l.unitPriceHtCents,
        discountPercent: l.discountPercent,
        vatRate: l.vatRate,
        lineSubtotalHtCents: l.lineSubtotalHtCents,
        lineTaxableCents: l.lineTaxableCents,
        lineVatCents: l.lineVatCents,
        lineTtcCents: l.lineTtcCents,
      }));

      await targetDb.quotes.add(quote);
      await targetDb.quoteItems.bulkAdd(quoteItems);

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'QUOTE_CREATED',
        entityType: 'QUOTE',
        entityId: quoteId,
        summary: `Devis ${quoteNumber} créé (${(calc.totalTtcCents / 100).toFixed(2)} MAD TTC) sans impact sur le stock physique.`,
        contradictionArbitrated: 'RULE_05_QUOTE_NO_STOCK_IMPACT',
        businessDate,
      });

      return quote;
    });
  });
}

export async function executeConvertQuoteToSale(
  params: {
    quoteId: string;
    paymentMethod: PaymentMethod;
    amountPaidCents: number;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<CreateSaleResult> {
  const quote = await targetDb.quotes.get(params.quoteId);
  if (!quote) throw new Error('Devis introuvable.');
  if (quote.convertedSaleId) {
    throw new Error('Ce devis a déjà été converti en vente.');
  }
  if (quote.status === 'ANNULE' || quote.status === 'REFUSE') {
    throw new Error('Impossible de convertir un devis annulé ou refusé.');
  }

  const qItems = await targetDb.quoteItems.where('quoteId').equals(quote.id).toArray();
  const lines: DocumentLineInput[] = qItems.map((qi) => ({
    productId: qi.productId,
    productRef: qi.productRef,
    productName: qi.productName,
    quantity: qi.quantity,
    unitPriceHtCents: qi.unitPriceHtCents,
    discountPercent: qi.discountPercent,
    vatRate: qi.vatRate,
  }));

  const saleResult = await executeCreateSale(
    {
      customerId: quote.customerId,
      quoteId: quote.id,
      lines,
      globalDiscountPercent: quote.globalDiscountPercent,
      globalDiscountAmountCents:
        quote.globalDiscountCents > 0 ? quote.globalDiscountCents : undefined,
      paymentMethod: params.paymentMethod,
      amountPaidCents: params.amountPaidCents,
      notes: `Conversion du devis ${quote.number}`,
      actor: params.actor,
    },
    targetDb
  );

  await targetDb.quotes.update(quote.id, {
    status: 'ACCEPTE',
    convertedSaleId: saleResult.sale.id,
    convertedInvoiceId: saleResult.invoice.id,
    updatedAt: new Date().toISOString(),
  });

  return saleResult;
}

/**
 * RÈGLE 6 : Achat et Stock
 * La création d'un bon de commande n'augmente jamais le stock.
 * Seule la réception effective (partielle ou complète) génère les mouvements de stock.
 */
export async function executeCreatePurchaseOrder(
  params: {
    supplierId: string;
    lines: DocumentLineInput[];
    globalDiscountPercent?: number;
    notes?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<Purchase> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const supplier = await targetDb.suppliers.get(params.supplierId);
      if (!supplier) throw new Error('Fournisseur introuvable.');
      if (!params.lines.length) throw new Error("L'achat doit contenir au moins une ligne.");

      const calc = calculateDocumentLinesAndTotals(
        params.lines,
        params.globalDiscountPercent ?? 0
      );
      const purchaseNumber = await nextDocumentNumberInTx(targetDb, 'purchase', businessDate);
      const purchaseId = generateId();

      const purchase: Purchase = {
        id: purchaseId,
        number: purchaseNumber,
        supplierId: supplier.id,
        supplierName: supplier.name,
        businessDate,
        status: 'COMMANDE',
        subtotalHtCents: calc.subtotalHtCents,
        globalDiscountPercent: calc.globalDiscountPercent,
        globalDiscountCents: calc.globalDiscountCents,
        totalTaxableCents: calc.totalTaxableCents,
        totalVatCents: calc.totalVatCents,
        totalTtcCents: calc.totalTtcCents,
        paidCents: 0,
        remainingDueCents: calc.totalTtcCents,
        notes: params.notes ?? '',
        createdBy: actor.userName,
        isDemo: false,
        createdAt: now,
        updatedAt: now,
      };

      const pItems: PurchaseItem[] = calc.lines.map((l) => ({
        id: generateId(),
        purchaseId,
        productId: l.productId,
        productRef: l.productRef,
        productName: l.productName,
        orderedQty: l.quantity,
        receivedQty: 0,
        unitPriceHtCents: l.unitPriceHtCents,
        discountPercent: l.discountPercent,
        vatRate: l.vatRate,
        lineSubtotalHtCents: l.lineSubtotalHtCents,
        lineTaxableCents: l.lineTaxableCents,
        lineVatCents: l.lineVatCents,
        lineTtcCents: l.lineTtcCents,
      }));

      await targetDb.purchases.add(purchase);
      await targetDb.purchaseItems.bulkAdd(pItems);

      // Mise à jour de la dette fournisseur
      await targetDb.suppliers.update(supplier.id, {
        totalPurchasesCents: supplier.totalPurchasesCents + calc.totalTtcCents,
        debtCents: supplier.debtCents + calc.totalTtcCents,
        updatedAt: now,
      });

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'PURCHASE_ORDER_CREATED',
        entityType: 'PURCHASE',
        entityId: purchaseId,
        summary: `Bon de commande ${purchaseNumber} créé (${(calc.totalTtcCents / 100).toFixed(2)} MAD TTC) — Stock inchangé avant réception.`,
        contradictionArbitrated: 'RULE_06_PURCHASE_STOCK_ON_RECEIPT_ONLY',
        businessDate,
      });

      return purchase;
    });
  });
}

export async function executeReceivePurchaseItems(
  params: {
    purchaseId: string;
    receptions: {
      purchaseItemId: string;
      receivedDeltaQty: number;
      defectiveQty?: number;
      defectReason?: string;
    }[];
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<Purchase> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const purchase = await targetDb.purchases.get(params.purchaseId);
      if (!purchase) throw new Error('Commande fournisseur introuvable.');
      if (purchase.status === 'ANNULE') {
        throw new Error('Impossible de réceptionner un achat annulé.');
      }
      if (purchase.status === 'RECU') {
        throw new Error('Cet achat a déjà été intégralement réceptionné.');
      }

      const items = await targetDb.purchaseItems.where('purchaseId').equals(purchase.id).toArray();
      let anyReceivedNow = false;

      for (const rec of params.receptions) {
        if (rec.receivedDeltaQty <= 0) continue;
        const pItem = items.find((i) => i.id === rec.purchaseItemId);
        if (!pItem) continue;
        const remainingToReceive = pItem.orderedQty - pItem.receivedQty;
        if (rec.receivedDeltaQty > remainingToReceive) {
          throw new Error(
            `Quantité reçue (${rec.receivedDeltaQty}) supérieure au reliquat attendu (${remainingToReceive}) pour ${pItem.productName}.`
          );
        }

        const newReceivedQty = pItem.receivedQty + rec.receivedDeltaQty;
        await targetDb.purchaseItems.update(pItem.id, {
          receivedQty: newReceivedQty,
        });
        pItem.receivedQty = newReceivedQty;
        anyReceivedNow = true;

        const defectiveQty = Math.max(
          0,
          Math.min(rec.receivedDeltaQty, Number(rec.defectiveQty) || 0)
        );
        const goodQty = rec.receivedDeltaQty - defectiveQty;

        const product = await targetDb.products.get(pItem.productId);
        if (product) {
          // 1. Entrée effective en stock vendable de la quantité saine
          if (goodQty > 0) {
            const stockBefore = product.stock;
            const stockAfter = stockBefore + goodQty;
            await targetDb.products.update(product.id, {
              stock: stockAfter,
              purchasePriceCents: pItem.unitPriceHtCents,
              updatedAt: now,
            });

            await targetDb.stockMovements.add({
              id: generateId(),
              date: now,
              businessDate,
              productId: product.id,
              productRef: product.reference,
              productName: product.name,
              quantity: goodQty,
              stockBefore,
              stockAfter,
              type: 'PURCHASE_RECEIPT',
              sourceDocType: 'PURCHASE',
              sourceDocId: purchase.id,
              sourceDocNumber: purchase.number,
              reason: `Réception conforme achat ${purchase.number}`,
              userId: actor.userId,
              userName: actor.userName,
              status: 'ACTIVE',
              createdAt: now,
            });
          }

          // 2. Traçabilité des produits constatés défectueux à la réception
          if (defectiveQty > 0) {
            const defNumber = await nextDocumentNumberInTx(
              targetDb,
              'defective' as any,
              businessDate
            );
            const defId = generateId();
            const defectReason =
              rec.defectReason?.trim() ||
              'Produit constaté défectueux ou endommagé lors de la livraison commande fournisseur';

            await targetDb.defectiveProducts.add({
              id: defId,
              number: defNumber,
              productId: product.id,
              productRef: product.reference,
              productName: product.name,
              quantity: defectiveQty,
              sourceType: 'PURCHASE_RECEIPT',
              sourceDocType: 'PURCHASE',
              sourceDocId: purchase.id,
              sourceDocNumber: purchase.number,
              supplierId: purchase.supplierId,
              supplierName: purchase.supplierName,
              defectReason,
              severity: 'MAJEUR',
              status: 'EN_QUARANTAINE',
              unitCostCents: pItem.unitPriceHtCents,
              totalCostCents: pItem.unitPriceHtCents * defectiveQty,
              reportedDate: businessDate,
              businessDate,
              reportedBy: actor.userName,
              isDemo: false,
              createdAt: now,
              updatedAt: now,
            });

            await targetDb.stockMovements.add({
              id: generateId(),
              date: now,
              businessDate,
              productId: product.id,
              productRef: product.reference,
              productName: product.name,
              quantity: defectiveQty,
              stockBefore: product.stock,
              stockAfter: product.stock,
              type: 'PURCHASE_RECEIPT',
              sourceDocType: 'PURCHASE',
              sourceDocId: purchase.id,
              sourceDocNumber: purchase.number,
              reason: `Réception défectueuse isolée en Quarantaine (${defNumber}) : ${defectReason}`,
              userId: actor.userId,
              userName: actor.userName,
              status: 'ACTIVE',
              createdAt: now,
            });

            await recordAuditLogInTx(targetDb, {
              ...actor,
              action: 'DEFECTIVE_PRODUCT_LOGGED_ON_RECEIPT',
              entityType: 'PRODUCT',
              entityId: product.id,
              summary: `${defectiveQty} unité(s) de ${product.name} constatée(s) défectueuse(s) sur ${purchase.number} -> Fiche Quarantaine ${defNumber}`,
              businessDate,
            });
          }
        }
      }

      if (!anyReceivedNow) {
        throw new Error('Aucune quantité de réception saisie.');
      }

      const allFullyReceived = items.every((i) => i.receivedQty >= i.orderedQty);
      const newStatus = allFullyReceived ? 'RECU' : 'PARTIELLEMENT_RECU';

      await targetDb.purchases.update(purchase.id, {
        status: newStatus,
        updatedAt: now,
      });

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'PURCHASE_RECEIVED',
        entityType: 'PURCHASE',
        entityId: purchase.id,
        summary: `Réception sur commande ${purchase.number} -> Statut : ${newStatus}`,
        contradictionArbitrated: 'RULE_06_PURCHASE_STOCK_ON_RECEIPT_ONLY',
        businessDate,
      });

      return (await targetDb.purchases.get(purchase.id))!;
    });
  });
}

export async function executeRecordSupplierPayment(
  params: {
    purchaseId: string;
    amountCents: number;
    method: Exclude<PaymentMethod, 'CREDIT' | 'CREDIT_NOTE'>;
    reference?: string;
    notes?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<Purchase> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const purchase = await targetDb.purchases.get(params.purchaseId);
      if (!purchase) throw new Error('Achat introuvable.');
      if (params.amountCents <= 0 || params.amountCents > purchase.remainingDueCents) {
        throw new Error(
          `Montant de paiement invalide. Reste à payer fournisseur : ${(purchase.remainingDueCents / 100).toFixed(2)} MAD.`
        );
      }

      const payNumber = await nextDocumentNumberInTx(targetDb, 'payment', businessDate);
      const payId = generateId();
      const destination = resolvePaymentDestination(params.method);

      await targetDb.payments.add({
        id: payId,
        number: payNumber,
        businessDate,
        direction: 'OUT',
        targetType: 'PURCHASE',
        targetId: purchase.id,
        targetNumber: purchase.number,
        partyId: purchase.supplierId,
        partyName: purchase.supplierName,
        amountCents: params.amountCents,
        method: params.method,
        destination,
        reference: params.reference ?? '',
        status: 'VALIDATED',
        reversedByPaymentId: null,
        reversalOfPaymentId: null,
        notes: params.notes ?? `Paiement fournisseur sur ${purchase.number}`,
        userId: actor.userId,
        isDemo: false,
        createdAt: now,
      });

      if (params.method === 'CASH') {
        await targetDb.cashEntries.add({
          id: generateId(),
          businessDate,
          direction: 'OUT',
          type: 'SUPPLIER_CASH',
          amountCents: params.amountCents,
          sourceId: payId,
          sourceNumber: payNumber,
          description: `Paiement fournisseur espèces ${purchase.number} (${purchase.supplierName})`,
          auditId: null,
          isLockedByAudit: false,
          userId: actor.userId,
          createdAt: now,
        });
      }

      const newPaid = purchase.paidCents + params.amountCents;
      const newRemaining = Math.max(0, purchase.totalTtcCents - newPaid);

      await targetDb.purchases.update(purchase.id, {
        paidCents: newPaid,
        remainingDueCents: newRemaining,
        updatedAt: now,
      });

      const supplier = await targetDb.suppliers.get(purchase.supplierId);
      if (supplier) {
        await targetDb.suppliers.update(supplier.id, {
          debtCents: Math.max(0, supplier.debtCents - params.amountCents),
          updatedAt: now,
        });
      }

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'SUPPLIER_PAYMENT_RECORDED',
        entityType: 'PURCHASE',
        entityId: purchase.id,
        summary: `Paiement fournisseur ${payNumber} de ${(params.amountCents / 100).toFixed(2)} MAD sur ${purchase.number}`,
        businessDate,
      });

      return (await targetDb.purchases.get(purchase.id))!;
    });
  });
}

/**
 * 1. Supprimer une commande fournisseur AVANT réception et paiement
 */
export async function executeDeletePurchaseBeforeReceiptAndPayment(
  params: {
    purchaseId: string;
    reason?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<{ deletedNumber: string }> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const purchase = await targetDb.purchases.get(params.purchaseId);
      if (!purchase) throw new Error('Commande fournisseur introuvable.');

      const items = await targetDb.purchaseItems.where('purchaseId').equals(purchase.id).toArray();
      const totalReceivedQty = items.reduce((acc, i) => acc + i.receivedQty, 0);

      if (totalReceivedQty > 0) {
        throw new Error(
          `Impossible de supprimer la commande ${purchase.number} : des marchandises ont été réceptionnées (${totalReceivedQty} unité(s)). Veuillez d'abord annuler l'intégration au stock.`
        );
      }

      if (purchase.paidCents > 0) {
        throw new Error(
          `Impossible de supprimer la commande ${purchase.number} : un paiement de ${(purchase.paidCents / 100).toFixed(2)} MAD est enregistré. Veuillez d'abord annuler le paiement via PV et dépense.`
        );
      }

      if (purchase.status !== 'ANNULE') {
        const supplier = await targetDb.suppliers.get(purchase.supplierId);
        if (supplier) {
          await targetDb.suppliers.update(supplier.id, {
            debtCents: Math.max(0, supplier.debtCents - purchase.remainingDueCents),
            totalPurchasesCents: Math.max(0, supplier.totalPurchasesCents - purchase.totalTtcCents),
            updatedAt: now,
          });
        }
      }

      await targetDb.purchaseItems.where('purchaseId').equals(purchase.id).delete();
      await targetDb.purchases.delete(purchase.id);

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'PURCHASE_DELETED_BEFORE_RECEIPT_AND_PAYMENT',
        entityType: 'PURCHASE',
        entityId: purchase.id,
        summary: `Commande fournisseur ${purchase.number} supprimée avant réception et paiement.${
          params.reason ? ` Motif : ${params.reason}` : ''
        }`,
        businessDate,
      });

      return { deletedNumber: purchase.number };
    });
  });
}

/**
 * 2. Annuler l'intégration au stock de la commande APRÈS réception
 */
export async function executeCancelPurchaseStockReception(
  params: {
    purchaseId: string;
    reason?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<Purchase> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const purchase = await targetDb.purchases.get(params.purchaseId);
      if (!purchase) throw new Error('Commande fournisseur introuvable.');

      const items = await targetDb.purchaseItems.where('purchaseId').equals(purchase.id).toArray();
      const receivedItems = items.filter((i) => i.receivedQty > 0);

      if (receivedItems.length === 0) {
        throw new Error(
          `Aucune quantité réceptionnée en stock à annuler sur la commande ${purchase.number}.`
        );
      }

      let totalReversedQty = 0;

      for (const pItem of receivedItems) {
        const qtyToReverse = pItem.receivedQty;
        totalReversedQty += qtyToReverse;

        const product = await targetDb.products.get(pItem.productId);
        if (product) {
          const stockBefore = product.stock;
          const stockAfter = stockBefore - qtyToReverse;
          await targetDb.products.update(product.id, {
            stock: stockAfter,
            updatedAt: now,
          });

          await targetDb.stockMovements.add({
            id: generateId(),
            date: now,
            businessDate,
            productId: product.id,
            productRef: product.reference,
            productName: product.name,
            quantity: -qtyToReverse,
            stockBefore,
            stockAfter,
            type: 'MANUAL_ADJUST',
            sourceDocType: 'PURCHASE',
            sourceDocId: purchase.id,
            sourceDocNumber: purchase.number,
            reason: `Annulation intégration au stock réception commande ${purchase.number}${
              params.reason ? ` — ${params.reason}` : ''
            }`,
            userId: actor.userId,
            userName: actor.userName,
            status: 'ACTIVE',
            createdAt: now,
          });
        }

        await targetDb.purchaseItems.update(pItem.id, {
          receivedQty: 0,
        });
      }

      // Marquer les mouvements d'entrée initiaux de cette commande comme annulés
      const prevReceiptMovements = await targetDb.stockMovements
        .where('sourceDocId')
        .equals(purchase.id)
        .filter((m) => m.type === 'PURCHASE_RECEIPT' && m.status === 'ACTIVE')
        .toArray();

      for (const mv of prevReceiptMovements) {
        await targetDb.stockMovements.update(mv.id, { status: 'CANCELLED' });
      }

      await targetDb.purchases.update(purchase.id, {
        status: 'COMMANDE',
        updatedAt: now,
      });

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'PURCHASE_STOCK_RECEPTION_CANCELLED',
        entityType: 'PURCHASE',
        entityId: purchase.id,
        summary: `Annulation de l'intégration au stock sur commande ${purchase.number} (-${totalReversedQty} unité(s) retirée(s) du stock). Commande remise à l'état COMMANDE.${
          params.reason ? ` Motif : ${params.reason}` : ''
        }`,
        contradictionArbitrated: 'RULE_06_PURCHASE_STOCK_ON_RECEIPT_ONLY',
        businessDate,
      });

      return (await targetDb.purchases.get(purchase.id))!;
    });
  });
}

/**
 * 3. Annuler le paiement d'une commande fournisseur via PV et Dépense
 */
export async function executeCancelPurchasePaymentViaPvAndExpense(
  params: {
    purchaseId: string;
    reason?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<{
  purchase: Purchase;
  pvAudit: CashAudit;
  expense: Expense;
  paymentMethod: string;
  canceledAmountCents: number;
}> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const purchase = await targetDb.purchases.get(params.purchaseId);
      if (!purchase) throw new Error('Commande fournisseur introuvable.');
      if (purchase.paidCents <= 0) {
        throw new Error(`Aucun paiement actif à annuler sur la commande ${purchase.number}.`);
      }

      const canceledAmountCents = purchase.paidCents;
      const reasonText =
        params.reason?.trim() || `Annulation règlement fournisseur sur commande ${purchase.number}`;

      const activePayments = await targetDb.payments
        .where('targetId')
        .equals(purchase.id)
        .filter((p) => p.targetType === 'PURCHASE' && p.status === 'VALIDATED')
        .toArray();

      let detectedMethod: 'CASH' | 'CARD' | 'TRANSFER' | 'CHECK' = 'TRANSFER';
      let cashAmountToRestoreCents = 0;

      for (const origPay of activePayments) {
        if (
          origPay.method === 'CASH' ||
          origPay.method === 'CARD' ||
          origPay.method === 'TRANSFER' ||
          origPay.method === 'CHECK'
        ) {
          detectedMethod = origPay.method;
        }
        if (origPay.method === 'CASH') {
          cashAmountToRestoreCents += origPay.amountCents;
        }
        await targetDb.payments.update(origPay.id, {
          status: 'REVERSED',
          notes: `${origPay.notes} [ANNULÉ VIA PV & DÉPENSE : ${reasonText}]`,
        });
      }

      // 1. Génération du PV d'annulation de paiement
      const pvNumber = await nextDocumentNumberInTx(targetDb, 'cashAudit', businessDate);
      const pvId = generateId();

      // Si le paiement annulé était en espèces, réintégrer le montant dans la caisse physique
      if (cashAmountToRestoreCents > 0) {
        await targetDb.cashEntries.add({
          id: generateId(),
          businessDate,
          direction: 'IN',
          type: 'CORRECTION',
          amountCents: cashAmountToRestoreCents,
          sourceId: pvId,
          sourceNumber: pvNumber,
          description: `PV ${pvNumber} — Annulation paiement espèces commande ${purchase.number} (${purchase.supplierName})`,
          auditId: null,
          isLockedByAudit: false,
          userId: actor.userId,
          createdAt: now,
        });
      }

      const allCashEntries = await targetDb.cashEntries.toArray();
      const currentTheoCashCents = allCashEntries.reduce(
        (acc, e) => acc + (e.direction === 'IN' ? e.amountCents : -e.amountCents),
        0
      );

      // 2. Génération de la pièce de Dépense / Régularisation liée au PV
      const expNumber = await nextDocumentNumberInTx(targetDb, 'expense', businessDate);
      const expId = generateId();
      const amountHtCents = Math.round(canceledAmountCents / 1.2);
      const amountVatCents = canceledAmountCents - amountHtCents;

      const expense: Expense = {
        id: expId,
        number: expNumber,
        businessDate,
        category: 'DIVERS',
        label: `Annulation paiement commande ${purchase.number} via PV ${pvNumber} (${reasonText})`,
        beneficiary: purchase.supplierName,
        amountHtCents,
        vatRate: 20,
        amountVatCents,
        amountTtcCents: canceledAmountCents,
        paymentMethod: detectedMethod,
        receiptRef: pvNumber,
        notes: `Contre-passation règlement achat ${purchase.number} — Motif : ${reasonText}`,
        status: 'CANCELLED',
        isDemo: false,
        createdAt: now,
      };

      await targetDb.expenses.add(expense);

      const pvAudit: CashAudit = {
        id: pvId,
        number: pvNumber,
        businessDate,
        counts: {},
        theoreticalBalanceCents: currentTheoCashCents,
        countedBalanceCents: currentTheoCashCents,
        varianceCents: 0,
        status: 'CONFORME',
        notes: `PV d'annulation du paiement de ${(canceledAmountCents / 100).toFixed(2)} MAD (${detectedMethod}) sur commande ${purchase.number} (${purchase.supplierName}) — Dépense liée : ${expNumber} — Motif : ${reasonText}`,
        userId: actor.userId,
        userName: actor.userName,
        createdAt: now,
      };

      await targetDb.cashAudits.add(pvAudit);

      // 3. Rétablissement du solde restant dû sur la commande et de la dette fournisseur
      await targetDb.purchases.update(purchase.id, {
        paidCents: 0,
        remainingDueCents: purchase.totalTtcCents,
        updatedAt: now,
      });

      const supplier = await targetDb.suppliers.get(purchase.supplierId);
      if (supplier && purchase.status !== 'ANNULE') {
        await targetDb.suppliers.update(supplier.id, {
          debtCents: supplier.debtCents + canceledAmountCents,
          updatedAt: now,
        });
      }

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'PURCHASE_PAYMENT_CANCELLED_VIA_PV_EXPENSE',
        entityType: 'PURCHASE',
        entityId: purchase.id,
        summary: `Annulation paiement de ${(canceledAmountCents / 100).toFixed(2)} MAD sur commande ${purchase.number} via PV ${pvNumber} et Dépense ${expNumber}. Motif : ${reasonText}`,
        contradictionArbitrated: 'RULE_08_PHYSICAL_DELETE_FORBIDDEN',
        businessDate,
      });

      return {
        purchase: (await targetDb.purchases.get(purchase.id))!,
        pvAudit,
        expense,
        paymentMethod: detectedMethod,
        canceledAmountCents,
      };
    });
  });
}

/**
 * 4. Annuler une Dépense via PV dans le module Finance & Dépenses
 */
export async function executeCancelExpenseViaPv(
  params: {
    expenseId: string;
    reason?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<{ expense: Expense; pvAudit: CashAudit }> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const expense = await targetDb.expenses.get(params.expenseId);
      if (!expense) throw new Error('Dépense introuvable.');
      if (expense.status === 'CANCELLED') {
        throw new Error('Cette dépense est déjà annulée.');
      }

      const reasonText = params.reason?.trim() || `Annulation dépense ${expense.number}`;
      const pvNumber = await nextDocumentNumberInTx(targetDb, 'cashAudit', businessDate);
      const pvId = generateId();

      if (expense.category === 'ALIMENTATION_CAISSE') {
        await targetDb.cashEntries.add({
          id: generateId(),
          businessDate,
          direction: 'OUT',
          type: 'CORRECTION',
          amountCents: expense.amountTtcCents,
          sourceId: pvId,
          sourceNumber: pvNumber,
          description: `PV ${pvNumber} — Annulation alimentation fond de caisse ${expense.number} (${expense.label})`,
          auditId: null,
          isLockedByAudit: false,
          userId: actor.userId,
          createdAt: now,
        });
      } else if (expense.paymentMethod === 'CASH') {
        await targetDb.cashEntries.add({
          id: generateId(),
          businessDate,
          direction: 'IN',
          type: 'CORRECTION',
          amountCents: expense.amountTtcCents,
          sourceId: pvId,
          sourceNumber: pvNumber,
          description: `PV ${pvNumber} — Annulation dépense espèces ${expense.number} (${expense.label})`,
          auditId: null,
          isLockedByAudit: false,
          userId: actor.userId,
          createdAt: now,
        });
      }

      const allCashEntries = await targetDb.cashEntries.toArray();
      const currentTheoCashCents = allCashEntries.reduce(
        (acc, e) => acc + (e.direction === 'IN' ? e.amountCents : -e.amountCents),
        0
      );

      const pvAudit: CashAudit = {
        id: pvId,
        number: pvNumber,
        businessDate,
        counts: {},
        theoreticalBalanceCents: currentTheoCashCents,
        countedBalanceCents: currentTheoCashCents,
        varianceCents: 0,
        status: 'CONFORME',
        notes: `PV d'annulation dépense ${expense.number} (${(expense.amountTtcCents / 100).toFixed(2)} MAD — ${expense.paymentMethod}) — Motif : ${reasonText}`,
        userId: actor.userId,
        userName: actor.userName,
        createdAt: now,
      };

      await targetDb.cashAudits.add(pvAudit);

      await targetDb.expenses.update(expense.id, {
        status: 'CANCELLED',
        receiptRef: pvNumber,
        notes: `${expense.notes ? expense.notes + ' · ' : ''}Annulée via ${pvNumber} (${reasonText})`,
      });

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'EXPENSE_CANCELLED_VIA_PV',
        entityType: 'EXPENSE',
        entityId: expense.id,
        summary: `Dépense ${expense.number} (${(expense.amountTtcCents / 100).toFixed(2)} MAD) annulée via PV ${pvNumber}. Motif : ${reasonText}`,
        contradictionArbitrated: 'RULE_08_PHYSICAL_DELETE_FORBIDDEN',
        businessDate,
      });

      return {
        expense: (await targetDb.expenses.get(expense.id))!,
        pvAudit,
      };
    });
  });
}

/**
 * RÈGLES 7 & 14 : Inventaire physique et génération explicite des écarts
 */
export async function executeCreateInventorySession(
  params: {
    mode: InventoryMode;
    scopeFilter?: string;
    notes?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<{ session: InventorySession; items: InventoryItem[] }> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      let products = await targetDb.products.filter((p) => p.active).toArray();
      if (params.mode === 'CATEGORIE' && params.scopeFilter) {
        products = products.filter(
          (p) => p.categoryId === params.scopeFilter || p.categoryName === params.scopeFilter
        );
      } else if (params.mode === 'EMPLACEMENT' && params.scopeFilter) {
        products = products.filter(
          (p) => p.location.toLowerCase() === params.scopeFilter!.toLowerCase()
        );
      }

      const invNumber = await nextDocumentNumberInTx(targetDb, 'inventory', businessDate);
      const invId = generateId();

      const items: InventoryItem[] = products.map((p) => {
        const theoVal = Math.round(p.stock * p.purchasePriceCents);
        return {
          id: generateId(),
          inventoryId: invId,
          productId: p.id,
          productRef: p.reference,
          productName: p.name,
          location: p.location,
          unitCostCents: p.purchasePriceCents,
          theoreticalQty: p.stock,
          countedQty: p.stock,
          varianceQty: 0,
          varianceValueCents: 0,
          adjustmentMovementId: null,
        };
      });

      const totalTheo = items.reduce(
        (acc, i) => acc + Math.round(i.theoreticalQty * i.unitCostCents),
        0
      );

      const session: InventorySession = {
        id: invId,
        number: invNumber,
        businessDate,
        mode: params.mode,
        scopeFilter: params.scopeFilter ?? 'Tous les produits actifs',
        status: 'COMPTAGE',
        totalTheoreticalValueCents: totalTheo,
        totalCountedValueCents: totalTheo,
        totalVarianceValueCents: 0,
        notes: params.notes ?? '',
        validatedBy: null,
        validatedAt: null,
        createdAt: now,
        updatedAt: now,
      };

      await targetDb.inventories.add(session);
      await targetDb.inventoryItems.bulkAdd(items);

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'INVENTORY_CREATED',
        entityType: 'INVENTORY',
        entityId: invId,
        summary: `Inventaire ${invNumber} ouvert (${items.length} articles capturés).`,
        businessDate,
      });

      return { session, items };
    });
  });
}

export async function executeUpdateInventoryCounts(
  params: {
    inventoryId: string;
    counts: { inventoryItemId: string; countedQty: number }[];
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<InventorySession> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const session = await targetDb.inventories.get(params.inventoryId);
      if (!session) throw new Error('Session inventaire introuvable.');
      if (session.status === 'VALIDE' || session.status === 'ANNULE') {
        throw new ArbitrageError(
          buildArbitrageDecision(
            'RULE_09_VALIDATED_DOC_IMMUTABLE',
            false,
            `Arbitrage Règle 9 : L'inventaire ${session.number} est déjà validé et ne peut plus être modifié.`
          )
        );
      }

      for (const c of params.counts) {
        const item = await targetDb.inventoryItems.get(c.inventoryItemId);
        if (!item) continue;
        const countedQty = Number(c.countedQty);
        const varianceQty = countedQty - item.theoreticalQty;
        const varianceValueCents = Math.round(varianceQty * item.unitCostCents);
        await targetDb.inventoryItems.update(item.id, {
          countedQty,
          varianceQty,
          varianceValueCents,
        });
      }

      const allItems = await targetDb.inventoryItems
        .where('inventoryId')
        .equals(session.id)
        .toArray();
      const totalTheo = allItems.reduce(
        (acc, i) => acc + Math.round(i.theoreticalQty * i.unitCostCents),
        0
      );
      const totalCounted = allItems.reduce(
        (acc, i) => acc + Math.round(i.countedQty * i.unitCostCents),
        0
      );
      const totalVar = allItems.reduce((acc, i) => acc + i.varianceValueCents, 0);

      await targetDb.inventories.update(session.id, {
        totalTheoreticalValueCents: totalTheo,
        totalCountedValueCents: totalCounted,
        totalVarianceValueCents: totalVar,
        updatedAt: new Date().toISOString(),
      });

      return (await targetDb.inventories.get(session.id))!;
    });
  });
}

export async function executeValidateInventorySession(
  params: {
    inventoryId: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<InventorySession> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const session = await targetDb.inventories.get(params.inventoryId);
      if (!session) throw new Error('Inventaire introuvable.');
      if (session.status === 'VALIDE') {
        throw new Error('Cet inventaire est déjà validé.');
      }

      const items = await targetDb.inventoryItems
        .where('inventoryId')
        .equals(session.id)
        .toArray();

      let hadNegativeStockAdjustment = false;

      for (const item of items) {
        const product = await targetDb.products.get(item.productId);
        if (!product) continue;

        const currentTheoretical = product.stock;
        const varianceQty = item.countedQty - currentTheoretical;
        const varianceValueCents = Math.round(varianceQty * item.unitCostCents);

        if (currentTheoretical < 0 && varianceQty !== 0) {
          hadNegativeStockAdjustment = true;
        }

        let movementId: string | null = null;
        if (varianceQty !== 0) {
          movementId = generateId();
          const stockBefore = currentTheoretical;
          const stockAfter = stockBefore + varianceQty;

          await targetDb.products.update(product.id, {
            stock: stockAfter,
            updatedAt: now,
          });

          await targetDb.stockMovements.add({
            id: movementId,
            date: now,
            businessDate,
            productId: product.id,
            productRef: product.reference,
            productName: product.name,
            quantity: varianceQty,
            stockBefore,
            stockAfter,
            type: 'INVENTORY_ADJUST',
            sourceDocType: 'INVENTORY',
            sourceDocId: session.id,
            sourceDocNumber: session.number,
            reason: `Régularisation écart inventaire ${session.number} (Théorique: ${stockBefore}, Compté: ${item.countedQty})`,
            userId: actor.userId,
            userName: actor.userName,
            status: 'ACTIVE',
            createdAt: now,
          });
        }

        await targetDb.inventoryItems.update(item.id, {
          theoreticalQty: currentTheoretical,
          varianceQty,
          varianceValueCents,
          adjustmentMovementId: movementId,
        });
      }

      const updatedItems = await targetDb.inventoryItems
        .where('inventoryId')
        .equals(session.id)
        .toArray();
      const totalTheo = updatedItems.reduce(
        (acc, i) => acc + Math.round(i.theoreticalQty * i.unitCostCents),
        0
      );
      const totalCounted = updatedItems.reduce(
        (acc, i) => acc + Math.round(i.countedQty * i.unitCostCents),
        0
      );
      const totalVar = updatedItems.reduce((acc, i) => acc + i.varianceValueCents, 0);

      await targetDb.inventories.update(session.id, {
        status: 'VALIDE',
        totalTheoreticalValueCents: totalTheo,
        totalCountedValueCents: totalCounted,
        totalVarianceValueCents: totalVar,
        validatedBy: actor.userName,
        validatedAt: now,
        updatedAt: now,
      });

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'INVENTORY_VALIDATED',
        entityType: 'INVENTORY',
        entityId: session.id,
        summary: `Inventaire ${session.number} validé. Écart valorisé : ${(totalVar / 100).toFixed(2)} MAD.`,
        contradictionArbitrated: hadNegativeStockAdjustment
          ? 'RULE_14_NEGATIVE_STOCK_INVENTORY_DELTA'
          : 'RULE_07_INVENTORY_EXPLICIT_VARIANCE',
        businessDate,
      });

      return (await targetDb.inventories.get(session.id))!;
    });
  });
}

/**
 * RÈGLE 13 : Arrêt de caisse (Billetage) et verrouillage des écritures clôturées
 */
export async function executeCloseCashRegister(
  params: {
    counts: Record<string, number>;
    notes?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<CashAudit> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const allEntries = await targetDb.cashEntries.toArray();
      const theoreticalBalanceCents = allEntries.reduce(
        (acc, e) => acc + (e.direction === 'IN' ? e.amountCents : -e.amountCents),
        0
      );

      let countedBalanceCents = 0;
      for (const [denomStr, count] of Object.entries(params.counts)) {
        const denomDh = parseFloat(denomStr);
        const qty = Math.max(0, Math.floor(Number(count) || 0));
        if (Number.isFinite(denomDh) && qty > 0) {
          countedBalanceCents += Math.round(denomDh * 100) * qty;
        }
      }

      const varianceCents = countedBalanceCents - theoreticalBalanceCents;
      const status: CashAudit['status'] =
        varianceCents === 0 ? 'CONFORME' : varianceCents > 0 ? 'EXCEDENT' : 'MANQUANT';

      const auditNumber = await nextDocumentNumberInTx(targetDb, 'cashAudit', businessDate);
      const auditId = generateId();

      const audit: CashAudit = {
        id: auditId,
        number: auditNumber,
        businessDate,
        counts: params.counts,
        theoreticalBalanceCents,
        countedBalanceCents,
        varianceCents,
        status,
        notes: params.notes ?? '',
        userId: actor.userId,
        userName: actor.userName,
        createdAt: now,
      };

      await targetDb.cashAudits.add(audit);

      // Verrouillage des écritures de la période clôturée (Règle 13)
      const unlockedEntries = allEntries.filter((e) => !e.isLockedByAudit);
      for (const entry of unlockedEntries) {
        await targetDb.cashEntries.update(entry.id, {
          auditId,
          isLockedByAudit: true,
        });
      }

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'CASH_AUDIT_CLOSED',
        entityType: 'CASH_AUDIT',
        entityId: auditId,
        summary: `Clôture de caisse ${auditNumber} : Théorique ${(theoreticalBalanceCents / 100).toFixed(2)} MAD, Compté ${(countedBalanceCents / 100).toFixed(2)} MAD (${status}). ${unlockedEntries.length} écritures verrouillées.`,
        contradictionArbitrated: 'RULE_13_CLOSED_CASH_IMMUTABLE',
        businessDate,
      });

      return audit;
    });
  });
}

export async function executeAttemptModifyCashEntry(
  params: {
    cashEntryId: string;
    newAmountCents: number;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<CashEntry> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const entry = await targetDb.cashEntries.get(params.cashEntryId);
      if (!entry) throw new Error('Écriture de caisse introuvable.');
      if (entry.isLockedByAudit) {
        throw new ArbitrageError(
          buildArbitrageDecision(
            'RULE_13_CLOSED_CASH_IMMUTABLE',
            false,
            `Arbitrage Règle 13 [Caisse Clôturée] : L'écriture de caisse (${entry.description}) appartient à une période clôturée et ne peut pas être modifiée directement. Créez une écriture corrective tracée.`
          )
        );
      }
      await targetDb.cashEntries.update(entry.id, {
        amountCents: params.newAmountCents,
      });
      return (await targetDb.cashEntries.get(entry.id))!;
    });
  });
}

/**
 * RÈGLES 8, 9, 15, 16, 17 : Protection contre la suppression physique et modification directe
 */
export async function executeAttemptPhysicalDeleteDocument(
  params: {
    entityType: 'SALE' | 'INVOICE' | 'PAYMENT' | 'PURCHASE' | 'EXPENSE';
    entityId: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<never> {
  const actor = params.actor ?? DEFAULT_ACTOR;
  const decision = buildArbitrageDecision(
    'RULE_08_PHYSICAL_DELETE_FORBIDDEN',
    false,
    `Arbitrage Règle 8 [Suppression Physique Interdite] : Le document financier (${params.entityType} #${params.entityId}) ne peut pas être supprimé physiquement. Utilisez une annulation, un avoir ou une contre-écriture.`
  );
  await recordAuditLogInTx(targetDb, {
    ...actor,
    action: 'BLOCKED_PHYSICAL_DELETE',
    entityType: params.entityType,
    entityId: params.entityId,
    summary: decision.resolutionMessage,
    contradictionArbitrated: 'RULE_08_PHYSICAL_DELETE_FORBIDDEN',
  });
  throw new ArbitrageError(decision);
}

export async function executeAttemptModifyValidatedDocument(
  params: {
    entityType: 'SALE' | 'INVOICE' | 'INVENTORY';
    entityId: string;
    documentNumber: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<never> {
  const actor = params.actor ?? DEFAULT_ACTOR;
  const decision = buildArbitrageDecision(
    'RULE_09_VALIDATED_DOC_IMMUTABLE',
    false,
    `Arbitrage Règle 9 [Document Validé Immuable] : Le document validé ${params.documentNumber} ne peut pas être modifié directement (impact stock/TVA/caisse). Utilisez la procédure d'annulation/recréation ou de retour/avoir.`
  );
  await recordAuditLogInTx(targetDb, {
    ...actor,
    action: 'BLOCKED_VALIDATED_DOC_EDIT',
    entityType: params.entityType,
    entityId: params.entityId,
    summary: decision.resolutionMessage,
    contradictionArbitrated: 'RULE_09_VALIDATED_DOC_IMMUTABLE',
  });
  throw new ArbitrageError(decision);
}

/**
 * RÈGLE 15 : Suppression logique d'un client possédant un historique
 */
export async function executeDeleteOrDeactivateCustomer(
  customerId: string,
  actor: ActorContext = DEFAULT_ACTOR,
  targetDb: AtlasSoftWaterDB = db
): Promise<{ mode: 'DELETED' | 'DEACTIVATED'; customer?: Customer }> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const customer = await targetDb.customers.get(customerId);
      if (!customer) throw new Error('Client introuvable.');

      const salesCount = await targetDb.sales.where('customerId').equals(customerId).count();
      const invoicesCount = await targetDb.invoices.where('customerId').equals(customerId).count();
      const quotesCount = await targetDb.quotes.where('customerId').equals(customerId).count();
      const equipCount = await targetDb.customerEquipments
        .where('customerId')
        .equals(customerId)
        .count();
      const savCount = await targetDb.reminders.where('customerId').equals(customerId).count();
      const payCount = await targetDb.payments.where('partyId').equals(customerId).count();

      const totalLinks =
        salesCount + invoicesCount + quotesCount + equipCount + savCount + payCount;

      if (totalLinks > 0) {
        await targetDb.customers.update(customerId, {
          active: false,
          updatedAt: new Date().toISOString(),
        });

        await recordAuditLogInTx(targetDb, {
          ...actor,
          action: 'CUSTOMER_LOGICAL_DEACTIVATION',
          entityType: 'CUSTOMER',
          entityId: customerId,
          summary: `Arbitrage Règle 15 : Client "${customer.name}" désactivé logiquement (${totalLinks} opérations/équipements liés conservés).`,
          contradictionArbitrated: 'RULE_15_CUSTOMER_LOGICAL_DELETE_ONLY',
        });

        return {
          mode: 'DEACTIVATED',
          customer: (await targetDb.customers.get(customerId))!,
        };
      }

      await targetDb.customers.delete(customerId);
      return { mode: 'DELETED' };
    });
  });
}

/**
 * RÈGLE 16 : Suppression logique d'un produit possédant un historique
 */
export async function executeDeleteOrDeactivateProduct(
  productId: string,
  actor: ActorContext = DEFAULT_ACTOR,
  targetDb: AtlasSoftWaterDB = db
): Promise<{ mode: 'DELETED' | 'DEACTIVATED'; product?: Product }> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const product = await targetDb.products.get(productId);
      if (!product) throw new Error('Produit introuvable.');

      const saleLines = await targetDb.saleItems.where('productId').equals(productId).count();
      const purchaseLines = await targetDb.purchaseItems
        .where('productId')
        .equals(productId)
        .count();
      const movements = await targetDb.stockMovements.where('productId').equals(productId).count();

      if (saleLines + purchaseLines + movements > 0) {
        await targetDb.products.update(productId, {
          active: false,
          updatedAt: new Date().toISOString(),
        });

        await recordAuditLogInTx(targetDb, {
          ...actor,
          action: 'PRODUCT_LOGICAL_DEACTIVATION',
          entityType: 'PRODUCT',
          entityId: productId,
          summary: `Arbitrage Règle 16 : Produit "${product.name}" (${product.reference}) archivé logiquement pour préserver l'historique des ventes et mouvements.`,
          contradictionArbitrated: 'RULE_16_PRODUCT_LOGICAL_DELETE_ONLY',
        });

        return {
          mode: 'DEACTIVATED',
          product: (await targetDb.products.get(productId))!,
        };
      }

      await targetDb.products.delete(productId);
      return { mode: 'DELETED' };
    });
  });
}

/**
 * RÈGLE 17 : Suppression logique d'un fournisseur possédant un historique
 */
export async function executeDeleteOrDeactivateSupplier(
  supplierId: string,
  actor: ActorContext = DEFAULT_ACTOR,
  targetDb: AtlasSoftWaterDB = db
): Promise<{ mode: 'DELETED' | 'DEACTIVATED'; supplier?: Supplier }> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const supplier = await targetDb.suppliers.get(supplierId);
      if (!supplier) throw new Error('Fournisseur introuvable.');

      const purchasesCount = await targetDb.purchases
        .where('supplierId')
        .equals(supplierId)
        .count();
      const paymentsCount = await targetDb.payments.where('partyId').equals(supplierId).count();

      if (purchasesCount + paymentsCount > 0) {
        await targetDb.suppliers.update(supplierId, {
          active: false,
          updatedAt: new Date().toISOString(),
        });

        await recordAuditLogInTx(targetDb, {
          ...actor,
          action: 'SUPPLIER_LOGICAL_DEACTIVATION',
          entityType: 'SUPPLIER',
          entityId: supplierId,
          summary: `Arbitrage Règle 17 : Fournisseur "${supplier.name}" désactivé logiquement (${purchasesCount} achats conservés).`,
          contradictionArbitrated: 'RULE_17_SUPPLIER_LOGICAL_DELETE_ONLY',
        });

        return {
          mode: 'DEACTIVATED',
          supplier: (await targetDb.suppliers.get(supplierId))!,
        };
      }

      await targetDb.suppliers.delete(supplierId);
      return { mode: 'DELETED' };
    });
  });
}

/**
 * RÈGLE 18 : Intervention SAV avec consommation de pièce du stock et renouvellement automatique
 */
export async function executeCompleteSavReminder(
  params: {
    reminderId: string;
    consumedProductId?: string | null;
    consumedQty?: number;
    serviceFeeCents?: number;
    paymentMethod?: Exclude<PaymentMethod, 'CREDIT' | 'CREDIT_NOTE'>;
    technicianNotes?: string;
    scheduleNextReminder?: boolean;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<{ completed: SavReminder; nextReminder: SavReminder | null }> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);
      const settings = await targetDb.settings.get('default');

      const reminder = await targetDb.reminders.get(params.reminderId);
      if (!reminder) throw new Error('Rappel SAV introuvable.');

      const consumedQty = Math.max(0, Number(params.consumedQty) || 0);
      if (params.consumedProductId && consumedQty > 0) {
        const product = await targetDb.products.get(params.consumedProductId);
        if (!product) throw new Error('Pièce/filtre consommé introuvable en stock.');

        const decision = arbitrateSaleStock({
          productName: product.name,
          productRef: product.reference,
          availableStock: product.stock,
          requestedQty: consumedQty,
          allowNegativeStock: settings?.allowNegativeStock ?? false,
        });

        if (!decision.allowed) {
          throw new ArbitrageError(decision);
        }

        const stockBefore = product.stock;
        const stockAfter = stockBefore - consumedQty;
        await targetDb.products.update(product.id, {
          stock: stockAfter,
          updatedAt: now,
        });

        await targetDb.stockMovements.add({
          id: generateId(),
          date: now,
          businessDate,
          productId: product.id,
          productRef: product.reference,
          productName: product.name,
          quantity: -consumedQty,
          stockBefore,
          stockAfter,
          type: 'SAV_CONSUMPTION',
          sourceDocType: 'SAV',
          sourceDocId: reminder.id,
          sourceDocNumber: `SAV-${reminder.id.slice(0, 6).toUpperCase()}`,
          reason: `Consommation pièce intervention SAV (${reminder.customerName} / ${reminder.equipmentName})`,
          userId: actor.userId,
          userName: actor.userName,
          status: 'ACTIVE',
          createdAt: now,
        });
      }

      let paymentId: string | null = null;
      const feeCents = Math.max(0, Math.round(Number(params.serviceFeeCents) || 0));
      if (feeCents > 0 && params.paymentMethod) {
        const payNum = await nextDocumentNumberInTx(targetDb, 'payment', businessDate);
        paymentId = generateId();
        await targetDb.payments.add({
          id: paymentId,
          number: payNum,
          businessDate,
          direction: 'IN',
          targetType: 'SAV',
          targetId: reminder.id,
          targetNumber: `SAV-${reminder.id.slice(0, 6).toUpperCase()}`,
          partyId: reminder.customerId,
          partyName: reminder.customerName,
          amountCents: feeCents,
          method: params.paymentMethod,
          destination: resolvePaymentDestination(params.paymentMethod),
          reference: 'INTERVENTION-SAV',
          status: 'VALIDATED',
          reversedByPaymentId: null,
          reversalOfPaymentId: null,
          notes: `Frais intervention SAV (${reminder.equipmentName})`,
          userId: actor.userId,
          isDemo: false,
          createdAt: now,
        });

        if (params.paymentMethod === 'CASH') {
          await targetDb.cashEntries.add({
            id: generateId(),
            businessDate,
            direction: 'IN',
            type: 'SALE_CASH',
            amountCents: feeCents,
            sourceId: paymentId,
            sourceNumber: payNum,
            description: `Encaissement SAV espèces (${reminder.customerName})`,
            auditId: null,
            isLockedByAudit: false,
            userId: actor.userId,
            createdAt: now,
          });
        }
      }

      await targetDb.reminders.update(reminder.id, {
        status: 'EFFECTUE',
        completedAt: businessDate,
        consumedProductId: params.consumedProductId ?? reminder.productId,
        consumedQty,
        serviceFeeCents: feeCents,
        paymentId,
        technicianNotes: params.technicianNotes ?? reminder.technicianNotes,
        updatedAt: now,
      });

      let nextReminder: SavReminder | null = null;
      if (params.scheduleNextReminder !== false) {
        const nextDueDate = addMonthsToBusinessDate(businessDate, reminder.intervalMonths);
        nextReminder = {
          id: generateId(),
          customerId: reminder.customerId,
          customerName: reminder.customerName,
          customerPhone: reminder.customerPhone,
          customerWhatsapp: reminder.customerWhatsapp,
          equipmentId: reminder.equipmentId,
          equipmentName: reminder.equipmentName,
          productId: reminder.productId,
          productName: reminder.productName,
          installDate: businessDate,
          intervalMonths: reminder.intervalMonths,
          dueDate: nextDueDate,
          status: computeSavReminderStatus(nextDueDate, null, businessDate),
          completedAt: null,
          technicianNotes: `Renouvellement périodique (${reminder.intervalMonths} mois)`,
          consumedProductId: null,
          consumedQty: 0,
          serviceFeeCents: 0,
          paymentId: null,
          isDemo: reminder.isDemo,
          createdAt: now,
          updatedAt: now,
        };
        await targetDb.reminders.add(nextReminder);
      }

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'SAV_INTERVENTION_COMPLETED',
        entityType: 'SAV_REMINDER',
        entityId: reminder.id,
        summary: `Intervention SAV effectuée pour ${reminder.customerName} (${reminder.equipmentName}). Pièce sortie stock : ${consumedQty}.`,
        contradictionArbitrated: 'RULE_18_SAV_EQUIPMENT_PRESERVATION_AND_STOCK',
        businessDate,
      });

      return {
        completed: (await targetDb.reminders.get(reminder.id))!,
        nextReminder,
      };
    });
  });
}

/**
 * Enregistrement d'une dépense d'exploitation (Section 29)
 */
export async function executeCreateExpense(
  params: {
    category: ExpenseCategory;
    label: string;
    beneficiary: string;
    amountHtCents: number;
    vatRate: number;
    paymentMethod: 'CASH' | 'CARD' | 'TRANSFER' | 'CHECK';
    receiptRef?: string;
    notes?: string;
    businessDate?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<Expense> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = params.businessDate ?? getMoroccoBusinessDate(now);

      const amountHtCents = Math.max(0, Math.round(params.amountHtCents));
      const amountVatCents = Math.round((amountHtCents * Math.max(0, params.vatRate)) / 100);
      const amountTtcCents = amountHtCents + amountVatCents;

      const expNumber = await nextDocumentNumberInTx(targetDb, 'expense', businessDate);
      const expId = generateId();

      const expense: Expense = {
        id: expId,
        number: expNumber,
        businessDate,
        category: params.category,
        label: params.label,
        beneficiary: params.beneficiary,
        amountHtCents,
        vatRate: params.vatRate,
        amountVatCents,
        amountTtcCents,
        paymentMethod: params.paymentMethod,
        receiptRef: params.receiptRef ?? '',
        notes: params.notes ?? '',
        status: 'VALIDATED',
        isDemo: false,
        createdAt: now,
      };

      await targetDb.expenses.add(expense);

      if (params.category === 'ALIMENTATION_CAISSE') {
        // Alimentation du fond de caisse (Entrée d'espèces en caisse physique)
        await targetDb.cashEntries.add({
          id: generateId(),
          businessDate,
          direction: 'IN',
          type: 'OPENING_FLOAT',
          amountCents: amountTtcCents,
          sourceId: expId,
          sourceNumber: expNumber,
          description: `Alimentation fond de caisse : ${params.label}${params.beneficiary ? ` (${params.beneficiary})` : ''}`,
          auditId: null,
          isLockedByAudit: false,
          userId: actor.userId,
          createdAt: now,
        });
      } else if (params.paymentMethod === 'CASH') {
        await targetDb.cashEntries.add({
          id: generateId(),
          businessDate,
          direction: 'OUT',
          type: 'EXPENSE_CASH',
          amountCents: amountTtcCents,
          sourceId: expId,
          sourceNumber: expNumber,
          description: `Dépense espèces ${expNumber} : ${params.label} (${params.beneficiary})`,
          auditId: null,
          isLockedByAudit: false,
          userId: actor.userId,
          createdAt: now,
        });
      }

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'EXPENSE_CREATED',
        entityType: 'EXPENSE',
        entityId: expId,
        summary: `Dépense ${expNumber} enregistrée (${(amountTtcCents / 100).toFixed(2)} MAD TTC) via ${params.paymentMethod}`,
        businessDate,
      });

      return expense;
    });
  });
}

export async function executeAddEquipmentAndSavReminder(
  params: {
    customerId: string;
    type: string;
    brand: string;
    model: string;
    serialNumber: string;
    installDate: string;
    capacity: string;
    membraneType: string;
    notes?: string;
    replacementProductId?: string;
    intervalMonths?: number;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<CustomerEquipment> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const now = new Date().toISOString();
      const customer = await targetDb.customers.get(params.customerId);
      if (!customer) throw new Error('Client introuvable.');

      const equipId = generateId();
      const equipment: CustomerEquipment = {
        id: equipId,
        customerId: customer.id,
        customerName: customer.name,
        type: params.type,
        brand: params.brand,
        model: params.model,
        serialNumber: params.serialNumber,
        installDate: params.installDate,
        capacity: params.capacity,
        membraneType: params.membraneType,
        notes: params.notes ?? '',
        active: true,
        createdAt: now,
        updatedAt: now,
      };

      await targetDb.customerEquipments.add(equipment);

      if (params.intervalMonths && params.intervalMonths > 0) {
        const product = params.replacementProductId
          ? await targetDb.products.get(params.replacementProductId)
          : undefined;
        const dueDate = addMonthsToBusinessDate(params.installDate, params.intervalMonths);
        await targetDb.reminders.add({
          id: generateId(),
          customerId: customer.id,
          customerName: customer.name,
          customerPhone: customer.phone,
          customerWhatsapp: customer.whatsapp,
          equipmentId: equipId,
          equipmentName: `${params.type} ${params.brand} ${params.model}`,
          productId: product?.id ?? '',
          productName: product?.name ?? 'Kit Filtres / Membrane de rechange',
          installDate: params.installDate,
          intervalMonths: params.intervalMonths,
          dueDate,
          status: computeSavReminderStatus(dueDate, null),
          completedAt: null,
          technicianNotes: 'Suivi périodique filtration / osmose',
          consumedProductId: null,
          consumedQty: 0,
          serviceFeeCents: 0,
          paymentId: null,
          isDemo: customer.isDemo,
          createdAt: now,
          updatedAt: now,
        });
      }

      return equipment;
    });
  });
}

/**
 * DÉCLARATION MANUELLE D'UN PRODUIT DÉFECTUEUX / QUARANTAINE
 */
export async function executeDeclareDefectiveProduct(
  params: {
    productId: string;
    quantity: number;
    sourceType: DefectiveSourceType;
    sourceDocNumber?: string;
    supplierId?: string;
    supplierName?: string;
    customerId?: string;
    customerName?: string;
    defectReason: string;
    severity?: 'CRITIQUE' | 'MAJEUR' | 'MINEUR';
    deductFromStock?: boolean;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<DefectiveProduct> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const qty = Math.max(1, Number(params.quantity) || 1);
      const product = await targetDb.products.get(params.productId);
      if (!product) throw new Error('Produit introuvable.');

      if (params.deductFromStock) {
        if (product.stock < qty) {
          throw new Error(
            `Stock disponible insuffisant (${product.stock} ${product.unit}) pour isoler ${qty} unité(s) en quarantaine.`
          );
        }
        const stockBefore = product.stock;
        const stockAfter = stockBefore - qty;
        await targetDb.products.update(product.id, {
          stock: stockAfter,
          updatedAt: now,
        });

        await targetDb.stockMovements.add({
          id: generateId(),
          date: now,
          businessDate,
          productId: product.id,
          productRef: product.reference,
          productName: product.name,
          quantity: -qty,
          stockBefore,
          stockAfter,
          type: 'MANUAL_ADJUST',
          sourceDocType: 'MANUAL',
          sourceDocId: params.productId,
          sourceDocNumber: 'SORTIE-QUARANTAINE',
          reason: `Mise en quarantaine produit défectueux : ${params.defectReason}`,
          userId: actor.userId,
          userName: actor.userName,
          status: 'ACTIVE',
          createdAt: now,
        });
      }

      const defNumber = await nextDocumentNumberInTx(
        targetDb,
        'defective' as any,
        businessDate
      );
      const defId = generateId();

      const defective: DefectiveProduct = {
        id: defId,
        number: defNumber,
        productId: product.id,
        productRef: product.reference,
        productName: product.name,
        quantity: qty,
        sourceType: params.sourceType,
        sourceDocType: params.sourceType === 'PURCHASE_RECEIPT' ? 'PURCHASE' : 'MANUAL',
        sourceDocNumber: params.sourceDocNumber ?? '',
        supplierId: params.supplierId ?? product.supplierId ?? '',
        supplierName: params.supplierName ?? product.supplierName ?? '',
        customerId: params.customerId ?? '',
        customerName: params.customerName ?? '',
        defectReason: params.defectReason.trim() || 'Constaté défectueux lors de l’inspection',
        severity: params.severity ?? 'MAJEUR',
        status: 'EN_QUARANTAINE',
        unitCostCents: product.purchasePriceCents,
        totalCostCents: product.purchasePriceCents * qty,
        reportedDate: businessDate,
        businessDate,
        reportedBy: actor.userName,
        isDemo: false,
        createdAt: now,
        updatedAt: now,
      };

      await targetDb.defectiveProducts.add(defective);

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'DEFECTIVE_PRODUCT_DECLARED',
        entityType: 'PRODUCT',
        entityId: product.id,
        summary: `Fiche Défectueux ${defNumber} créée : ${qty}x ${product.name} mis en quarantaine (${params.defectReason})`,
        businessDate,
      });

      return defective;
    });
  });
}

/**
 * TRAITEMENT & RÉSOLUTION D'UN PRODUIT DÉFECTUEUX EN QUARANTAINE
 */
export async function executeResolveDefectiveProduct(
  params: {
    defectiveId: string;
    status: DefectiveStatus;
    resolutionNotes: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<DefectiveProduct> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      const def = await targetDb.defectiveProducts.get(params.defectiveId);
      if (!def) throw new Error('Dossier défectueux introuvable.');

      const product = await targetDb.products.get(def.productId);

      // Si le statut résolu correspond à une réintégration en stock vendable (ex: réparé par l'atelier)
      if (params.status === 'REPARE_REMIS_EN_STOCK' && product) {
        const stockBefore = product.stock;
        const stockAfter = stockBefore + def.quantity;
        await targetDb.products.update(product.id, {
          stock: stockAfter,
          updatedAt: now,
        });

        await targetDb.stockMovements.add({
          id: generateId(),
          date: now,
          businessDate,
          productId: product.id,
          productRef: product.reference,
          productName: product.name,
          quantity: def.quantity,
          stockBefore,
          stockAfter,
          type: 'MANUAL_ADJUST',
          sourceDocType: 'MANUAL',
          sourceDocId: def.id,
          sourceDocNumber: def.number,
          reason: `Réintégration en stock après réparation du défectueux (${def.number})`,
          userId: actor.userId,
          userName: actor.userName,
          status: 'ACTIVE',
          createdAt: now,
        });
      }

      await targetDb.defectiveProducts.update(def.id, {
        status: params.status,
        resolutionNotes: params.resolutionNotes,
        resolutionDate: businessDate,
        updatedAt: now,
      });

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'DEFECTIVE_PRODUCT_RESOLVED',
        entityType: 'PRODUCT',
        entityId: def.productId,
        summary: `Fiche Défectueux ${def.number} mise à jour : Statut -> ${params.status} (${params.resolutionNotes})`,
        businessDate,
      });

      return (await targetDb.defectiveProducts.get(def.id))!;
    });
  });
}

/**
 * GESTION DES FLUX & VERSEMENTS BANCAIRES :
 * 1. Préparation d'un Versement Bancaire (Espèces & Chèques)
 * Permet de définir le montant en espèces à verser, de conserver une partie en caisse (fond de roulement),
 * de sélectionner les chèques en portefeuille et d'éditer le bordereau de remise en banque officiel.
 */
export async function executePrepareBankDeposit(
  params: {
    cashToDepositCents: number;
    checksSelected: BankDepositCheckItem[];
    bankName: string;
    bankAccountNumber?: string;
    reference?: string;
    notes?: string;
    businessDate?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<BankDeposit> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = params.businessDate ?? getMoroccoBusinessDate(now);

      const allCashEntries = await targetDb.cashEntries.toArray();
      const cashAvailableCents = allCashEntries.reduce(
        (acc, e) => acc + (e.direction === 'IN' ? e.amountCents : -e.amountCents),
        0
      );

      const cashToDepositCents = Math.max(0, Math.round(params.cashToDepositCents || 0));
      if (cashToDepositCents > cashAvailableCents) {
        throw new Error(
          `Montant espèces à verser (${(cashToDepositCents / 100).toFixed(2)} MAD) supérieur au solde disponible en caisse (${(cashAvailableCents / 100).toFixed(2)} MAD).`
        );
      }

      const totalChecksCents = params.checksSelected.reduce(
        (acc, c) => acc + Math.max(0, Math.round(c.amountCents || 0)),
        0
      );

      const totalDepositCents = cashToDepositCents + totalChecksCents;
      if (totalDepositCents <= 0) {
        throw new Error('Veuillez indiquer un montant en espèces à verser et/ou sélectionner au moins un chèque.');
      }

      const cashRemainingInRegisterCents = cashAvailableCents - cashToDepositCents;

      const depositNumber = await nextDocumentNumberInTx(targetDb, 'bankDeposit', businessDate);
      const depositId = generateId();

      const deposit: BankDeposit = {
        id: depositId,
        number: depositNumber,
        businessDate,
        status: 'PREPARED',
        cashAvailableCents,
        cashToDepositCents,
        cashRemainingInRegisterCents,
        checksSelected: params.checksSelected,
        totalChecksCents,
        totalDepositCents,
        bankName: params.bankName || 'Banque Principale',
        bankAccountNumber: params.bankAccountNumber ?? '',
        reference: params.reference ?? '',
        notes: params.notes ?? '',
        preparedByUserId: actor.userId,
        preparedByUserName: actor.userName,
        confirmedAt: null,
        confirmedByUserId: null,
        confirmedByUserName: null,
        cashEntryId: null,
        createdAt: now,
        updatedAt: now,
      };

      await targetDb.bankDeposits.add(deposit);

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'BANK_DEPOSIT_PREPARED',
        entityType: 'BANK_DEPOSIT',
        entityId: depositId,
        summary: `Préparation du bordereau de versement ${depositNumber} (${(totalDepositCents / 100).toFixed(2)} MAD dont ${(cashToDepositCents / 100).toFixed(2)} MAD espèces et ${(totalChecksCents / 100).toFixed(2)} MAD chèques) vers ${deposit.bankName}. Reste prévu en caisse : ${(cashRemainingInRegisterCents / 100).toFixed(2)} MAD.`,
        businessDate,
      });

      return deposit;
    });
  });
}

/**
 * 2. Confirmation du Versement Bancaire (au retour de la banque avec récépissé)
 * Débite officiellement la caisse physique du montant versé et met à jour le solde pour le billetage.
 */
export async function executeConfirmBankDeposit(
  params: {
    depositId: string;
    reference?: string;
    confirmationDate?: string;
    notes?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<BankDeposit> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const deposit = await targetDb.bankDeposits.get(params.depositId);
      if (!deposit) throw new Error('Versement introuvable.');
      if (deposit.status === 'CONFIRMED') {
        throw new Error('Ce versement a déjà été confirmé.');
      }
      if (deposit.status === 'CANCELLED') {
        throw new Error('Impossible de confirmer un versement annulé.');
      }

      const confDate = params.confirmationDate ?? getMoroccoBusinessDate(now);
      let cashEntryId: string | null = null;

      // 1. Débit officiel de la caisse physique si des espèces sont versées
      if (deposit.cashToDepositCents > 0) {
        cashEntryId = generateId();
        await targetDb.cashEntries.add({
          id: cashEntryId,
          businessDate: confDate,
          direction: 'OUT',
          type: 'BANK_DEPOSIT',
          amountCents: deposit.cashToDepositCents,
          sourceId: deposit.id,
          sourceNumber: deposit.number,
          description: `Versement bancaire espèces ${deposit.number} (${deposit.bankName}) - Reste laissé en caisse : ${(deposit.cashRemainingInRegisterCents / 100).toFixed(2)} MAD`,
          auditId: null,
          isLockedByAudit: false,
          userId: actor.userId,
          createdAt: now,
        });
      }

      // 2. Mise à jour de la destination des chèques remis en banque
      for (const checkItem of deposit.checksSelected) {
        const pay = await targetDb.payments.get(checkItem.paymentId);
        if (pay) {
          await targetDb.payments.update(pay.id, {
            destination: 'BANQUE',
            notes: pay.notes
              ? `${pay.notes} | Remis en banque via ${deposit.number}`
              : `Remis en banque via ${deposit.number}`,
          });
        }
      }

      // 3. Mise à jour du document de versement
      const updatedDeposit: BankDeposit = {
        ...deposit,
        status: 'CONFIRMED',
        reference: params.reference?.trim() || deposit.reference,
        notes: params.notes?.trim() ? `${deposit.notes ? deposit.notes + ' · ' : ''}${params.notes.trim()}` : deposit.notes,
        confirmedAt: now,
        confirmedByUserId: actor.userId,
        confirmedByUserName: actor.userName,
        cashEntryId,
        updatedAt: now,
      };

      await targetDb.bankDeposits.put(updatedDeposit);

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'BANK_DEPOSIT_CONFIRMED',
        entityType: 'BANK_DEPOSIT',
        entityId: deposit.id,
        summary: `Versement bancaire ${deposit.number} confirmé (${(deposit.totalDepositCents / 100).toFixed(2)} MAD) à ${deposit.bankName}. Solde caisse mis à jour : ${(deposit.cashRemainingInRegisterCents / 100).toFixed(2)} MAD disponible pour audit/billetage.`,
        businessDate: confDate,
      });

      return updatedDeposit;
    });
  });
}

/**
 * 3. Annulation d'un versement bancaire
 */
export async function executeCancelBankDeposit(
  params: {
    depositId: string;
    reason?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<BankDeposit> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);
      const deposit = await targetDb.bankDeposits.get(params.depositId);
      if (!deposit) throw new Error('Versement introuvable.');
      if (deposit.status === 'CANCELLED') {
        throw new Error('Ce versement est déjà annulé.');
      }

      // Si le versement avait déjà été confirmé, réinjecter l'argent en caisse et remettre les chèques en portefeuille
      if (deposit.status === 'CONFIRMED') {
        if (deposit.cashToDepositCents > 0) {
          await targetDb.cashEntries.add({
            id: generateId(),
            businessDate,
            direction: 'IN',
            type: 'CORRECTION',
            amountCents: deposit.cashToDepositCents,
            sourceId: deposit.id,
            sourceNumber: deposit.number,
            description: `Annulation du versement espèces ${deposit.number} (${params.reason || 'Retour fonds'})`,
            auditId: null,
            isLockedByAudit: false,
            userId: actor.userId,
            createdAt: now,
          });
        }

        for (const checkItem of deposit.checksSelected) {
          const pay = await targetDb.payments.get(checkItem.paymentId);
          if (pay) {
            await targetDb.payments.update(pay.id, {
              destination: 'PORTEFEUILLE_EFFETS',
            });
          }
        }
      }

      const updatedDeposit: BankDeposit = {
        ...deposit,
        status: 'CANCELLED',
        notes: `${deposit.notes ? deposit.notes + ' · ' : ''}Annulé : ${params.reason || 'Non précisé'}`,
        updatedAt: now,
      };

      await targetDb.bankDeposits.put(updatedDeposit);

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'BANK_DEPOSIT_CANCELLED',
        entityType: 'BANK_DEPOSIT',
        entityId: deposit.id,
        summary: `Annulation du versement ${deposit.number}. Motif : ${params.reason || 'Non précisé'}.`,
        businessDate,
      });

      return updatedDeposit;
    });
  });
}

/**
 * REMISE À ZÉRO DE L'APPLICATION SOUS CODE PIN MAÎTRE :
 * Permet de réinitialiser l'application pour démarrer une activité réelle ou repartir d'une base vierge.
 * Requiert obligatoirement le Code PIN Maître d'un administrateur actif.
 */
export async function executeResetAppToZero(
  params: {
    masterPinInput: string;
    mode: 'ZERO_OPERATIONS' | 'FACTORY_RESET';
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<{ mode: 'ZERO_OPERATIONS' | 'FACTORY_RESET'; message: string }> {
  const actor = params.actor ?? DEFAULT_ACTOR;
  const cleanPin = params.masterPinInput?.trim();
  if (!cleanPin) {
    throw new Error('Le Code PIN Maître est obligatoire pour autoriser la remise à zéro.');
  }

  // 1. Vérification stricte du Code PIN Maître auprès des profils Administrateurs
  const allProfiles = await targetDb.profiles.toArray();
  const adminProfiles = allProfiles.filter((p) => p.role === 'ADMIN' && p.active !== false);
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
    throw new Error('Code PIN Maître incorrect. Remise à zéro de l’application refusée.');
  }

  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const now = new Date().toISOString();
      const businessDate = getMoroccoBusinessDate(now);

      if (params.mode === 'FACTORY_RESET') {
        // Effacement complet de toutes les tables (réinitialisation d'usine totale)
        for (const table of getAllTables(targetDb)) {
          await table.clear();
        }
        return {
          mode: 'FACTORY_RESET',
          message: 'Base de données réinitialisée. L’assistant de configuration initial va démarrer.',
        };
      }

      // Mode ZERO_OPERATIONS :
      // 1. Ventes, devis, factures & avoirs
      await targetDb.sales.clear();
      await targetDb.saleItems.clear();
      await targetDb.quotes.clear();
      await targetDb.quoteItems.clear();
      await targetDb.invoices.clear();
      await targetDb.invoiceItems.clear();

      // 2. Achats et réceptions
      await targetDb.purchases.clear();
      await targetDb.purchaseItems.clear();

      // 3. Stocks, inventaires et mouvements (stocks remis à 0)
      await targetDb.stockMovements.clear();
      await targetDb.inventories.clear();
      await targetDb.inventoryItems.clear();
      await targetDb.defectiveProducts.clear();
      await targetDb.products.toCollection().modify({ stock: 0 });

      // 4. Trésorerie & Caisse (Solde de caisse strictement = 0,00 DH)
      await targetDb.cashEntries.clear();
      await targetDb.cashAudits.clear();
      await targetDb.bankDeposits.clear();
      await targetDb.expenses.clear();
      await targetDb.payments.clear();

      // 5. Soldes clients, dettes fournisseurs et SAV
      await targetDb.customers.toCollection().modify({ balanceCents: 0, creditAvailableCents: 0 });
      await targetDb.suppliers.toCollection().modify({ debtCents: 0, totalPurchasesCents: 0 });
      await targetDb.reminders.clear();

      // 6. Veille marché
      await targetDb.marketResearch.clear();

      // 7. Compteurs / séquences documentaires remises à 1
      await targetDb.sequences.clear();

      // 8. Fiche Entreprise : marquage isDemoData = false
      const comp = await targetDb.company.get('default');
      if (comp) {
        await targetDb.company.put({
          ...comp,
          isDemoData: false,
          updatedAt: now,
        });
      }

      // 9. Journal d'audit : réinitialisé avec enregistrement officiel du PV de remise à 0
      await targetDb.auditLogs.clear();
      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'APP_RESET_TO_ZERO',
        entityType: 'SYSTEM',
        entityId: 'ALL',
        summary: `Remise à zéro complète de l'application (Ventes, Stocks, Caisse = 0 DH, Compteurs à 1) validée sous Code PIN Maître par ${actor.userName}`,
        businessDate,
      });

      return {
        mode: 'ZERO_OPERATIONS',
        message: 'L’application a été remise à zéro avec succès (0 vente, 0 stock, solde de caisse = 0 DH, compteurs réinitialisés à 1).',
      };
    });
  });
}

export async function executeUpdateCustomer(
  params: {
    customerId: string;
    name: string;
    type?: CustomerType;
    phone?: string;
    whatsapp?: string;
    email?: string;
    city?: string;
    address?: string;
    ice?: string;
    notes?: string;
    actor?: ActorContext;
  },
  targetDb: AtlasSoftWaterDB = db
): Promise<Customer> {
  return enqueueTransactionalMutation(async () => {
    return targetDb.transaction('rw', getAllTables(targetDb), async () => {
      const actor = params.actor ?? DEFAULT_ACTOR;
      const now = new Date().toISOString();
      const bDate = getMoroccoBusinessDate(now);

      const customer = await targetDb.customers.get(params.customerId);
      if (!customer) throw new Error('Client introuvable.');

      const cleanName = params.name.trim();
      if (!cleanName) throw new Error('Le nom du client est obligatoire.');

      // Préservation intégrale du solde dû (balanceCents) et de l'historique
      const updatedCustomer: Customer = {
        ...customer,
        name: cleanName,
        type: params.type ?? customer.type,
        phone: params.phone !== undefined ? params.phone.trim() : customer.phone,
        whatsapp: params.whatsapp !== undefined ? params.whatsapp.trim() : (params.phone?.trim() ?? customer.whatsapp),
        email: params.email !== undefined ? params.email.trim() : customer.email,
        city: params.city !== undefined ? params.city.trim() : customer.city,
        address: params.address !== undefined ? params.address.trim() : customer.address,
        ice: params.ice !== undefined ? params.ice.trim() : customer.ice,
        notes: params.notes !== undefined ? params.notes.trim() : customer.notes,
        updatedAt: now,
      };

      await targetDb.customers.put(updatedCustomer);

      await recordAuditLogInTx(targetDb, {
        ...actor,
        action: 'CUSTOMER_UPDATED',
        entityType: 'CUSTOMER',
        entityId: customer.id,
        summary: `Mise à jour des coordonnées du client "${updatedCustomer.name}" (${updatedCustomer.code})`,
        businessDate: bDate,
      });

      return updatedCustomer;
    });
  });
}
