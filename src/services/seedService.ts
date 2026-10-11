import {
  AtlasSoftWaterDB,
  CURRENT_SCHEMA_VERSION,
  db,
  DEFAULT_PREFIXES,
  getAllTables,
} from '../db/database';
import {
  executeAddEquipmentAndSavReminder,
  executeCreateExpense,
  executeCreatePurchaseOrder,
  executeCreateQuote,
  executeCreateSale,
  executeReceivePurchaseItems,
} from './commandService';
import {
  AppSettings,
  Brand,
  Category,
  CompanyInfo,
  Customer,
  MarketObservation,
  Product,
  Supplier,
  UserProfile,
} from '../types/domain';
import {
  addDaysToBusinessDate,
  addMonthsToBusinessDate,
  getMoroccoBusinessDate,
} from '../utils/dateUtils';
import {
  generateId,
  generateRandomSalt,
  hashPinWithSalt,
} from '../utils/securityUtils';

export interface FirstRunSetupInput {
  companyName: string;
  legalName: string;
  ice: string;
  ifNumber: string;
  rc: string;
  patente: string;
  cnss: string;
  address: string;
  city: string;
  phone: string;
  whatsapp: string;
  email: string;
  defaultVatRate: number;
  currency: string;
  pin: string;
  masterPin: string;
  loadDemoData: boolean;
  logoDataUrl?: string;
  adminName?: string;
}

export async function initializeDatabaseIfNeeded(targetDb: AtlasSoftWaterDB = db): Promise<void> {
  // Nettoyage proactif de l'ancien fond de caisse initial de 2 000 DH (le solde de départ est strictement 0 par défaut)
  try {
    const legacyFloats = await targetDb.cashEntries
      .filter((e) => e.sourceId === 'INIT' || e.sourceNumber === 'OUV-CAISSE')
      .toArray();
    for (const f of legacyFloats) {
      await targetDb.cashEntries.delete(f.id);
    }
  } catch {
    // ignore
  }

  const existingCompany = await targetDb.company.get('default');
  if (existingCompany) return;

  // Initialisation avec données de démonstration explicitement identifiées (Section 49)
  await initializeWithSetupConfig(
    {
      companyName: 'ATLAS SOFT WATER',
      legalName: 'ATLAS SOFT WATER MAROC SARL AU',
      ice: '003194827000054',
      ifNumber: '52849103',
      rc: '549201 (Casablanca)',
      patente: '34910284',
      cnss: '4829104',
      address: 'Bd Abdelmoumen, Technopole Anfa, N° 142',
      city: 'Casablanca',
      phone: '+212 5 22 48 91 00',
      whatsapp: '+212 6 61 48 91 00',
      email: 'contact@atlassoftwater.ma',
      defaultVatRate: 20,
      currency: 'MAD',
      pin: '2468',
      masterPin: '135790',
      loadDemoData: true,
    },
    targetDb
  );
}

export async function initializeWithSetupConfig(
  input: FirstRunSetupInput,
  targetDb: AtlasSoftWaterDB = db
): Promise<void> {
  const now = new Date().toISOString();
  const today = getMoroccoBusinessDate(now);

  const pinSalt = generateRandomSalt();
  const pinHash = await hashPinWithSalt(input.pin, pinSalt);
  const masterSalt = generateRandomSalt();
  const masterHash = await hashPinWithSalt(input.masterPin, masterSalt);

  await targetDb.transaction('rw', getAllTables(targetDb), async () => {
    for (const table of getAllTables(targetDb)) {
      await table.clear();
    }

    const counterCustomerId = generateId();

    const company: CompanyInfo = {
      id: 'default',
      name: input.companyName,
      legalName: input.legalName,
      ice: input.ice,
      ifNumber: input.ifNumber,
      rc: input.rc,
      patente: input.patente,
      cnss: input.cnss,
      defaultVatRate: input.defaultVatRate,
      currency: input.currency,
      address: input.address,
      city: input.city,
      phone: input.phone,
      whatsapp: input.whatsapp,
      email: input.email,
      paymentTerms: 'Paiement à la livraison ou 30 jours fin de mois pour comptes professionnels.',
      legalMentions:
        'Marchandises garanties 12 mois hors consommables (cartouches, membranes et lampes UV). Pénalité de retard selon la loi 69-21.',
      logoText: 'ASW',
      logoDataUrl: input.logoDataUrl,
      headerMentions:
        "Traitement de l'eau, Filtration et Purificateur d'eau domestique et industriel",
      watermarkEnabled: false,
      watermarkOpacity: 100,
      isDemoData: input.loadDemoData,
      setupCompleted: true,
      createdAt: now,
      updatedAt: now,
    };

    const settings: AppSettings = {
      id: 'default',
      schemaVersion: CURRENT_SCHEMA_VERSION,
      defaultVatRate: input.defaultVatRate,
      availableVatRates: [20, 14, 10, 7, 0],
      currency: input.currency,
      allowNegativeStock: false,
      allowOverpayment: false,
      autoPrintTicket: false,
      defaultCounterCustomerId: counterCustomerId,
      lockTimeoutMinutes: 15,
      theme: 'light',
      ollamaUrl: 'http://localhost:11434',
      ollamaModel: 'llama3.2',
      enableExternalAi: false,
      prefixes: { ...DEFAULT_PREFIXES },
      updatedAt: now,
    };

    const adminDisplayName =
      input.adminName && input.adminName.trim().length > 0
        ? input.adminName.trim()
        : 'Youssef El Amrani (Dirigeant)';

    const profiles: UserProfile[] = [
      {
        id: 'admin',
        name: adminDisplayName,
        role: 'ADMIN',
        pinHash,
        pinSalt,
        masterPinHash: masterHash,
        masterPinSalt: masterSalt,
        active: true,
        failedAttempts: 0,
        lockedUntil: null,
        createdAt: now,
        updatedAt: now,
      },
      ...(input.loadDemoData
        ? ([
            {
              id: 'seller-1',
              name: 'Salma Bennani (Comptoir POS)',
              role: 'SELLER',
              pinHash,
              pinSalt,
              masterPinHash: masterHash,
              masterPinSalt: masterSalt,
              active: true,
              failedAttempts: 0,
              lockedUntil: null,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: 'tech-1',
              name: 'Karim Tazi (Technicien SAV)',
              role: 'TECHNICIAN',
              pinHash,
              pinSalt,
              masterPinHash: masterHash,
              masterPinSalt: masterSalt,
              active: true,
              failedAttempts: 0,
              lockedUntil: null,
              createdAt: now,
              updatedAt: now,
            },
            {
              id: 'acc-1',
              name: 'Nadia Chraibi (Comptabilité)',
              role: 'ACCOUNTANT',
              pinHash,
              pinSalt,
              masterPinHash: masterHash,
              masterPinSalt: masterSalt,
              active: true,
              failedAttempts: 0,
              lockedUntil: null,
              createdAt: now,
              updatedAt: now,
            },
          ] satisfies UserProfile[])
        : []),
    ];

    const counterCustomer: Customer = {
      id: counterCustomerId,
      code: 'CLI-COMPTOIR',
      name: 'Client Comptoir (Passage)',
      type: 'PARTICULIER',
      phone: '',
      whatsapp: '',
      email: '',
      address: input.city,
      city: input.city,
      ice: '',
      notes: 'Client par défaut pour les ventes rapides au comptoir POS.',
      balanceCents: 0,
      creditAvailableCents: 0,
      active: true,
      isDemo: input.loadDemoData,
      createdAt: now,
      updatedAt: now,
    };

    await targetDb.company.add(company);
    await targetDb.settings.add(settings);
    await targetDb.profiles.bulkAdd(profiles);
    await targetDb.customers.add(counterCustomer);
    // Solde de caisse de départ strictement égal à 0 DH par défaut (l'alimentation se fait via Dépenses)
  });

  if (!input.loadDemoData) return;

  // Peuplement des DONNÉES DE DÉMONSTRATION (Section 49)
  const categories: Category[] = [
    {
      id: 'cat-ro',
      name: 'Osmose Inverse Domestique & Pro',
      parentCategory: 'Systèmes Complets',
      description: 'Osmoseurs 5, 6, 7 étapes et systèmes commerciaux 400-800 GPD',
      active: true,
      createdAt: now,
    },
    {
      id: 'cat-membranes',
      name: 'Membranes Osmose Inverse',
      parentCategory: 'Consommables',
      description: 'Membranes TFC 75 GPD, 100 GPD, 400 GPD, 4040 et 8040',
      active: true,
      createdAt: now,
    },
    {
      id: 'cat-cartouches',
      name: 'Cartouches & Préfiltres',
      parentCategory: 'Consommables',
      description: 'Cartouches PP sédiments, charbon actif GAC, bloc CTO, post-filtre T33',
      active: true,
      createdAt: now,
    },
    {
      id: 'cat-adoucisseurs',
      name: 'Adoucisseurs & Résines',
      parentCategory: 'Systèmes Complets',
      description: 'Adoucisseurs volumétriques 20L/30L/50L, vannes Fleck/Clack et résines',
      active: true,
      createdAt: now,
    },
    {
      id: 'cat-uv-pieces',
      name: 'Stérilisateurs UV & Pièces Détachées',
      parentCategory: 'Équipements Techniques',
      description: 'Chambres UV inox, lampes UV-C, pompes booster 24V/36V, vannes et raccords',
      active: true,
      createdAt: now,
    },
  ];

  const brands: Brand[] = [
    { id: 'br-filmtec', name: 'DuPont FilmTec', country: 'USA', notes: 'Membranes haute réjection', active: true, createdAt: now },
    { id: 'br-pentair', name: 'Pentair Fleck', country: 'USA / Europe', notes: 'Vannes et adoucisseurs', active: true, createdAt: now },
    { id: 'br-atlas', name: 'Atlas Filtri', country: 'Italie', notes: 'Porte-filtres et cartouches', active: true, createdAt: now },
    { id: 'br-aquapro', name: 'AquaPro Maroc', country: 'Taïwan / Maroc', notes: 'Systèmes RO et pompes booster', active: true, createdAt: now },
  ];

  const suppliers: Supplier[] = [
    {
      id: 'sup-1',
      code: 'FOUR-2026-0001',
      name: 'MAGHREB HYDRO TECH IMPORT',
      contactName: 'M. Rachid Berrada',
      phone: '+212 5 22 35 12 80',
      whatsapp: '+212 6 61 35 12 80',
      email: 'commandes@maghrebhydro.ma',
      city: 'Casablanca (Aïn Sebaâ)',
      address: 'Zone Industrielle Aïn Sebaâ, Allée des Orangers N° 18',
      ice: '001928374000081',
      ifNumber: '40192831',
      rc: '291045',
      paymentTerms: '60 jours fin de mois',
      totalPurchasesCents: 0,
      debtCents: 0,
      notes: '[DONNÉES DE DÉMONSTRATION] Importateur officiel membranes FilmTec et vannes Pentair.',
      active: true,
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'sup-2',
      code: 'FOUR-2026-0002',
      name: 'EUROFILTRATION TANGER MED',
      contactName: 'Mme Sofia Alaoui',
      phone: '+212 5 39 32 44 10',
      whatsapp: '+212 6 62 32 44 10',
      email: 'logistique@eurofiltration.ma',
      city: 'Tanger',
      address: 'Tanger Free Zone, Ilot 14',
      ice: '002481920000039',
      ifNumber: '33849102',
      rc: '88412',
      paymentTerms: '30 jours net',
      totalPurchasesCents: 0,
      debtCents: 0,
      notes: '[DONNÉES DE DÉMONSTRATION] Grossiste osmoseurs domestiques, cartouches et UV.',
      active: true,
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const products: Product[] = [
    {
      id: 'prod-ro-7',
      reference: 'RO-DOM-75G-7S',
      barcode: '6111240001014',
      name: 'Osmoseur Domestique 7 Étapes 75 GPD avec Pompe Booster & Reminéralisation',
      categoryId: 'cat-ro',
      categoryName: 'Osmose Inverse Domestique & Pro',
      subCategory: 'Domestique Sous-Évier',
      brandId: 'br-aquapro',
      brandName: 'AquaPro Maroc',
      description: 'Système complet 7 étapes avec pompe booster 24V silencieuse, réservoir 12L métal et cartouche alcaline/calcite.',
      photoUrl: '',
      purchasePriceCents: 115000, // 1 150,00 MAD HT
      salePriceHtCents: 195000, // 1 950,00 MAD HT (2 340,00 TTC)
      minSalePriceHtCents: 175000,
      vatRate: 20,
      stock: 8,
      minStock: 4,
      maxStock: 25,
      unit: 'Unité',
      supplierId: 'sup-2',
      supplierName: 'EUROFILTRATION TANGER MED',
      location: 'Allée A - Rack 01',
      replacementMonths: 6,
      compatibleModels: 'Cartouches standard 10 pouces / Membrane 1812-75',
      notes: '[DONNÉES DE DÉMONSTRATION]',
      active: true,
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'prod-kit-3f',
      reference: 'KIT-PRE-10P-3X',
      barcode: '6111240001021',
      name: 'Pack Entretien 3 Préfiltres 10" (PP 5µm + Charbon GAC + Bloc CTO)',
      categoryId: 'cat-cartouches',
      categoryName: 'Cartouches & Préfiltres',
      subCategory: 'Kits Maintenance 6 mois',
      brandId: 'br-atlas',
      brandName: 'Atlas Filtri',
      description: 'Kit complet de remplacement semestriel pour osmoseur 5 à 7 étapes.',
      photoUrl: '',
      purchasePriceCents: 4500, // 45,00 MAD HT
      salePriceHtCents: 12500, // 125,00 MAD HT (150,00 TTC)
      minSalePriceHtCents: 10000,
      vatRate: 20,
      stock: 34,
      minStock: 15,
      maxStock: 100,
      unit: 'Kit',
      supplierId: 'sup-2',
      supplierName: 'EUROFILTRATION TANGER MED',
      location: 'Allée B - Bac 04',
      replacementMonths: 6,
      compatibleModels: 'Tous osmoseurs carters 10" standard',
      notes: '[DONNÉES DE DÉMONSTRATION]',
      active: true,
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'prod-memb-75',
      reference: 'MEMB-FT-75GPD',
      barcode: '6111240001038',
      name: 'Membrane Osmose Inverse DuPont FilmTec TW30-1812-75 GPD Authentique',
      categoryId: 'cat-membranes',
      categoryName: 'Membranes Osmose Inverse',
      subCategory: 'Membranes Domestiques 1812',
      brandId: 'br-filmtec',
      brandName: 'DuPont FilmTec',
      description: 'Membrane polyamide composite TFC haute réjection saline (98%), certifiée NSF/ANSI 58.',
      photoUrl: '',
      purchasePriceCents: 18500, // 185,00 MAD HT
      salePriceHtCents: 32000, // 320,00 MAD HT (384,00 TTC)
      minSalePriceHtCents: 28000,
      vatRate: 20,
      stock: 14,
      minStock: 8,
      maxStock: 50,
      unit: 'Unité',
      supplierId: 'sup-1',
      supplierName: 'MAGHREB HYDRO TECH IMPORT',
      location: 'Allée B - Coffre 01',
      replacementMonths: 24,
      compatibleModels: 'Porte-membrane standard 1812 / 2012',
      notes: '[DONNÉES DE DÉMONSTRATION]',
      active: true,
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'prod-memb-4040',
      reference: 'MEMB-FT-LCLE-4040',
      barcode: '6111240001045',
      name: 'Membrane Industrielle FilmTec LCLE-4040 Basse Énergie (2500 GPD)',
      categoryId: 'cat-membranes',
      categoryName: 'Membranes Osmose Inverse',
      subCategory: 'Membranes Industrielles 4"',
      brandId: 'br-filmtec',
      brandName: 'DuPont FilmTec',
      description: 'Membrane 4"×40" haute productivité basse pression pour cafés, hôtels, laboratoires et stations.',
      photoUrl: '',
      purchasePriceCents: 185000, // 1 850,00 MAD HT
      salePriceHtCents: 265000, // 2 650,00 MAD HT (3 180,00 TTC)
      minSalePriceHtCents: 240000,
      vatRate: 20,
      stock: 2, // Stock critique pour démonstration badge
      minStock: 5,
      maxStock: 15,
      unit: 'Unité',
      supplierId: 'sup-1',
      supplierName: 'MAGHREB HYDRO TECH IMPORT',
      location: 'Allée C - Rack Lourd 02',
      replacementMonths: 24,
      compatibleModels: 'Corps de pression 4040 Inox ou PRV',
      notes: '[DONNÉES DE DÉMONSTRATION]',
      active: true,
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'prod-adouc-25l',
      reference: 'ADOUC-FLECK-5600-25L',
      barcode: '6111240001052',
      name: 'Adoucisseur Volumétrique 25L Résine Monosphère avec Vanne Pentair Fleck 5600 SXT',
      categoryId: 'cat-adoucisseurs',
      categoryName: 'Adoucisseurs & Résines',
      subCategory: 'Adoucisseurs Résidentiels & Villas',
      brandId: 'br-pentair',
      brandName: 'Pentair Fleck',
      description: 'Adoucisseur complet bi-bloc ou monobloc 25 litres avec by-pass inox et flotteur sécurité saumure.',
      photoUrl: '',
      purchasePriceCents: 380000, // 3 800,00 MAD HT
      salePriceHtCents: 560000, // 5 600,00 MAD HT (6 720,00 TTC)
      minSalePriceHtCents: 510000,
      vatRate: 20,
      stock: 4,
      minStock: 2,
      maxStock: 10,
      unit: 'Unité',
      supplierId: 'sup-1',
      supplierName: 'MAGHREB HYDRO TECH IMPORT',
      location: 'Allée D - Zone Sol',
      replacementMonths: 12,
      compatibleModels: 'Villas 4 à 8 personnes / Cafés CHR',
      notes: '[DONNÉES DE DÉMONSTRATION]',
      active: true,
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'prod-uv-55w',
      reference: 'UV-INOX-55W-12GPM',
      barcode: '6111240001069',
      name: 'Stérilisateur UV-C Inox 316L 55W (2,7 m³/h) avec Ballast Compteur Horaire',
      categoryId: 'cat-uv-pieces',
      categoryName: 'Stérilisateurs UV & Pièces Détachées',
      subCategory: 'Désinfection UV-C',
      brandId: 'br-aquapro',
      brandName: 'AquaPro Maroc',
      description: 'Traitement bactériologique sans chimie pour eaux de puits et forages.',
      photoUrl: '',
      purchasePriceCents: 110000,
      salePriceHtCents: 175000,
      minSalePriceHtCents: 155000,
      vatRate: 20,
      stock: 0, // En rupture pour démonstration alerte rupture
      minStock: 3,
      maxStock: 12,
      unit: 'Unité',
      supplierId: 'sup-2',
      supplierName: 'EUROFILTRATION TANGER MED',
      location: 'Allée C - Rack 03',
      replacementMonths: 12,
      compatibleModels: 'Lampe UV 55W 4 broches T5',
      notes: '[DONNÉES DE DÉMONSTRATION]',
      active: true,
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'prod-post-t33',
      reference: 'CART-T33-COCO',
      barcode: '6111240001076',
      name: 'Post-Filtre Charbon Actif Noix de Coco en Ligne T33 (Raccords 1/4" Quick)',
      categoryId: 'cat-cartouches',
      categoryName: 'Cartouches & Préfiltres',
      subCategory: 'Post-Filtration Finition',
      brandId: 'br-atlas',
      brandName: 'Atlas Filtri',
      description: 'Affinage du goût et élimination des odeurs en sortie de réservoir RO.',
      photoUrl: '',
      purchasePriceCents: 2200,
      salePriceHtCents: 6500,
      minSalePriceHtCents: 5000,
      vatRate: 20,
      stock: 28,
      minStock: 10,
      maxStock: 80,
      unit: 'Unité',
      supplierId: 'sup-2',
      supplierName: 'EUROFILTRATION TANGER MED',
      location: 'Allée B - Bac 06',
      replacementMonths: 12,
      compatibleModels: 'Tous osmoseurs domestiques',
      notes: '[DONNÉES DE DÉMONSTRATION]',
      active: true,
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
  ];

  const customers: Customer[] = [
    {
      id: 'cust-1',
      code: 'CLI-2026-0001',
      name: 'Clinique Dentaire Anfa Sourire (Dr. Bennani)',
      type: 'PROFESSIONNEL',
      phone: '+212 5 22 94 11 22',
      whatsapp: '+212 6 61 94 11 22',
      email: 'contact@anfasourire.ma',
      address: 'Bd d’Anfa, Résidence Les Palmiers, 3ème étage',
      city: 'Casablanca',
      ice: '002109482000017',
      notes: '[DONNÉES DE DÉMONSTRATION] Contrat annuel suivi eau osmosée autoclaves.',
      balanceCents: 0,
      creditAvailableCents: 0,
      active: true,
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'cust-2',
      code: 'CLI-2026-0002',
      name: 'Café & Torréfaction Villa Majorelle',
      type: 'PROFESSIONNEL',
      phone: '+212 5 24 43 88 90',
      whatsapp: '+212 6 63 43 88 90',
      email: 'direction@cafemajorelle.ma',
      address: 'Quartier Guéliz, Avenue Mohammed V',
      city: 'Marrakech',
      ice: '001849201000063',
      notes: '[DONNÉES DE DÉMONSTRATION] Protection machines expresso Marzocco (Adoucisseur + Osmoseur Pro).',
      balanceCents: 0,
      creditAvailableCents: 0,
      active: true,
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'cust-3',
      code: 'CLI-2026-0003',
      name: 'M. Mehdi Ouazzani (Villa Californie)',
      type: 'PARTICULIER',
      phone: '+212 6 61 77 20 33',
      whatsapp: '+212 6 61 77 20 33',
      email: 'm.ouazzani@gmail.com',
      address: 'Lotissement Californie, Rue 12 Villa 8',
      city: 'Casablanca',
      ice: '',
      notes: '[DONNÉES DE DÉMONSTRATION] Adoucisseur 25L + Osmoseur cuisine 7 étapes.',
      balanceCents: 0,
      creditAvailableCents: 0,
      active: true,
      isDemo: true,
      createdAt: now,
      updatedAt: now,
    },
  ];

  await targetDb.categories.bulkAdd(categories);
  await targetDb.brands.bulkAdd(brands);
  await targetDb.suppliers.bulkAdd(suppliers);
  await targetDb.products.bulkAdd(products);
  await targetDb.customers.bulkAdd(customers);

  // Enregistrement des mouvements de stock initiaux pour que stockBefore + qty = stockAfter soit toujours exact
  for (const p of products) {
    if (p.stock > 0) {
      await targetDb.stockMovements.add({
        id: generateId(),
        date: now,
        businessDate: today,
        productId: p.id,
        productRef: p.reference,
        productName: p.name,
        quantity: p.stock,
        stockBefore: 0,
        stockAfter: p.stock,
        type: 'MANUAL_ADJUST',
        sourceDocType: 'MANUAL',
        sourceDocId: p.id,
        sourceDocNumber: 'STOCK-INIT-DEMO',
        reason: 'Stock initial de démonstration',
        userId: 'admin',
        userName: 'Youssef El Amrani',
        status: 'ACTIVE',
        createdAt: now,
      });
    }
  }

  // Création d'une vente payée comptant et d'une vente partiellement payée via le moteur transactionnel réel
  await executeCreateSale(
    {
      customerId: 'cust-1',
      businessDate: today,
      lines: [
        {
          productId: 'prod-ro-7',
          productRef: 'RO-DOM-75G-7S',
          productName: 'Osmoseur Domestique 7 Étapes 75 GPD avec Pompe Booster & Reminéralisation',
          quantity: 1,
          unitPriceHtCents: 195000,
          discountPercent: 0,
          vatRate: 20,
        },
        {
          productId: 'prod-kit-3f',
          productRef: 'KIT-PRE-10P-3X',
          productName: 'Pack Entretien 3 Préfiltres 10" (PP 5µm + Charbon GAC + Bloc CTO)',
          quantity: 2,
          unitPriceHtCents: 12500,
          discountPercent: 0,
          vatRate: 20,
        },
      ],
      paymentMethod: 'CASH',
      amountPaidCents: 264000, // 2 640,00 MAD TTC payé intégralement en espèces
      notes: '[DONNÉES DE DÉMONSTRATION] Installation complète + 2 kits d’avance',
    },
    targetDb
  );

  await executeCreateSale(
    {
      customerId: 'cust-2',
      businessDate: today,
      lines: [
        {
          productId: 'prod-adouc-25l',
          productRef: 'ADOUC-FLECK-5600-25L',
          productName: 'Adoucisseur Volumétrique 25L Résine Monosphère avec Vanne Pentair Fleck 5600 SXT',
          quantity: 1,
          unitPriceHtCents: 560000,
          discountPercent: 5,
          vatRate: 20,
        },
      ],
      paymentMethod: 'TRANSFER',
      amountPaidCents: 300000, // Acompte 3 000,00 MAD par virement sur 6 384,00 MAD TTC
      paymentReference: 'VIR-ATTIJARI-8492',
      notes: '[DONNÉES DE DÉMONSTRATION] Acompte installation adoucisseur Marrakech',
    },
    targetDb
  );

  // Création d'un devis en attente
  await executeCreateQuote(
    {
      customerId: 'cust-3',
      lines: [
        {
          productId: 'prod-ro-7',
          productRef: 'RO-DOM-75G-7S',
          productName: 'Osmoseur Domestique 7 Étapes 75 GPD avec Pompe Booster & Reminéralisation',
          quantity: 1,
          unitPriceHtCents: 195000,
          discountPercent: 0,
          vatRate: 20,
        },
      ],
      notes: '[DONNÉES DE DÉMONSTRATION] Devis équipement cuisine Villa Californie',
    },
    targetDb
  );

  // Création d'une commande fournisseur partiellement reçue
  const purchase = await executeCreatePurchaseOrder(
    {
      supplierId: 'sup-1',
      lines: [
        {
          productId: 'prod-memb-75',
          productRef: 'MEMB-FT-75GPD',
          productName: 'Membrane Osmose Inverse DuPont FilmTec TW30-1812-75 GPD Authentique',
          quantity: 10,
          unitPriceHtCents: 18500,
          discountPercent: 0,
          vatRate: 20,
        },
      ],
      notes: '[DONNÉES DE DÉMONSTRATION] Réapprovisionnement membranes FilmTec',
    },
    targetDb
  );

  const pItems = await targetDb.purchaseItems.where('purchaseId').equals(purchase.id).toArray();
  if (pItems[0]) {
    await executeReceivePurchaseItems(
      {
        purchaseId: purchase.id,
        receptions: [{ purchaseItemId: pItems[0].id, receivedDeltaQty: 6 }],
      },
      targetDb
    );
  }

  // Création d'équipements clients et rappels SAV (dont 1 urgent/dépassé)
  await executeAddEquipmentAndSavReminder(
    {
      customerId: 'cust-1',
      type: 'Osmoseur Médical 7 Étapes',
      brand: 'AquaPro Maroc',
      model: 'RO-75G-PRO',
      serialNumber: 'SN-ASW-2025-8841',
      installDate: addMonthsToBusinessDate(today, -6),
      capacity: '280 L/jour (75 GPD)',
      membraneType: 'FilmTec TW30-1812-75',
      notes: 'Alimente 2 autoclaves classe B.',
      replacementProductId: 'prod-kit-3f',
      intervalMonths: 6,
    },
    targetDb
  );

  await executeAddEquipmentAndSavReminder(
    {
      customerId: 'cust-3',
      type: 'Adoucisseur Villa + Préfiltre 20"',
      brand: 'Pentair Fleck',
      model: '5600-SXT-25L',
      serialNumber: 'SN-FLK-2025-1042',
      installDate: addDaysToBusinessDate(addMonthsToBusinessDate(today, -6), -5),
      capacity: '25 Litres Résine',
      membraneType: 'Cartouche PP 20" + Entretien Vanne',
      notes: 'Dureté eau brute mesurée à 34 °f.',
      replacementProductId: 'prod-kit-3f',
      intervalMonths: 6,
    },
    targetDb
  );

  // Création d'une dépense réelle
  await executeCreateExpense(
    {
      category: 'CARBURANT',
      label: 'Gasoil véhicules intervention SAV Casablanca-Mohammedia',
      beneficiary: 'Station Afriquia Anfa',
      amountHtCents: 50000,
      vatRate: 10,
      paymentMethod: 'CASH',
      receiptRef: 'TICK-AFR-9921',
      notes: '[DONNÉES DE DÉMONSTRATION] Tournée SAV hebdomadaire',
    },
    targetDb
  );

  // Veille marché (Section 35 : clairement identifiée comme EXEMPLE)
  const marketObs: MarketObservation[] = [
    {
      id: generateId(),
      productName: 'Membrane FilmTec TW30-1812-75 GPD',
      category: 'Membranes Osmose Inverse',
      sellerName: 'Distributeur Gros Casablanca (B2B)',
      sourceType: 'EXEMPLE',
      sourceUrl: '',
      priceHtCents: 31000,
      priceTtcCents: 37200,
      observedDate: today,
      specs: 'Origine USA avec hologramme QR DuPont',
      notes: '[DONNÉES DE DÉMONSTRATION - EXEMPLE] Prix moyen constaté au comptoir pro.',
      createdAt: now,
    },
    {
      id: generateId(),
      productName: 'Osmoseur 7 Étapes avec Pompe Booster 75 GPD',
      category: 'Osmose Inverse Domestique & Pro',
      sellerName: 'Marché Équipement Derb Omar',
      sourceType: 'EXEMPLE',
      sourceUrl: '',
      priceHtCents: 185000,
      priceTtcCents: 222000,
      observedDate: today,
      specs: 'Livré hors pose, garantie 1 an atelier',
      notes: '[DONNÉES DE DÉMONSTRATION - EXEMPLE]',
      createdAt: now,
    },
  ];
  await targetDb.marketResearch.bulkAdd(marketObs);
}
