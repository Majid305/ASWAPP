import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  BarChart3,
  Boxes,
  ClipboardList,
  Compass,
  CreditCard,
  Database,
  Droplets,
  FileCheck2,
  FileSpreadsheet,
  FileText,
  Leaf,
  Lock,
  Maximize,
  Minimize,
  Moon,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  Search,
  Settings,
  ShieldAlert,
  ShieldCheck,
  ShoppingBag,
  ShoppingCart,
  Sliders,
  Sparkles,
  Sun,
  Power,
  Truck,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary';
import {
  FirstStartWizardModal,
  GlobalSearchModal,
  PinLockModal,
  PrintPreviewModal,
  ShutdownModal,
} from './components/ModalsAndSearch';
import { initSystemLifecycle, requestServerShutdown } from './services/systemLifecycle';
import { db } from './db/database';
import { computeCentralFinancialSnapshot } from './domain/analyticsEngine';
import { DashboardView, PosView } from './features/DashboardAndPosView';
import {
  BackupsDiagnosticsAndSettingsView,
  FinanceView,
  IntelligenceAndWaterDiagView,
  MarketWatchView,
} from './features/FinanceIntelligenceSettingsView';
import {
  InventoryView,
  ProductsView,
  StockCenterView,
} from './features/ProductsStockInventoryView';
import { DefectiveProductsView } from './features/DefectiveProductsView';
import {
  CustomersView,
  PurchasesView,
  SavView,
  SuppliersView,
} from './features/PurchasesSuppliersCustomersSavView';
import {
  InvoicesView,
  QuotesView,
  SalesView,
} from './features/SalesQuotesInvoicesView';
import { PrintableDocument } from './printing/printTemplates';
import { initializeDatabaseIfNeeded } from './services/seedService';
import { AppSettings, CompanyInfo, UserProfile } from './types/domain';

type NavTab =
  | 'dashboard'
  | 'pos'
  | 'sales'
  | 'quotes'
  | 'invoices'
  | 'products'
  | 'stock'
  | 'defective'
  | 'inventory'
  | 'purchases'
  | 'suppliers'
  | 'customers'
  | 'sav'
  | 'finance'
  | 'intelligence'
  | 'market'
  | 'backups'
  | 'tests'
  | 'settings';

export default function App() {
  const [ready, setReady] = useState(false);
  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [company, setCompany] = useState<CompanyInfo | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [profiles, setProfiles] = useState<UserProfile[]>([]);
  const [currentProfile, setCurrentProfile] = useState<UserProfile | null>(null);

  const [refreshCounter, setRefreshCounter] = useState(0);
  const [badges, setBadges] = useState({
    criticalStock: 0,
    unpaidInvoices: 0,
    urgentSav: 0,
    pendingPurchases: 0,
    defectiveCount: 0,
  });

  // Modales globales
  const [searchOpen, setSearchOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [printDoc, setPrintDoc] = useState<PrintableDocument | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem('asw_sidebar_collapsed') === '1';
    } catch {
      return false;
    }
  });

  const [isFullscreen, setIsFullscreen] = useState<boolean>(() => {
    return typeof document !== 'undefined' && !!document.fullscreenElement;
  });
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);

  // Option 1 : Synchronisation du cycle de vie et arrêt de Node.js
  const [shutdownModalOpen, setShutdownModalOpen] = useState(false);
  const [isShuttingDown, setIsShuttingDown] = useState(false);
  const [shutdownDone, setShutdownDone] = useState(false);

  useEffect(() => {
    const cleanup = initSystemLifecycle();
    return cleanup;
  }, []);

  const handleRequestShutdown = useCallback(async () => {
    setIsShuttingDown(true);
    await requestServerShutdown();
    setIsShuttingDown(false);
    setShutdownDone(true);
  }, []);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const handleToggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) {
          await document.documentElement.requestFullscreen();
        }
      } else {
        if (document.exitFullscreen) {
          await document.exitFullscreen();
        }
      }
    } catch {
      // Ignorer si l'API est restreinte par l'environnement
    }
  }, []);

  const handleToggleSidebar = useCallback(() => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('asw_sidebar_collapsed', next ? '1' : '0');
      } catch {
        // ignore storage errors
      }
      return next;
    });
  }, []);

  const handleSelectProfile = useCallback((prof: UserProfile) => {
    try {
      sessionStorage.setItem('asw_active_profile_id', prof.id);
    } catch {
      // ignore storage restrictions
    }
    setCurrentProfile(prof);
    if (prof.role !== 'ADMIN') {
      setActiveTab((prev) => (prev === 'settings' ? 'dashboard' : prev));
    }
  }, []);

  const reloadCoreState = useCallback(async () => {
    const [comp, sett, profs, snap, defCount] = await Promise.all([
      db.company.get('default'),
      db.settings.get('default'),
      db.profiles.toArray(),
      computeCentralFinancialSnapshot('30_DAYS'),
      db.defectiveProducts.where('status').equals('EN_QUARANTAINE').count(),
    ]);
    if (comp) setCompany(comp);
    if (sett) setSettings(sett);
    setProfiles(profs);
    const activeProfs = profs.filter((p) => p.active !== false);
    let savedId: string | null = null;
    try {
      savedId = sessionStorage.getItem('asw_active_profile_id');
    } catch {
      savedId = null;
    }
    setCurrentProfile((prev) => {
      if (savedId) {
        const matchedSaved = profs.find((p) => p.id === savedId && p.active !== false);
        if (matchedSaved) return matchedSaved;
      }
      if (prev) {
        const updatedPrev = profs.find((p) => p.id === prev.id);
        if (updatedPrev && updatedPrev.active !== false) return updatedPrev;
      }
      return activeProfs[0] ?? profs[0] ?? null;
    });
    setBadges({
      criticalStock: snap.outOfStockCount + snap.criticalStockCount,
      unpaidInvoices: snap.unpaidInvoicesCount,
      urgentSav: snap.urgentSavCount,
      pendingPurchases: snap.pendingPurchasesCount,
      defectiveCount: defCount,
    });
    setRefreshCounter((c) => c + 1);
  }, []);

  useEffect(() => {
    initializeDatabaseIfNeeded()
      .then(() => reloadCoreState())
      .then(async () => {
        const comp = await db.company.get('default');
        let unlockedInSession = false;
        let wizardConfigured = false;
        try {
          unlockedInSession = sessionStorage.getItem('asw_session_unlocked') === '1';
          wizardConfigured = localStorage.getItem('asw_require_pin_on_start') === '1';
        } catch {
          // ignore
        }
        // Verrouiller automatiquement au démarrage si l'assistant 9 étapes a été configuré ou si la session n'est pas encore déverrouillée
        if (!unlockedInSession && (wizardConfigured || (comp && !comp.isDemoData))) {
          setLocked(true);
        }
        setReady(true);
      });
  }, [reloadCoreState]);

  // Raccourcis clavier globaux (Section 15 & 31 : F1 Dashboard, F2 POS, Ctrl+K Recherche, Escape Fermer)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'F1') {
        e.preventDefault();
        setActiveTab('dashboard');
      } else if (e.key === 'F2') {
        e.preventDefault();
        setActiveTab('pos');
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (e.key === 'Escape') {
        setSearchOpen(false);
        setPrintDoc(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Application du thème : Clair, Sombre, Vert printemps, Orange joyeux
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('dark', 'theme-green', 'theme-orange');

    let effectiveTheme = settings?.theme || 'light';
    if (effectiveTheme === 'system') {
      const prefersDark = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      effectiveTheme = prefersDark ? 'dark' : 'light';
    }

    if (effectiveTheme === 'dark') {
      root.classList.add('dark');
    } else if (effectiveTheme === 'green') {
      root.classList.add('theme-green');
    } else if (effectiveTheme === 'orange') {
      root.classList.add('theme-orange');
    }
  }, [settings?.theme]);

  const handleSelectTheme = async (nextTheme: 'light' | 'dark' | 'green' | 'orange') => {
    if (!settings) return;
    setSettings({ ...settings, theme: nextTheme });
    await db.settings.update('default', { theme: nextTheme });
    setThemeMenuOpen(false);
  };

  if (!ready || !company || !settings) {
    return (
      <div className="min-h-screen bg-[#F6F4EE] dark:bg-slate-950 flex items-center justify-center p-8">
        <div className="text-center space-y-2">
          <div className="font-display text-3xl font-bold text-[#0F172A] dark:text-white">
            Atlas Soft Water
          </div>
          <div className="text-xs text-slate-500 font-mono">
            Initialisation de la base locale IndexedDB...
          </div>
        </div>
      </div>
    );
  }

  const sidebarItems: {
    id: NavTab;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    badge?: number;
    badgeTone?: 'red' | 'amber' | 'blue';
  }[] = [
    { id: 'dashboard', label: 'Dashboard (F1)', icon: BarChart3 },
    { id: 'pos', label: 'Caisse POS (F2)', icon: ShoppingCart },
    { id: 'sales', label: 'Ventes', icon: ShoppingBag },
    { id: 'quotes', label: 'Devis', icon: FileText },
    {
      id: 'invoices',
      label: 'Factures & Avoirs',
      icon: Receipt,
      badge: badges.unpaidInvoices,
      badgeTone: 'amber',
    },
    { id: 'products', label: 'Produits', icon: Package },
    {
      id: 'stock',
      label: 'Stock & Mouvements',
      icon: Boxes,
      badge: badges.criticalStock,
      badgeTone: 'red',
    },
    {
      id: 'defective',
      label: 'Produits Défectueux',
      icon: ShieldAlert,
      badge: badges.defectiveCount,
      badgeTone: 'red',
    },
    { id: 'inventory', label: 'Inventaire', icon: ClipboardList },
    {
      id: 'purchases',
      label: 'Achats & Réceptions',
      icon: Truck,
      badge: badges.pendingPurchases,
      badgeTone: 'blue',
    },
    { id: 'suppliers', label: 'Fournisseurs', icon: BuildingIcon },
    { id: 'customers', label: 'Clients & Équipements', icon: Users },
    {
      id: 'sav',
      label: 'SAV & Filtres',
      icon: Wrench,
      badge: badges.urgentSav,
      badgeTone: 'amber',
    },
    { id: 'finance', label: 'Finance & Caisse', icon: Wallet },
    { id: 'intelligence', label: 'Intelligence & Eau', icon: Activity },
    { id: 'market', label: 'Veille Marché', icon: Compass },
    { id: 'tests', label: 'Arbitrage & Tests Auto', icon: ShieldCheck },
    { id: 'backups', label: 'Sauvegardes & Excel', icon: Database },
    ...(currentProfile?.role === 'ADMIN'
      ? [{ id: 'settings' as NavTab, label: 'Paramètres', icon: Settings }]
      : []),
  ];

  return (
    <ErrorBoundary>
      <div className="h-screen flex flex-col bg-[#F9F6F0] dark:bg-slate-800 text-[#0F172A] dark:text-slate-100 zellige-pattern overflow-hidden">
        {/* Top Bar Contract : 3 zones (Brand Title — Navigation Links — Primary Actions) */}
        <header className="shrink-0 z-30 bg-white/95 dark:bg-[#273549]/95 backdrop-blur border-b border-slate-200 dark:border-slate-700 px-4 sm:px-6 py-3 flex items-center justify-between gap-3 no-print">
          {/* Zone 1 : Brand Wordmark & Logo */}
          <div className="flex items-center gap-3 shrink-0">
            <a
              href="#dashboard"
              onClick={(e) => {
                e.preventDefault();
                setActiveTab('dashboard');
              }}
              className="flex items-center gap-2.5 font-display text-2xl font-bold tracking-tight text-[#0F172A] dark:text-white whitespace-nowrap"
            >
              {company.logoDataUrl && (
                <img
                  src={company.logoDataUrl}
                  alt={company.name}
                  className="h-8 w-auto max-w-[110px] object-contain rounded bg-white p-0.5 border border-slate-200 dark:border-slate-700"
                />
              )}
              <span>{company.name}</span>
            </a>
          </div>

          {/* Zone 2 : 5 clean text navigation links */}
          <nav className="hidden lg:flex items-center gap-3.5 xl:gap-6 text-xs font-medium text-slate-600 dark:text-slate-300">
            <button
              type="button"
              onClick={() => setActiveTab('pos')}
              className="hover:text-[#1D4ED8] hover:underline transition-colors whitespace-nowrap"
            >
              Caisse POS (F2)
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('stock')}
              className="hover:text-[#1D4ED8] hover:underline transition-colors whitespace-nowrap"
            >
              Centre de Stock
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('sav')}
              className="hover:text-[#1D4ED8] hover:underline transition-colors whitespace-nowrap"
            >
              Suivi SAV
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('tests')}
              className="hover:text-[#1D4ED8] hover:underline transition-colors whitespace-nowrap"
            >
              Arbitrage & Tests (17)
            </button>
          </nav>

          {/* Zone 3 : Actions rapides (Recherche Ctrl+K, Thème Clair/Sombre & Verrouillage/Profil) */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors whitespace-nowrap"
            >
              <Search className="w-3.5 h-3.5" />
              Rechercher (Ctrl+K)
            </button>

            <button
              type="button"
              onClick={handleToggleFullscreen}
              className="inline-flex items-center justify-center w-8 h-8 text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer shrink-0"
              title={isFullscreen ? 'Quitter le mode plein écran (Échap)' : 'Afficher l’application en plein écran'}
              aria-label={isFullscreen ? 'Quitter le mode plein écran' : 'Afficher en plein écran'}
            >
              {isFullscreen ? (
                <Minimize className="w-4 h-4 text-[#1D4ED8] dark:text-blue-400" />
              ) : (
                <Maximize className="w-4 h-4 text-slate-600 dark:text-slate-300" />
              )}
            </button>

            {/* Sélecteur de Thème Visuel (Clair, Sombre, Vert printemps, Orange joyeux) */}
            <div className="relative">
              <button
                type="button"
                onClick={() => setThemeMenuOpen((prev) => !prev)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors whitespace-nowrap cursor-pointer"
                title="Changer de thème visuel"
              >
                {settings.theme === 'dark' ? (
                  <>
                    <Moon className="w-3.5 h-3.5 text-blue-400" />
                    <span>Sombre</span>
                  </>
                ) : settings.theme === 'green' ? (
                  <>
                    <Leaf className="w-3.5 h-3.5 text-emerald-600" />
                    <span>Vert printemps</span>
                  </>
                ) : settings.theme === 'orange' ? (
                  <>
                    <Sparkles className="w-3.5 h-3.5 text-orange-500" />
                    <span>Orange joyeux</span>
                  </>
                ) : (
                  <>
                    <Sun className="w-3.5 h-3.5 text-[#D9A95B]" />
                    <span>Clair</span>
                  </>
                )}
              </button>

              {themeMenuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-40"
                    onClick={() => setThemeMenuOpen(false)}
                  />
                  <div className="absolute right-0 mt-1.5 w-52 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg shadow-xl py-1 z-50 animate-in fade-in zoom-in-95 duration-100">
                    <div className="px-3 py-1 text-[10px] uppercase font-bold text-slate-400 tracking-wider">
                      Thèmes visuels
                    </div>

                    <button
                      type="button"
                      onClick={() => handleSelectTheme('light')}
                      className={`w-full flex items-center justify-between px-3 py-2 text-xs transition-colors cursor-pointer ${
                        settings.theme === 'light'
                          ? 'bg-amber-50 dark:bg-amber-950/30 text-amber-900 dark:text-amber-200 font-bold'
                          : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <Sun className="w-4 h-4 text-[#D9A95B]" />
                        <span>Clair (Sable & Ivoire)</span>
                      </span>
                      {settings.theme === 'light' && <span className="text-amber-600 font-bold">✓</span>}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleSelectTheme('dark')}
                      className={`w-full flex items-center justify-between px-3 py-2 text-xs transition-colors cursor-pointer ${
                        settings.theme === 'dark'
                          ? 'bg-slate-700 text-white font-bold'
                          : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <Moon className="w-4 h-4 text-blue-400" />
                        <span>Sombre (Bleu Nuit Atlas)</span>
                      </span>
                      {settings.theme === 'dark' && <span className="text-blue-300 font-bold">✓</span>}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleSelectTheme('green')}
                      className={`w-full flex items-center justify-between px-3 py-2 text-xs transition-colors cursor-pointer ${
                        settings.theme === 'green'
                          ? 'bg-emerald-50 dark:bg-emerald-950/30 text-emerald-800 dark:text-emerald-200 font-bold'
                          : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <Leaf className="w-4 h-4 text-emerald-600" />
                        <span>Vert printemps</span>
                      </span>
                      {settings.theme === 'green' && <span className="text-emerald-600 font-bold">✓</span>}
                    </button>

                    <button
                      type="button"
                      onClick={() => handleSelectTheme('orange')}
                      className={`w-full flex items-center justify-between px-3 py-2 text-xs transition-colors cursor-pointer ${
                        settings.theme === 'orange'
                          ? 'bg-orange-50 dark:bg-orange-950/30 text-orange-900 dark:text-orange-200 font-bold'
                          : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-orange-500" />
                        <span>Orange joyeux</span>
                      </span>
                      {settings.theme === 'orange' && <span className="text-orange-600 font-bold">✓</span>}
                    </button>
                  </div>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => setLocked(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-[#0F172A] rounded-md hover:bg-slate-800 transition-colors whitespace-nowrap cursor-pointer"
              title="Verrouiller la session ou changer de profil"
            >
              <Lock className="w-3.5 h-3.5 text-[#D9A95B]" />
              {currentProfile?.role ?? 'ADMIN'}
            </button>

            <button
              type="button"
              onClick={() => {
                setShutdownDone(false);
                setShutdownModalOpen(true);
              }}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/60 rounded-md hover:bg-red-100 dark:hover:bg-red-900/50 transition-colors whitespace-nowrap cursor-pointer"
              title="Fermer l'application et arrêter le serveur Node.js (Option 1)"
            >
              <Power className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
              <span className="hidden sm:inline">Quitter Node.js</span>
            </button>
          </div>
        </header>

        {/* Bandeau explicite Section 49 si Données de Démonstration actives */}
        {company.isDemoData && (
          <div className="shrink-0 bg-amber-50/90 border-b border-amber-200 px-6 py-1.5 flex flex-wrap items-center justify-between gap-2 text-xs text-amber-950 no-print">
            <div>
              <strong>DONNÉES DE DÉMONSTRATION ACTIVES</strong> — Base pré-remplie pour explorer
              les modules (Osmoseurs, Membranes FilmTec, Adoucisseurs, SAV, Ventes, Caisse).
            </div>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setActiveTab('tests')}
                className="font-semibold text-[#1D4ED8] hover:underline"
              >
                Exécuter les 17 Tests Automatisés →
              </button>
            </div>
          </div>
        )}

        {/* Workspace Canvas : Sidebar (256px fixe ou masquée) + Main Content Viewport défilant */}
        <div className="flex-1 flex overflow-hidden relative min-h-0">
          {!sidebarCollapsed ? (
            <aside className="sidebar-container w-64 shrink-0 bg-white dark:bg-[#273549] border-r border-slate-200 dark:border-slate-700 p-3 flex flex-col justify-between overflow-hidden select-none no-print">
              <div className="flex items-center justify-between px-2 pb-2 mb-1.5 border-b border-slate-100 dark:border-slate-700/70 shrink-0">
                <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-400">
                  Navigation
                </span>
                <button
                  type="button"
                  onClick={handleToggleSidebar}
                  className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 rounded transition-colors"
                  title="Masquer la barre latérale de menu"
                >
                  <PanelLeftClose className="w-3.5 h-3.5" />
                  <span>Masquer</span>
                </button>
              </div>

              {/* Liste d'onglets de navigation avec défilement interne indépendant */}
              <div className="space-y-0.5 flex-1 overflow-y-auto min-h-0 pr-1 custom-scrollbar">
                {sidebarItems.map((item) => {
                  const Icon = item.icon;
                  const active = activeTab === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => setActiveTab(item.id)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-md text-xs font-medium transition-colors whitespace-nowrap ${
                        active
                          ? 'bg-[#0F172A] text-white'
                          : 'text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/60'
                      }`}
                    >
                      <span className="flex items-center gap-2.5 truncate">
                        <Icon
                          className={`w-4 h-4 shrink-0 ${
                            active ? 'text-[#D9A95B]' : 'text-slate-400'
                          }`}
                        />
                        <span className="truncate">{item.label}</span>
                      </span>

                      {item.badge !== undefined && item.badge > 0 && (
                        <span
                          className={`font-mono-tabular text-[11px] font-bold px-1.5 py-0.2 rounded ${
                            active
                              ? 'bg-white/20 text-white'
                              : item.badgeTone === 'red'
                              ? 'text-red-700 bg-red-50'
                              : item.badgeTone === 'amber'
                              ? 'text-amber-800 bg-amber-50'
                              : 'text-blue-800 bg-blue-50'
                          }`}
                        >
                          {item.badge}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Profil & statuts toujours ancrés au bas de la barre latérale */}
              <div className="pt-3 mt-2 border-t border-slate-200 dark:border-slate-800 px-2 space-y-1.5 text-[11px] text-slate-500 shrink-0">
                <div className="flex items-center justify-between gap-1">
                  <div
                    className="font-semibold text-slate-800 dark:text-slate-200 truncate"
                    title={currentProfile?.name}
                  >
                    {currentProfile?.name}
                  </div>
                  <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 shrink-0">
                    {currentProfile?.role}
                  </span>
                </div>
                <div className="flex items-center gap-2 pt-0.5">
                  {currentProfile?.role === 'ADMIN' && (
                    <>
                      <button
                        type="button"
                        onClick={() => setActiveTab('settings')}
                        className="text-[11px] font-medium text-[#1D4ED8] dark:text-blue-400 hover:underline"
                        title="Accéder aux Paramètres (Code PIN Maître requis)"
                      >
                        Gérer / Modifier utilisateurs
                      </button>
                      <span>·</span>
                    </>
                  )}
                  <button
                    type="button"
                    onClick={() => setLocked(true)}
                    className="text-[11px] font-medium text-slate-600 dark:text-slate-400 hover:underline cursor-pointer"
                    title="Changer de profil opérateur actif"
                  >
                    Changer d&apos;utilisateur
                  </button>
                  <span>·</span>
                  <button
                    type="button"
                    onClick={() => {
                      setShutdownDone(false);
                      setShutdownModalOpen(true);
                    }}
                    className="text-[11px] font-medium text-red-600 dark:text-red-400 hover:underline cursor-pointer"
                    title="Arrêter le serveur Node.js et fermer l'application"
                  >
                    Quitter Node.js
                  </button>
                </div>
                <div className="font-mono pt-0.5">
                  ICE : {company.ice} · {company.currency}
                </div>
                <div>Stockage Local IndexedDB Actif</div>
              </div>
            </aside>
          ) : (
            <aside
              className="sidebar-container shrink-0 bg-white/90 dark:bg-[#273549]/90 border-r border-slate-200 dark:border-slate-700 p-1.5 flex flex-col items-center gap-1 overflow-y-auto custom-scrollbar select-none no-print"
              aria-label="Menu latéral réduit"
            >
              <button
                type="button"
                onClick={handleToggleSidebar}
                className="p-2 rounded-md text-xs font-medium text-[#1D4ED8] dark:text-blue-400 bg-blue-50 dark:bg-slate-800 border border-blue-200 dark:border-slate-700 hover:bg-blue-100 transition-colors flex flex-col items-center gap-1"
                title="Afficher la barre latérale de menu"
              >
                <PanelLeftOpen className="w-4 h-4" />
                <span className="text-[9px] font-bold uppercase tracking-tighter">Menu</span>
              </button>
              <div className="w-6 border-t border-slate-200 dark:border-slate-700 my-1" />
              {sidebarItems.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveTab(item.id)}
                    title={item.label}
                    className={`relative p-2 rounded-md transition-colors ${
                      active
                        ? 'bg-[#0F172A] text-[#D9A95B]'
                        : 'text-slate-500 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700/60'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {item.badge !== undefined && item.badge > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-600" />
                    )}
                  </button>
                );
              })}
            </aside>
          )}

          {/* Main Content Viewport avec défilement autonome indépendant */}
          <main
            className={`flex-1 p-6 overflow-y-auto overflow-x-hidden min-h-0 ${
              sidebarCollapsed ? 'max-w-full' : 'max-w-[1600px]'
            }`}
          >
            {activeTab === 'dashboard' && (
              <DashboardView
                company={company}
                onNavigate={(t) => setActiveTab(t as NavTab)}
                refreshTrigger={refreshCounter}
                onOpenPrintPreview={setPrintDoc}
              />
            )}

            {activeTab === 'pos' && (
              <PosView
                company={company}
                settings={settings}
                currentProfile={currentProfile}
                onSaleCompleted={reloadCoreState}
                onOpenPrintPreview={setPrintDoc}
              />
            )}

            {activeTab === 'sales' && (
              <SalesView
                company={company}
                currentProfile={currentProfile}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenPrintPreview={setPrintDoc}
              />
            )}

            {activeTab === 'quotes' && (
              <QuotesView
                company={company}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenPrintPreview={setPrintDoc}
              />
            )}

            {activeTab === 'invoices' && (
              <InvoicesView
                company={company}
                settings={settings}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenPrintPreview={setPrintDoc}
              />
            )}

            {activeTab === 'products' && (
              <ProductsView
                company={company}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenPrintPreview={setPrintDoc}
              />
            )}

            {activeTab === 'stock' && (
              <StockCenterView
                company={company}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenPrintPreview={setPrintDoc}
                onNavigateToDefective={() => setActiveTab('defective')}
              />
            )}

            {activeTab === 'defective' && (
              <DefectiveProductsView
                company={company}
                currentProfile={currentProfile}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenPrintPreview={setPrintDoc}
              />
            )}

            {activeTab === 'inventory' && (
              <InventoryView
                company={company}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenPrintPreview={setPrintDoc}
              />
            )}

            {activeTab === 'purchases' && (
              <PurchasesView
                company={company}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenPrintPreview={setPrintDoc}
              />
            )}

            {activeTab === 'suppliers' && (
              <SuppliersView refreshTrigger={refreshCounter} onChanged={reloadCoreState} />
            )}

            {activeTab === 'customers' && (
              <CustomersView refreshTrigger={refreshCounter} onChanged={reloadCoreState} />
            )}

            {activeTab === 'sav' && (
              <SavView refreshTrigger={refreshCounter} onChanged={reloadCoreState} />
            )}

            {activeTab === 'finance' && (
              <FinanceView
                company={company}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenPrintPreview={setPrintDoc}
              />
            )}

            {activeTab === 'intelligence' && (
              <IntelligenceAndWaterDiagView
                settings={settings}
                refreshTrigger={refreshCounter}
              />
            )}

            {activeTab === 'market' && (
              <MarketWatchView
                company={company}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenPrintPreview={setPrintDoc}
              />
            )}

            {activeTab === 'tests' && (
              <BackupsDiagnosticsAndSettingsView
                key="tab-tests"
                initialTab="TESTS"
                company={company}
                settings={settings}
                currentProfile={currentProfile}
                onSelectProfile={handleSelectProfile}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenWizard={() => setWizardOpen(true)}
              />
            )}

            {activeTab === 'backups' && (
              <BackupsDiagnosticsAndSettingsView
                key="tab-backups"
                initialTab="BACKUPS"
                company={company}
                settings={settings}
                currentProfile={currentProfile}
                onSelectProfile={handleSelectProfile}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenWizard={() => setWizardOpen(true)}
              />
            )}

            {activeTab === 'settings' && (
              <BackupsDiagnosticsAndSettingsView
                key="tab-settings"
                initialTab="SETTINGS"
                company={company}
                settings={settings}
                currentProfile={currentProfile}
                onSelectProfile={handleSelectProfile}
                refreshTrigger={refreshCounter}
                onChanged={reloadCoreState}
                onOpenWizard={() => setWizardOpen(true)}
              />
            )}
          </main>
        </div>

        {/* Modales Globales */}
        <GlobalSearchModal
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          onNavigate={(t) => setActiveTab(t as NavTab)}
        />

        <PrintPreviewModal doc={printDoc} onClose={() => setPrintDoc(null)} />

        <PinLockModal
          locked={locked}
          profiles={profiles}
          currentProfile={currentProfile}
          isDemoData={company.isDemoData}
          onUnlock={(prof) => {
            try {
              sessionStorage.setItem('asw_session_unlocked', '1');
              sessionStorage.setItem('asw_active_profile_id', prof.id);
            } catch {
              // ignore
            }
            setCurrentProfile(prof);
            if (prof.role !== 'ADMIN') {
              setActiveTab((prev) => (prev === 'settings' ? 'dashboard' : prev));
            }
            setLocked(false);
          }}
        />

        <FirstStartWizardModal
          open={wizardOpen}
          onClose={() => setWizardOpen(false)}
          onCompleted={async () => {
            try {
              localStorage.setItem('asw_require_pin_on_start', '1');
              sessionStorage.removeItem('asw_session_unlocked');
              sessionStorage.removeItem('asw_active_profile_id');
            } catch {
              // ignore
            }
            await reloadCoreState();
            setActiveTab('dashboard');
            setLocked(true);
          }}
        />

        <ShutdownModal
          open={shutdownModalOpen}
          onClose={() => setShutdownModalOpen(false)}
          onRequestShutdown={handleRequestShutdown}
          isShuttingDown={isShuttingDown}
          shutdownDone={shutdownDone}
        />
      </div>
    </ErrorBoundary>
  );
}

function BuildingIcon({ className }: { className?: string }) {
  return <Droplets className={className} />;
}
