import { ContradictionRuleCode } from '../types/domain';

/**
 * SYSTÈME D'ARBITRAGE OBLIGATOIRE DES RÈGLES MÉTIER CONTRADICTOIRES
 * Priorité :
 * 1. Intégrité des données
 * 2. Intégrité financière
 * 3. Intégrité du stock
 * 4. Traçabilité et audit
 * 5. Cohérence des documents
 * 6. Expérience utilisateur
 */

export interface ArbitrageDecision {
  ruleCode: ContradictionRuleCode;
  title: string;
  conflictingRules: [string, string];
  impactedModules: string[];
  priorityApplied:
    | 'INTEGRITE_DONNEES'
    | 'INTEGRITE_FINANCIERE'
    | 'INTEGRITE_STOCK'
    | 'TRACABILITE_AUDIT'
    | 'COHERENCE_DOCUMENTS';
  allowed: boolean;
  resolutionMessage: string;
  requiresAudit: boolean;
}

export class ArbitrageError extends Error {
  public readonly decision: ArbitrageDecision;

  constructor(decision: ArbitrageDecision) {
    super(decision.resolutionMessage);
    this.name = 'ArbitrageError';
    this.decision = decision;
  }
}

export const ARBITRAGE_RULES_CATALOG: Record<
  ContradictionRuleCode,
  Omit<ArbitrageDecision, 'allowed' | 'resolutionMessage'>
> = {
  RULE_01_INSUFFICIENT_STOCK: {
    ruleCode: 'RULE_01_INSUFFICIENT_STOCK',
    title: 'Vente avec stock insuffisant bloquée',
    conflictingRules: ['La vente doit diminuer le stock', 'Le stock disponible est insuffisant'],
    impactedModules: ['POS', 'Ventes', 'Stock', 'Audit'],
    priorityApplied: 'INTEGRITE_STOCK',
    requiresAudit: true,
  },
  RULE_01_NEGATIVE_STOCK_AUTHORIZED: {
    ruleCode: 'RULE_01_NEGATIVE_STOCK_AUTHORIZED',
    title: 'Vente en stock négatif autorisée par paramètre explicite',
    conflictingRules: ['Stock physique nul ou insuffisant', 'Continuité commerciale autorisée en paramètre'],
    impactedModules: ['POS', 'Ventes', 'Stock', 'Audit'],
    priorityApplied: 'TRACABILITE_AUDIT',
    requiresAudit: true,
  },
  RULE_02_PAID_SALE_CANCELLATION: {
    ruleCode: 'RULE_02_PAID_SALE_CANCELLATION',
    title: "Annulation d'une vente déjà payée avec contre-passation",
    conflictingRules: ['Demande annulation vente', 'Paiement et encaissement déjà enregistrés'],
    impactedModules: ['Ventes', 'Factures', 'Paiements', 'Caisse', 'Stock', 'Clients', 'Audit'],
    priorityApplied: 'INTEGRITE_FINANCIERE',
    requiresAudit: true,
  },
  RULE_03_INVOICE_STATUS_COMPUTED: {
    ruleCode: 'RULE_03_INVOICE_STATUS_COMPUTED',
    title: 'Statut de facture calculé exclusivement depuis les paiements',
    conflictingRules: ['Modification directe statut facture', 'Somme réelle des paiements validés'],
    impactedModules: ['Factures', 'Paiements', 'Finance'],
    priorityApplied: 'INTEGRITE_FINANCIERE',
    requiresAudit: false,
  },
  RULE_04_PAYMENT_DESTINATION_ROUTING: {
    ruleCode: 'RULE_04_PAYMENT_DESTINATION_ROUTING',
    title: 'Séparation stricte Caisse physique vs Banque / Effets',
    conflictingRules: ['Encaissement enregistré', 'Mode de paiement non-espèces (Carte, Virement, Chèque)'],
    impactedModules: ['Paiements', 'Caisse', 'Finance'],
    priorityApplied: 'INTEGRITE_FINANCIERE',
    requiresAudit: false,
  },
  RULE_05_QUOTE_NO_STOCK_IMPACT: {
    ruleCode: 'RULE_05_QUOTE_NO_STOCK_IMPACT',
    title: 'Devis sans impact stock avant conversion explicite en vente',
    conflictingRules: ['Création/modification de devis', 'Disponibilité du stock réel'],
    impactedModules: ['Devis', 'Ventes', 'Factures', 'Stock'],
    priorityApplied: 'INTEGRITE_STOCK',
    requiresAudit: false,
  },
  RULE_06_PURCHASE_STOCK_ON_RECEIPT_ONLY: {
    ruleCode: 'RULE_06_PURCHASE_STOCK_ON_RECEIPT_ONLY',
    title: 'Entrée en stock uniquement sur réception effective de marchandise',
    conflictingRules: ['Commande fournisseur créée', 'Réception physique partielle ou complète'],
    impactedModules: ['Achats', 'Stock', 'Fournisseurs'],
    priorityApplied: 'INTEGRITE_STOCK',
    requiresAudit: true,
  },
  RULE_07_INVENTORY_EXPLICIT_VARIANCE: {
    ruleCode: 'RULE_07_INVENTORY_EXPLICIT_VARIANCE',
    title: 'Validation inventaire par mouvements explicites sans écrasement silencieux',
    conflictingRules: ['Stock théorique vs Stock compté', 'Traçabilité historique des mouvements'],
    impactedModules: ['Inventaire', 'Stock', 'Audit'],
    priorityApplied: 'INTEGRITE_STOCK',
    requiresAudit: true,
  },
  RULE_08_PHYSICAL_DELETE_FORBIDDEN: {
    ruleCode: 'RULE_08_PHYSICAL_DELETE_FORBIDDEN',
    title: "Interdiction de suppression physique d'un document financier validé",
    conflictingRules: ['Demande de suppression utilisateur', 'Conservation légale et comptable'],
    impactedModules: ['Ventes', 'Factures', 'Paiements', 'Achats', 'Dépenses', 'Audit'],
    priorityApplied: 'INTEGRITE_DONNEES',
    requiresAudit: true,
  },
  RULE_09_VALIDATED_DOC_IMMUTABLE: {
    ruleCode: 'RULE_09_VALIDATED_DOC_IMMUTABLE',
    title: "Immutabilité d'un document déjà validé",
    conflictingRules: ['Édition directe document validé', 'Cohérence stock, TVA, caisse et paiements'],
    impactedModules: ['Ventes', 'Factures', 'Inventaire', 'Achats', 'Audit'],
    priorityApplied: 'COHERENCE_DOCUMENTS',
    requiresAudit: true,
  },
  RULE_10_LINE_LEVEL_VAT: {
    ruleCode: 'RULE_10_LINE_LEVEL_VAT',
    title: 'Calcul de TVA ligne par ligne multi-taux',
    conflictingRules: ['Taux de TVA globaux simplifiés', 'Produits avec taux distincts (20%, 10%, 7%, 0%)'],
    impactedModules: ['POS', 'Ventes', 'Devis', 'Factures', 'Achats', 'Finance'],
    priorityApplied: 'INTEGRITE_FINANCIERE',
    requiresAudit: false,
  },
  RULE_11_DISCOUNT_WATERFALL_ORDER: {
    ruleCode: 'RULE_11_DISCOUNT_WATERFALL_ORDER',
    title: 'Ordre en cascade Remise ligne -> Sous-total -> Remise globale -> TVA',
    conflictingRules: ['Cumul remise ligne et remise globale', 'Unicité de la base taxable'],
    impactedModules: ['POS', 'Ventes', 'Devis', 'Factures', 'Impression'],
    priorityApplied: 'INTEGRITE_FINANCIERE',
    requiresAudit: false,
  },
  RULE_12_LINKED_CUSTOMER_RETURN: {
    ruleCode: 'RULE_12_LINKED_CUSTOMER_RETURN',
    title: "Retour client rattaché à la vente d'origine",
    conflictingRules: ['Retour marchandise client', 'Vente et paiement initiaux'],
    impactedModules: ['Ventes', 'Stock', 'Factures', 'Paiements', 'Caisse', 'Audit'],
    priorityApplied: 'COHERENCE_DOCUMENTS',
    requiresAudit: true,
  },
  RULE_13_CLOSED_CASH_IMMUTABLE: {
    ruleCode: 'RULE_13_CLOSED_CASH_IMMUTABLE',
    title: 'Verrouillage des écritures de caisse après clôture',
    conflictingRules: ['Modification écriture période clôturée', 'Intégrité du PV de clôture de caisse'],
    impactedModules: ['Caisse', 'Finance', 'Audit'],
    priorityApplied: 'INTEGRITE_FINANCIERE',
    requiresAudit: true,
  },
  RULE_14_NEGATIVE_STOCK_INVENTORY_DELTA: {
    ruleCode: 'RULE_14_NEGATIVE_STOCK_INVENTORY_DELTA',
    title: "Ajustement d'inventaire depuis un stock négatif",
    conflictingRules: ['Stock théorique négatif', 'Comptage physique positif ou nul'],
    impactedModules: ['Inventaire', 'Stock', 'Audit'],
    priorityApplied: 'INTEGRITE_STOCK',
    requiresAudit: true,
  },
  RULE_15_CUSTOMER_LOGICAL_DELETE_ONLY: {
    ruleCode: 'RULE_15_CUSTOMER_LOGICAL_DELETE_ONLY',
    title: 'Désactivation logique obligatoire pour client avec historique',
    conflictingRules: ['Suppression fiche client', 'Existence de ventes, factures, équipements ou SAV'],
    impactedModules: ['Clients', 'Ventes', 'Factures', 'Équipements', 'SAV', 'Audit'],
    priorityApplied: 'INTEGRITE_DONNEES',
    requiresAudit: true,
  },
  RULE_16_PRODUCT_LOGICAL_DELETE_ONLY: {
    ruleCode: 'RULE_16_PRODUCT_LOGICAL_DELETE_ONLY',
    title: 'Désactivation logique obligatoire pour produit avec mouvements',
    conflictingRules: ['Suppression fiche produit', 'Existence de mouvements de stock, ventes ou achats'],
    impactedModules: ['Produits', 'Stock', 'Ventes', 'Achats', 'Audit'],
    priorityApplied: 'INTEGRITE_DONNEES',
    requiresAudit: true,
  },
  RULE_17_SUPPLIER_LOGICAL_DELETE_ONLY: {
    ruleCode: 'RULE_17_SUPPLIER_LOGICAL_DELETE_ONLY',
    title: 'Désactivation logique obligatoire pour fournisseur avec historique',
    conflictingRules: ['Suppression fiche fournisseur', 'Existence de commandes ou paiements fournisseurs'],
    impactedModules: ['Fournisseurs', 'Achats', 'Paiements', 'Audit'],
    priorityApplied: 'INTEGRITE_DONNEES',
    requiresAudit: true,
  },
  RULE_18_SAV_EQUIPMENT_PRESERVATION_AND_STOCK: {
    ruleCode: 'RULE_18_SAV_EQUIPMENT_PRESERVATION_AND_STOCK',
    title: 'Préservation chaîne Client -> Équipement -> SAV et sortie stock pièce',
    conflictingRules: ['Client désactivé ou consommation pièce SAV', 'Continuité suivi technique et stock'],
    impactedModules: ['Clients', 'Équipements', 'SAV', 'Stock', 'Paiements'],
    priorityApplied: 'INTEGRITE_DONNEES',
    requiresAudit: true,
  },
  RULE_19_OVERPAYMENT_ARBITRAGE: {
    ruleCode: 'RULE_19_OVERPAYMENT_ARBITRAGE',
    title: 'Arbitrage des paiements supérieurs au solde restant dû',
    conflictingRules: ['Montant payé > Solde dû', 'Exactitude des soldes factures'],
    impactedModules: ['Factures', 'Paiements', 'Clients', 'Finance', 'Audit'],
    priorityApplied: 'INTEGRITE_FINANCIERE',
    requiresAudit: true,
  },
  RULE_20_MOROCCO_TIMEZONE_BUSINESS_DATE: {
    ruleCode: 'RULE_20_MOROCCO_TIMEZONE_BUSINESS_DATE',
    title: 'Rattachement des opérations au fuseau Africa/Casablanca',
    conflictingRules: ['Heure UTC système autour de minuit', 'Journée commerciale marocaine réelle'],
    impactedModules: ['POS', 'Ventes', 'Caisse', 'Dashboard', 'Statistiques'],
    priorityApplied: 'COHERENCE_DOCUMENTS',
    requiresAudit: false,
  },
  RULE_21_TRANSACTIONAL_SEQUENCE: {
    ruleCode: 'RULE_21_TRANSACTIONAL_SEQUENCE',
    title: 'Numérotation séquentielle atomique sans doublon',
    conflictingRules: ['Créations simultanées de documents', 'Unicité stricte des numéros séquentiels'],
    impactedModules: ['Devis', 'Ventes', 'Factures', 'Achats', 'Paiements', 'Inventaire'],
    priorityApplied: 'INTEGRITE_DONNEES',
    requiresAudit: false,
  },
  RULE_22_ATOMIC_MUTATION_ROLLBACK: {
    ruleCode: 'RULE_22_ATOMIC_MUTATION_ROLLBACK',
    title: 'Transaction atomique multi-modules avec rollback intégral',
    conflictingRules: ['Échec partiel en cours de validation', 'Cohérence croisée Vente/Stock/Caisse/Audit'],
    impactedModules: ['Base de données', 'Tous les modules'],
    priorityApplied: 'INTEGRITE_DONNEES',
    requiresAudit: true,
  },
  RULE_23_CENTRAL_DASHBOARD_METRICS: {
    ruleCode: 'RULE_23_CENTRAL_DASHBOARD_METRICS',
    title: 'Unicité du moteur de calcul des indicateurs financiers',
    conflictingRules: ['Affichage Dashboard vs Module Finance vs Analyse', 'Exactitude des agrégats'],
    impactedModules: ['Dashboard', 'Finance', 'Intelligence'],
    priorityApplied: 'INTEGRITE_FINANCIERE',
    requiresAudit: false,
  },
  RULE_24_EXCLUDE_CANCELLED_FROM_STATS: {
    ruleCode: 'RULE_24_EXCLUDE_CANCELLED_FROM_STATS',
    title: 'Exclusion des documents annulés et entités archivées des statistiques actives',
    conflictingRules: ['Conservation historique des annulations', 'Vérité du CA, des encaissements et du stock'],
    impactedModules: ['Dashboard', 'Finance', 'Intelligence', 'Ventes', 'Factures'],
    priorityApplied: 'INTEGRITE_FINANCIERE',
    requiresAudit: false,
  },
  RULE_25_VALIDATED_IMPORT_PIPELINE: {
    ruleCode: 'RULE_25_VALIDATED_IMPORT_PIPELINE',
    title: 'Validation préalable et transaction atomique des imports Excel/CSV',
    conflictingRules: ['Fichier importé contenant des anomalies', 'Intégrité de la base locale'],
    impactedModules: ['Import/Export', 'Produits', 'Clients', 'Fournisseurs', 'Audit'],
    priorityApplied: 'INTEGRITE_DONNEES',
    requiresAudit: true,
  },
  RULE_26_VERIFIED_BACKUP_RESTORE: {
    ruleCode: 'RULE_26_VERIFIED_BACKUP_RESTORE',
    title: 'Exigence du Code PIN Maître et vérification structurelle/relationnelle avant restauration',
    conflictingRules: ['Restauration fichier externe', 'Protection contre la corruption de base et écrasement non autorisé'],
    impactedModules: ['Sauvegardes', 'Sécurité PIN Maître', 'Diagnostic', 'Audit'],
    priorityApplied: 'INTEGRITE_DONNEES',
    requiresAudit: true,
  },
};

export function buildArbitrageDecision(
  ruleCode: ContradictionRuleCode,
  allowed: boolean,
  resolutionMessage: string
): ArbitrageDecision {
  const meta = ARBITRAGE_RULES_CATALOG[ruleCode];
  return {
    ...meta,
    allowed,
    resolutionMessage,
  };
}

/**
 * RÈGLE 1 : Arbitrage Vente vs Stock disponible
 */
export function arbitrateSaleStock(params: {
  productName: string;
  productRef: string;
  availableStock: number;
  requestedQty: number;
  allowNegativeStock: boolean;
}): ArbitrageDecision {
  const { productName, productRef, availableStock, requestedQty, allowNegativeStock } = params;
  if (requestedQty <= availableStock) {
    return buildArbitrageDecision(
      'RULE_01_INSUFFICIENT_STOCK',
      true,
      `Stock suffisant pour ${productName} (${productRef}) : demandé ${requestedQty}, disponible ${availableStock}.`
    );
  }
  if (!allowNegativeStock) {
    return buildArbitrageDecision(
      'RULE_01_INSUFFICIENT_STOCK',
      false,
      `Arbitrage Règle 1 [Stock Insuffisant] : Impossible de vendre ${requestedQty} × "${productName}" (${productRef}). Quantité disponible : ${availableStock}, quantité demandée : ${requestedQty}. La vente en stock négatif est désactivée dans les paramètres.`
    );
  }
  return buildArbitrageDecision(
    'RULE_01_NEGATIVE_STOCK_AUTHORIZED',
    true,
    `Arbitrage Règle 1 [Stock Négatif Autorisé] : Vente de ${requestedQty} × "${productName}" (${productRef}) avec stock disponible ${availableStock} (nouveau stock : ${availableStock - requestedQty}). Opération tracée dans le journal d'audit.`
  );
}

/**
 * RÈGLE 3 & 19 : Arbitrage Paiement vs Solde restant dû
 */
export function arbitratePaymentAmount(params: {
  documentNumber: string;
  remainingDueCents: number;
  paymentAmountCents: number;
  allowOverpayment: boolean;
  confirmedOverpayment?: boolean;
}): ArbitrageDecision {
  const {
    documentNumber,
    remainingDueCents,
    paymentAmountCents,
    allowOverpayment,
    confirmedOverpayment,
  } = params;

  if (paymentAmountCents <= 0) {
    return buildArbitrageDecision(
      'RULE_19_OVERPAYMENT_ARBITRAGE',
      false,
      `Le montant du paiement doit être strictement supérieur à 0,00 MAD.`
    );
  }

  if (paymentAmountCents <= remainingDueCents) {
    return buildArbitrageDecision(
      'RULE_03_INVOICE_STATUS_COMPUTED',
      true,
      `Paiement conforme au solde restant dû sur ${documentNumber}.`
    );
  }

  const excessDh = ((paymentAmountCents - remainingDueCents) / 100).toFixed(2);
  const dueDh = (remainingDueCents / 100).toFixed(2);
  const paidDh = (paymentAmountCents / 100).toFixed(2);

  if (!allowOverpayment || !confirmedOverpayment) {
    return buildArbitrageDecision(
      'RULE_19_OVERPAYMENT_ARBITRAGE',
      false,
      `Arbitrage Règles 3 & 19 [Paiement > Solde restant] : Le paiement saisi (${paidDh} MAD) dépasse le solde restant dû (${dueDh} MAD) de ${excessDh} MAD sur ${documentNumber}. Activez et confirmez la génération d'avoir/crédit client ou ajustez le montant.`
    );
  }

  return buildArbitrageDecision(
    'RULE_19_OVERPAYMENT_ARBITRAGE',
    true,
    `Arbitrage Règle 19 [Trop-perçu converti en Crédit Client] : Le solde de ${dueDh} MAD sur ${documentNumber} est réglé et l'excédent de ${excessDh} MAD est enregistré explicitement en crédit/avoir client.`
  );
}
