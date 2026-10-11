import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

interface WebSearchSource {
  title: string;
  uri: string;
  domain: string;
  snippet: string;
  extractedPrices: string[];
  pageExcerpt: string;
  mentionsTargetCity: boolean;
  mentionsTargetCountry: boolean;
}

function getGenAIClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY' || apiKey.trim().length < 10) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRealUrlFromDuckDuckGo(rawHref: string): string {
  try {
    const u = rawHref.startsWith('//') ? `https:${rawHref}` : rawHref;
    const parsed = new URL(u);
    const uddg = parsed.searchParams.get('uddg');
    if (uddg) return decodeURIComponent(uddg);
    return u;
  } catch {
    return rawHref;
  }
}

function extractPricesFromText(text: string): string[] {
  const matches =
    text.match(
      /\b\d{1,3}(?:[\s.,]\d{3})*(?:[.,]\d{1,2})?\s*(?:MAD|DH|DHS|Dh|Dhs|dirhams?|€|EUR|\$|USD|TND|DZD|FCFA)\b/gi
    ) || [];
  const cleaned = matches
    .map((m) => m.replace(/\s+/g, ' ').trim())
    .filter((m) => {
      const numPart = parseFloat(m.replace(/[^\d.,]/g, '').replace(',', '.'));
      return !isNaN(numPart) && numPart >= 15 && numPart <= 250000;
    });
  return Array.from(new Set(cleaned)).slice(0, 6);
}

async function runDuckDuckGoQuery(query: string): Promise<Array<{ title: string; uri: string; snippet: string }>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6500);
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
      },
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const html = await res.text();
    const results: Array<{ title: string; uri: string; snippet: string }> = [];
    const regex =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null && results.length < 8) {
      const uri = extractRealUrlFromDuckDuckGo(decodeHtmlEntities(match[1]));
      const title = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, ' '));
      const snippet = decodeHtmlEntities(match[3].replace(/<[^>]+>/g, ' '));
      if (uri.startsWith('http') && !uri.includes('duckduckgo.com/y.js')) {
        results.push({ title, uri, snippet });
      }
    }
    return results;
  } catch {
    clearTimeout(timeout);
    return [];
  }
}

async function enrichWebSource(
  item: { title: string; uri: string; snippet: string },
  targetCity: string,
  targetCountry: string
): Promise<WebSearchSource> {
  let domain = '';
  try {
    domain = new URL(item.uri).hostname.replace(/^www\./, '');
  } catch {
    domain = item.uri;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4500);
  let pageText = '';
  try {
    const res = await fetch(item.uri, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      },
    });
    clearTimeout(timeout);
    if (res.ok) {
      const rawHtml = await res.text();
      pageText = decodeHtmlEntities(
        rawHtml
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
      ).slice(0, 6000);
    }
  } catch {
    clearTimeout(timeout);
  }

  const combinedText = `${item.title} ${item.snippet} ${pageText}`;
  const extractedPrices = extractPricesFromText(combinedText);
  const lowerCombined = combinedText.toLowerCase();
  const cityLower = targetCity.toLowerCase();
  const countryLower = targetCountry.toLowerCase();

  const mentionsTargetCity =
    cityLower !== 'toutes villes' && cityLower.length > 2
      ? lowerCombined.includes(cityLower)
      : false;
  const mentionsTargetCountry =
    lowerCombined.includes(countryLower) ||
    (countryLower === 'maroc' && (domain.endsWith('.ma') || lowerCombined.includes('casablanca') || lowerCombined.includes('rabat') || lowerCombined.includes('marrakech') || lowerCombined.includes('dirham') || lowerCombined.includes(' dh')));

  return {
    title: item.title,
    uri: item.uri,
    domain,
    snippet: item.snippet,
    extractedPrices,
    pageExcerpt: pageText.slice(0, 950),
    mentionsTargetCity,
    mentionsTargetCountry,
  };
}

function buildFactualFallbackReport(params: {
  cleanProduct: string;
  coreProduct: string;
  cleanCountry: string;
  cleanCity: string;
  locationLabel: string;
  category: string;
  evaluationFocus: string;
  sources: WebSearchSource[];
}): { status: 'FOUND' | 'PARTIAL' | 'NOT_FOUND'; reportMarkdown: string } {
  const { cleanProduct, cleanCountry, cleanCity, locationLabel, sources } = params;

  if (sources.length === 0) {
    return {
      status: 'NOT_FOUND',
      reportMarkdown: [
        `**1. Résumé de la disponibilité à ${locationLabel}**`,
        `Aucune page web publique ni offre en ligne vérifiable n'a été trouvée pour la référence exacte « ${cleanProduct} » à ${locationLabel}.`,
        `Conformément à la règle stricte **Zéro Invention**, aucun prix, distributeur ou caractéristique non vérifié n'est généré.`,
        '',
        `**2. Recommandation pour affiner la recherche**`,
        `- Essayez avec uniquement la marque et le modèle principal (sans le code article interne).`,
        `- Sélectionnez « Toutes villes » pour élargir la recherche à l'ensemble du pays (${cleanCountry}).`,
      ].join('\n'),
    };
  }

  const cityMatches = sources.filter((s) => s.mentionsTargetCity);
  const countryMatches = sources.filter((s) => s.mentionsTargetCountry);
  const sourcesWithPrices = sources.filter((s) => s.extractedPrices.length > 0);

  const status: 'FOUND' | 'PARTIAL' | 'NOT_FOUND' =
    sourcesWithPrices.length > 0 || countryMatches.length > 0 ? (cityMatches.length > 0 || cleanCity.toLowerCase() === 'toutes villes' ? 'FOUND' : 'PARTIAL') : 'PARTIAL';

  const lines: string[] = [];

  lines.push(`**1. Résumé de la disponibilité à ${locationLabel}**`);
  if (cityMatches.length > 0) {
    lines.push(
      `- **Présence locale confirmée** : ${cityMatches.length} source(s) web mentionnent explicitement **${cleanCity}** ou une livraison directe à **${locationLabel}** pour **${cleanProduct}**.`
    );
  } else if (countryMatches.length > 0) {
    lines.push(
      `- **Disponibilité nationale (${cleanCountry})** : Aucun revendeur n'affiche d'adresse physique exclusivement à **${cleanCity}** dans les extraits publics, mais **${countryMatches.length} distributeur(s) / site(s) en ${cleanCountry}** proposent ce produit (avec expédition nationale vers ${cleanCity}).`
    );
  } else {
    lines.push(
      `- Aucun prix public local n'a été trouvé spécifiquement à **${locationLabel}**, mais **${sources.length} source(s) web** permettent d'identifier et d'évaluer le produit.`
    );
  }

  lines.push('');
  lines.push(`**2. Prix & Distributeurs / Offres constatés en ligne (Zéro Invention)**`);
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const priceText =
      s.extractedPrices.length > 0
        ? `Prix relevé(s) sur la page : **${s.extractedPrices.join(' / ')}**`
        : `Prix non affiché publiquement dans l'extrait (sur devis ou consultation du site)`;
    const locTag = s.mentionsTargetCity
      ? `${cleanCity}, ${cleanCountry}`
      : s.mentionsTargetCountry
      ? `${cleanCountry}`
      : 'International / Web';
    lines.push(`- **[${i + 1}] ${s.title}** (${s.domain} — *${locTag}*) : ${priceText}`);
    if (s.snippet) {
      lines.push(`  Extrait vérifié : « ${s.snippet} »`);
    }
  }

  lines.push('');
  lines.push(`**3. Identification & Éléments Techniques Relevés sur les Sources**`);
  const excerptsWithSpecs = sources
    .filter((s) => s.snippet || s.pageExcerpt)
    .slice(0, 3);
  for (const s of excerptsWithSpecs) {
    const cleanExcerpt = (s.snippet || s.pageExcerpt).slice(0, 280);
    lines.push(`- **Source ${s.domain}** : ${cleanExcerpt}`);
  }

  return {
    status,
    reportMarkdown: lines.join('\n'),
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.text({ limit: '1mb', type: ['text/plain', 'text/html'] }));

  // =========================================================================
  // SYSTÈME DE SYNCHRONISATION CYCLE DE VIE (OPTION 1 : ARRÊT AUTO DE NODE.JS)
  // Détecte la fermeture de l'appli et arrête proprement le processus Node.js
  // =========================================================================
  const isCloudEnvironment = !!process.env.K_SERVICE;
  const activeClients = new Map<string, number>(); // clientId -> lastHeartbeatTimestamp
  let pendingShutdownTimer: NodeJS.Timeout | null = null;
  const serverStartedAt = Date.now();
  let hasEverHadClients = false;

  const cancelPendingShutdown = () => {
    if (pendingShutdownTimer) {
      clearTimeout(pendingShutdownTimer);
      pendingShutdownTimer = null;
    }
  };

  const scheduleShutdown = (delayMs = 5000, reason = 'Aucun onglet client connecté') => {
    if (pendingShutdownTimer) return;
    pendingShutdownTimer = setTimeout(() => {
      if (activeClients.size === 0) {
        console.log(`\n🛑 [Atlas Soft Water] Arrêt système déclenché (${reason}).`);
        if (isCloudEnvironment) {
          console.log(`ℹ️ [Atlas Soft Water] Mode Cloud/Aperçu AI Studio détecté : le processus est maintenu pour l'environnement hébergé.`);
        } else {
          console.log(`🔌 [Atlas Soft Water] Arrêt complet du processus Node.js. À bientôt !`);
          process.exit(0);
        }
      }
    }, delayMs);
  };

  // Nettoyage régulier des clients inactifs (toutes les 5 secondes)
  setInterval(() => {
    const now = Date.now();
    for (const [id, lastSeen] of activeClients.entries()) {
      if (now - lastSeen > 12000) {
        activeClients.delete(id);
      }
    }
    // Si des clients ont déjà été connectés et qu'il n'en reste aucun
    if (hasEverHadClients && activeClients.size === 0 && now - serverStartedAt > 15000) {
      scheduleShutdown(5000, 'Tous les clients se sont déconnectés');
    }
  }, 5000);

  // 1. Heartbeat périodique (toutes les 3s par client)
  app.post('/api/system/heartbeat', (req, res) => {
    try {
      let body: Record<string, unknown> = {};
      if (typeof req.body === 'string') {
        try {
          body = JSON.parse(req.body);
        } catch {
          body = {};
        }
      } else if (req.body && typeof req.body === 'object') {
        body = req.body as Record<string, unknown>;
      }
      const cId = typeof body.clientId === 'string' ? body.clientId : 'default_client';
      activeClients.set(cId, Date.now());
      hasEverHadClients = true;
      cancelPendingShutdown();
      res.json({
        status: 'alive',
        activeClients: activeClients.size,
        isLocalStandalone: !isCloudEnvironment,
      });
    } catch {
      res.json({ status: 'alive' });
    }
  });

  // 2. Beacon envoyé automatiquement à la fermeture d'un onglet ou de la fenêtre
  app.post('/api/system/shutdown-beacon', (req, res) => {
    try {
      let body: Record<string, unknown> = {};
      if (typeof req.body === 'string') {
        try {
          body = JSON.parse(req.body);
        } catch {
          body = {};
        }
      } else if (req.body && typeof req.body === 'object') {
        body = req.body as Record<string, unknown>;
      }
      const cId = typeof body.clientId === 'string' ? body.clientId : null;
      if (cId) {
        activeClients.delete(cId);
      }
      if (activeClients.size === 0) {
        // Délai de grâce de 5 secondes (tolère un rechargement F5 sans couper le serveur)
        scheduleShutdown(5000, 'Fermeture de l’onglet/fenêtre détectée (Beacon)');
      }
      res.status(204).end();
    } catch {
      res.status(204).end();
    }
  });

  // 3. Arrêt manuel immédiat depuis l'interface utilisateur
  app.post('/api/system/shutdown', (_req, res) => {
    cancelPendingShutdown();
    res.json({
      success: true,
      message: 'Arrêt de Node.js en cours...',
      isLocalStandalone: !isCloudEnvironment,
    });
    setTimeout(() => {
      console.log(`\n🛑 [Atlas Soft Water] Arrêt manuel demandé par l'utilisateur.`);
      if (isCloudEnvironment) {
        console.log(`ℹ️ [Atlas Soft Water] Mode Cloud/Aperçu AI Studio détecté : le processus est maintenu pour l'environnement hébergé.`);
      } else {
        console.log(`🔌 [Atlas Soft Water] Arrêt complet du processus Node.js.`);
        process.exit(0);
      }
    }, 500);
  });

  // 4. Statut système
  app.get('/api/system/status', (_req, res) => {
    res.json({
      isLocalStandalone: !isCloudEnvironment,
      activeClients: activeClients.size,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  /**
   * API Sur Demande : Veille Marché & Évaluation Produit Géolocalisée (Pays / Ville)
   * 1. Effectue une vraie recherche web en direct (sources vérifiables, prix, extraits).
   * 2. Synthétise avec Gemini Flash (quota gratuit : gemini-flash-latest / gemini-3.1-flash-lite)
   *    ou bascule automatiquement sur le moteur de synthèse factuel déterministe si le quota ou la clé est indisponible.
   */
  app.post('/api/market-research', async (req, res) => {
    try {
      const {
        productQuery,
        country = 'Maroc',
        city = 'Casablanca',
        category = '',
        evaluationFocus = 'Prix constatés, distributeurs & évaluation technique et commerciale',
        extraNotes = '',
      } = req.body ?? {};

      if (!productQuery || typeof productQuery !== 'string' || !productQuery.trim()) {
        res.status(400).json({
          error: 'Veuillez indiquer le nom, la référence ou la marque du produit à rechercher.',
        });
        return;
      }

      const cleanProduct = productQuery.trim();
      // Nettoyage d'un éventuel code article interne entre parenthèses ex: (OSMO-6ETP-0003) pour ne pas bloquer le moteur de recherche
      const coreProduct =
        cleanProduct
          .replace(/\([A-Z0-9_-]{4,}\)/gi, '')
          .replace(/\b(?:REF|SKU)\s*[:#-]?\s*[A-Z0-9_-]+/gi, '')
          .replace(/\s+/g, ' ')
          .trim() || cleanProduct;

      const cleanCountry = String(country || 'Maroc').trim();
      const cleanCity = String(city || 'Toutes villes').trim();
      const locationLabel =
        cleanCity && cleanCity.toLowerCase() !== 'toutes villes'
          ? `${cleanCity}, ${cleanCountry}`
          : cleanCountry;

      const currencyHint =
        cleanCountry.toLowerCase() === 'maroc' ? 'MAD DH prix' : 'prix';

      const searchQueries = [
        `${coreProduct} ${cleanCity !== 'Toutes villes' ? cleanCity : ''} ${cleanCountry} ${currencyHint}`.replace(/\s+/g, ' ').trim(),
        `${coreProduct} ${cleanCountry} ${currencyHint}`.replace(/\s+/g, ' ').trim(),
        `${coreProduct} fiche technique specifications`.replace(/\s+/g, ' ').trim(),
      ];

      // 1. Exécution des recherches web réelles en parallèle
      const rawResultsLists = await Promise.all(
        searchQueries.map((q) => runDuckDuckGoQuery(q))
      );

      const dedupedRaw: Array<{ title: string; uri: string; snippet: string }> = [];
      const seenUris = new Set<string>();
      for (const list of rawResultsLists) {
        for (const item of list) {
          if (!seenUris.has(item.uri) && dedupedRaw.length < 6) {
            seenUris.add(item.uri);
            dedupedRaw.push(item);
          }
        }
      }

      // 2. Extraction en direct du contenu et des prix affichés sur les meilleures pages trouvées
      const enrichedSources = await Promise.all(
        dedupedRaw.map((item) => enrichWebSource(item, cleanCity, cleanCountry))
      );

      // 3. Synthèse IA via Quota Gratuit Gemini Flash (sans facturation googleSearch payante)
      const ai = getGenAIClient();
      let aiMarkdown = '';
      let verificationStatus: 'FOUND' | 'PARTIAL' | 'NOT_FOUND' = 'PARTIAL';
      let modelUsed = 'Recherche Web Directe + Synthèse Factuelle Vérifiée';

      if (ai && enrichedSources.length > 0) {
        const contextBlocks = enrichedSources
          .map(
            (s, idx) =>
              `SOURCE [${idx + 1}]:
- Titre: ${s.title}
- URL: ${s.uri}
- Domaine: ${s.domain}
- Mentionne ${cleanCity}: ${s.mentionsTargetCity ? 'OUI' : 'NON'}
- Mentionne ${cleanCountry}: ${s.mentionsTargetCountry ? 'OUI' : 'NON'}
- Prix détectés sur la page: ${s.extractedPrices.length > 0 ? s.extractedPrices.join(', ') : 'Aucun prix chiffré détecté dans le texte brut'}
- Résumé moteur: ${s.snippet}
- Extrait du contenu de la page: ${s.pageExcerpt}`
          )
          .join('\n\n');

        const systemInstruction = `Tu es un analyste expert en veille concurrentielle et équipements de traitement de l'eau (osmose inverse, filtration, adoucissement, pompes, UV).
Ta mission est d'analyser EXCLUSIVEMENT les résultats de recherche web réels fournis ci-dessous pour évaluer le produit demandé dans le lieu ciblé (${locationLabel}).

RÈGLES STRICTES DE FIABILITÉ (ZÉRO INVENTION / ZÉRO HALLUCINATION) :
1. INTERDICTION FORMELLE D'INVENTER : N'invente JAMAIS un prix, un nom de vendeur, une adresse ou une caractéristique qui ne figure pas dans les sources fournies.
2. TRANSPARENCE GÉOGRAPHIQUE :
   - Si les sources montrent des vendeurs en ${cleanCountry} (ex: sites .ma ou livraison nationale) mais pas de magasin physique mentionné spécifiquement à ${cleanCity}, dis-le honnêtement : indique que l'offre est disponible en ${cleanCountry} (avec livraison possible à ${cleanCity}) mais qu'aucun prix exclusif à ${cleanCity} n'est séparément affiché.
   - Si aucun prix n'est affiché sur une source, indique "Prix non affiché publiquement sur cette page".
3. Cite toujours le numéro de la source [1], [2]... et le nom du site/vendeur.
4. Commence ta réponse par UNE ligne de statut exacte :
   STATUT_VERIFICATION: TROUVE (si le produit et des offres/infos dans le pays/ville ont été trouvés)
   ou
   STATUT_VERIFICATION: PARTIEL (si le produit est identifié mais sans prix local à ${locationLabel})
   ou
   STATUT_VERIFICATION: NON_TROUVE (si les sources ne correspondent pas au produit demandé)`;

        const userPrompt = `Produit recherché : "${cleanProduct}" (Modèle principal : "${coreProduct}")
Catégorie : "${category || 'Traitement de l’eau'}"
Lieu ciblé (Pays / Ville) : "${locationLabel}"
Objectif d'évaluation : "${evaluationFocus}"
${extraNotes ? `Précisions de l'utilisateur : "${extraNotes}"` : ''}

SOURCES WEB RÉELLES EXTRAITES EN DIRECT :
${contextBlocks}

Rédige un récapitulatif structuré, clair et strictement fidèle aux sources comprenant :
1. **STATUT_VERIFICATION: [TROUVE | PARTIEL | NON_TROUVE]** (sur la première ligne)
2. **Disponibilité constatée à ${locationLabel}** (ce qui est trouvé à ${cleanCity} même vs au niveau national en ${cleanCountry}).
3. **Prix & Distributeurs / Sites identifiés** (liste chaque vendeur pertinent avec ses prix exacts relevés dans les sources et sa référence [1], [2]...).
4. **Spécifications Techniques & Qualité du Produit** (étapes de filtration, capacité GPD, technologie, certifications mentionnées dans les extraits).
5. **Évaluation Commerciale & Points de Vigilance** (positionnement prix constaté, disponibilité des consommables/filtres de rechange, conseils).`;

        const freeQuotaModels = ['gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
        for (const candidateModel of freeQuotaModels) {
          try {
            const response = await ai.models.generateContent({
              model: candidateModel,
              contents: userPrompt,
              config: {
                systemInstruction,
                temperature: 0.0,
              },
            });
            if (response.text && response.text.trim().length > 20) {
              aiMarkdown = response.text.trim();
              modelUsed = `${candidateModel} (Quota Gratuit + Recherche Web Directe)`;
              break;
            }
          } catch {
            // Try next free quota model
          }
        }
      }

      if (aiMarkdown) {
        if (/STATUT_VERIFICATION\s*:\s*TROUVE/i.test(aiMarkdown)) {
          verificationStatus = 'FOUND';
        } else if (/STATUT_VERIFICATION\s*:\s*NON_TROUVE/i.test(aiMarkdown)) {
          verificationStatus = 'NOT_FOUND';
        } else {
          verificationStatus = 'PARTIAL';
        }
        aiMarkdown = aiMarkdown
          .replace(/^\s*\*?\*?STATUT_VERIFICATION\s*:\s*(TROUVE|PARTIEL|NON_TROUVE)\*?\*?\s*\n?/i, '')
          .trim();
      } else {
        const fallback = buildFactualFallbackReport({
          cleanProduct,
          coreProduct,
          cleanCountry,
          cleanCity,
          locationLabel,
          category,
          evaluationFocus,
          sources: enrichedSources,
        });
        verificationStatus = fallback.status;
        aiMarkdown = fallback.reportMarkdown;
      }

      res.json({
        status: verificationStatus,
        productQuery: cleanProduct,
        country: cleanCountry,
        city: cleanCity,
        locationLabel,
        evaluationFocus,
        reportMarkdown: aiMarkdown,
        sources: enrichedSources.map((s) => ({
          title:
            s.extractedPrices.length > 0
              ? `${s.title} — [${s.extractedPrices.slice(0, 2).join(' / ')}]`
              : s.title,
          uri: s.uri,
        })),
        searchQueries,
        modelUsed,
        timestamp: new Date().toISOString(),
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        error: `Erreur lors de la recherche : ${errMsg}`,
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Atlas Soft Water server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
