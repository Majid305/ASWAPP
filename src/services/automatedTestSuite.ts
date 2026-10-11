import { computeCentralFinancialSnapshot } from '../domain/analyticsEngine';
import { calculateDocumentLinesAndTotals } from '../domain/financialEngine';
import { AtlasSoftWaterDB } from '../db/database';
import {
  createBackupPayloadObject,
  executeCommitValidatedImport,
  validateAndRestoreBackup,
  validateImportData,
} from './backupAndDiagnosticService';
import {
  executeAttemptModifyCashEntry,
  executeAttemptModifyValidatedDocument,
  executeAttemptPhysicalDeleteDocument,
  executeCancelSale,
  executeCloseCashRegister,
  executeCompleteSavReminder,
  executeConvertQuoteToSale,
  executeCreateInventorySession,
  executeCreatePurchaseOrder,
  executeCreateQuote,
  executeCreateSale,
  executeCustomerReturn,
  executeDeleteOrDeactivateCustomer,
  executeDeleteOrDeactivateProduct,
  executeDeleteOrDeactivateSupplier,
  executeReceivePurchaseItems,
  executeRecordInvoicePayment,
  executeUpdateInventoryCounts,
  executeValidateInventorySession,
} from './commandService';
import { initializeWithSetupConfig } from './seedService';
import { getMoroccoBusinessDate } from '../utils/dateUtils';
import { escapeHtml, generateId } from '../utils/securityUtils';

export interface AutomatedTestResult {
  id: string;
  ruleNumber: string;
  name: string;
  passed: boolean;
  durationMs: number;
  assertionSummary: string;
  errorDetails?: string;
}

export interface AutomatedTestSuiteReport {
  executedAt: string;
  totalTests: number;
  passedCount: number;
  failedCount: number;
  totalDurationMs: number;
  results: AutomatedTestResult[];
}

function assertCondition(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion échouée : ${message}`);
  }
}

export async function runMandatoryAutomatedTests(): Promise<AutomatedTestSuiteReport> {
  const suiteStart = performance.now();
  const results: AutomatedTestResult[] = [];
  const sandboxDbName = `AtlasSoftWater_TestSandbox_${generateId()}`;
  const testDb = new AtlasSoftWaterDB(sandboxDbName);

  const runTest = async (
    id: string,
    ruleNumber: string,
    name: string,
    fn: () => Promise<string>
  ) => {
    const t0 = performance.now();
    try {
      const summary = await fn();
      results.push({
        id,
        ruleNumber,
        name,
        passed: true,
        durationMs: Math.round(performance.now() - t0),
        assertionSummary: summary,
      });
    } catch (err) {
      results.push({
        id,
        ruleNumber,
        name,
        passed: false,
        durationMs: Math.round(performance.now() - t0),
        assertionSummary: 'Échec du test',
        errorDetails: err instanceof Error ? err.message : String(err),
      });
    }
  };

  try {
    await initializeWithSetupConfig(
      {
        companyName: 'ATLAS TEST SANDBOX',
        legalName: 'ATLAS TEST SARL',
        ice: '000111222000033',
        ifNumber: '112233',
        rc: '445566',
        patente: '778899',
        cnss: '998877',
        address: 'Casablanca',
        city: 'Casablanca',
        phone: '0522000000',
        whatsapp: '0661000000',
        email: 'test@atlas.ma',
        defaultVatRate: 20,
        currency: 'MAD',
        pin: '1234',
        masterPin: '999999',
        loadDemoData: true,
      },
      testDb
    );

    // TEST 1 : Vente avec stock insuffisant bloquée par défaut
    await runTest(
      'T01',
      'Règle 1',
      'Vente avec stock insuffisant (bloquée par défaut)',
      async () => {
        const prodBefore = await testDb.products.get('prod-memb-4040');
        assertCondition(!!prodBefore && prodBefore.stock === 2, 'Stock initial = 2');
        let blocked = false;
        try {
          await executeCreateSale(
            {
              customerId: 'cust-1',
              lines: [
                {
                  productId: 'prod-memb-4040',
                  productRef: prodBefore!.reference,
                  productName: prodBefore!.name,
                  quantity: 5,
                  unitPriceHtCents: prodBefore!.salePriceHtCents,
                  discountPercent: 0,
                  vatRate: 20,
                },
              ],
              paymentMethod: 'CASH',
              amountPaidCents: 100000,
            },
            testDb
          );
        } catch {
          blocked = true;
        }
        const prodAfter = await testDb.products.get('prod-memb-4040');
        assertCondition(blocked, 'La vente dépassant le stock doit être rejetée');
        assertCondition(prodAfter?.stock === 2, 'Le stock doit rester intact à 2');
        return 'Vente de 5 unités pour 2 disponibles bloquée ; stock préservé à 2.';
      }
    );

    // TEST 2 : Vente avec stock négatif autorisé + Audit
    await runTest(
      'T02',
      'Règle 1 & 14',
      'Vente avec stock négatif autorisé en paramètre et journalisation Audit',
      async () => {
        await testDb.settings.update('default', { allowNegativeStock: true });
        const prodBefore = await testDb.products.get('prod-uv-55w'); // stock = 0
        assertCondition(prodBefore?.stock === 0, 'Stock initial UV = 0');

        const res = await executeCreateSale(
          {
            customerId: 'cust-1',
            lines: [
              {
                productId: 'prod-uv-55w',
                productRef: prodBefore!.reference,
                productName: prodBefore!.name,
                quantity: 2,
                unitPriceHtCents: 175000,
                discountPercent: 0,
                vatRate: 20,
              },
            ],
            paymentMethod: 'CASH',
            amountPaidCents: 420000,
          },
          testDb
        );

        const prodAfter = await testDb.products.get('prod-uv-55w');
        const auditLogs = await testDb.auditLogs
          .where('contradictionArbitrated')
          .equals('RULE_01_NEGATIVE_STOCK_AUTHORIZED')
          .toArray();

        await testDb.settings.update('default', { allowNegativeStock: false });
        assertCondition(prodAfter?.stock === -2, 'Stock passé à -2');
        assertCondition(auditLogs.length >= 1, 'Trace audit stock négatif enregistrée');
        return `Vente ${res.sale.number} autorisée en stock négatif (-2) avec trace d'audit RULE_01_NEGATIVE_STOCK_AUTHORIZED.`;
      }
    );

    // TEST 3 : Annulation d'une vente déjà payée
    await runTest(
      'T03',
      'Règle 2 & 8',
      'Annulation après paiement (conservation, contre-écriture, retour stock, caisse)',
      async () => {
        const prodBefore = await testDb.products.get('prod-kit-3f');
        const stockStart = prodBefore!.stock;

        const saleRes = await executeCreateSale(
          {
            customerId: 'cust-1',
            lines: [
              {
                productId: 'prod-kit-3f',
                productRef: prodBefore!.reference,
                productName: prodBefore!.name,
                quantity: 2,
                unitPriceHtCents: 12500,
                discountPercent: 0,
                vatRate: 20,
              },
            ],
            paymentMethod: 'CASH',
            amountPaidCents: 30000, // 300 MAD TTC
          },
          testDb
        );

        const stockDuring = (await testDb.products.get('prod-kit-3f'))!.stock;
        assertCondition(stockDuring === stockStart - 2, 'Stock diminué de 2 après vente');

        const cancelledSale = await executeCancelSale(
          {
            saleId: saleRes.sale.id,
            reason: 'Erreur de saisie client - test automatisé',
          },
          testDb
        );

        const stockEnd = (await testDb.products.get('prod-kit-3f'))!.stock;
        const invoiceAfter = await testDb.invoices.get(saleRes.invoice.id);
        const paymentsOnInv = await testDb.payments
          .where('targetId')
          .equals(saleRes.invoice.id)
          .toArray();

        assertCondition(cancelledSale.status === 'CANCELLED', 'Vente conservée avec statut CANCELLED');
        assertCondition(stockEnd === stockStart, 'Stock intégralement restitué');
        assertCondition(invoiceAfter?.status === 'CANCELLED', 'Facture annulée');
        assertCondition(
          paymentsOnInv.some((p) => p.direction === 'OUT' && p.reversalOfPaymentId !== null),
          'Opération financière inverse créée'
        );
        return `Vente ${saleRes.sale.number} annulée sans suppression physique ; stock restitué (${stockEnd}) et contre-écriture générée.`;
      }
    );

    // TEST 4 : Retour client après paiement
    await runTest(
      'T04',
      'Règle 12',
      'Retour client partiel après paiement (lien vente origine, stock, avoir)',
      async () => {
        const prodBefore = await testDb.products.get('prod-post-t33');
        const stockStart = prodBefore!.stock;

        const saleRes = await executeCreateSale(
          {
            customerId: 'cust-3',
            lines: [
              {
                productId: 'prod-post-t33',
                productRef: prodBefore!.reference,
                productName: prodBefore!.name,
                quantity: 4,
                unitPriceHtCents: 6500,
                discountPercent: 0,
                vatRate: 20,
              },
            ],
            paymentMethod: 'CASH',
            amountPaidCents: 31200, // 4 * 65 * 1.2 = 312 MAD
          },
          testDb
        );

        const sItems = await testDb.saleItems.where('saleId').equals(saleRes.sale.id).toArray();
        const retRes = await executeCustomerReturn(
          {
            saleId: saleRes.sale.id,
            itemsToReturn: [{ saleItemId: sItems[0].id, returnQty: 1 }],
            refundMethod: 'CASH',
            reason: '1 cartouche excédentaire retournée',
          },
          testDb
        );

        const stockEnd = (await testDb.products.get('prod-post-t33'))!.stock;
        assertCondition(stockEnd === stockStart - 3, 'Stock restauré de +1 unité');
        assertCondition(
          retRes.creditNote.type === 'CREDIT_NOTE' &&
            retRes.creditNote.saleId === saleRes.sale.id,
          "Avoir rattaché explicitement à la vente d'origine"
        );
        assertCondition(retRes.updatedSale.status === 'PARTIAL_RETURN', 'Statut PARTIAL_RETURN');
        return `Avoir ${retRes.creditNote.number} créé et lié à ${saleRes.sale.number} ; stock mis à jour.`;
      }
    );

    // TEST 5 & 6 : Paiement partiel, paiement complet et blocage paiement > solde
    await runTest(
      'T05',
      'Règles 3, 4 & 19',
      'Facture à crédit, paiement partiel, blocage trop-perçu puis solde',
      async () => {
        const saleRes = await executeCreateSale(
          {
            customerId: 'cust-2',
            lines: [
              {
                productId: 'prod-memb-75',
                productRef: 'MEMB-FT-75GPD',
                productName: 'Membrane 75 GPD',
                quantity: 1,
                unitPriceHtCents: 32000, // 384,00 MAD TTC
                discountPercent: 0,
                vatRate: 20,
              },
            ],
            paymentMethod: 'CREDIT',
            amountPaidCents: 0,
          },
          testDb
        );

        assertCondition(saleRes.invoice.status === 'UNPAID', 'Statut initial UNPAID');

        // Paiement partiel de 184,00 MAD par virement (ne doit pas toucher la caisse physique)
        const cashCountBefore = await testDb.cashEntries.count();
        const partRes = await executeRecordInvoicePayment(
          {
            invoiceId: saleRes.invoice.id,
            amountCents: 18400,
            method: 'TRANSFER',
          },
          testDb
        );
        const cashCountAfter = await testDb.cashEntries.count();

        assertCondition(partRes.invoice.status === 'PARTIAL', 'Statut calculé PARTIAL');
        assertCondition(partRes.invoice.remainingDueCents === 20000, 'Reste dû = 200,00 MAD');
        assertCondition(
          cashCountAfter === cashCountBefore,
          'Règle 4 : Virement bancaire hors caisse physique'
        );

        // Tentative de paiement supérieur au solde (250 MAD > 200 MAD)
        let overpaymentBlocked = false;
        try {
          await executeRecordInvoicePayment(
            {
              invoiceId: saleRes.invoice.id,
              amountCents: 25000,
              method: 'CASH',
            },
            testDb
          );
        } catch {
          overpaymentBlocked = true;
        }
        assertCondition(overpaymentBlocked, 'Règle 19 : Paiement > Solde restant bloqué par défaut');

        // Règlement du solde exact (200 MAD)
        const finalRes = await executeRecordInvoicePayment(
          {
            invoiceId: saleRes.invoice.id,
            amountCents: 20000,
            method: 'CASH',
          },
          testDb
        );
        assertCondition(finalRes.invoice.status === 'PAID', 'Statut final PAID');
        return `Cycle UNPAID -> PARTIAL -> Blocage Trop-perçu -> PAID validé sur ${saleRes.invoice.number}.`;
      }
    );

    // TEST 7 : Achat commandé puis réception partielle et complète
    await runTest(
      'T06',
      'Règle 6 & Section 56',
      'Achat fournisseur : commande sans stock, réception partielle puis complète',
      async () => {
        const prodBefore = await testDb.products.get('prod-memb-75');
        const stockInitial = prodBefore!.stock;

        const po = await executeCreatePurchaseOrder(
          {
            supplierId: 'sup-1',
            lines: [
              {
                productId: 'prod-memb-75',
                productRef: prodBefore!.reference,
                productName: prodBefore!.name,
                quantity: 10,
                unitPriceHtCents: 18500,
                discountPercent: 0,
                vatRate: 20,
              },
            ],
          },
          testDb
        );

        const stockAfterOrder = (await testDb.products.get('prod-memb-75'))!.stock;
        assertCondition(
          stockAfterOrder === stockInitial,
          'Règle 6 : Le bon de commande ne modifie pas le stock'
        );

        const pItems = await testDb.purchaseItems.where('purchaseId').equals(po.id).toArray();
        const afterPartial = await executeReceivePurchaseItems(
          {
            purchaseId: po.id,
            receptions: [{ purchaseItemId: pItems[0].id, receivedDeltaQty: 4 }],
          },
          testDb
        );
        const stockAfterPartial = (await testDb.products.get('prod-memb-75'))!.stock;
        assertCondition(afterPartial.status === 'PARTIELLEMENT_RECU', 'Statut PARTIELLEMENT_RECU');
        assertCondition(stockAfterPartial === stockInitial + 4, 'Stock augmenté de +4');

        const afterFull = await executeReceivePurchaseItems(
          {
            purchaseId: po.id,
            receptions: [{ purchaseItemId: pItems[0].id, receivedDeltaQty: 6 }],
          },
          testDb
        );
        const stockAfterFull = (await testDb.products.get('prod-memb-75'))!.stock;
        assertCondition(afterFull.status === 'RECU', 'Statut RECU');
        assertCondition(stockAfterFull === stockInitial + 10, 'Stock augmenté de +10 au total');
        return `Commande ${po.number} : Stock +0 à la commande, +4 en réception partielle, +6 au solde.`;
      }
    );

    // TEST 8 : Inventaire avec écart et stock négatif
    await runTest(
      'T07',
      'Règles 7, 9 & 14',
      'Inventaire physique sur stock négatif avec génération de mouvement explicite',
      async () => {
        // prod-uv-55w est à -2 depuis le Test 2
        const uvBefore = await testDb.products.get('prod-uv-55w');
        assertCondition(uvBefore?.stock === -2, 'Stock théorique UV avant inventaire = -2');

        const inv = await executeCreateInventorySession(
          { mode: 'COMPLET', notes: 'Inventaire test automatisé' },
          testDb
        );
        const uvInvItem = inv.items.find((i) => i.productId === 'prod-uv-55w')!;
        assertCondition(uvInvItem.theoreticalQty === -2, 'Quantité théorique capturée = -2');

        await executeUpdateInventoryCounts(
          {
            inventoryId: inv.session.id,
            counts: [{ inventoryItemId: uvInvItem.id, countedQty: 3 }],
          },
          testDb
        );

        const validated = await executeValidateInventorySession(
          { inventoryId: inv.session.id },
          testDb
        );
        const uvAfter = await testDb.products.get('prod-uv-55w');
        const movements = await testDb.stockMovements
          .where('sourceDocId')
          .equals(inv.session.id)
          .toArray();
        const uvMv = movements.find((m) => m.productId === 'prod-uv-55w');

        assertCondition(uvAfter?.stock === 3, 'Stock après validation = 3');
        assertCondition(
          !!uvMv && uvMv.stockBefore === -2 && uvMv.quantity === 5 && uvMv.stockAfter === 3,
          'Mouvement explicite : -2 + 5 = 3'
        );

        // Vérifier l'immutabilité après validation (Règle 9)
        let editBlocked = false;
        try {
          await executeUpdateInventoryCounts(
            {
              inventoryId: validated.id,
              counts: [{ inventoryItemId: uvInvItem.id, countedQty: 10 }],
            },
            testDb
          );
        } catch {
          editBlocked = true;
        }
        assertCondition(editBlocked, 'Inventaire validé non modifiable (Règle 9)');
        return `Inventaire ${validated.number} : écart de +5 (-2 -> 3) régularisé par mouvement explicite et verrouillé.`;
      }
    );

    // TEST 9 : Devis et conversion Devis -> Vente -> Facture -> Paiement
    await runTest(
      'T08',
      'Règle 5',
      'Devis sans impact stock puis conversion atomique Devis -> Vente -> Facture',
      async () => {
        const prodBefore = await testDb.products.get('prod-ro-7');
        const stockBefore = prodBefore!.stock;

        const quote = await executeCreateQuote(
          {
            customerId: 'cust-3',
            lines: [
              {
                productId: 'prod-ro-7',
                productRef: prodBefore!.reference,
                productName: prodBefore!.name,
                quantity: 1,
                unitPriceHtCents: 195000,
                discountPercent: 0,
                vatRate: 20,
              },
            ],
          },
          testDb
        );
        const stockAfterQuote = (await testDb.products.get('prod-ro-7'))!.stock;
        assertCondition(stockAfterQuote === stockBefore, 'Devis ne modifie pas le stock');

        const conv = await executeConvertQuoteToSale(
          {
            quoteId: quote.id,
            paymentMethod: 'CARD',
            amountPaidCents: quote.totalTtcCents,
          },
          testDb
        );
        const stockAfterConv = (await testDb.products.get('prod-ro-7'))!.stock;
        assertCondition(stockAfterConv === stockBefore - 1, 'Conversion diminue le stock de 1');
        assertCondition(
          conv.sale.quoteId === quote.id && conv.invoice.quoteId === quote.id,
          'Lien explicite Devis -> Vente -> Facture préservé'
        );
        return `Devis ${quote.number} converti en Vente ${conv.sale.number} et Facture ${conv.invoice.number}.`;
      }
    );

    // TEST 10 : Suppression logique Client, Produit, Fournisseur et interdiction suppression document
    await runTest(
      'T09',
      'Règles 8, 15, 16, 17 & 18',
      'Suppression logique Client/Produit/Fournisseur avec historique & préservation SAV',
      async () => {
        let docDeleteBlocked = false;
        try {
          await executeAttemptPhysicalDeleteDocument(
            { entityType: 'SALE', entityId: 'any-sale' },
            testDb
          );
        } catch {
          docDeleteBlocked = true;
        }
        assertCondition(docDeleteBlocked, 'Règle 8 : Suppression physique document bloquée');

        let docEditBlocked = false;
        try {
          await executeAttemptModifyValidatedDocument(
            { entityType: 'INVOICE', entityId: 'inv-1', documentNumber: 'FAC-TEST' },
            testDb
          );
        } catch {
          docEditBlocked = true;
        }
        assertCondition(docEditBlocked, 'Règle 9 : Modification document validé bloquée');

        const custRes = await executeDeleteOrDeactivateCustomer('cust-1', undefined, testDb);
        const prodRes = await executeDeleteOrDeactivateProduct('prod-ro-7', undefined, testDb);
        const supRes = await executeDeleteOrDeactivateSupplier('sup-1', undefined, testDb);

        // Vérifier que les équipements du client désactivé restent liés (Règle 18)
        const equips = await testDb.customerEquipments
          .where('customerId')
          .equals('cust-1')
          .toArray();

        assertCondition(custRes.mode === 'DEACTIVATED', 'Règle 15 : Client désactivé logiquement');
        assertCondition(prodRes.mode === 'DEACTIVATED', 'Règle 16 : Produit désactivé logiquement');
        assertCondition(supRes.mode === 'DEACTIVATED', 'Règle 17 : Fournisseur désactivé logiquement');
        assertCondition(equips.length > 0, 'Règle 18 : Équipements SAV du client préservés');

        // Réactiver pour la suite
        await testDb.customers.update('cust-1', { active: true });
        await testDb.products.update('prod-ro-7', { active: true });
        await testDb.suppliers.update('sup-1', { active: true });

        return 'Désactivations logiques Règles 15/16/17/18 et blocages Règles 8/9 vérifiés.';
      }
    );

    // TEST 11 : Calcul Remise ligne + Remise globale + Multi-taux TVA
    await runTest(
      'T10',
      'Règles 10 & 11',
      'Cascade Remise ligne -> Sous-total -> Remise globale -> Multi-taux TVA (20%, 10%, 0%)',
      async () => {
        const calc = calculateDocumentLinesAndTotals(
          [
            {
              productId: 'p1',
              productRef: 'R1',
              productName: 'Osmoseur TVA 20%',
              quantity: 1,
              unitPriceHtCents: 100000, // 1000 MAD HT
              discountPercent: 10, // -> 900 MAD HT
              vatRate: 20,
            },
            {
              productId: 'p2',
              productRef: 'R2',
              productName: 'Service Installation TVA 10%',
              quantity: 1,
              unitPriceHtCents: 50000, // 500 MAD HT
              discountPercent: 0, // -> 500 MAD HT
              vatRate: 10,
            },
            {
              productId: 'p3',
              productRef: 'R3',
              productName: 'Équipement Exonéré TVA 0%',
              quantity: 1,
              unitPriceHtCents: 60000, // 600 MAD HT
              discountPercent: 0, // -> 600 MAD HT
              vatRate: 0,
            },
          ],
          10 // 10% de remise globale sur le sous-total (2000 MAD HT -> base taxable totale 1800 MAD HT)
        );

        assertCondition(calc.subtotalHtCents === 200000, 'Sous-total après remise ligne = 2000 MAD');
        assertCondition(calc.globalDiscountCents === 20000, 'Remise globale 10% = 200 MAD');
        assertCondition(calc.totalTaxableCents === 180000, 'Base taxable nette = 1800 MAD');
        // Ligne 1 base taxable = 900 - 90 = 810 MAD -> TVA 20% = 162 MAD
        // Ligne 2 base taxable = 500 - 50 = 450 MAD -> TVA 10% = 45 MAD
        // Ligne 3 base taxable = 600 - 60 = 540 MAD -> TVA 0% = 0 MAD
        // Total TVA = 162 + 45 + 0 = 207 MAD (20700 centimes)
        assertCondition(calc.totalVatCents === 20700, 'TVA multi-taux exacte = 207,00 MAD');
        assertCondition(calc.totalTtcCents === 200700, 'Total TTC exact = 2 007,00 MAD');
        return 'Calcul cascade HT 2000 -> Remise globale 200 -> Base 1800 -> TVA multi-taux (20%/10%/0%) 207 -> TTC 2007 MAD validé.';
      }
    );

    // TEST 12 : Fuseau horaire Africa/Casablanca autour de minuit
    await runTest(
      'T11',
      'Règle 20',
      'Interprétation des dates métier autour de minuit au fuseau Africa/Casablanca',
      async () => {
        // 23h30 UTC le 15 juin = 00h30 heure marocaine (UTC+1) le 16 juin
        const utcLateNight = '2026-06-15T23:30:00.000Z';
        const moroccoDate = getMoroccoBusinessDate(utcLateNight);
        assertCondition(
          moroccoDate === '2026-06-16',
          `23:30 UTC (00:30 Casablanca) doit donner 2026-06-16 (obtenu: ${moroccoDate})`
        );
        return `Horodatage UTC 2026-06-15T23:30:00Z rattaché à la journée marocaine ${moroccoDate}.`;
      }
    );

    // TEST 13 : Génération simultanée de numéros de documents sans doublon
    await runTest(
      'T12',
      'Règle 21',
      'Génération simultanée de 5 devis en parallèle sans aucun doublon de numéro',
      async () => {
        const concurrentQuotes = await Promise.all(
          [1, 2, 3, 4, 5].map((n) =>
            executeCreateQuote(
              {
                customerId: 'cust-1',
                lines: [
                  {
                    productId: 'prod-kit-3f',
                    productRef: 'KIT-PRE-10P-3X',
                    productName: `Kit #${n}`,
                    quantity: 1,
                    unitPriceHtCents: 12500,
                    discountPercent: 0,
                    vatRate: 20,
                  },
                ],
              },
              testDb
            )
          )
        );
        const numbers = concurrentQuotes.map((q) => q.number);
        const uniqueNumbers = new Set(numbers);
        assertCondition(
          uniqueNumbers.size === 5,
          `5 numéros uniques générés : ${numbers.join(', ')}`
        );
        return `5 opérations simultanées ont généré 5 numéros séquentiels distincts (${numbers[0]} à ${numbers[4]}).`;
      }
    );

    // TEST 14 : Échec en cours de transaction (Rollback atomique)
    await runTest(
      'T13',
      'Règle 22',
      "Échec d'une opération transactionnelle : rollback intégral Vente/Stock/Facture",
      async () => {
        const salesBefore = await testDb.sales.count();
        const stockBefore = (await testDb.products.get('prod-kit-3f'))!.stock;

        let rolledBack = false;
        try {
          await executeCreateSale(
            {
              customerId: 'cust-1',
              lines: [
                {
                  productId: 'prod-kit-3f',
                  productRef: 'KIT-PRE-10P-3X',
                  productName: 'Kit',
                  quantity: 3,
                  unitPriceHtCents: 12500,
                  discountPercent: 0,
                  vatRate: 20,
                },
              ],
              paymentMethod: 'CASH',
              amountPaidCents: 45000,
              simulateMidTransactionFailure: true,
            },
            testDb
          );
        } catch {
          rolledBack = true;
        }

        const salesAfter = await testDb.sales.count();
        const stockAfter = (await testDb.products.get('prod-kit-3f'))!.stock;
        assertCondition(rolledBack, 'Transaction interrompue par erreur simulée');
        assertCondition(salesAfter === salesBefore, 'Aucune vente partielle enregistrée');
        assertCondition(stockAfter === stockBefore, 'Stock intégralement restauré par rollback');
        return 'Rollback atomique vérifié : 0 vente partielle et stock inchangé après erreur critique.';
      }
    );

    // TEST 15 : Clôture de caisse et immutabilité des écritures clôturées
    await runTest(
      'T14',
      'Règle 13',
      'Clôture de caisse avec billetage et verrouillage des écritures clôturées',
      async () => {
        const audit = await executeCloseCashRegister(
          {
            counts: { '200': 10, '100': 5, '50': 2 },
            notes: 'Clôture test',
          },
          testDb
        );
        const entries = await testDb.cashEntries.toArray();
        assertCondition(
          entries.every((e) => e.isLockedByAudit),
          'Toutes les écritures de la période sont verrouillées'
        );

        let modifyBlocked = false;
        try {
          await executeAttemptModifyCashEntry(
            { cashEntryId: entries[0].id, newAmountCents: 999999 },
            testDb
          );
        } catch {
          modifyBlocked = true;
        }
        assertCondition(
          modifyBlocked,
          'Modification directe écriture caisse clôturée bloquée'
        );
        return `PV de caisse ${audit.number} (${audit.status}) généré ; écritures antérieures verrouillées.`;
      }
    );

    // TEST 16 : Import Excel contenant des erreurs + Caractères spéciaux/arabes/HTML
    await runTest(
      'T15',
      'Règle 25 & Section 53/54',
      'Import contenant des erreurs bloqué + Échappement XSS & support Arabe/Français',
      async () => {
        const report = await validateImportData(
          'PRODUCTS',
          [
            {
              reference: 'NEW-FILT-AR-01',
              name: 'مصفاة مياه أطلس — Filtre "L\'Eau Pure" <script>alert(1)</script>',
              salePriceDh: '150',
              vatRate: '20',
              stock: '10',
            },
            {
              reference: '', // Erreur : référence manquante
              name: 'Produit Invalide',
              salePriceDh: '-50',
              vatRate: '20',
              stock: '5',
            },
          ],
          {},
          testDb
        );

        assertCondition(report.errorRowsCount === 1, '1 ligne en erreur détectée');
        let partialImportBlocked = false;
        try {
          await executeCommitValidatedImport(report, { allowSkipErrors: false }, testDb);
        } catch {
          partialImportBlocked = true;
        }
        assertCondition(
          partialImportBlocked,
          'Règle 25 : Aucune donnée partielle enregistrée en cas d’erreur'
        );

        const escaped = escapeHtml('<script>alert("xss")</script>');
        assertCondition(
          !escaped.includes('<script>'),
          'Section 54 : Balises HTML correctement échappées'
        );
        return 'Validation import Règle 25, support caractères arabes/accents et protection XSS vérifiés.';
      }
    );

    // TEST 17 : Sauvegarde, Restauration vérifiée et Diagnostic post-restauration sous Code PIN Maître
    await runTest(
      'T16',
      'Règles 23, 24 & 26',
      'Sauvegarde, exigence code PIN Maître, rejet sauvegarde corrompue et restauration vérifiée',
      async () => {
        const backupObj = await createBackupPayloadObject(testDb);
        const validJson = JSON.stringify(backupObj);

        // 1. Test sécurité : Restauration refusée si code PIN Maître absent ou erroné
        let missingPinRejected = false;
        try {
          await validateAndRestoreBackup(validJson, undefined, testDb, { masterPinInput: '' });
        } catch {
          missingPinRejected = true;
        }
        assertCondition(missingPinRejected, 'Règle 26 : Restauration sans code PIN Maître rejetée');

        let wrongPinRejected = false;
        try {
          await validateAndRestoreBackup(validJson, undefined, testDb, { masterPinInput: '000000' });
        } catch {
          wrongPinRejected = true;
        }
        assertCondition(wrongPinRejected, 'Règle 26 : Restauration avec code PIN Maître erroné rejetée');

        // 2. Corrompre un mouvement de stock dans une copie pour tester le rejet Règle 26
        const corruptedObj = JSON.parse(validJson);
        corruptedObj.tables.stockMovements[0].stockAfter = 999999;
        let corruptRejected = false;
        try {
          await validateAndRestoreBackup(JSON.stringify(corruptedObj), undefined, testDb, { masterPinInput: '999999' });
        } catch {
          corruptRejected = true;
        }
        assertCondition(corruptRejected, 'Règle 26 : Sauvegarde avec stock incohérent rejetée');

        // 3. Restaurer la sauvegarde saine avec le PIN Maître valide (999999)
        const restoreRes = await validateAndRestoreBackup(validJson, undefined, testDb, { masterPinInput: '999999' });
        assertCondition(
          restoreRes.diagnosticReport.healthy,
          'Diagnostic post-restauration 100% sain'
        );

        const snap = await computeCentralFinancialSnapshot('30_DAYS', undefined, undefined, testDb);
        assertCondition(snap.periodCaTtcCents > 0, 'Moteur analytique centralisé opérationnel');
        return `Restauration vérifiée (${restoreRes.restoredTablesCount} tables) sous Code PIN Maître et diagnostic d'intégrité post-restauration conforme.`;
      }
    );

    // TEST 18 : Intervention SAV avec sortie de pièce du stock et création du prochain rappel
    await runTest(
      'T17',
      'Règle 18',
      'Intervention SAV avec consommation pièce du stock et renouvellement rappel',
      async () => {
        const reminders = await testDb.reminders.toArray();
        const targetRem = reminders[0];
        const prodBefore = await testDb.products.get('prod-kit-3f');
        const stockBefore = prodBefore!.stock;

        const savRes = await executeCompleteSavReminder(
          {
            reminderId: targetRem.id,
            consumedProductId: 'prod-kit-3f',
            consumedQty: 1,
            serviceFeeCents: 15000,
            paymentMethod: 'CASH',
            scheduleNextReminder: true,
          },
          testDb
        );

        const stockAfter = (await testDb.products.get('prod-kit-3f'))!.stock;
        assertCondition(stockAfter === stockBefore - 1, 'Pièce SAV déduite du stock (-1)');
        assertCondition(savRes.completed.status === 'EFFECTUE', 'Rappel marqué EFFECTUE');
        assertCondition(!!savRes.nextReminder, 'Prochain rappel périodique créé automatiquement');
        return `Intervention SAV validée : stock déduit de 1 et prochaine échéance planifiée au ${savRes.nextReminder?.dueDate}.`;
      }
    );
  } finally {
    await testDb.delete();
  }

  const passedCount = results.filter((r) => r.passed).length;
  return {
    executedAt: new Date().toISOString(),
    totalTests: results.length,
    passedCount,
    failedCount: results.length - passedCount,
    totalDurationMs: Math.round(performance.now() - suiteStart),
    results,
  };
}
