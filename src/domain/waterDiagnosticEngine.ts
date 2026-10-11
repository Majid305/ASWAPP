/**
 * MODULE TECHNIQUE DE DIAGNOSTIC TRAITEMENT DE L'EAU (Section 34)
 * Osmose inverse, membranes, TDS, pression, préfiltres, post-filtres, UV, adoucisseurs, résines, vannes, fuites, débit.
 */

export interface WaterDiagnosticRule {
  id: string;
  systemCategory:
    | 'OSMOSE_INVERSE'
    | 'MEMBRANES_TDS'
    | 'PRESSION_POMPE'
    | 'PREFILTRES_POSTFILTRES'
    | 'STERILISATION_UV'
    | 'ADOUCISSEUR_RESINE'
    | 'FUITES_DEBIT';
  symptomTitle: string;
  severity: 'NORMALE' | 'ATTENTION' | 'CRITIQUE';
  possibleCauses: string[];
  technicalChecks: string[];
  stepByStepProcedure: string[];
  recommendedSolutions: string[];
  safetyWarnings: string[];
}

export const WATER_DIAGNOSTIC_RULES: WaterDiagnosticRule[] = [
  {
    id: 'DIAG-RO-TDS-HIGH',
    systemCategory: 'MEMBRANES_TDS',
    symptomTitle: 'TDS perméat élevé (> 50-80 ppm) ou taux de rejet membrane < 85 %',
    severity: 'CRITIQUE',
    possibleCauses: [
      'Membrane osmose inverse (75/100/400 GPD ou 4040) colmatée ou hydrolysée par le chlore libre',
      'Joint torique (O-ring) double du porte-membrane pincé ou déplacé (bipasse eau brute -> perméat)',
      'Restricteur de débit (Flow Restrictor) surdimensionné ou entartré',
      'Pression amont insuffisante (< 2,8 bar sans pompe booster)',
    ],
    technicalChecks: [
      "Mesurer le TDS de l'eau brute (entrée) et le TDS en sortie directe de membrane (avant reminéralisation)",
      'Calculer le taux de rejet : ((TDS Entrée - TDS Sortie) / TDS Entrée) × 100',
      'Tester le chlore libre en sortie du filtre charbon actif (GAC/CTO) : doit être à 0,0 mg/L',
      'Contrôler l’état des deux joints toriques sur la tige centrale de la membrane',
    ],
    stepByStepProcedure: [
      '1. Fermer la vanne du réservoir sous pression et ouvrir le robinet d’eau pure.',
      '2. Laisser couler 3 minutes puis prélever l’eau directement sur la sortie perméat.',
      '3. Mesurer le TDS avec un conductimètre étalonné.',
      '4. Ouvrir le porte-membrane, inspecter le joint de saumure et les joints toriques de tige.',
    ],
    recommendedSolutions: [
      'Remplacer le trio de préfiltres (PP 5µm + GAC + CTO) avant d’installer une nouvelle membrane',
      'Remplacer la membrane RO et rincer à l’égout pendant 30 minutes avant de raccorder le post-filtre',
      'Vérifier la correspondance du restricteur (ex: 300-350 cc pour 50 GPD, 420 cc pour 75 GPD, 550 cc pour 100 GPD)',
    ],
    safetyWarnings: [
      'Ne jamais installer une membrane neuve en polyamide TFC sans avoir éliminé le chlore actif en amont.',
      'Couper l’alimentation d’eau et dépressuriser le circuit avant d’ouvrir le porte-membrane.',
    ],
  },
  {
    id: 'DIAG-RO-LOW-FLOW',
    systemCategory: 'FUITES_DEBIT',
    symptomTitle: 'Débit très faible au robinet d’eau osmosée ou réservoir qui ne se remplit pas',
    severity: 'ATTENTION',
    possibleCauses: [
      'Vessie du réservoir sous pression dégonflée ou percée (précharge d’air perdue)',
      'Préfiltres sédiments (PP 5µm / 1µm) saturés de boue ou calcaire',
      'Vanne Shut-Off (4 voies) bloquée en position fermée',
      'Pompe booster 24V/36V défectueuse ou transformateur hors service',
    ],
    technicalChecks: [
      'Soupeser le réservoir : s’il est lourd mais que rien ne sort au robinet -> manque de pression d’air',
      'Mesurer la pression d’air à la valve Schrader du réservoir (doit être entre 0,4 et 0,5 bar à vide)',
      'Mesurer la pression en sortie de pompe booster (doit atteindre 5,5 à 6,8 bar en fonctionnement)',
    ],
    stepByStepProcedure: [
      '1. Fermer l’arrivée d’eau et ouvrir le robinet col de cygne.',
      '2. Contrôler la pression d’air sur la valve inférieure du ballon avec un manomètre basse pression.',
      '3. Regonfler à 0,5 bar (7 PSI) robinet ouvert jusqu’à vidange complète.',
      '4. Si de l’eau sort par la valve d’air Schrader, la membrane interne du ballon est percée.',
    ],
    recommendedSolutions: [
      'Regonfler le ballon à 0,5 bar (à vide) ou remplacer le réservoir sous pression si la vessie est percée',
      'Remplacer les cartouches préfiltres PP / Charbon si la chute de pression dépasse 0,8 bar',
      'Remplacer la vanne automatique 4 voies (Auto Shut-Off) ou l’électrovanne d’entrée',
    ],
    safetyWarnings: [
      'Ne jamais gonfler un réservoir d’osmose domestique au-delà de 0,7 bar à vide (risque de blocage du remplissage ou d’éclatement de la vessie).',
    ],
  },
  {
    id: 'DIAG-PRESSURE-PUMP',
    systemCategory: 'PRESSION_POMPE',
    symptomTitle: 'Pompe booster ne démarre pas ou s’arrête/redémarre sans arrêt (cyclage rapide)',
    severity: 'ATTENTION',
    possibleCauses: [
      'Pressostat basse pression (Low Pressure Switch) coupé par manque d’eau ou préfiltre colmaté',
      'Pressostat haute pression (High Pressure Switch) déréglé ou clapet anti-retour fuyard',
      'Transformateur 24V DC défaillant ou connectique oxydée',
    ],
    technicalChecks: [
      'Shunter temporairement (5 secondes) les cosses du pressostat basse pression (LPS) pour tester',
      'Contrôler le clapet anti-retour (Check Valve) situé sur le coude de sortie perméat du porte-membrane',
      'Mesurer la tension continue 24V DC en charge aux bornes de la pompe',
    ],
    stepByStepProcedure: [
      '1. Vérifier que le robinet d’arrêt d’eau froide est bien ouvert.',
      '2. Débrancher et shunter le LPS : si la pompe démarre, le préfiltre amont est bouché ou le LPS est HS.',
      '3. Si la pompe fait des à-coups lorsque le ballon est plein, remplacer le clapet anti-retour sur la sortie perméat.',
    ],
    recommendedSolutions: [
      'Remplacer le clapet anti-retour (Check Valve 1/4") en sortie perméat',
      'Remplacer le pressostat basse/haute pression ou le transformateur 24V',
    ],
    safetyWarnings: [
      'Débrancher l’alimentation 220V avant toute manipulation sur le boîtier électrique en zone humide.',
    ],
  },
  {
    id: 'DIAG-SOFTENER-HARDNESS',
    systemCategory: 'ADOUCISSEUR_RESINE',
    symptomTitle: 'Dureté résiduelle élevée en sortie d’adoucisseur (> 10-15 °f)',
    severity: 'CRITIQUE',
    possibleCauses: [
      'Bac à sel vide ou formation d’une voûte de sel (pont de sel cristallisé au-dessus de l’eau)',
      'Injecteur Venturi ou crépine d’aspiration saumure bouché sur la vanne volumétrique (Fleck / Clack / Runxin)',
      'Vanne de by-pass partiellement ouverte ou joint du distributeur central endommagé',
      'Résine échangeuse d’ions saturée, ferrugineuse ou dégradée (> 7-10 ans)',
    ],
    technicalChecks: [
      'Mesurer le TH (Titre Hydrotimétrique en °f) en amont et en aval de l’adoucisseur',
      'Briser une éventuelle croûte de sel dans le bac à saumure avec un manche propre',
      'Lancer une régénération manuelle et vérifier l’aspiration réelle de la saumure à l’étape 2 (Brine Draw)',
      'Vérifier la programmation du volume inter-régénération en fonction de la dureté locale marocaine (souvent 25 à 45 °f)',
    ],
    stepByStepProcedure: [
      '1. Tester le TH sortie avec réactif gouttes ou photomètre.',
      '2. Vérifier le niveau d’eau et la qualité du sel régénérant (pastilles norme EN 973).',
      '3. Démonter et nettoyer l’injecteur Venturi et son filtre tamis.',
      '4. Lancer un cycle de régénération immédiate et recontrôler le TH après rinçage final.',
    ],
    recommendedSolutions: [
      'Casser la voûte de sel, nettoyer le bac à saumure et recharger en sel pastilles haute pureté',
      'Nettoyer l’injecteur Venturi et remplacer le joint de cheminée centrale si fuite interne',
      'Appliquer un nettoyant résine (Resin Cleaner) ou remplacer la charge de résine cationique alimentaire',
    ],
    safetyWarnings: [
      'Dépressuriser la bouteille PRV avant de dévisser la tête de vanne volumétrique.',
    ],
  },
  {
    id: 'DIAG-UV-ALARM',
    systemCategory: 'STERILISATION_UV',
    symptomTitle: 'Alarme ballast UV / Lampe UV-C éteinte ou échauffement de la chambre inox',
    severity: 'ATTENTION',
    possibleCauses: [
      'Durée de vie de la lampe UV-C atteinte (> 9 000 heures / 12 mois)',
      'Gaine quartz entartrée par le calcaire (bloque le rayonnement germicide à 254 nm)',
      'Ballast électronique endommagé par une surtension réseau',
    ],
    technicalChecks: [
      'Vérifier le compteur d’heures ou le témoin LED sur le ballast électronique',
      'Démonter et inspecter la transparence de la gaine en quartz (dépôt blanchâtre ou ocre)',
      'Inspecter les broches céramiques de la lampe UV-C',
    ],
    stepByStepProcedure: [
      '1. Débrancher le ballast électrique et laisser refroidir la lampe 10 minutes.',
      '2. Fermer les vannes d’isolement et purger la chambre inox 304/316L.',
      '3. Extraire la lampe sans toucher le verre avec les doigts nus (utiliser des gants propres).',
      '4. Nettoyer la gaine quartz à l’acide citrique doux ou au vinaigre blanc, puis remplacer le joint torique.',
    ],
    recommendedSolutions: [
      'Remplacer la lampe UV-C annuellement (toutes les 9 000 h) et réinitialiser le compteur du ballast',
      'Détartrer ou remplacer la gaine quartz et installer un onduleur/régulateur si le réseau électrique fluctue',
    ],
    safetyWarnings: [
      'DANGER OCULAIRE GRAVE : Ne jamais regarder directement une lampe UV-C allumée hors de sa chambre inox.',
    ],
  },
  {
    id: 'DIAG-PREFILTER-TASTE',
    systemCategory: 'PREFILTRES_POSTFILTRES',
    symptomTitle: 'Mauvais goût, odeur de chlore ou particules blanches dans l’eau purifiée',
    severity: 'NORMALE',
    possibleCauses: [
      'Post-filtre charbon actif en ligne (T33 Coco) arrivé à saturation (> 12 mois)',
      'Relargage de fines de charbon ou d’air micro-bullé après un remplacement de cartouche non rincée',
      'Stagnation prolongée dans le réservoir sous pression (> 2 semaines sans tirage)',
    ],
    technicalChecks: [
      'Vérifier la date du dernier remplacement des cartouches dans le module SAV',
      'Remplir un verre : si l’eau s’éclaircit du bas vers le haut en 30 secondes, il s’agit de micro-bulles d’air inoffensives',
    ],
    stepByStepProcedure: [
      '1. Vidanger intégralement le réservoir sous pression 2 fois de suite.',
      '2. Remplacer le post-filtre charbon T33 et éventuellement la cartouche de reminéralisation Calcite/Corail.',
      '3. Désinfecter le circuit et le réservoir au peroxyde d’hydrogène alimentaire lors de la maintenance annuelle.',
    ],
    recommendedSolutions: [
      'Remplacer le post-filtre T33 et rincer 10 litres avant raccordement final',
      'Créer un rappel SAV automatique à 6 mois (préfiltres) et 12 mois (post-filtre)',
    ],
    safetyWarnings: [
      'Respecter scrupuleusement le sens de la flèche (FLOW) gravé sur le corps du post-filtre en ligne.',
    ],
  },
];

export interface InteractiveWaterDiagnosisInput {
  rawTdsPpm: number;
  permeateTdsPpm: number;
  inletPressureBar: number;
  waterHardnessTh: number;
  monthsSinceFilterChange: number;
}

export interface InteractiveWaterDiagnosisResult {
  rejectionRatePercent: number;
  membraneHealth: 'EXCELLENT' | 'ACCEPTABLE' | 'CRITIQUE';
  pressureStatus: 'CONFORME' | 'INSUFFISANTE_POMPE_REQUISE' | 'EXCESSIVE_REDUCTEUR_REQUIS';
  hardnessRecommendation: string;
  maintenanceAlert: string;
}

export function evaluateWaterParameters(
  input: InteractiveWaterDiagnosisInput
): InteractiveWaterDiagnosisResult {
  const raw = Math.max(1, input.rawTdsPpm);
  const perm = Math.max(0, input.permeateTdsPpm);
  const rejectionRatePercent = Math.max(0, Math.round(((raw - perm) / raw) * 1000) / 10);

  let membraneHealth: InteractiveWaterDiagnosisResult['membraneHealth'] = 'EXCELLENT';
  if (rejectionRatePercent < 85) membraneHealth = 'CRITIQUE';
  else if (rejectionRatePercent < 92) membraneHealth = 'ACCEPTABLE';

  let pressureStatus: InteractiveWaterDiagnosisResult['pressureStatus'] = 'CONFORME';
  if (input.inletPressureBar < 2.8) pressureStatus = 'INSUFFISANTE_POMPE_REQUISE';
  else if (input.inletPressureBar > 5.5) pressureStatus = 'EXCESSIVE_REDUCTEUR_REQUIS';

  let hardnessRecommendation = 'Dureté modérée : préfiltration standard suffisante.';
  if (input.waterHardnessTh > 30) {
    hardnessRecommendation =
      'Eau très calcaire (> 30 °f) : Adoucisseur amont ou cartouche anti-tartre polyphosphate fortement recommandé pour protéger la membrane RO.';
  } else if (input.waterHardnessTh > 18) {
    hardnessRecommendation =
      'Eau dure (18–30 °f) : Surveiller le restricteur de débit et rincer régulièrement la membrane.';
  }

  let maintenanceAlert = 'Fréquence de remplacement des préfiltres respectée.';
  if (input.monthsSinceFilterChange >= 12) {
    maintenanceAlert =
      'Retard critique (> 12 mois) : Remplacement immédiat des préfiltres PP/GAC/CTO et du post-filtre T33 requis.';
  } else if (input.monthsSinceFilterChange >= 6) {
    maintenanceAlert =
      'Échéance atteinte (≥ 6 mois) : Prévoir le remplacement des 3 préfiltres inférieurs.';
  }

  return {
    rejectionRatePercent,
    membraneHealth,
    pressureStatus,
    hardnessRecommendation,
    maintenanceAlert,
  };
}
