import React, { useEffect, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Coins,
  Database,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FileText,
  FlaskConical,
  Globe,
  Image as ImageIcon,
  KeyRound,
  Landmark,
  Leaf,
  Lock,
  MapPin,
  Moon,
  Play,
  Plus,
  Printer,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  UserPlus,
  Users,
  Wrench,
} from 'lucide-react';
import { db } from '../db/database';
import {
  CentralFinancialSnapshot,
  computeCentralFinancialSnapshot,
} from '../domain/analyticsEngine';
import { ARBITRAGE_RULES_CATALOG, ArbitrageError } from '../domain/arbitrageEngine';
import { dhToCents, formatMad } from '../domain/financialEngine';
import {
  evaluateWaterParameters,
  WATER_DIAGNOSTIC_RULES,
} from '../domain/waterDiagnosticEngine';
import {
  AiMarketResearchSummaryData,
  buildAiMarketResearchReportPrint,
  buildBankDepositReceiptPrint,
  buildCashAuditPvPrint,
  buildCashJournalPeriodPrint,
  buildExpensesPeriodPrint,
  buildPaymentCancellationPvPrint,
  buildSalesPeriodReportPrint,
  PrintableDocument,
} from '../printing/printTemplates';
import {
  AutomatedTestSuiteReport,
  runMandatoryAutomatedTests,
} from '../services/automatedTestSuite';
import {
  downloadExcelImportTemplate,
  executeAutoRepairDatabase,
  executeCommitValidatedImport,
  exportBackupString,
  exportDatabaseToExcelFile,
  ImportEntityType,
  ImportValidationReport,
  runDatabaseDiagnostic,
  validateAndRestoreBackup,
  validateImportData,
} from '../services/backupAndDiagnosticService';
import {
  executeAttemptModifyCashEntry,
  executeCancelBankDeposit,
  executeCancelExpenseViaPv,
  executeCloseCashRegister,
  executeConfirmBankDeposit,
  executeCreateExpense,
  executePrepareBankDeposit,
  executeResetAppToZero,
} from '../services/commandService';
import {
  AppSettings,
  AuditLog,
  BankDeposit,
  BankDepositCheckItem,
  CashAudit,
  CashEntry,
  CompanyInfo,
  DiagnosticReport,
  Expense,
  ExpenseCategory,
  MarketObservation,
  Payment,
  Product,
  Sale,
  UserProfile,
  UserRole,
} from '../types/domain';
import {
  addDaysToBusinessDate,
  formatBusinessDateFr,
  formatMoroccoDateTime,
  getMoroccoBusinessDate,
} from '../utils/dateUtils';
import {
  fileToLogoDataUrl,
  fileToWatermarkDataUrl,
  generateAtlasSoftWaterWatermarkDataUrl,
  generateId,
  generateRandomSalt,
  hashPinWithSalt,
  verifyPin,
} from '../utils/securityUtils';

const DENOMINATIONS = ['200', '100', '50', '20', '10', '5', '2', '1', '0.5'];

/**
 * SECTIONS 27, 28 & 29 : FINANCE, JOURNAL DE CAISSE, ARRÊT DE CAISSE (BILLETAGE) & DÉPENSES
 */
export const FinanceView: React.FC<{
  company: CompanyInfo;
  refreshTrigger: number;
  onChanged: () => void;
  onOpenPrintPreview: (doc: PrintableDocument) => void;
}> = ({ company, refreshTrigger, onChanged, onOpenPrintPreview }) => {
  const today = getMoroccoBusinessDate();
  const [subTab, setSubTab] = useState<
    'OVERVIEW' | 'BANK_DEPOSITS' | 'CASH_AUDIT' | 'EXPENSES'
  >('OVERVIEW');
  const [snapshot, setSnapshot] = useState<CentralFinancialSnapshot | null>(null);
  const [cashEntries, setCashEntries] = useState<CashEntry[]>([]);
  const [cashAudits, setCashAudits] = useState<CashAudit[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [bankDeposits, setBankDeposits] = useState<BankDeposit[]>([]);
  const [availableChecks, setAvailableChecks] = useState<Payment[]>([]);

  // Modale Préparation Versement Bancaire
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [cashToDepositDh, setCashToDepositDh] = useState<string>('');
  const [selectedCheckIds, setSelectedCheckIds] = useState<Set<string>>(new Set());
  const [depositBankName, setDepositBankName] = useState<string>('Attijariwafa bank');
  const [depositBankAccount, setDepositBankAccount] = useState<string>('');
  const [depositReference, setDepositReference] = useState<string>('');
  const [depositNotes, setDepositNotes] = useState<string>('');

  // Modale Confirmation Versement (Retour de Banque)
  const [confirmingDeposit, setConfirmingDeposit] = useState<BankDeposit | null>(null);
  const [confirmReference, setConfirmReference] = useState<string>('');
  const [confirmDate, setConfirmDate] = useState<string>(today);
  const [confirmNotes, setConfirmNotes] = useState<string>('');

  // Modale Annulation Versement
  const [cancelingDeposit, setCancelingDeposit] = useState<BankDeposit | null>(null);
  const [cancelDepositReason, setCancelDepositReason] = useState<string>('');

  const [startDate, setStartDate] = useState<string>(addDaysToBusinessDate(today, -30));
  const [endDate, setEndDate] = useState<string>(today);
  const [counts, setCounts] = useState<Record<string, number>>({
    '200': 0,
    '100': 0,
    '50': 0,
    '20': 0,
    '10': 0,
    '5': 0,
    '2': 0,
    '1': 0,
    '0.5': 0,
  });
  const [auditNotes, setAuditNotes] = useState('');
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // Formulaire Dépense
  const [expForm, setExpForm] = useState({
    category: 'CARBURANT' as ExpenseCategory,
    label: '',
    beneficiary: '',
    amountHtDh: '',
    vatRate: 20,
    paymentMethod: 'CASH' as 'CASH' | 'CARD' | 'TRANSFER' | 'CHECK',
    receiptRef: '',
  });
  const [cancelingExpense, setCancelingExpense] = useState<Expense | null>(null);
  const [cancelExpenseReason, setCancelExpenseReason] = useState('');

  useEffect(() => {
    Promise.all([
      computeCentralFinancialSnapshot('30_DAYS'),
      db.cashEntries.orderBy('createdAt').reverse().toArray(),
      db.cashAudits.orderBy('createdAt').reverse().toArray(),
      db.expenses.orderBy('createdAt').reverse().toArray(),
      db.sales.orderBy('createdAt').reverse().toArray(),
      db.bankDeposits.orderBy('createdAt').reverse().toArray(),
      db.payments.where('method').equals('CHECK').toArray(),
    ]).then(([snap, entries, audits, exps, sList, deposits, checks]) => {
      setSnapshot(snap);
      setCashEntries(entries);
      setCashAudits(audits);
      setExpenses(exps);
      setSales(sList);
      setBankDeposits(deposits);
      setAvailableChecks(
        checks.filter(
          (c) =>
            c.direction === 'IN' &&
            c.status === 'VALIDATED' &&
            c.destination === 'PORTEFEUILLE_EFFETS'
        )
      );
    });
  }, [refreshTrigger]);

  const filteredCashEntries = cashEntries.filter((ce) => {
    if (startDate && ce.businessDate < startDate) return false;
    if (endDate && ce.businessDate > endDate) return false;
    return true;
  });

  const filteredExpenses = expenses.filter((ex) => {
    if (startDate && ex.businessDate < startDate) return false;
    if (endDate && ex.businessDate > endDate) return false;
    return true;
  });

  const filteredSales = sales.filter((s) => {
    if (startDate && s.businessDate < startDate) return false;
    if (endDate && s.businessDate > endDate) return false;
    return true;
  });

  const filteredDeposits = bankDeposits.filter((d) => {
    if (startDate && d.businessDate < startDate) return false;
    if (endDate && d.businessDate > endDate) return false;
    return true;
  });

  const pendingDepositsCount = bankDeposits.filter((d) => d.status === 'PREPARED').length;
  const pendingDeposits = bankDeposits.filter((d) => d.status === 'PREPARED');
  const confirmedDeposits = bankDeposits.filter((d) => d.status === 'CONFIRMED');
  const pendingCashToDepositCents = pendingDeposits.reduce((acc, d) => acc + d.cashToDepositCents, 0);
  const totalConfirmedDepositsCents = confirmedDeposits.reduce((acc, d) => acc + d.totalDepositCents, 0);
  const totalAvailableChecksCents = availableChecks.reduce((acc, c) => acc + c.amountCents, 0);

  const currentCashAvailable = snapshot?.physicalCashBalanceCents ?? 0;
  const parsedCashToDepositCents = dhToCents(cashToDepositDh);
  const estimatedRemainingCashCents = currentCashAvailable - parsedCashToDepositCents;
  const selectedChecksList = availableChecks.filter((c) => selectedCheckIds.has(c.id));
  const totalSelectedChecksCents = selectedChecksList.reduce((acc, c) => acc + c.amountCents, 0);
  const totalEstimatedDepositCents = parsedCashToDepositCents + totalSelectedChecksCents;

  const handleOpenPrepareDepositModal = () => {
    // Par défaut, propose de verser la totalité ou de laisser le fond souhaité
    setCashToDepositDh(currentCashAvailable > 0 ? (currentCashAvailable / 100).toString() : '0');
    // Sélectionne par défaut tous les chèques disponibles en portefeuille
    setSelectedCheckIds(new Set(availableChecks.map((c) => c.id)));
    setDepositBankName('Attijariwafa bank');
    setDepositBankAccount(company.rib || '');
    setDepositReference('');
    setDepositNotes('');
    setShowDepositModal(true);
  };

  const handlePrepareDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (parsedCashToDepositCents < 0) {
      setFeedback({
        type: 'error',
        msg: 'Le montant en espèces à verser ne peut pas être négatif.',
      });
      return;
    }
    if (parsedCashToDepositCents > currentCashAvailable) {
      setFeedback({
        type: 'error',
        msg: `Le montant en espèces à verser (${formatMad(parsedCashToDepositCents)}) dépasse le solde disponible en caisse (${formatMad(currentCashAvailable)}).`,
      });
      return;
    }
    if (totalEstimatedDepositCents <= 0) {
      setFeedback({
        type: 'error',
        msg: 'Veuillez saisir un montant en espèces ou sélectionner au moins un chèque à verser.',
      });
      return;
    }

    try {
      const checksToInclude: BankDepositCheckItem[] = selectedChecksList.map((c) => {
        let extractedBank = 'Banque';
        if (c.notes) {
          const match = c.notes.match(/banque\s*:\s*([^|;]+)/i);
          if (match?.[1]) extractedBank = match[1].trim();
        }
        return {
          paymentId: c.id,
          checkNumber: c.reference || c.number,
          bankName: extractedBank,
          amountCents: c.amountCents,
          partyName: c.partyName,
          date: c.businessDate,
        };
      });

      const newDeposit = await executePrepareBankDeposit({
        cashToDepositCents: parsedCashToDepositCents,
        checksSelected: checksToInclude,
        bankName: depositBankName,
        bankAccountNumber: depositBankAccount,
        reference: depositReference,
        notes: depositNotes,
      });

      setShowDepositModal(false);
      setCashToDepositDh('');
      setSelectedCheckIds(new Set());
      setDepositReference('');
      setDepositNotes('');
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Bordereau de versement ${newDeposit.number} édité avec succès (${formatMad(newDeposit.totalDepositCents)} dont ${formatMad(newDeposit.cashToDepositCents)} en espèces). Le reste prévu en caisse est de ${formatMad(newDeposit.cashRemainingInRegisterCents)}. À votre retour de la banque, cliquez sur "Confirmer le versement" pour actualiser officiellement la caisse.`,
      });
      onOpenPrintPreview(buildBankDepositReceiptPrint(company, newDeposit));
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleConfirmDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!confirmingDeposit) return;
    try {
      const updated = await executeConfirmBankDeposit({
        depositId: confirmingDeposit.id,
        reference: confirmReference,
        confirmationDate: confirmDate,
        notes: confirmNotes,
      });
      setConfirmingDeposit(null);
      setConfirmReference('');
      setConfirmNotes('');
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Versement ${updated.number} confirmé ! La caisse physique a été actualisée. Nouveau solde en caisse : ${formatMad(updated.cashRemainingInRegisterCents)} (solde officiel disponible pour l'Arrêt de Caisse & Billetage).`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleCancelDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelingDeposit) return;
    try {
      const res = await executeCancelBankDeposit({
        depositId: cancelingDeposit.id,
        reason: cancelDepositReason,
      });
      setCancelingDeposit(null);
      setCancelDepositReason('');
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Versement ${res.number} annulé avec succès.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const countedBalanceCents = Object.entries(counts).reduce((acc, [denom, qty]) => {
    return acc + Math.round(parseFloat(denom) * 100) * (Number(qty) || 0);
  }, 0);

  const theoreticalCashCents = snapshot?.physicalCashBalanceCents ?? 0;
  const varianceCents = countedBalanceCents - theoreticalCashCents;

  const handleCloseCash = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const audit = await executeCloseCashRegister({
        counts,
        notes: auditNotes,
      });
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Clôture de caisse ${audit.number} validée (${audit.status}). Les écritures de la période sont désormais verrouillées (Règle 13).`,
      });
      onOpenPrintPreview(buildCashAuditPvPrint(company, audit));
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleTestLockedCashEdit = async (entry: CashEntry) => {
    try {
      await executeAttemptModifyCashEntry({
        cashEntryId: entry.id,
        newAmountCents: entry.amountCents + 1000,
      });
    } catch (err) {
      if (err instanceof ArbitrageError) {
        setFeedback({ type: 'error', msg: err.decision.resolutionMessage });
      }
    }
  };

  const handleCreateExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!expForm.label || !expForm.amountHtDh) return;
    await executeCreateExpense({
      category: expForm.category,
      label: expForm.label,
      beneficiary: expForm.beneficiary,
      amountHtCents: dhToCents(expForm.amountHtDh),
      vatRate: expForm.vatRate,
      paymentMethod: expForm.paymentMethod,
      receiptRef: expForm.receiptRef,
    });
    setExpForm({ ...expForm, label: '', beneficiary: '', amountHtDh: '', receiptRef: '' });
    onChanged();
    setFeedback({ type: 'success', msg: 'Dépense enregistrée avec succès.' });
  };

  const handleConfirmCancelExpenseViaPv = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cancelingExpense) return;
    try {
      const reason =
        cancelExpenseReason.trim() || `Annulation dépense ${cancelingExpense.number}`;
      const res = await executeCancelExpenseViaPv({
        expenseId: cancelingExpense.id,
        reason,
      });
      setCancelingExpense(null);
      setCancelExpenseReason('');
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Dépense ${res.expense.number} annulée via PV ${res.pvAudit.number}.`,
      });
      onOpenPrintPreview(
        buildPaymentCancellationPvPrint(company, {
          pvAudit: res.pvAudit,
          expense: res.expense,
          canceledAmountCents: res.expense.amountTtcCents,
          paymentMethod: res.expense.paymentMethod,
          reason,
        })
      );
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <div className="space-y-5">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-2xl font-bold text-slate-900 dark:text-white">
              Finance, Journal de Caisse, Billetage & Charges
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Section 27 & Règle 13 : Séparation stricte CA / Encaissements / Caisse / Banque ·
              États imprimables & PDF par période
            </p>
          </div>

          <div className="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800 rounded-lg">
            <button
              type="button"
              onClick={() => setSubTab('OVERVIEW')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                subTab === 'OVERVIEW'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              Journal de Caisse & Trésorerie
            </button>
            <button
              type="button"
              onClick={() => setSubTab('BANK_DEPOSITS')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md flex items-center gap-1.5 ${
                subTab === 'BANK_DEPOSITS'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              <Landmark className="w-3.5 h-3.5 text-[#1D4ED8] dark:text-blue-400" />
              <span>Versements Bancaires ({bankDeposits.length})</span>
              {pendingDepositsCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-amber-100 dark:bg-amber-950/80 text-amber-900 dark:text-amber-200 font-bold">
                  {pendingDepositsCount} en attente
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setSubTab('CASH_AUDIT')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                subTab === 'CASH_AUDIT'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              Arrêt de Caisse & Billetage
            </button>
            <button
              type="button"
              onClick={() => setSubTab('EXPENSES')}
              className={`px-3 py-1.5 text-xs font-medium rounded-md ${
                subTab === 'EXPENSES'
                  ? 'bg-white dark:bg-slate-700 text-slate-900 dark:text-white shadow-xs'
                  : 'text-slate-600 dark:text-slate-300'
              }`}
            >
              Dépenses & Charges ({filteredExpenses.length})
            </button>
          </div>
        </div>

        {/* Barre de sélection de période et d'impression / téléchargement PDF des 3 états */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100 dark:border-slate-800 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-700 dark:text-slate-300">
              Période d&apos;impression :
            </span>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="px-2.5 py-1 font-mono border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
            />
            <span className="text-slate-500">au</span>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="px-2.5 py-1 font-mono border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800"
            />
            <div className="inline-flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setStartDate(today);
                  setEndDate(today);
                }}
                className="px-2 py-1 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Aujourd&apos;hui
              </button>
              <button
                type="button"
                onClick={() => {
                  setStartDate(addDaysToBusinessDate(today, -7));
                  setEndDate(today);
                }}
                className="px-2 py-1 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                7j
              </button>
              <button
                type="button"
                onClick={() => {
                  setStartDate(addDaysToBusinessDate(today, -30));
                  setEndDate(today);
                }}
                className="px-2 py-1 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                30j
              </button>
              <button
                type="button"
                onClick={() => {
                  setStartDate('2020-01-01');
                  setEndDate(today);
                }}
                className="px-2 py-1 border border-slate-300 dark:border-slate-700 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
              >
                Tout
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onOpenPrintPreview(
                  buildCashJournalPeriodPrint(
                    company,
                    filteredCashEntries,
                    startDate || '2020-01-01',
                    endDate || today,
                    theoreticalCashCents
                  )
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0F172A] text-white font-semibold rounded-md hover:bg-slate-800 transition-colors"
            >
              <Printer className="w-3.5 h-3.5 text-[#D9A95B]" />
              Journal de Caisse (PDF / A4)
            </button>
            <button
              type="button"
              onClick={() =>
                onOpenPrintPreview(
                  buildExpensesPeriodPrint(
                    company,
                    filteredExpenses,
                    startDate || '2020-01-01',
                    endDate || today
                  )
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-amber-800 text-white font-semibold rounded-md hover:bg-amber-900 transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              Journal des Dépenses (PDF / A4)
            </button>
            <button
              type="button"
              onClick={() =>
                onOpenPrintPreview(
                  buildSalesPeriodReportPrint(
                    company,
                    filteredSales,
                    startDate || '2020-01-01',
                    endDate || today
                  )
                )
              }
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1D4ED8] text-white font-semibold rounded-md hover:bg-blue-800 transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              État des Ventes (PDF / A4)
            </button>
          </div>
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-md border text-xs flex justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
              : 'bg-red-50 border-red-300 text-red-900'
          }`}
        >
          <span>{feedback.msg}</span>
          <button type="button" onClick={() => setFeedback(null)} className="underline">
            Fermer
          </button>
        </div>
      )}

      {subTab === 'OVERVIEW' && snapshot && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Solde Caisse Physique (Espèces)</div>
              <div className="text-xl font-bold font-mono-tabular text-slate-900 mt-1">
                {formatMad(snapshot.physicalCashBalanceCents)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">Règle 4 : Espèces uniquement</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Solde Banque & Effets</div>
              <div className="text-xl font-bold font-mono-tabular text-[#1D4ED8] mt-1">
                {formatMad(snapshot.bankBalanceCents)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">Virements, Cartes, Chèques</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Résultat d&apos;Exploitation (30j HT)</div>
              <div className="text-xl font-bold font-mono-tabular text-emerald-700 mt-1">
                {formatMad(snapshot.periodOperatingResultCents)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">Marge brute HT − Charges HT</div>
            </div>
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500">Créances Clients / Dettes Fourn.</div>
              <div className="text-sm font-bold font-mono-tabular mt-1.5">
                <span className="text-amber-700">
                  Créances : {formatMad(snapshot.customerReceivablesCents)}
                </span>
                <br />
                <span className="text-red-700">
                  Dettes : {formatMad(snapshot.supplierDebtsCents)}
                </span>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between font-semibold text-xs text-slate-800">
              <span>
                Journal des Écritures de Caisse Physique sur la période ({filteredCashEntries.length}{' '}
                mouvement(s) du {formatBusinessDateFr(startDate)} au {formatBusinessDateFr(endDate)})
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleOpenPrepareDepositModal}
                  className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#1D4ED8] hover:bg-blue-700 text-white rounded font-medium shadow-xs"
                >
                  <Landmark className="w-3.5 h-3.5" /> Effectuer un Versement Bancaire
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onOpenPrintPreview(
                      buildCashJournalPeriodPrint(
                        company,
                        filteredCashEntries,
                        startDate || '2020-01-01',
                        endDate || today,
                        theoreticalCashCents
                      )
                    )
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded border border-slate-300"
                >
                  <Printer className="w-3.5 h-3.5" /> Imprimer / PDF Journal de Caisse
                </button>
              </div>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                  <th className="py-2.5 px-4">Date</th>
                  <th className="py-2.5 px-4">Type</th>
                  <th className="py-2.5 px-4">Libellé</th>
                  <th className="py-2.5 px-4">Pièce Source</th>
                  <th className="py-2.5 px-4 text-right">Montant Espèces</th>
                  <th className="py-2.5 px-4">Verrouillage Clôture</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredCashEntries.map((ce) => (
                  <tr key={ce.id}>
                    <td className="py-2.5 px-4 font-mono-tabular">
                      {formatBusinessDateFr(ce.businessDate)}
                    </td>
                    <td className="py-2.5 px-4 font-mono text-[11px]">{ce.type}</td>
                    <td className="py-2.5 px-4">{ce.description}</td>
                    <td className="py-2.5 px-4 font-mono">{ce.sourceNumber}</td>
                    <td
                      className={`py-2.5 px-4 text-right font-mono-tabular font-bold ${
                        ce.direction === 'IN' ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {ce.direction === 'IN' ? '+' : '-'}
                      {formatMad(ce.amountCents)}
                    </td>
                    <td className="py-2.5 px-4">
                      {ce.isLockedByAudit ? (
                        <button
                          type="button"
                          onClick={() => handleTestLockedCashEdit(ce)}
                          className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-600 hover:text-red-700"
                          title="Cliquer pour tester le blocage Règle 13"
                        >
                          <Lock className="w-3 h-3" /> Verrouillé (Tester Règle 13)
                        </button>
                      ) : (
                        <span className="text-emerald-700 text-[11px]">Période ouverte</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {subTab === 'BANK_DEPOSITS' && (
        <div className="space-y-5">
          {/* Cartes KPI Synthèse Versements */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500 font-medium">Solde Actuel en Caisse Physique</div>
              <div className="text-xl font-bold font-mono-tabular text-slate-900 mt-1">
                {formatMad(currentCashAvailable)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                Disponible pour versement ou roulement
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500 font-medium">En Attente Retour Banque</div>
              <div className={`text-xl font-bold font-mono-tabular mt-1 ${pendingDepositsCount > 0 ? 'text-amber-600' : 'text-slate-700'}`}>
                {pendingDepositsCount} bordereau(x)
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                {pendingDepositsCount > 0
                  ? `Total : ${formatMad(pendingCashToDepositCents)} espèces`
                  : 'Aucun versement en cours de remise'}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500 font-medium">Chèques en Portefeuille</div>
              <div className="text-xl font-bold font-mono-tabular text-[#1D4ED8] mt-1">
                {availableChecks.length} chèque(s)
              </div>
              <div className="text-[11px] text-slate-500 mt-1 font-mono-tabular">
                Total : {formatMad(totalAvailableChecksCents)}
              </div>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg p-4">
              <div className="text-xs text-slate-500 font-medium">Versements Confirmés (Période)</div>
              <div className="text-xl font-bold font-mono-tabular text-emerald-700 mt-1">
                {formatMad(totalConfirmedDepositsCents)}
              </div>
              <div className="text-[11px] text-slate-500 mt-1">
                {confirmedDeposits.length} remise(s) bancaire(s) validée(s)
              </div>
            </div>
          </div>

          {/* Bandeau d'action et explication */}
          <div className="bg-blue-50/70 border border-blue-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
            <div className="max-w-2xl">
              <div className="font-bold text-blue-900 text-sm flex items-center gap-1.5">
                <Landmark className="w-4 h-4 text-[#1D4ED8]" />
                <span>Gestion des Versements Espèces & Chèques en Banque</span>
              </div>
              <p className="text-blue-800 mt-1 leading-relaxed">
                Arrêtez la caisse à tout moment pour préparer un versement vers votre agence bancaire. Choisissez le montant en espèces à déposer (en conservant si souhaité une partie en caisse comme fond de roulement) et sélectionnez les chèques en portefeuille. Éditez le bordereau officiel A4, puis à votre retour de banque, confirmez le versement avec le récépissé pour actualiser le solde officiel servant d&apos;audit au billetage.
              </p>
            </div>
            <button
              type="button"
              onClick={handleOpenPrepareDepositModal}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-[#1D4ED8] hover:bg-blue-700 text-white font-semibold rounded-md shadow-xs transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Arrêter la caisse & Préparer un Versement</span>
            </button>
          </div>

          {/* Tableau des bordereaux de versements */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden text-xs">
            <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center justify-between gap-2 font-semibold text-slate-800">
              <div className="flex items-center gap-2">
                <span>Historique des Versements Bancaires ({filteredDeposits.length})</span>
                {pendingDepositsCount > 0 && (
                  <span className="px-2 py-0.5 rounded-full text-[11px] bg-amber-100 text-amber-800 font-bold">
                    {pendingDepositsCount} en attente de retour agence
                  </span>
                )}
              </div>
            </div>

            {filteredDeposits.length === 0 ? (
              <div className="p-8 text-center space-y-3">
                <Landmark className="w-10 h-10 text-slate-300 mx-auto" />
                <p className="text-slate-500 font-medium">Aucun bordereau de versement bancaire enregistré sur cette période.</p>
                <button
                  type="button"
                  onClick={handleOpenPrepareDepositModal}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#1D4ED8] text-white rounded font-medium hover:bg-blue-700"
                >
                  <Plus className="w-4 h-4" /> Préparer le premier versement
                </button>
              </div>
            ) : (
              <table className="w-full text-left">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600">
                    <th className="py-2.5 px-4">N° Bordereau</th>
                    <th className="py-2.5 px-4">Date</th>
                    <th className="py-2.5 px-4">Banque / Compte</th>
                    <th className="py-2.5 px-4 text-right">Espèces Versées</th>
                    <th className="py-2.5 px-4 text-right">Chèques Versés</th>
                    <th className="py-2.5 px-4 text-right font-bold text-slate-900">Total Remise</th>
                    <th className="py-2.5 px-4 text-right">Reste Laissé en Caisse</th>
                    <th className="py-2.5 px-4 text-center">Statut</th>
                    <th className="py-2.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filteredDeposits.map((dep) => {
                    const isPrep = dep.status === 'PREPARED';
                    const isConf = dep.status === 'CONFIRMED';
                    const isCanc = dep.status === 'CANCELLED';
                    return (
                      <tr key={dep.id} className={isPrep ? 'bg-amber-50/30' : isCanc ? 'opacity-60 bg-rose-50/20' : ''}>
                        <td className="py-3 px-4 font-mono font-bold text-slate-900">
                          {dep.number}
                        </td>
                        <td className="py-3 px-4 font-mono-tabular">
                          {formatBusinessDateFr(dep.businessDate)}
                        </td>
                        <td className="py-3 px-4">
                          <div className="font-semibold text-slate-800">{dep.bankName}</div>
                          {dep.bankAccountNumber && (
                            <div className="text-[11px] font-mono text-slate-500">
                              RIB: {dep.bankAccountNumber}
                            </div>
                          )}
                          {dep.reference && (
                            <div className="text-[11px] text-blue-700 font-mono">
                              Réf: {dep.reference}
                            </div>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-tabular font-medium text-slate-800">
                          {formatMad(dep.cashToDepositCents)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-tabular text-slate-800">
                          <div>{formatMad(dep.totalChecksCents)}</div>
                          <div className="text-[10px] text-slate-500 font-normal">
                            ({dep.checksSelected.length} chèque(s))
                          </div>
                        </td>
                        <td className="py-3 px-4 text-right font-mono-tabular font-bold text-[#1D4ED8]">
                          {formatMad(dep.totalDepositCents)}
                        </td>
                        <td className="py-3 px-4 text-right font-mono-tabular font-medium text-emerald-700">
                          {formatMad(dep.cashRemainingInRegisterCents)}
                        </td>
                        <td className="py-3 px-4 text-center">
                          {isPrep && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold bg-amber-100 text-amber-900 border border-amber-300">
                              <Clock className="w-3 h-3 text-amber-700" />
                              <span>En attente retour banque</span>
                            </span>
                          )}
                          {isConf && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-900 border border-emerald-300">
                              <CheckCircle2 className="w-3 h-3 text-emerald-700" />
                              <span>Confirmé · Caisse débitée</span>
                            </span>
                          )}
                          {isCanc && (
                            <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold bg-rose-100 text-rose-900 border border-rose-300">
                              <span>Annulé</span>
                            </span>
                          )}
                        </td>
                        <td className="py-3 px-4 text-right">
                          <div className="inline-flex items-center justify-end gap-1.5">
                            <button
                              type="button"
                              onClick={() => onOpenPrintPreview(buildBankDepositReceiptPrint(company, dep))}
                              className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded border border-slate-300 font-medium inline-flex items-center gap-1"
                              title="Imprimer / Télécharger le bordereau PDF"
                            >
                              <Printer className="w-3 h-3" />
                              <span>Bordereau PDF</span>
                            </button>

                            {isPrep && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setConfirmingDeposit(dep);
                                    setConfirmReference(dep.reference || '');
                                    setConfirmDate(today);
                                    setConfirmNotes('');
                                  }}
                                  className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded font-medium inline-flex items-center gap-1 shadow-xs"
                                  title="Confirmer la remise effectuée à la banque pour actualiser la caisse"
                                >
                                  <CheckCircle2 className="w-3 h-3" />
                                  <span>Confirmer versement</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setCancelingDeposit(dep);
                                    setCancelDepositReason('');
                                  }}
                                  className="px-2 py-1 text-rose-700 hover:bg-rose-50 rounded border border-rose-200"
                                  title="Annuler ce bordereau"
                                >
                                  Annuler
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {subTab === 'CASH_AUDIT' && (
        <div className="space-y-4">
          {/* Bandeau de liaison Arrêt de caisse & Versements bancaires */}
          <div className="bg-white border border-slate-200 rounded-lg p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Landmark className="w-4 h-4 text-[#1D4ED8]" />
                  <span>Arrêt de Caisse & Préparation aux Versements Bancaires</span>
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Solde théorique actuel de caisse : <strong className="text-slate-900 font-mono">{formatMad(theoreticalCashCents)}</strong>.
                  Vous pouvez arrêter la caisse pour effectuer un versement (espèces et chèques) tout en laissant une partie en caisse. Dès confirmation du versement, le solde s&apos;actualise et servira d&apos;audit au billetage ci-dessous.
                </p>
              </div>
              <button
                type="button"
                onClick={handleOpenPrepareDepositModal}
                className="inline-flex items-center gap-1.5 px-3 py-2 bg-[#1D4ED8] hover:bg-blue-700 text-white font-semibold rounded-md shadow-xs text-xs"
              >
                <Landmark className="w-3.5 h-3.5" />
                <span>Arrêter la caisse pour versement (Espèces / Chèques)</span>
              </button>
            </div>

            {pendingDeposits.length > 0 && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-xs text-amber-900 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-amber-600 flex-shrink-0" />
                  <span>
                    <strong>{pendingDeposits.length} versement(s) préparé(s) en attente de retour banque</strong> ({formatMad(pendingCashToDepositCents)} espèces).
                    À votre retour de la banque, confirmez le versement pour actualiser officiellement la caisse avant de finaliser le billetage.
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmingDeposit(pendingDeposits[0]);
                    setConfirmReference(pendingDeposits[0].reference || '');
                    setConfirmDate(today);
                    setConfirmNotes('');
                  }}
                  className="px-3 py-1 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded shadow-xs inline-flex items-center gap-1"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Confirmer le versement {pendingDeposits[0].number}</span>
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
          <form
            onSubmit={handleCloseCash}
            className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-5 space-y-4 text-xs"
          >
            <h2 className="text-base font-bold text-slate-900">
              Arrêt de Caisse & Billetage Marocain (MAD)
            </h2>
            <div className="grid grid-cols-3 gap-2">
              {DENOMINATIONS.map((denom) => (
                <div key={denom} className="p-2.5 border border-slate-200 rounded bg-slate-50">
                  <label className="block font-mono font-bold text-slate-800 mb-1">
                    {denom === '0.5' ? '0,50 DH (Pièce)' : `${denom} DH`}
                  </label>
                  <input
                    type="number"
                    min={0}
                    value={counts[denom] ?? 0}
                    onChange={(e) =>
                      setCounts({
                        ...counts,
                        [denom]: Math.max(0, parseInt(e.target.value, 10) || 0),
                      })
                    }
                    className="w-full px-2 py-1 text-right font-mono bg-white border border-slate-300 rounded"
                  />
                </div>
              ))}
            </div>

            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded space-y-1.5 font-mono-tabular">
              <div className="flex justify-between">
                <span>Solde Théorique Caisse :</span>
                <strong>{formatMad(theoreticalCashCents)}</strong>
              </div>
              <div className="flex justify-between">
                <span>Total Physique Compté (Billetage) :</span>
                <strong className="text-[#1D4ED8]">{formatMad(countedBalanceCents)}</strong>
              </div>
              <div className="flex justify-between pt-1 border-t border-slate-300">
                <span>Écart de Caisse :</span>
                <strong
                  className={
                    varianceCents === 0
                      ? 'text-emerald-700'
                      : varianceCents > 0
                      ? 'text-amber-700'
                      : 'text-red-700'
                  }
                >
                  {formatMad(varianceCents)} (
                  {varianceCents === 0
                    ? 'CONFORME'
                    : varianceCents > 0
                    ? 'EXCÉDENT'
                    : 'MANQUANT'}
                  )
                </strong>
              </div>
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Observations du PV de clôture
              </label>
              <input
                type="text"
                value={auditNotes}
                onChange={(e) => setAuditNotes(e.target.value)}
                placeholder="Observations éventuelles..."
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>

            <button
              type="submit"
              className="w-full py-2.5 bg-[#0F172A] text-white font-semibold rounded hover:bg-slate-800"
            >
              Valider l&apos;Arrêt de Caisse, Verrouiller la Période & Imprimer le PV
            </button>
          </form>

          <div className="lg:col-span-6 bg-white border border-slate-200 rounded-lg p-5 space-y-3 text-xs">
            <h2 className="text-base font-bold text-slate-900">
              Historique des PV d&apos;Arrêt de Caisse
            </h2>
            {cashAudits.length === 0 ? (
              <p className="text-slate-400 py-8 text-center">Aucun arrêt de caisse enregistré.</p>
            ) : (
              <div className="divide-y divide-slate-100">
                {cashAudits.map((a) => (
                  <div key={a.id} className="py-3 flex items-center justify-between">
                    <div>
                      <div className="font-mono font-bold text-slate-900">
                        {a.number} — {formatBusinessDateFr(a.businessDate)}
                      </div>
                      <div className="font-mono-tabular text-[11px] text-slate-500">
                        Théo: {formatMad(a.theoreticalBalanceCents)} · Compté:{' '}
                        {formatMad(a.countedBalanceCents)} · Écart: {formatMad(a.varianceCents)} (
                        {a.status})
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onOpenPrintPreview(buildCashAuditPvPrint(company, a))}
                      className="px-2.5 py-1 border border-slate-300 rounded hover:bg-slate-50 inline-flex items-center gap-1"
                    >
                      <Printer className="w-3.5 h-3.5" /> PV A4
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {subTab === 'EXPENSES' && (
        <div className="space-y-5">
          {/* Bandeau d'information Fond de Caisse & Dépenses */}
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 flex flex-wrap items-center justify-between gap-4 text-xs">
            <div>
              <div className="font-bold text-slate-800 flex items-center gap-2">
                <Coins className="w-4 h-4 text-amber-600" />
                <span>Approvisionnement Fond de Caisse & Dépenses d&apos;Exploitation</span>
              </div>
              <p className="text-slate-600 mt-1 max-w-xl">
                Par défaut, le solde de départ en caisse est strictement égal à 0 DH. L&apos;alimentation de caisse en fond initial (ex: 2 000 DH) ou complémentaire se fait via la catégorie <strong>« Alimentation Fond de Caisse »</strong>. Cette opération crédite immédiatement les espèces en caisse physique sans impact de TVA.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setExpForm({
                  category: 'ALIMENTATION_CAISSE',
                  label: 'Approvisionnement Fond de Caisse initial',
                  beneficiary: 'Direction / Caisse Centrale',
                  amountHtDh: '2000',
                  vatRate: 0,
                  paymentMethod: 'CASH',
                  receiptRef: 'OUV-CAISSE-2000',
                });
              }}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-amber-700 hover:bg-amber-800 text-white font-semibold rounded-md shadow-xs"
            >
              <Plus className="w-4 h-4" /> Approvisionner Fond de Caisse (2 000 DH)
            </button>
          </div>

          <form
            onSubmit={handleCreateExpense}
            className="bg-white border border-slate-200 rounded-lg p-5 grid grid-cols-1 md:grid-cols-4 gap-3 text-xs"
          >
            <div>
              <label className="block font-medium mb-1">Catégorie de charge</label>
              <select
                value={expForm.category}
                onChange={(e) => {
                  const cat = e.target.value as ExpenseCategory;
                  if (cat === 'ALIMENTATION_CAISSE') {
                    setExpForm({
                      ...expForm,
                      category: cat,
                      vatRate: 0,
                      label: expForm.label || 'Alimentation fond de caisse',
                      beneficiary: expForm.beneficiary || 'Caisse Centrale',
                    });
                  } else {
                    setExpForm({ ...expForm, category: cat });
                  }
                }}
                className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
              >
                <option value="ALIMENTATION_CAISSE">
                  ★ Alimentation Fond de Caisse (Entrée Espèces en Caisse)
                </option>
                <option value="CARBURANT">Carburant / Tournées SAV</option>
                <option value="TRANSPORT">Transport & Logistique</option>
                <option value="LOYER">Loyer Dépôt / Magasin</option>
                <option value="ELECTRICITE_EAU">Électricité & Eau</option>
                <option value="TELEPHONE_INTERNET">Téléphone & Fibre</option>
                <option value="SALAIRES_PRIMES">Salaires & Primes</option>
                <option value="ENTRETIEN">Entretien & Outillage</option>
                <option value="COMPTABLE">Honoraires Comptable</option>
                <option value="IMPOTS_TAXES">Impôts & Taxes</option>
                <option value="MARKETING">Marketing & Publicité</option>
                <option value="DIVERS">Divers</option>
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">Libellé *</label>
              <input
                type="text"
                required
                value={expForm.label}
                onChange={(e) => setExpForm({ ...expForm, label: e.target.value })}
                className="w-full px-3 py-1.5 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Bénéficiaire</label>
              <input
                type="text"
                value={expForm.beneficiary}
                onChange={(e) => setExpForm({ ...expForm, beneficiary: e.target.value })}
                className="w-full px-3 py-1.5 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">Montant HT (MAD) *</label>
              <input
                type="number"
                step="0.01"
                required
                value={expForm.amountHtDh}
                onChange={(e) => setExpForm({ ...expForm, amountHtDh: e.target.value })}
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium mb-1">TVA (%)</label>
              <select
                value={expForm.vatRate}
                onChange={(e) => setExpForm({ ...expForm, vatRate: Number(e.target.value) })}
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded bg-white"
              >
                <option value={20}>20 %</option>
                <option value={14}>14 %</option>
                <option value={10}>10 %</option>
                <option value={0}>0 %</option>
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">Mode de paiement</label>
              <select
                value={expForm.paymentMethod}
                onChange={(e) =>
                  setExpForm({
                    ...expForm,
                    paymentMethod: e.target.value as 'CASH' | 'CARD' | 'TRANSFER' | 'CHECK',
                  })
                }
                className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
              >
                <option value="CASH">Espèces (Sortie Caisse)</option>
                <option value="TRANSFER">Virement Bancaire</option>
                <option value="CARD">Carte Bancaire</option>
                <option value="CHECK">Chèque</option>
              </select>
            </div>
            <div>
              <label className="block font-medium mb-1">N° Pièce / Justificatif</label>
              <input
                type="text"
                value={expForm.receiptRef}
                onChange={(e) => setExpForm({ ...expForm, receiptRef: e.target.value })}
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
              />
            </div>
            <div className="flex items-end">
              <button
                type="submit"
                className="w-full py-1.5 bg-[#0F172A] text-white font-medium rounded"
              >
                + Enregistrer la Dépense
              </button>
            </div>
          </form>

          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between font-semibold text-xs text-slate-800">
              <span>
                Journal des Dépenses & Charges sur la période ({filteredExpenses.length} pièce(s) du{' '}
                {formatBusinessDateFr(startDate)} au {formatBusinessDateFr(endDate)})
              </span>
              <button
                type="button"
                onClick={() =>
                  onOpenPrintPreview(
                    buildExpensesPeriodPrint(
                      company,
                      filteredExpenses,
                      startDate || '2020-01-01',
                      endDate || today
                    )
                  )
                }
                className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-50 hover:bg-amber-100 text-amber-900 rounded border border-amber-300"
              >
                <Printer className="w-3.5 h-3.5" /> Imprimer / PDF Journal des Dépenses
              </button>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                  <th className="py-2.5 px-4">N°</th>
                  <th className="py-2.5 px-4">Date</th>
                  <th className="py-2.5 px-4">Catégorie</th>
                  <th className="py-2.5 px-4">Libellé & Bénéficiaire</th>
                  <th className="py-2.5 px-4">Moyen</th>
                  <th className="py-2.5 px-4">Statut</th>
                  <th className="py-2.5 px-4 text-right">HT</th>
                  <th className="py-2.5 px-4 text-right">TVA</th>
                  <th className="py-2.5 px-4 text-right">TTC</th>
                  <th className="py-2.5 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredExpenses.map((ex) => {
                  const isCancelled = ex.status === 'CANCELLED';
                  return (
                    <tr key={ex.id} className={isCancelled ? 'opacity-60 bg-rose-50/30' : ''}>
                      <td className="py-2.5 px-4 font-mono font-semibold">{ex.number}</td>
                      <td className="py-2.5 px-4 font-mono-tabular">
                        {formatBusinessDateFr(ex.businessDate)}
                      </td>
                      <td className="py-2.5 px-4 font-mono text-[11px]">{ex.category}</td>
                      <td className="py-2.5 px-4">
                        <div className="font-medium">{ex.label}</div>
                        <div className="text-[11px] text-slate-500">
                          {ex.beneficiary}
                          {ex.receiptRef ? ` · Réf/PV: ${ex.receiptRef}` : ''}
                        </div>
                      </td>
                      <td className="py-2.5 px-4 font-mono">{ex.paymentMethod}</td>
                      <td className="py-2.5 px-4 font-mono text-[11px]">
                        {isCancelled ? (
                          <span className="px-2 py-0.5 rounded bg-red-100 text-red-800 font-bold">
                            ANNULÉE (PV)
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold">
                            VALIDÉE
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono-tabular">
                        {formatMad(ex.amountHtCents)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono-tabular">
                        {formatMad(ex.amountVatCents)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono-tabular font-bold">
                        {formatMad(ex.amountTtcCents)}
                      </td>
                      <td className="py-2.5 px-4 text-right">
                        {!isCancelled ? (
                          <button
                            type="button"
                            onClick={() => {
                              setCancelingExpense(ex);
                              setCancelExpenseReason('');
                            }}
                            className="px-2.5 py-1 bg-rose-50 border border-rose-300 text-rose-900 rounded hover:bg-rose-100 font-medium"
                          >
                            Annuler via PV
                          </button>
                        ) : (
                          <span className="text-[11px] font-mono text-slate-400">
                            {ex.receiptRef || 'PV'}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {cancelingExpense && (
            <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
              <form
                onSubmit={handleConfirmCancelExpenseViaPv}
                className="bg-white border border-slate-300 rounded-lg max-w-md w-full p-6 space-y-4 text-xs"
              >
                <h3 className="text-base font-bold text-rose-800">
                  Annuler la Dépense {cancelingExpense.number} via PV
                </h3>
                <p className="text-slate-600 leading-relaxed">
                  Cette opération annule la dépense <strong>{cancelingExpense.label}</strong> (
                  <strong>{formatMad(cancelingExpense.amountTtcCents)}</strong>) en générant un{' '}
                  <strong>Procès-Verbal (PV)</strong> de régularisation (et réintègre le montant en
                  caisse si le règlement initial était en espèces).
                </p>
                <div>
                  <label className="block font-medium text-slate-700 mb-1">
                    Motif d&apos;annulation (figurera sur le PV) *
                  </label>
                  <input
                    type="text"
                    required
                    value={cancelExpenseReason}
                    onChange={(e) => setCancelExpenseReason(e.target.value)}
                    placeholder="Ex: Erreur d'imputation, annulation décaissement..."
                    className="w-full px-3 py-2 border border-slate-300 rounded"
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setCancelingExpense(null)}
                    className="px-3 py-1.5 border border-slate-300 rounded"
                  >
                    Retour
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-1.5 bg-rose-700 text-white font-medium rounded hover:bg-rose-800"
                  >
                    Valider l&apos;annulation & Imprimer PV
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      {/* MODALE DE PRÉPARATION D'UN VERSEMENT BANCAIRE (ARRÊT DE CAISSE POUR REMISE) */}
      {showDepositModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handlePrepareDepositSubmit}
            className="bg-white border border-slate-300 rounded-xl max-w-2xl w-full p-6 space-y-4 text-xs my-8 shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Landmark className="w-5 h-5 text-[#1D4ED8]" />
                  <span>Arrêter la Caisse pour Versement Bancaire (Espèces & Chèques)</span>
                </h3>
                <p className="text-slate-500 text-[11px] mt-0.5">
                  Choisissez le montant à verser, laissez le fond de roulement souhaité et sélectionnez les chèques. Un bordereau de remise officiel A4 sera généré.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowDepositModal(false)}
                className="text-slate-400 hover:text-slate-700 text-lg font-bold px-2"
              >
                ✕
              </button>
            </div>

            {/* Cadre Espèces & Fond de caisse restant */}
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
              <div className="font-bold text-slate-900 uppercase text-[11px] tracking-wide flex items-center justify-between">
                <span>1. Versement en Espèces (Caisse Physique)</span>
                <span className="font-mono text-slate-600">
                  Solde disponible : <strong className="text-slate-900">{formatMad(currentCashAvailable)}</strong>
                </span>
              </div>

              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Montant en Espèces à Verser (MAD) *
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  max={(currentCashAvailable / 100).toString()}
                  value={cashToDepositDh}
                  onChange={(e) => setCashToDepositDh(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded bg-white font-bold text-slate-900 focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Raccourcis pour laisser une partie de l'argent en caisse */}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-[11px] text-slate-500">Raccourcis fond conservé :</span>
                <button
                  type="button"
                  onClick={() => setCashToDepositDh(Math.max(0, currentCashAvailable / 100).toFixed(2))}
                  className="px-2 py-1 bg-white hover:bg-slate-100 border border-slate-300 rounded text-[10px] font-medium"
                >
                  Verser tout (Laisser 0 DH)
                </button>
                <button
                  type="button"
                  onClick={() => setCashToDepositDh(Math.max(0, (currentCashAvailable - 50000) / 100).toFixed(2))}
                  className="px-2 py-1 bg-white hover:bg-slate-100 border border-slate-300 rounded text-[10px] font-medium"
                >
                  Laisser 500 DH
                </button>
                <button
                  type="button"
                  onClick={() => setCashToDepositDh(Math.max(0, (currentCashAvailable - 100000) / 100).toFixed(2))}
                  className="px-2 py-1 bg-white hover:bg-slate-100 border border-slate-300 rounded text-[10px] font-medium"
                >
                  Laisser 1 000 DH
                </button>
                <button
                  type="button"
                  onClick={() => setCashToDepositDh(Math.max(0, (currentCashAvailable - 200000) / 100).toFixed(2))}
                  className="px-2 py-1 bg-blue-50 hover:bg-blue-100 border border-blue-300 text-blue-900 rounded text-[10px] font-bold"
                >
                  Laisser 2 000 DH (Fond initial)
                </button>
                <button
                  type="button"
                  onClick={() => setCashToDepositDh('0')}
                  className="px-2 py-1 bg-white hover:bg-slate-100 border border-slate-300 rounded text-[10px] font-medium"
                >
                  Garder tout en caisse (0 DH espèces)
                </button>
              </div>

              {/* Indicateur visuel du reste en caisse */}
              <div className="p-2.5 rounded bg-white border border-slate-200 flex items-center justify-between font-mono-tabular">
                <span className="text-slate-600 font-medium">Solde prévu restant en caisse :</span>
                <span
                  className={`font-bold text-sm ${
                    estimatedRemainingCashCents < 0
                      ? 'text-red-600'
                      : estimatedRemainingCashCents === 0
                      ? 'text-slate-700'
                      : 'text-emerald-700'
                  }`}
                >
                  {formatMad(estimatedRemainingCashCents)}
                </span>
              </div>
            </div>

            {/* Cadre Chèques en Portefeuille */}
            <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg space-y-3">
              <div className="font-bold text-slate-900 uppercase text-[11px] tracking-wide flex items-center justify-between">
                <span>2. Remise de Chèques ({availableChecks.length} en portefeuille)</span>
                <span className="font-mono text-[#1D4ED8]">
                  Sélection : <strong>{formatMad(totalSelectedChecksCents)}</strong> ({selectedCheckIds.size} chèque(s))
                </span>
              </div>

              {availableChecks.length === 0 ? (
                <p className="text-slate-400 italic py-2">
                  Aucun chèque client actuellement en attente d&apos;encaissement en portefeuille.
                </p>
              ) : (
                <div className="space-y-2">
                  <div className="flex justify-end gap-2 text-[11px]">
                    <button
                      type="button"
                      onClick={() => setSelectedCheckIds(new Set(availableChecks.map((c) => c.id)))}
                      className="text-blue-700 underline font-medium"
                    >
                      Tout sélectionner
                    </button>
                    <span>·</span>
                    <button
                      type="button"
                      onClick={() => setSelectedCheckIds(new Set())}
                      className="text-slate-600 underline font-medium"
                    >
                      Tout désélectionner
                    </button>
                  </div>
                  <div className="max-h-40 overflow-y-auto border border-slate-200 rounded bg-white divide-y divide-slate-100">
                    {availableChecks.map((check) => {
                      const isChecked = selectedCheckIds.has(check.id);
                      return (
                        <label
                          key={check.id}
                          className="flex items-center justify-between p-2.5 hover:bg-slate-50 cursor-pointer"
                        >
                          <div className="flex items-center gap-2.5">
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={(e) => {
                                const next = new Set(selectedCheckIds);
                                if (e.target.checked) next.add(check.id);
                                else next.delete(check.id);
                                setSelectedCheckIds(next);
                              }}
                              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500 w-4 h-4"
                            />
                            <div>
                              <div className="font-semibold text-slate-900 font-mono">
                                N° {check.reference || check.number}
                              </div>
                              <div className="text-[11px] text-slate-500">
                                {check.partyName} · {formatBusinessDateFr(check.businessDate)}
                              </div>
                            </div>
                          </div>
                          <div className="font-mono font-bold text-slate-900">
                            {formatMad(check.amountCents)}
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Cadre Coordonnées Bancaires de Dépôt */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 p-4 bg-slate-50 border border-slate-200 rounded-lg">
              <div>
                <label className="block font-medium text-slate-700 mb-1">Banque Réceptrice *</label>
                <input
                  type="text"
                  required
                  value={depositBankName}
                  onChange={(e) => setDepositBankName(e.target.value)}
                  placeholder="Ex: Attijariwafa bank, Banque Populaire..."
                  className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Compte Bancaire / RIB</label>
                <input
                  type="text"
                  value={depositBankAccount}
                  onChange={(e) => setDepositBankAccount(e.target.value)}
                  placeholder="RIB à 24 chiffres"
                  className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded bg-white"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Réf. Bordereau Provisoire</label>
                <input
                  type="text"
                  value={depositReference}
                  onChange={(e) => setDepositReference(e.target.value)}
                  placeholder="Optionnel à cette étape"
                  className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded bg-white"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">Observations</label>
                <input
                  type="text"
                  value={depositNotes}
                  onChange={(e) => setDepositNotes(e.target.value)}
                  placeholder="Notes internes..."
                  className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
                />
              </div>
            </div>

            {/* Total Versement Récapitulatif */}
            <div className="p-3.5 bg-[#0F172A] text-white rounded-lg flex items-center justify-between font-mono-tabular">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-400">
                  Total Général à Verser (Espèces + Chèques)
                </div>
                <div className="text-[11px] text-slate-300 mt-0.5">
                  Dont {formatMad(parsedCashToDepositCents)} espèces et {formatMad(totalSelectedChecksCents)} chèques
                </div>
              </div>
              <div className="text-xl font-bold text-[#D9A95B]">
                {formatMad(totalEstimatedDepositCents)}
              </div>
            </div>

            {/* Boutons d'action */}
            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setShowDepositModal(false)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-md hover:bg-slate-100 font-medium"
              >
                Annuler
              </button>
              <button
                type="submit"
                disabled={totalEstimatedDepositCents <= 0 || estimatedRemainingCashCents < 0}
                className="inline-flex items-center gap-2 px-5 py-2 bg-[#1D4ED8] hover:bg-blue-700 text-white font-semibold rounded-md shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Printer className="w-4 h-4" />
                <span>Éditer le Bordereau A4 & Enregistrer</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODALE DE CONFIRMATION DU RETOUR DE LA BANQUE */}
      {confirmingDeposit && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleConfirmDepositSubmit}
            className="bg-white border border-slate-300 rounded-xl max-w-lg w-full p-6 space-y-4 text-xs shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-slate-200 pb-3">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                <span>Confirmer le Versement {confirmingDeposit.number}</span>
              </h3>
              <button
                type="button"
                onClick={() => setConfirmingDeposit(null)}
                className="text-slate-400 hover:text-slate-700 text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <div className="p-3.5 bg-emerald-50 border border-emerald-200 rounded-lg text-emerald-900 space-y-1.5 leading-relaxed">
              <div className="font-semibold">Confirmation de Remise en Banque :</div>
              <p>
                Vous confirmez avoir déposé <strong>{formatMad(confirmingDeposit.totalDepositCents)}</strong> (dont <strong>{formatMad(confirmingDeposit.cashToDepositCents)}</strong> en espèces) auprès de <strong>{confirmingDeposit.bankName}</strong>.
              </p>
              <p className="font-bold pt-1 text-emerald-800">
                La caisse physique sera officiellement débitée de {formatMad(confirmingDeposit.cashToDepositCents)}. Le nouveau solde disponible pour l&apos;Arrêt de Caisse & Billetage sera de {formatMad(confirmingDeposit.cashRemainingInRegisterCents)}.
              </p>
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">
                N° Récépissé / Bordereau tamponné par la banque *
              </label>
              <input
                type="text"
                required
                value={confirmReference}
                onChange={(e) => setConfirmReference(e.target.value)}
                placeholder="Ex: RECU-ATTIJARI-84920"
                className="w-full px-3 py-2 font-mono text-sm border border-slate-300 rounded bg-white font-bold"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">Date effective du versement *</label>
              <input
                type="date"
                required
                value={confirmDate}
                onChange={(e) => setConfirmDate(e.target.value)}
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded bg-white"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">Remarques / Observations</label>
              <input
                type="text"
                value={confirmNotes}
                onChange={(e) => setConfirmNotes(e.target.value)}
                placeholder="Observations éventuelles..."
                className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setConfirmingDeposit(null)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-md hover:bg-slate-100 font-medium"
              >
                Retour
              </button>
              <button
                type="submit"
                className="inline-flex items-center gap-2 px-5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-md shadow-xs"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>Valider le versement & Actualiser la caisse</span>
              </button>
            </div>
          </form>
        </div>
      )}

      {/* MODALE D'ANNULATION D'UN VERSEMENT */}
      {cancelingDeposit && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 flex items-center justify-center p-4">
          <form
            onSubmit={handleCancelDepositSubmit}
            className="bg-white border border-slate-300 rounded-xl max-w-md w-full p-6 space-y-4 text-xs shadow-2xl"
          >
            <h3 className="text-base font-bold text-rose-800">
              Annuler le Versement {cancelingDeposit.number}
            </h3>
            <p className="text-slate-600 leading-relaxed">
              Êtes-vous sûr de vouloir annuler le versement de <strong>{formatMad(cancelingDeposit.totalDepositCents)}</strong> ?
              {cancelingDeposit.status === 'CONFIRMED' && (
                <span className="block mt-1 text-rose-700 font-semibold">
                  Ce versement ayant déjà été confirmé, l&apos;annulation réintégrera automatiquement les espèces en caisse physique et replacera les chèques en portefeuille.
                </span>
              )}
            </p>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Motif d&apos;annulation *
              </label>
              <input
                type="text"
                required
                value={cancelDepositReason}
                onChange={(e) => setCancelDepositReason(e.target.value)}
                placeholder="Ex: Erreur de saisie, agence fermée..."
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setCancelingDeposit(null)}
                className="px-3 py-1.5 border border-slate-300 rounded"
              >
                Retour
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 bg-rose-700 text-white font-medium rounded hover:bg-rose-800"
              >
                Confirmer l&apos;annulation
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};

/**
 * SECTIONS 32, 33 & 34 : ANALYSE COMMERCIALE, DIAGNOSTIC TECHNIQUE EAU & OLLAMA LOCAL
 */
export const IntelligenceAndWaterDiagView: React.FC<{
  settings: AppSettings;
  refreshTrigger: number;
}> = ({ settings, refreshTrigger }) => {
  const [snapshot, setSnapshot] = useState<CentralFinancialSnapshot | null>(null);
  const [rawTds, setRawTds] = useState(550);
  const [permTds, setPermTds] = useState(28);
  const [pressureBar, setPressureBar] = useState(3.4);
  const [hardnessTh, setHardnessTh] = useState(32);
  const [monthsFilter, setMonthsFilter] = useState(7);

  // Ollama local status
  const [ollamaStatus, setOllamaStatus] = useState<string>('Non testé (100% local par défaut)');
  const [ollamaModels, setOllamaModels] = useState<string[]>([]);

  useEffect(() => {
    computeCentralFinancialSnapshot('12_MONTHS').then(setSnapshot);
  }, [refreshTrigger]);

  const waterEval = evaluateWaterParameters({
    rawTdsPpm: rawTds,
    permeateTdsPpm: permTds,
    inletPressureBar: pressureBar,
    waterHardnessTh: hardnessTh,
    monthsSinceFilterChange: monthsFilter,
  });

  const checkLocalOllama = async () => {
    setOllamaStatus('Connexion à Ollama local en cours...');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(`${settings.ollamaUrl}/api/tags`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { models?: { name: string }[] };
      const names = (data.models ?? []).map((m) => m.name);
      setOllamaModels(names);
      setOllamaStatus(
        names.length > 0
          ? `Ollama détecté (${names.length} modèle(s) local/locaux disponible(s))`
          : 'Ollama actif mais aucun modèle installé'
      );
    } catch {
      clearTimeout(timer);
      setOllamaStatus(
        `Serveur Ollama local non détecté sur ${settings.ollamaUrl}. Le moteur analytique déterministe local assure 100% des analyses sans dépendance externe.`
      );
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-4">
        <h1 className="font-display text-2xl font-bold text-slate-900">
          Intelligence Commerciale & Diagnostic Technique Traitement de l&apos;Eau
        </h1>
        <p className="text-xs text-slate-500">
          Sections 32, 33 & 34 : Calculateur technique Osmose Inverse / TDS / Adoucisseur · Analyse
          déterministe locale des stocks dormants et marges
        </p>
      </div>

      {/* Simulateur et Calculateur Technique Traitement de l'Eau (Section 34) */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
        <div className="flex items-center gap-2">
          <FlaskConical className="w-5 h-5 text-[#1D4ED8]" />
          <h2 className="text-base font-bold text-slate-900">
            Calculateur de Performance Membrane Osmose Inverse, Pression & Dureté (TH)
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3 text-xs">
          <div>
            <label className="block font-medium text-slate-700 mb-1">TDS Eau Brute (ppm)</label>
            <input
              type="number"
              value={rawTds}
              onChange={(e) => setRawTds(Number(e.target.value) || 1)}
              className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">
              TDS Sortie Membrane (ppm)
            </label>
            <input
              type="number"
              value={permTds}
              onChange={(e) => setPermTds(Number(e.target.value) || 0)}
              className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">Pression Entrée (bar)</label>
            <input
              type="number"
              step="0.1"
              value={pressureBar}
              onChange={(e) => setPressureBar(Number(e.target.value) || 0)}
              className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">Dureté TH (°f)</label>
            <input
              type="number"
              value={hardnessTh}
              onChange={(e) => setHardnessTh(Number(e.target.value) || 0)}
              className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-700 mb-1">
              Âge des préfiltres (mois)
            </label>
            <input
              type="number"
              value={monthsFilter}
              onChange={(e) => setMonthsFilter(Number(e.target.value) || 0)}
              className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 bg-slate-50 border border-slate-200 rounded-md text-xs">
          <div>
            <div className="text-slate-500">Taux de réjection saline Membrane RO</div>
            <div className="text-xl font-bold font-mono-tabular mt-1">
              {waterEval.rejectionRatePercent}% —{' '}
              <span
                className={
                  waterEval.membraneHealth === 'EXCELLENT'
                    ? 'text-emerald-700'
                    : waterEval.membraneHealth === 'ACCEPTABLE'
                    ? 'text-amber-700'
                    : 'text-red-700'
                }
              >
                {waterEval.membraneHealth}
              </span>
            </div>
            <div className="text-[11px] text-slate-500 mt-1">
              Statut pression : {waterEval.pressureStatus}
            </div>
          </div>
          <div>
            <div className="text-slate-500 font-semibold">Diagnostic Calcaire / Adoucissement</div>
            <p className="text-slate-800 mt-1 leading-relaxed">
              {waterEval.hardnessRecommendation}
            </p>
          </div>
          <div>
            <div className="text-slate-500 font-semibold">Recommandation Maintenance SAV</div>
            <p className="text-slate-800 mt-1 leading-relaxed">{waterEval.maintenanceAlert}</p>
          </div>
        </div>

        {/* Base de connaissances de diagnostic technique */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
          {WATER_DIAGNOSTIC_RULES.map((rule) => (
            <div
              key={rule.id}
              className="border border-slate-200 rounded-md p-4 space-y-2 text-xs bg-white"
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] text-slate-500">{rule.systemCategory}</span>
                <span
                  className={`font-mono font-bold text-[11px] ${
                    rule.severity === 'CRITIQUE' ? 'text-red-700' : 'text-amber-700'
                  }`}
                >
                  {rule.severity}
                </span>
              </div>
              <h3 className="font-bold text-slate-900 text-sm">{rule.symptomTitle}</h3>
              <div>
                <strong className="text-slate-700">Causes possibles :</strong>
                <ul className="list-disc list-inside text-slate-600 mt-0.5 space-y-0.5">
                  {rule.possibleCauses.slice(0, 2).map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              </div>
              <div>
                <strong className="text-slate-700">Solutions :</strong>
                <ul className="list-disc list-inside text-emerald-800 mt-0.5 space-y-0.5">
                  {rule.recommendedSolutions.slice(0, 2).map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
              <div className="p-2 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-900">
                <strong>Sécurité :</strong> {rule.safetyWarnings[0]}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Analyse déterministe des produits dormants et connecteur Ollama local (Sections 32 & 33) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 text-xs">
          <h2 className="text-base font-bold text-slate-900">
            Produits Dormants (Stock immobilisé sans rotation sur la période)
          </h2>
          {snapshot?.dormantProducts.length === 0 ? (
            <p className="text-slate-500 py-4">Tous les produits en stock ont tourné récemment.</p>
          ) : (
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-200 text-left text-slate-500">
                  <th className="py-2">Réf.</th>
                  <th className="py-2">Article</th>
                  <th className="py-2 text-right">Stock</th>
                  <th className="py-2 text-right">Immobilisation HT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {snapshot?.dormantProducts.map((dp) => (
                  <tr key={dp.id}>
                    <td className="py-2 font-mono">{dp.reference}</td>
                    <td className="py-2">{dp.name}</td>
                    <td className="py-2 text-right font-mono-tabular">{dp.stock}</td>
                    <td className="py-2 text-right font-mono-tabular font-semibold">
                      {formatMad(dp.stockValueCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 text-xs">
          <h2 className="text-base font-bold text-slate-900">
            Connecteur IA Locale Ollama (Optionnel — Zéro Fuite de Données)
          </h2>
          <p className="text-slate-600 leading-relaxed">
            Conformément à la Section 33, aucune donnée de l&apos;entreprise n&apos;est envoyée
            automatiquement sur Internet. Vous pouvez vérifier la présence d&apos;une instance
            Ollama locale sur <code className="font-mono">{settings.ollamaUrl}</code>.
          </p>
          <div className="p-3 bg-slate-50 border border-slate-200 rounded font-mono text-[11px]">
            Statut : {ollamaStatus}
            {ollamaModels.length > 0 && <div>Modèles : {ollamaModels.join(', ')}</div>}
          </div>
          <button
            type="button"
            onClick={checkLocalOllama}
            className="px-4 py-2 bg-[#0F172A] text-white font-medium rounded hover:bg-slate-800"
          >
            Tester la détection Ollama locale
          </button>
        </div>
      </div>
    </div>
  );
};

const AI_MARKET_HISTORY_STORAGE_KEY = 'asw_ai_market_reports_v1';

function loadSavedAiMarketReports(): AiMarketResearchSummaryData[] {
  try {
    const raw = localStorage.getItem(AI_MARKET_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAiMarketReports(reports: AiMarketResearchSummaryData[]): void {
  try {
    localStorage.setItem(AI_MARKET_HISTORY_STORAGE_KEY, JSON.stringify(reports.slice(0, 15)));
  } catch {
    // ignore storage quota errors
  }
}

/**
 * SECTION 35 : VEILLE MARCHÉ (Sources explicites : VERIFIEE, MANUELLE, IMPORTEE, EXEMPLE + Recherche IA sur demande)
 */
export const MarketWatchView: React.FC<{
  company: CompanyInfo;
  refreshTrigger: number;
  onChanged: () => void;
  onOpenPrintPreview: (doc: PrintableDocument) => void;
}> = ({ company, refreshTrigger, onChanged, onOpenPrintPreview }) => {
  const [observations, setObservations] = useState<MarketObservation[]>([]);
  const [catalogProducts, setCatalogProducts] = useState<Product[]>([]);
  const [tableFilter, setTableFilter] = useState('');

  // On-demand AI Search & Evaluation state
  const [aiQueryForm, setAiQueryForm] = useState({
    productQuery: '',
    category: 'Membranes Osmose Inverse',
    country: 'Maroc',
    city: 'Casablanca',
    evaluationFocus: 'Prix constatés, distributeurs & évaluation technique et commerciale',
    extraNotes: '',
  });
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [activeAiReport, setActiveAiReport] = useState<AiMarketResearchSummaryData | null>(() => {
    const saved = loadSavedAiMarketReports();
    return saved[0] ?? null;
  });
  const [savedAiReports, setSavedAiReports] = useState<AiMarketResearchSummaryData[]>(() =>
    loadSavedAiMarketReports()
  );

  const [form, setForm] = useState({
    productName: '',
    category: 'Membranes Osmose Inverse',
    sellerName: '',
    sourceType: 'MANUELLE' as MarketObservation['sourceType'],
    sourceUrl: '',
    priceTtcDh: '',
    specs: '',
    notes: '',
  });

  useEffect(() => {
    db.marketResearch.orderBy('observedDate').reverse().toArray().then(setObservations);
    db.products
      .filter((p) => p.active !== false)
      .toArray()
      .then(setCatalogProducts);
  }, [refreshTrigger]);

  const handleRunAiMarketSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!aiQueryForm.productQuery.trim()) {
      setAiError('Veuillez saisir le nom, le modèle ou la référence du produit à rechercher.');
      return;
    }
    setAiLoading(true);
    setAiError(null);

    try {
      const response = await fetch('/api/market-research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(aiQueryForm),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data?.error || `Erreur serveur (${response.status}) lors de la recherche IA.`
        );
      }
      const report = data as AiMarketResearchSummaryData;
      setActiveAiReport(report);
      const nextHistory = [
        report,
        ...savedAiReports.filter(
          (r) =>
            !(
              r.productQuery.toLowerCase() === report.productQuery.toLowerCase() &&
              r.locationLabel.toLowerCase() === report.locationLabel.toLowerCase()
            )
        ),
      ].slice(0, 15);
      setSavedAiReports(nextHistory);
      saveAiMarketReports(nextHistory);
    } catch (err) {
      setAiError(
        err instanceof Error
          ? err.message
          : 'Impossible de contacter le service de recherche IA sur demande.'
      );
    } finally {
      setAiLoading(false);
    }
  };

  const handlePrefillObservationFromAi = (report: AiMarketResearchSummaryData) => {
    const firstSource = report.sources[0];
    setForm({
      productName: report.productQuery,
      category: aiQueryForm.category || 'Membranes Osmose Inverse',
      sellerName: firstSource
        ? `${firstSource.title.slice(0, 45)} (${report.locationLabel})`
        : `Relevé Web (${report.locationLabel})`,
      sourceType: report.status === 'FOUND' ? 'VERIFIEE' : 'MANUELLE',
      sourceUrl: firstSource?.uri || '',
      priceTtcDh: '',
      specs: `Recherche IA (${report.locationLabel}) — ${
        report.status === 'FOUND'
          ? 'Sources vérifiées'
          : report.status === 'PARTIAL'
          ? 'Données partielles'
          : 'Non trouvé en ligne'
      }`,
      notes: report.reportMarkdown.slice(0, 350),
    });
  };

  const handleDeleteSavedAiReport = (timestamp: string) => {
    const next = savedAiReports.filter((r) => r.timestamp !== timestamp);
    setSavedAiReports(next);
    saveAiMarketReports(next);
    if (activeAiReport?.timestamp === timestamp) {
      setActiveAiReport(next[0] ?? null);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.productName || !form.sellerName || !form.priceTtcDh) return;
    const ttcCents = dhToCents(form.priceTtcDh);
    const htCents = Math.round(ttcCents / 1.2);
    await db.marketResearch.add({
      id: generateId(),
      productName: form.productName,
      category: form.category,
      sellerName: form.sellerName,
      sourceType: form.sourceType,
      sourceUrl: form.sourceUrl,
      priceHtCents: htCents,
      priceTtcCents: ttcCents,
      observedDate: getMoroccoBusinessDate(),
      specs: form.specs,
      notes: form.notes,
      createdAt: new Date().toISOString(),
    });
    setForm({
      ...form,
      productName: '',
      sellerName: '',
      sourceUrl: '',
      priceTtcDh: '',
      specs: '',
      notes: '',
    });
    onChanged();
  };

  const handleDeleteObservation = async (id: string) => {
    await db.marketResearch.delete(id);
    onChanged();
  };

  const filteredObservations = observations.filter((o) => {
    if (!tableFilter.trim()) return true;
    const q = tableFilter.toLowerCase();
    return (
      o.productName.toLowerCase().includes(q) ||
      o.sellerName.toLowerCase().includes(q) ||
      o.category.toLowerCase().includes(q) ||
      o.specs.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="bg-white border border-slate-200 rounded-lg p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900">
            Veille Marché, Recherche IA Géolocalisée & Relevés de Prix
          </h1>
          <p className="text-xs text-slate-500">
            Section 35 : Recherche & évaluation de produit par Pays/Ville sur demande (Quota Gratuit
            IA + Google Search, zéro invention) et journal des relevés concurrents
          </p>
        </div>
        <div className="text-xs text-slate-600 font-mono">
          {observations.length} relevé(s) enregistré(s) · {savedAiReports.length} recherche(s) IA
        </div>
      </div>

      {/* MODULE SUR DEMANDE : RECHERCHE & ÉVALUATION IA D'UN PRODUIT DANS UN LIEU (PAYS / VILLE) */}
      <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-5">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3 border-b border-slate-200 pb-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Globe className="w-5 h-5 text-[#1D4ED8]" />
              <h2 className="text-base font-bold text-slate-900">
                Recherche & Évaluation Produit par IA sur Demande (Pays / Ville)
              </h2>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed max-w-3xl">
              Interrogez l&apos;IA à la demande pour chercher, vérifier et évaluer un produit
              (prix publics constatés, distributeurs locaux, fiche technique, fiabilité et
              alternatives) dans un <strong>Pays</strong> et une <strong>Ville</strong> précis.{' '}
              <strong className="text-slate-900">
                Consigne stricte Zéro Invention :
              </strong>{' '}
              la réponse s&apos;appuie exclusivement sur la recherche web Google en direct ; si
              aucune offre ou donnée n&apos;est trouvée dans la zone ciblée, l&apos;IA vous
              l&apos;indique explicitement sans rien inventer.
            </p>
          </div>
          <div className="text-[11px] text-slate-500 font-mono shrink-0">
            Mode : Sur demande uniquement · Quota gratuit Gemini Flash
          </div>
        </div>

        <form onSubmit={handleRunAiMarketSearch} className="space-y-4 text-xs">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-5">
              <label className="block font-medium text-slate-700 mb-1">
                Produit, Modèle ou Référence à chercher et évaluer *
              </label>
              <input
                type="text"
                required
                value={aiQueryForm.productQuery}
                onChange={(e) =>
                  setAiQueryForm({ ...aiQueryForm, productQuery: e.target.value })
                }
                placeholder="Ex: Membrane FilmTec TW30-1812-75, Vanne Fleck 5600 SXT, Osmoseur 400 GPD..."
                className="w-full px-3 py-2 border border-slate-300 rounded font-medium"
              />
            </div>

            <div className="md:col-span-3">
              <label className="block font-medium text-slate-700 mb-1">
                Ou choisir depuis votre catalogue stock
              </label>
              <select
                value=""
                onChange={(e) => {
                  const prod = catalogProducts.find((p) => p.id === e.target.value);
                  if (prod) {
                    setAiQueryForm({
                      ...aiQueryForm,
                      productQuery: `${prod.name} (${prod.reference})`,
                      category: prod.categoryName || aiQueryForm.category,
                    });
                  }
                }}
                className="w-full px-3 py-2 border border-slate-300 rounded bg-white"
              >
                <option value="">-- Sélectionner un article du stock --</option>
                {catalogProducts.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.reference} — {p.name} (
                    {formatMad(Math.round(p.salePriceHtCents * (1 + (p.vatRate || 20) / 100)))} TTC)
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block font-medium text-slate-700 mb-1">
                Pays ciblé *
              </label>
              <input
                type="text"
                list="market-countries-list"
                required
                value={aiQueryForm.country}
                onChange={(e) => setAiQueryForm({ ...aiQueryForm, country: e.target.value })}
                placeholder="Ex: Maroc, France..."
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
              <datalist id="market-countries-list">
                <option value="Maroc" />
                <option value="France" />
                <option value="Espagne" />
                <option value="Tunisie" />
                <option value="Algérie" />
                <option value="Sénégal" />
                <option value="Côte d'Ivoire" />
                <option value="Émirats Arabes Unis" />
                <option value="Turquie" />
                <option value="Chine" />
              </datalist>
            </div>

            <div className="md:col-span-2">
              <label className="block font-medium text-slate-700 mb-1">
                Ville / Région *
              </label>
              <input
                type="text"
                list="market-cities-list"
                required
                value={aiQueryForm.city}
                onChange={(e) => setAiQueryForm({ ...aiQueryForm, city: e.target.value })}
                placeholder="Ex: Casablanca, Rabat..."
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
              <datalist id="market-cities-list">
                <option value="Casablanca" />
                <option value="Rabat" />
                <option value="Tanger" />
                <option value="Marrakech" />
                <option value="Agadir" />
                <option value="Fès" />
                <option value="Meknès" />
                <option value="Oujda" />
                <option value="Kénitra" />
                <option value="Toutes villes" />
              </datalist>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-3">
              <label className="block font-medium text-slate-700 mb-1">
                Famille / Catégorie produit
              </label>
              <select
                value={aiQueryForm.category}
                onChange={(e) => setAiQueryForm({ ...aiQueryForm, category: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded bg-white"
              >
                <option value="Membranes Osmose Inverse">Membranes Osmose Inverse</option>
                <option value="Osmoseurs Domestiques & Industriels">
                  Osmoseurs Domestiques & Industriels
                </option>
                <option value="Adoucisseurs & Vannes Automatiques">
                  Adoucisseurs & Vannes Automatiques
                </option>
                <option value="Cartouches & Filtration Sédiments / Charbon">
                  Cartouches & Filtration Sédiments / Charbon
                </option>
                <option value="Pompes Booster & Dosage">Pompes Booster & Dosage</option>
                <option value="Stérilisateurs UV & Lampes">Stérilisateurs UV & Lampes</option>
                <option value="Résines, Sels & Média Filtrants">
                  Résines, Sels & Média Filtrants
                </option>
                <option value="Analyseurs TDS / pH & Accessoires">
                  Analyseurs TDS / pH & Accessoires
                </option>
              </select>
            </div>

            <div className="md:col-span-4">
              <label className="block font-medium text-slate-700 mb-1">
                Objectif de la recherche & évaluation
              </label>
              <select
                value={aiQueryForm.evaluationFocus}
                onChange={(e) =>
                  setAiQueryForm({ ...aiQueryForm, evaluationFocus: e.target.value })
                }
                className="w-full px-3 py-2 border border-slate-300 rounded bg-white"
              >
                <option value="Prix constatés, distributeurs & évaluation technique et commerciale">
                  Prix constatés, distributeurs & évaluation complète
                </option>
                <option value="Vérification fiche technique officielle, normes NSF/CE et risque de contrefaçon">
                  Vérification technique officielle, normes & authenticité
                </option>
                <option value="Comparatif de positionnement prix local et produits concurrents équivalents">
                  Comparatif prix local & alternatives concurrentes
                </option>
                <option value="Identification des importateurs, grossistes et revendeurs dans le lieu indiqué">
                  Recherche de fournisseurs / revendeurs dans la zone
                </option>
              </select>
            </div>

            <div className="md:col-span-5">
              <label className="block font-medium text-slate-700 mb-1">
                Question ou précision particulière (optionnel)
              </label>
              <input
                type="text"
                value={aiQueryForm.extraNotes}
                onChange={(e) => setAiQueryForm({ ...aiQueryForm, extraNotes: e.target.value })}
                placeholder="Ex: Comparer avec un prix de vente de 450 MAD TTC, vérifier la pression min..."
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
              <span>Exemples rapides :</span>
              <button
                type="button"
                onClick={() =>
                  setAiQueryForm({
                    ...aiQueryForm,
                    productQuery: 'Membrane FilmTec TW30-1812-75 GPD',
                    category: 'Membranes Osmose Inverse',
                    country: 'Maroc',
                    city: 'Casablanca',
                  })
                }
                className="underline hover:text-slate-900"
              >
                FilmTec 75 GPD (Casablanca)
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() =>
                  setAiQueryForm({
                    ...aiQueryForm,
                    productQuery: 'Vanne adoucisseur Fleck 5600 SXT',
                    category: 'Adoucisseurs & Vannes Automatiques',
                    country: 'Maroc',
                    city: 'Rabat',
                  })
                }
                className="underline hover:text-slate-900"
              >
                Fleck 5600 SXT (Rabat)
              </button>
              <span>·</span>
              <button
                type="button"
                onClick={() =>
                  setAiQueryForm({
                    ...aiQueryForm,
                    productQuery: 'Osmoseur domestique 7 étapes avec pompe booster',
                    category: 'Osmoseurs Domestiques & Industriels',
                    country: 'Maroc',
                    city: 'Tanger',
                  })
                }
                className="underline hover:text-slate-900"
              >
                Osmoseur 7 étapes (Tanger)
              </button>
            </div>

            <button
              type="submit"
              disabled={aiLoading}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-[#1D4ED8] hover:bg-blue-800 disabled:opacity-60 text-white font-semibold rounded transition-colors whitespace-nowrap"
            >
              {aiLoading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin" />
                  Recherche web & analyse en cours...
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  Lancer la Recherche & Évaluation IA (Sur demande)
                </>
              )}
            </button>
          </div>
        </form>

        {aiError && (
          <div className="p-3.5 bg-rose-50 border border-rose-300 rounded text-xs text-rose-900 flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-bold">Recherche IA interrompue</div>
              <div>{aiError}</div>
            </div>
          </div>
        )}

        {/* RÉCAPITULATIF DE LA RECHERCHE IA */}
        {activeAiReport && (
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <div className="bg-slate-50 px-4 py-3 border-b border-slate-200 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-bold text-slate-900 text-sm">
                    {activeAiReport.productQuery}
                  </span>
                  <span aria-hidden="true" className="text-slate-400">
                    ·
                  </span>
                  <span className="inline-flex items-center gap-1 font-medium text-slate-700">
                    <MapPin className="w-3.5 h-3.5 text-[#1D4ED8]" />
                    {activeAiReport.locationLabel}
                  </span>
                  <span aria-hidden="true" className="text-slate-400">
                    ·
                  </span>
                  <span
                    className={`font-mono font-bold text-[11px] ${
                      activeAiReport.status === 'FOUND'
                        ? 'text-emerald-700'
                        : activeAiReport.status === 'PARTIAL'
                        ? 'text-amber-700'
                        : 'text-rose-700'
                    }`}
                  >
                    {activeAiReport.status === 'FOUND'
                      ? 'STATUT : DONNÉES VÉRIFIÉES TROUVÉES'
                      : activeAiReport.status === 'PARTIAL'
                      ? 'STATUT : PARTIEL (PRODUIT IDENTIFIÉ / PRIX LOCAL NON PUBLIÉ)'
                      : 'STATUT : AUCUNE DONNÉE FIABLE TROUVÉE (ZÉRO INVENTION)'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-500 font-mono">
                  Généré le {formatMoroccoDateTime(activeAiReport.timestamp)} ·{' '}
                  {activeAiReport.sources.length} source(s) web vérifiée(s)
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => handlePrefillObservationFromAi(activeAiReport)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-white hover:bg-slate-100 text-slate-800 border border-slate-300 rounded text-xs font-medium whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" /> Pré-remplir un relevé concurrent
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onOpenPrintPreview(buildAiMarketResearchReportPrint(company, activeAiReport))
                  }
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-[#0F172A] hover:bg-slate-800 text-white rounded text-xs font-medium whitespace-nowrap"
                >
                  <Printer className="w-3.5 h-3.5" /> Imprimer / PDF ce Récapitulatif (A4)
                </button>
              </div>
            </div>

            <div className="p-4 grid grid-cols-1 lg:grid-cols-12 gap-5 bg-white">
              <div className="lg:col-span-8 space-y-3">
                <div className="text-xs font-bold text-slate-700 border-b border-slate-200 pb-1.5">
                  Synthèse d&apos;Évaluation & Relevés Vérifiés ({activeAiReport.locationLabel})
                </div>
                <div className="text-xs text-slate-800 leading-relaxed whitespace-pre-line font-sans">
                  {activeAiReport.reportMarkdown}
                </div>
              </div>

              <div className="lg:col-span-4 space-y-4 border-t lg:border-t-0 lg:border-l border-slate-200 pt-4 lg:pt-0 lg:pl-4">
                <div className="space-y-2">
                  <div className="text-xs font-bold text-slate-800 flex items-center justify-between">
                    <span>Sources Web Consultées ({activeAiReport.sources.length})</span>
                  </div>
                  {activeAiReport.sources.length === 0 ? (
                    <div className="p-3 bg-slate-50 border border-slate-200 rounded text-[11px] text-slate-600">
                      Aucune page web publique n&apos;a été retournée pour cette requête. Conformément
                      à la règle de fiabilité stricte, aucun prix ni revendeur fictif n&apos;a été
                      généré.
                    </div>
                  ) : (
                    <ul className="space-y-2 max-h-60 overflow-y-auto pr-1">
                      {activeAiReport.sources.map((src, idx) => (
                        <li
                          key={idx}
                          className="p-2.5 bg-slate-50 border border-slate-200 rounded text-[11px]"
                        >
                          <a
                            href={src.uri}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-semibold text-[#1D4ED8] hover:underline flex items-start justify-between gap-1.5"
                          >
                            <span className="line-clamp-2">
                              [{idx + 1}] {src.title}
                            </span>
                            <ExternalLink className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                          </a>
                          <div className="text-[10px] font-mono text-slate-500 truncate mt-1">
                            {src.uri}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {activeAiReport.searchQueries.length > 0 && (
                  <div className="space-y-1.5">
                    <div className="text-[11px] font-semibold text-slate-600">
                      Requêtes de vérification exécutées :
                    </div>
                    <div className="text-[11px] font-mono text-slate-500 space-y-1">
                      {activeAiReport.searchQueries.map((q, idx) => (
                        <div key={idx} className="truncate">
                          • {q}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* HISTORIQUE LOCAL DES RECHERCHES IA RÉCENTES (SANS CONSOMMER DE QUOTA) */}
        {savedAiReports.length > 1 && (
          <div className="pt-2 border-t border-slate-200 space-y-2">
            <div className="text-xs font-semibold text-slate-700">
              Recherches IA précédentes enregistrées localement (consultation gratuite immédiate) :
            </div>
            <div className="flex flex-wrap gap-2">
              {savedAiReports.map((rep) => {
                const isSelected = activeAiReport?.timestamp === rep.timestamp;
                return (
                  <div
                    key={rep.timestamp}
                    className={`inline-flex items-center gap-2 px-3 py-1.5 rounded border text-xs ${
                      isSelected
                        ? 'bg-slate-900 text-white border-slate-900'
                        : 'bg-slate-50 text-slate-700 border-slate-300 hover:bg-slate-100'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveAiReport(rep)}
                      className="text-left font-medium truncate max-w-[240px]"
                    >
                      {rep.productQuery} ({rep.locationLabel})
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteSavedAiReport(rep.timestamp)}
                      title="Retirer de l'historique"
                      className="opacity-70 hover:opacity-100"
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* SAISIE & ARCHIVAGE D'UN RELEVÉ DE PRIX CONCURRENT DANS LA BASE LOCALE */}
      <form
        onSubmit={handleAdd}
        className="bg-white border border-slate-200 rounded-lg p-5 space-y-3 text-xs"
      >
        <div className="font-bold text-slate-900 text-sm">
          Enregistrer un Relevé de Prix Concurrent dans le Journal Local
        </div>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="block font-medium mb-1">Produit observé *</label>
            <input
              type="text"
              required
              value={form.productName}
              onChange={(e) => setForm({ ...form, productName: e.target.value })}
              className="w-full px-3 py-1.5 border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Concurrent / Vendeur & Ville *</label>
            <input
              type="text"
              required
              value={form.sellerName}
              onChange={(e) => setForm({ ...form, sellerName: e.target.value })}
              placeholder="Ex: Distributeur Casablanca..."
              className="w-full px-3 py-1.5 border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Prix TTC constaté (MAD) *</label>
            <input
              type="number"
              step="0.01"
              required
              value={form.priceTtcDh}
              onChange={(e) => setForm({ ...form, priceTtcDh: e.target.value })}
              className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
            />
          </div>
          <div>
            <label className="block font-medium mb-1">Qualification de la source</label>
            <select
              value={form.sourceType}
              onChange={(e) =>
                setForm({
                  ...form,
                  sourceType: e.target.value as MarketObservation['sourceType'],
                })
              }
              className="w-full px-3 py-1.5 border border-slate-300 rounded bg-white"
            >
              <option value="VERIFIEE">VÉRIFIÉE (Facture / Devis / Offre web vérifiée)</option>
              <option value="MANUELLE">MANUELLE (Relevé terrain)</option>
              <option value="IMPORTEE">IMPORTÉE</option>
            </select>
          </div>
          <div className="md:col-span-3">
            <label className="block font-medium mb-1">Caractéristiques / Lien / Notes</label>
            <input
              type="text"
              value={form.specs}
              onChange={(e) => setForm({ ...form, specs: e.target.value })}
              placeholder="Origine, garantie, lien source, accessoires inclus..."
              className="w-full px-3 py-1.5 border border-slate-300 rounded"
            />
          </div>
          <div className="flex items-end">
            <button
              type="submit"
              className="w-full py-1.5 bg-[#0F172A] text-white font-medium rounded hover:bg-slate-800"
            >
              + Enregistrer le relevé
            </button>
          </div>
        </div>
      </form>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-xs">
          <span className="font-semibold text-slate-800">
            Journal des Relevés de Prix & Concurrents ({filteredObservations.length})
          </span>
          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-2" />
            <input
              type="text"
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
              placeholder="Filtrer par produit, vendeur, ville..."
              className="w-full pl-8 pr-3 py-1 border border-slate-300 rounded text-xs"
            />
          </div>
        </div>
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
              <th className="py-3 px-4">Date</th>
              <th className="py-3 px-4">Produit</th>
              <th className="py-3 px-4">Vendeur / Source</th>
              <th className="py-3 px-4">Qualification</th>
              <th className="py-3 px-4 text-right">Prix HT est.</th>
              <th className="py-3 px-4 text-right">Prix TTC constaté</th>
              <th className="py-3 px-4">Caractéristiques</th>
              <th className="py-3 px-4 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredObservations.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-slate-400">
                  Aucun relevé de prix correspondant.
                </td>
              </tr>
            ) : (
              filteredObservations.map((o) => (
                <tr key={o.id}>
                  <td className="py-3 px-4 font-mono-tabular">
                    {formatBusinessDateFr(o.observedDate)}
                  </td>
                  <td className="py-3 px-4 font-medium text-slate-900">{o.productName}</td>
                  <td className="py-3 px-4">
                    <div>{o.sellerName}</div>
                    {o.sourceUrl && (
                      <a
                        href={o.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] font-mono text-[#1D4ED8] hover:underline inline-flex items-center gap-1"
                      >
                        Source web <ExternalLink className="w-2.5 h-2.5" />
                      </a>
                    )}
                  </td>
                  <td className="py-3 px-4 font-mono text-[11px] font-semibold">{o.sourceType}</td>
                  <td className="py-3 px-4 text-right font-mono-tabular">
                    {formatMad(o.priceHtCents)}
                  </td>
                  <td className="py-3 px-4 text-right font-mono-tabular font-bold">
                    {formatMad(o.priceTtcCents)}
                  </td>
                  <td className="py-3 px-4 text-slate-600">{o.specs}</td>
                  <td className="py-3 px-4 text-right">
                    <button
                      type="button"
                      onClick={() => handleDeleteObservation(o.id)}
                      className="text-slate-400 hover:text-rose-700 p-1"
                      title="Supprimer ce relevé"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/**
 * SECTIONS 30, 39, 41, 42, 50, 52 : SAUVEGARDES, IMPORT EXCEL, DIAGNOSTIC BASE, TESTS AUTOMATISÉS & PARAMÈTRES
 */
export const BackupsDiagnosticsAndSettingsView: React.FC<{
  initialTab?: 'BACKUPS' | 'DIAGNOSTIC' | 'TESTS' | 'AUDIT' | 'SETTINGS';
  company: CompanyInfo;
  settings: AppSettings;
  currentProfile?: UserProfile | null;
  onSelectProfile?: (profile: UserProfile) => void;
  refreshTrigger: number;
  onChanged: () => void;
  onOpenWizard: () => void;
}> = ({
  initialTab = 'BACKUPS',
  company,
  settings,
  currentProfile,
  onSelectProfile,
  refreshTrigger,
  onChanged,
  onOpenWizard,
}) => {
  const [subTab, setSubTab] = useState<'BACKUPS' | 'DIAGNOSTIC' | 'TESTS' | 'AUDIT' | 'SETTINGS'>(
    initialTab
  );

  // Backup & Restore state
  const [backupPassphrase, setBackupPassphrase] = useState('');
  const [restoreJsonText, setRestoreJsonText] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [restoreMasterPin, setRestoreMasterPin] = useState('');
  const [restoreMasterPinError, setRestoreMasterPinError] = useState<string | null>(null);
  const [isRestoring, setIsRestoring] = useState(false);
  const [restoreConfirmedCheck, setRestoreConfirmedCheck] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; msg: string } | null>(null);

  // Import Excel state (Règle 25)
  const [importEntityType, setImportEntityType] = useState<ImportEntityType>('PRODUCTS');
  const [importReport, setImportReport] = useState<ImportValidationReport | null>(null);
  const [allowSkipImportErrors, setAllowSkipImportErrors] = useState(false);

  // Diagnostic state (Section 42)
  const [diagReport, setDiagReport] = useState<DiagnosticReport | null>(null);

  // Automated Tests state (Section 52 & Contradictions)
  const [testSuiteReport, setTestSuiteReport] = useState<AutomatedTestSuiteReport | null>(null);
  const [runningTests, setRunningTests] = useState(false);

  // Audit logs state
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);

  // User Profiles Management state
  const [userProfiles, setUserProfiles] = useState<UserProfile[]>([]);
  const [editingUserForm, setEditingUserForm] = useState<{
    id?: string;
    name: string;
    role: UserRole;
    pin: string;
    masterPin: string;
    active: boolean;
  } | null>(null);

  // Settings form state
  const [companyForm, setCompanyForm] = useState<CompanyInfo>(company);
  const [settingsForm, setSettingsForm] = useState<AppSettings>(settings);
  const [newPin, setNewPin] = useState('');

  // Verrouillage des Paramètres par Code PIN Maître (réservé ADMIN)
  const [masterPinUnlocked, setMasterPinUnlocked] = useState(false);
  const [masterPinInput, setMasterPinInput] = useState('');
  const [masterPinError, setMasterPinError] = useState<string | null>(null);
  const [verifyingMasterPin, setVerifyingMasterPin] = useState(false);

  // Remise à zéro de l'application sous Code PIN Maître
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetMode, setResetMode] = useState<'ZERO_OPERATIONS' | 'FACTORY_RESET'>('ZERO_OPERATIONS');
  const [resetMasterPin, setResetMasterPin] = useState('');
  const [resetError, setResetError] = useState<string | null>(null);
  const [isResetting, setIsResetting] = useState(false);

  useEffect(() => {
    setMasterPinUnlocked(false);
    setMasterPinInput('');
    setMasterPinError(null);
    if (currentProfile && currentProfile.role !== 'ADMIN' && subTab === 'SETTINGS') {
      setSubTab('BACKUPS');
    }
  }, [currentProfile?.id, currentProfile?.role]);

  const handleVerifyMasterPinForSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentProfile || currentProfile.role !== 'ADMIN') {
      setMasterPinError(
        "Accès refusé : seul un profil Administrateur [ADMIN] peut accéder aux Paramètres."
      );
      return;
    }
    const cleanPin = masterPinInput.trim();
    if (!cleanPin) {
      setMasterPinError('Veuillez saisir votre Code PIN Maître.');
      return;
    }

    setVerifyingMasterPin(true);
    setMasterPinError(null);
    try {
      const allProfiles = await db.profiles.toArray();
      const adminProfiles = allProfiles.filter(
        (p) => p.role === 'ADMIN' && p.active !== false
      );
      const candidates = [
        currentProfile,
        ...adminProfiles.filter((p) => p.id !== currentProfile.id),
      ];

      let matchedMaster = false;
      let matchedPersonalPinOnly = false;

      for (const adminProf of candidates) {
        const isMaster = await verifyPin(
          cleanPin,
          adminProf.masterPinSalt,
          adminProf.masterPinHash
        );
        if (isMaster) {
          matchedMaster = true;
          break;
        }
        const isPersonal = await verifyPin(cleanPin, adminProf.pinSalt, adminProf.pinHash);
        if (isPersonal) {
          matchedPersonalPinOnly = true;
        }
      }

      if (matchedMaster) {
        setMasterPinUnlocked(true);
        setMasterPinInput('');
        setMasterPinError(null);
      } else if (matchedPersonalPinOnly) {
        setMasterPinError(
          'Vous avez saisi votre Code PIN personnel de session. Pour accéder aux Paramètres, veuillez saisir votre Code PIN Maître.'
        );
      } else {
        setMasterPinError('Code PIN Maître incorrect. Accès aux Paramètres refusé.');
      }
    } finally {
      setVerifyingMasterPin(false);
    }
  };

  const handleConfirmResetApp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetMasterPin.trim()) {
      setResetError('Veuillez saisir votre Code PIN Maître.');
      return;
    }
    setIsResetting(true);
    setResetError(null);
    try {
      const res = await executeResetAppToZero({
        masterPinInput: resetMasterPin,
        mode: resetMode,
        actor: currentProfile
          ? {
              userId: currentProfile.id,
              userName: currentProfile.name,
              userRole: currentProfile.role,
            }
          : undefined,
      });

      setShowResetModal(false);
      setResetMasterPin('');
      onChanged();
      setFeedback({
        type: 'success',
        msg: res.message,
      });

      if (res.mode === 'FACTORY_RESET') {
        onOpenWizard();
      }
    } catch (err) {
      setResetError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsResetting(false);
    }
  };

  useEffect(() => {
    setCompanyForm(company);
    setSettingsForm(settings);
  }, [company, settings]);

  useEffect(() => {
    runDatabaseDiagnostic().then(setDiagReport);
    db.auditLogs.orderBy('timestamp').reverse().limit(100).toArray().then(setAuditLogs);
    db.profiles.toArray().then(setUserProfiles);
  }, [refreshTrigger]);

  const [isExportingExcel, setIsExportingExcel] = useState(false);

  const handleExportDatabaseExcel = async () => {
    setIsExportingExcel(true);
    setFeedback(null);
    try {
      await exportDatabaseToExcelFile();
      setFeedback({
        type: 'success',
        msg: 'Export Excel multi-feuilles (.xlsx) généré et téléchargé avec succès (19 collections exportées).',
      });
    } catch (err) {
      console.error('Erreur export Excel:', err);
      setFeedback({
        type: 'error',
        msg: `Échec de l'export Excel : ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setIsExportingExcel(false);
    }
  };

  const handleDownloadTemplate = (templateType: ImportEntityType | 'ALL_IN_ONE') => {
    try {
      downloadExcelImportTemplate(templateType);
      setFeedback({
        type: 'success',
        msg: 'Modèle Excel (.xlsx) téléchargé avec succès.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: `Erreur lors du téléchargement du modèle : ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleDownloadBackupJson = async () => {
    try {
      const content = await exportBackupString(backupPassphrase);
      const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ATLAS_SOFT_WATER_Backup_${getMoroccoBusinessDate()}${
        backupPassphrase ? '_AES256' : ''
      }.json`;
      a.click();
      URL.revokeObjectURL(url);
      setFeedback({
        type: 'success',
        msg: backupPassphrase
          ? 'Sauvegarde JSON chiffrée AES-GCM générée et téléchargée.'
          : 'Sauvegarde JSON complète générée et téléchargée.',
      });
    } catch (err) {
      setFeedback({ type: 'error', msg: err instanceof Error ? err.message : String(err) });
    }
  };

  const handleRestoreBackup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!restoreJsonText.trim()) {
      setFeedback({
        type: 'error',
        msg: 'Veuillez coller le contenu JSON de la sauvegarde ou sélectionner un fichier .json.',
      });
      return;
    }

    const cleanPin = restoreMasterPin.trim();
    if (!cleanPin) {
      setRestoreMasterPinError('Le Code PIN Maître Administrateur est obligatoire pour autoriser la restauration.');
      setFeedback({
        type: 'error',
        msg: 'Sécurité Règle 26 : Le Code PIN Maître Administrateur est obligatoire pour autoriser la restauration.',
      });
      return;
    }

    if (!restoreConfirmedCheck) {
      setRestoreMasterPinError('Veuillez cocher la case de confirmation pour autoriser le remplacement des données.');
      setFeedback({
        type: 'error',
        msg: 'Veuillez cocher la case de confirmation pour autoriser le remplacement des données.',
      });
      return;
    }

    setFeedback(null);
    setRestoreMasterPinError(null);
    setIsRestoring(true);

    try {
      const res = await validateAndRestoreBackup(restoreJsonText, restorePassphrase, db, {
        masterPinInput: cleanPin,
        actor: currentProfile
          ? {
              userId: currentProfile.id,
              userName: currentProfile.name,
              userRole: currentProfile.role,
            }
          : undefined,
      });

      setDiagReport(res.diagnosticReport);
      setRestoreMasterPin('');
      setRestoreJsonText('');
      setRestorePassphrase('');
      setRestoreConfirmedCheck(false);
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Restauration Règle 26 réussie sous Code PIN Maître (${res.restoredTablesCount} collections restaurées). Diagnostic post-restauration : ${
          res.diagnosticReport.healthy ? '100% Conforme' : 'Anomalies détectées'
        }.`,
      });
    } catch (err) {
      if (err instanceof ArbitrageError) {
        setFeedback({ type: 'error', msg: err.decision.resolutionMessage });
        setRestoreMasterPinError(err.decision.resolutionMessage);
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setFeedback({ type: 'error', msg: errorMsg });
        setRestoreMasterPinError(errorMsg);
      }
    } finally {
      setIsRestoring(false);
    }
  };

  const handleExcelFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const preferredSheetMap: Record<ImportEntityType, string[]> = {
      PRODUCTS: ['Produits', 'Products'],
      CUSTOMERS: ['Clients', 'Customers'],
      SUPPLIERS: ['Fournisseurs', 'Suppliers'],
      EQUIPMENTS_SAV: ['Equipements_SAV', 'Equipements', 'SAV'],
    };
    const candidates = preferredSheetMap[importEntityType] || [];
    const matchedSheetName =
      wb.SheetNames.find((name) =>
        candidates.some((c) => c.toLowerCase() === name.trim().toLowerCase())
      ) || wb.SheetNames[0];
    const ws = wb.Sheets[matchedSheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws);
    const report = await validateImportData(importEntityType, rows, {});
    setImportReport(report);
    e.target.value = '';
  };

  const handleSimulateSampleImportValidation = async () => {
    const sampleRows = [
      {
        reference: `FILT-PP-${Math.floor(100 + Math.random() * 899)}`,
        name: 'Cartouche Polypropylène 5 Microns 10 Pouces Haute Densité',
        salePriceDh: '25',
        purchasePriceDh: '9',
        vatRate: '20',
        stock: '50',
      },
      {
        reference: '', // Erreur intentionnelle pour démontrer l'assistant Règle 25
        name: 'Article sans référence (Erreur détectée)',
        salePriceDh: '-10',
        vatRate: '20',
        stock: '5',
      },
    ];
    const report = await validateImportData('PRODUCTS', sampleRows, {});
    setImportEntityType('PRODUCTS');
    setImportReport(report);
  };

  const handleCommitImport = async () => {
    if (!importReport) return;
    try {
      const res = await executeCommitValidatedImport(importReport, {
        allowSkipErrors: allowSkipImportErrors,
      });
      setImportReport(null);
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Import transactionnel Règle 25 terminé : ${res.importedCount} enregistrement(s) ajouté(s).`,
      });
    } catch (err) {
      if (err instanceof ArbitrageError) {
        setFeedback({ type: 'error', msg: err.decision.resolutionMessage });
      } else {
        setFeedback({ type: 'error', msg: err instanceof Error ? err.message : String(err) });
      }
    }
  };

  const handleRunTests = async () => {
    setRunningTests(true);
    try {
      const rep = await runMandatoryAutomatedTests();
      setTestSuiteReport(rep);
    } finally {
      setRunningTests(false);
    }
  };

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const now = new Date().toISOString();
    await db.company.put({ ...companyForm, updatedAt: now });
    await db.settings.put({ ...settingsForm, updatedAt: now });

    if (newPin.trim().length >= 4) {
      const salt = generateRandomSalt();
      const hash = await hashPinWithSalt(newPin.trim(), salt);
      await db.profiles.update('admin', {
        pinSalt: salt,
        pinHash: hash,
        updatedAt: now,
      });
      setNewPin('');
    }

    onChanged();
    setFeedback({ type: 'success', msg: 'Paramètres entreprise, TVA, POS et sécurité enregistrés.' });
  };

  const handleUploadCompanyLogo = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await fileToLogoDataUrl(file);
      const now = new Date().toISOString();
      const updated = { ...companyForm, logoDataUrl: dataUrl, updatedAt: now };
      setCompanyForm(updated);
      await db.company.put(updated);
      onChanged();
      setFeedback({
        type: 'success',
        msg: 'Logo de l’entreprise importé et enregistré pour l’interface de l’application (non affiché sur les documents imprimés).',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleRemoveCompanyLogo = async () => {
    const now = new Date().toISOString();
    const updated: CompanyInfo = { ...companyForm, logoDataUrl: undefined, updatedAt: now };
    setCompanyForm(updated);
    await db.company.put(updated);
    onChanged();
    setFeedback({
      type: 'success',
      msg: 'Logo retiré. Le monogramme par défaut est désormais utilisé.',
    });
  };

  const handleUploadWatermarkFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await fileToWatermarkDataUrl(file);
      const now = new Date().toISOString();
      const updated: CompanyInfo = {
        ...companyForm,
        watermarkDataUrl: dataUrl,
        watermarkFileName: file.name,
        watermarkEnabled: true,
        watermarkOpacity: companyForm.watermarkOpacity ?? 100,
        updatedAt: now,
      };
      setCompanyForm(updated);
      await db.company.put(updated);
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Filigrane « ${file.name} » importé et activé pour tous les documents A4 à imprimer ou télécharger.`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        msg: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleLoadDefaultWatermark = async () => {
    const dataUrl = generateAtlasSoftWaterWatermarkDataUrl();
    const now = new Date().toISOString();
    const updated: CompanyInfo = {
      ...companyForm,
      watermarkDataUrl: dataUrl,
      watermarkFileName: 'Filigrane_AtlasSoftWater_A4.pdf',
      watermarkEnabled: true,
      watermarkOpacity: companyForm.watermarkOpacity ?? 100,
      updatedAt: now,
    };
    setCompanyForm(updated);
    await db.company.put(updated);
    onChanged();
    setFeedback({
      type: 'success',
      msg: 'Filigrane modèle AtlasSoftWater chargé et activé sur les documents à imprimer.',
    });
  };

  const handleToggleWatermarkEnabled = async (enabled: boolean) => {
    const now = new Date().toISOString();
    const updated: CompanyInfo = {
      ...companyForm,
      watermarkEnabled: enabled,
      updatedAt: now,
    };
    setCompanyForm(updated);
    await db.company.put(updated);
    onChanged();
    setFeedback({
      type: 'success',
      msg: enabled
        ? 'Filigrane activé sur les documents à imprimer.'
        : 'Filigrane désactivé : vos documents seront imprimés sans filigrane.',
    });
  };

  const handleRemoveWatermark = async () => {
    const now = new Date().toISOString();
    const updated: CompanyInfo = {
      ...companyForm,
      watermarkDataUrl: undefined,
      watermarkFileName: undefined,
      watermarkEnabled: false,
      updatedAt: now,
    };
    setCompanyForm(updated);
    await db.company.put(updated);
    onChanged();
    setFeedback({
      type: 'success',
      msg: 'Filigrane supprimé. Les documents à imprimer sont désormais sans filigrane.',
    });
  };

  const handleSaveUserProfile = async () => {
    if (!editingUserForm) return;
    const trimmedName = editingUserForm.name.trim();
    if (!trimmedName) {
      setFeedback({
        type: 'error',
        msg: 'Veuillez saisir le nom complet de l’utilisateur / opérateur.',
      });
      return;
    }

    const now = new Date().toISOString();

    if (editingUserForm.id) {
      // Modification d'un utilisateur existant
      const existing = await db.profiles.get(editingUserForm.id);
      if (!existing) return;

      // Vérifier qu'on ne désactive ou ne retire pas le rôle ADMIN du tout dernier admin actif
      const otherActiveAdmins = userProfiles.filter(
        (u) => u.id !== existing.id && u.role === 'ADMIN' && u.active !== false
      );
      if (
        existing.role === 'ADMIN' &&
        otherActiveAdmins.length === 0 &&
        (editingUserForm.role !== 'ADMIN' || !editingUserForm.active)
      ) {
        setFeedback({
          type: 'error',
          msg: 'Action bloquée : il doit toujours rester au moins un profil Administrateur [ADMIN] actif.',
        });
        return;
      }

      let pinSalt = existing.pinSalt;
      let pinHash = existing.pinHash;
      if (editingUserForm.pin.trim().length > 0) {
        if (editingUserForm.pin.trim().length < 4) {
          setFeedback({
            type: 'error',
            msg: 'Le nouveau Code PIN personnel doit comporter au moins 4 caractères.',
          });
          return;
        }
        pinSalt = generateRandomSalt();
        pinHash = await hashPinWithSalt(editingUserForm.pin.trim(), pinSalt);
      }

      let masterPinSalt = existing.masterPinSalt;
      let masterPinHash = existing.masterPinHash;
      if (editingUserForm.masterPin.trim().length > 0) {
        if (editingUserForm.masterPin.trim().length < 4) {
          setFeedback({
            type: 'error',
            msg: 'Le nouveau Code PIN Maître doit comporter au moins 4 caractères.',
          });
          return;
        }
        masterPinSalt = generateRandomSalt();
        masterPinHash = await hashPinWithSalt(editingUserForm.masterPin.trim(), masterPinSalt);
      }

      const updatedUser: UserProfile = {
        ...existing,
        name: trimmedName,
        role: editingUserForm.role,
        active: editingUserForm.active,
        pinSalt,
        pinHash,
        masterPinSalt,
        masterPinHash,
        failedAttempts: 0,
        lockedUntil: null,
        updatedAt: now,
      };

      await db.profiles.put(updatedUser);
      if (currentProfile?.id === updatedUser.id && onSelectProfile) {
        onSelectProfile(updatedUser);
      }
      setEditingUserForm(null);
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Profil utilisateur « ${updatedUser.name} » (${updatedUser.role}) mis à jour avec succès.`,
      });
    } else {
      // Création d'un nouvel utilisateur
      const pinVal = editingUserForm.pin.trim() || '2468';
      const masterVal = editingUserForm.masterPin.trim() || '135790';
      if (pinVal.length < 4 || masterVal.length < 4) {
        setFeedback({
          type: 'error',
          msg: 'Les codes PIN et PIN Maître doivent comporter au moins 4 caractères.',
        });
        return;
      }

      const pinSalt = generateRandomSalt();
      const pinHash = await hashPinWithSalt(pinVal, pinSalt);
      const masterPinSalt = generateRandomSalt();
      const masterPinHash = await hashPinWithSalt(masterVal, masterPinSalt);

      const newUser: UserProfile = {
        id: `user-${generateId().slice(0, 8)}`,
        name: trimmedName,
        role: editingUserForm.role,
        pinSalt,
        pinHash,
        masterPinSalt,
        masterPinHash,
        active: editingUserForm.active,
        failedAttempts: 0,
        lockedUntil: null,
        createdAt: now,
        updatedAt: now,
      };

      await db.profiles.add(newUser);
      setEditingUserForm(null);
      onChanged();
      setFeedback({
        type: 'success',
        msg: `Nouvel utilisateur « ${newUser.name} » [${newUser.role}] créé avec succès.`,
      });
    }
  };

  const handleDeleteUserProfile = async (target: UserProfile) => {
    if (userProfiles.length <= 1) {
      setFeedback({
        type: 'error',
        msg: 'Impossible de supprimer le seul utilisateur existant dans l’application.',
      });
      return;
    }

    const remainingActiveAdmins = userProfiles.filter(
      (u) => u.id !== target.id && u.role === 'ADMIN' && u.active !== false
    );
    if (target.role === 'ADMIN' && remainingActiveAdmins.length === 0) {
      setFeedback({
        type: 'error',
        msg: 'Impossible de supprimer le dernier Administrateur [ADMIN] actif. Créez ou nommez d’abord un autre Administrateur.',
      });
      return;
    }

    await db.profiles.delete(target.id);
    if (editingUserForm?.id === target.id) {
      setEditingUserForm(null);
    }
    onChanged();
    setFeedback({
      type: 'success',
      msg: `Utilisateur « ${target.name} » supprimé de l'application.`,
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4 bg-white border border-slate-200 rounded-lg p-4">
        <div>
          <h1 className="font-display text-2xl font-bold text-slate-900">
            Sauvegardes, Import/Export, Diagnostic d&apos;Intégrité, Tests & Paramètres
          </h1>
          <p className="text-xs text-slate-500">
            Règles 25 & 26 · Vérificateur des 26 Règles d&apos;Arbitrage · Exécuteur de Tests
            Automatisés
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 rounded-lg">
          {(
            [
              { id: 'BACKUPS' as const, label: 'Sauvegardes & Excel' },
              { id: 'DIAGNOSTIC' as const, label: 'Diagnostic & Intégrité' },
              { id: 'TESTS' as const, label: 'Arbitrage & Tests Auto (18)' },
              { id: 'AUDIT' as const, label: "Journal d'Audit" },
              ...(currentProfile?.role === 'ADMIN'
                ? [{ id: 'SETTINGS' as const, label: 'Paramètres' }]
                : []),
            ]
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                if (t.id !== 'SETTINGS') {
                  setMasterPinUnlocked(false);
                  setMasterPinInput('');
                  setMasterPinError(null);
                }
                setSubTab(t.id);
              }}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                subTab === t.id ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {feedback && (
        <div
          className={`p-3.5 rounded-md border text-xs flex justify-between ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
              : 'bg-red-50 border-red-300 text-red-900'
          }`}
        >
          <span>{feedback.msg}</span>
          <button type="button" onClick={() => setFeedback(null)} className="underline">
            Fermer
          </button>
        </div>
      )}

      {subTab === 'BACKUPS' && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 text-xs">
          {/* Export JSON & Excel */}
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
              <Download className="w-4 h-4 text-[#1D4ED8]" />
              Sauvegarde JSON Complète & Export Excel Multi-Feuilles
            </h2>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Mot de passe de chiffrement AES-GCM 256 bits (Optionnel)
              </label>
              <input
                type="password"
                value={backupPassphrase}
                onChange={(e) => setBackupPassphrase(e.target.value)}
                placeholder="Laisser vide pour JSON standard ou saisir une clé..."
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleDownloadBackupJson}
                className="px-4 py-2 bg-[#0F172A] text-white font-medium rounded hover:bg-slate-800 inline-flex items-center gap-2"
              >
                <Download className="w-4 h-4" /> Télécharger Backup JSON
              </button>
              <button
                type="button"
                onClick={handleExportDatabaseExcel}
                disabled={isExportingExcel}
                className="px-4 py-2 bg-emerald-700 text-white font-medium rounded hover:bg-emerald-800 inline-flex items-center gap-2 cursor-pointer disabled:opacity-60"
              >
                <FileSpreadsheet className="w-4 h-4" />
                {isExportingExcel ? 'Génération Excel...' : 'Exporter Tout vers Excel (.xlsx)'}
              </button>
            </div>

            <div className="pt-4 border-t border-slate-200 space-y-2">
              <h3 className="text-sm font-bold text-slate-900">
                Lanceurs Windows Autonomes (Demarrer.bat & buil.bat)
              </h3>
              <p className="text-slate-600">
                Les scripts <code className="font-mono">Demarrer.bat</code>,{' '}
                <code className="font-mono">buil.bat</code> et{' '}
                <code className="font-mono">build.bat</code> sont présents à la racine du projet
                pour installer les dépendances, compiler et ouvrir l&apos;application dans une
                fenêtre autonome dédiée (<code className="font-mono">--app=http://localhost:3000</code>).
              </p>
            </div>

            <div className="pt-4 border-t border-slate-200 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                    <FileSpreadsheet className="w-4 h-4 text-emerald-700" />
                    Modèles Excel (.xlsx) Prêts à Importer
                  </h3>
                  <p className="text-slate-600 text-[11px]">
                    Téléchargez les modèles officiels pré-formatés (avec exemples et guide des
                    colonnes). Également disponibles dans le dossier{' '}
                    <code className="font-mono bg-slate-100 px-1 rounded">modeles_excel/</code> du
                    projet.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleDownloadTemplate('ALL_IN_ONE')}
                  className="px-3 py-1.5 bg-emerald-700 text-white font-medium rounded hover:bg-emerald-800 inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" /> Pack Complet Multi-Feuilles (.xlsx)
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                <div className="p-3 bg-slate-50 border border-slate-200 rounded flex flex-col justify-between gap-2">
                  <div>
                    <div className="font-bold text-slate-900">1. Modèle Produits & Stock</div>
                    <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                      Reference*, Designation*, Prix_Vente_HT*, Prix_Achat_HT, TVA, Stock_Initial,
                      Stock_Min, Categorie, Marque, Code_Barres
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDownloadTemplate('PRODUCTS')}
                    className="px-2.5 py-1.5 bg-white border border-slate-300 text-slate-800 font-medium rounded hover:bg-slate-100 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 text-emerald-700" /> Télécharger
                    Modele_Import_Produits.xlsx
                  </button>
                </div>

                <div className="p-3 bg-slate-50 border border-slate-200 rounded flex flex-col justify-between gap-2">
                  <div>
                    <div className="font-bold text-slate-900">2. Modèle Clients</div>
                    <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                      Nom_Client*, Type_Client, Telephone, WhatsApp, Ville, Adresse, ICE,
                      Code_Client, Email, Notes
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDownloadTemplate('CUSTOMERS')}
                    className="px-2.5 py-1.5 bg-white border border-slate-300 text-slate-800 font-medium rounded hover:bg-slate-100 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 text-emerald-700" /> Télécharger
                    Modele_Import_Clients.xlsx
                  </button>
                </div>

                <div className="p-3 bg-slate-50 border border-slate-200 rounded flex flex-col justify-between gap-2">
                  <div>
                    <div className="font-bold text-slate-900">3. Modèle Fournisseurs</div>
                    <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                      Nom_Fournisseur*, Contact, Telephone, WhatsApp, Ville, ICE, IF, RC,
                      Conditions_Paiement
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDownloadTemplate('SUPPLIERS')}
                    className="px-2.5 py-1.5 bg-white border border-slate-300 text-slate-800 font-medium rounded hover:bg-slate-100 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 text-emerald-700" /> Télécharger
                    Modele_Import_Fournisseurs.xlsx
                  </button>
                </div>

                <div className="p-3 bg-slate-50 border border-slate-200 rounded flex flex-col justify-between gap-2">
                  <div>
                    <div className="font-bold text-slate-900">4. Modèle Équipements & SAV</div>
                    <div className="text-[11px] text-slate-500 font-mono mt-0.5">
                      Nom_Client*, Type_Equipement*, Marque_Modele*, Numero_Serie*,
                      Prochaine_Echeance_SAV*, TDS_Brut_PPM, Pression_Bar
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDownloadTemplate('EQUIPMENTS_SAV')}
                    className="px-2.5 py-1.5 bg-white border border-slate-300 text-slate-800 font-medium rounded hover:bg-slate-100 inline-flex items-center justify-center gap-1.5 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5 text-emerald-700" /> Télécharger
                    Modele_Import_Equipements_SAV.xlsx
                  </button>
                </div>
              </div>
            </div>

            <div className="pt-4 border-t border-slate-200 space-y-3">
              <h3 className="text-sm font-bold text-slate-900">
                Assistant d&apos;Import Excel / CSV avec Validation Préalable (Règle 25)
              </h3>
              <p className="text-slate-600">
                Processus obligatoire : Lecture → Mapping automatique (Français / Technique) →
                Validation → Détection des erreurs & doublons → Aperçu → Transaction atomique.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={importEntityType}
                  onChange={(e) => setImportEntityType(e.target.value as ImportEntityType)}
                  className="px-3 py-1.5 border border-slate-300 rounded bg-white font-medium"
                >
                  <option value="PRODUCTS">1. Produits & Stock</option>
                  <option value="CUSTOMERS">2. Clients</option>
                  <option value="SUPPLIERS">3. Fournisseurs</option>
                  <option value="EQUIPMENTS_SAV">4. Équipements & Échéances SAV</option>
                </select>
                <label className="px-3 py-1.5 bg-[#0F172A] text-white rounded hover:bg-slate-800 cursor-pointer inline-flex items-center gap-1.5 font-medium">
                  <Upload className="w-3.5 h-3.5" /> Importer fichier .xlsx / .csv
                  <input
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    onChange={handleExcelFileSelect}
                    className="hidden"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => downloadExcelImportTemplate(importEntityType)}
                  className="px-3 py-1.5 border border-emerald-300 bg-emerald-50 text-emerald-900 rounded hover:bg-emerald-100 inline-flex items-center gap-1"
                >
                  <Download className="w-3.5 h-3.5" /> Modèle .xlsx correspondant
                </button>
                <button
                  type="button"
                  onClick={handleSimulateSampleImportValidation}
                  className="px-3 py-1.5 border border-blue-300 bg-blue-50 text-blue-900 rounded hover:bg-blue-100"
                >
                  Tester l&apos;assistant (1 valide + 1 erreur)
                </button>
              </div>

              {importReport && (
                <div className="p-3.5 bg-slate-50 border border-slate-300 rounded space-y-3">
                  <div className="font-semibold text-slate-900">
                    Rapport d&apos;Analyse Avant Import ({importReport.totalRows} lignes lues) :{' '}
                    <span className="text-emerald-700">
                      {importReport.validRowsCount} valide(s)
                    </span>{' '}
                    · <span className="text-red-700">{importReport.errorRowsCount} erreur(s)</span>
                  </div>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {importReport.rows.map((r) => (
                      <div
                        key={r.rowIndex}
                        className={`p-1.5 rounded border ${
                          r.valid
                            ? 'bg-emerald-50/60 border-emerald-200 text-emerald-900'
                            : 'bg-red-50 border-red-200 text-red-900'
                        }`}
                      >
                        Ligne #{r.rowIndex} :{' '}
                        {r.valid
                          ? `Prêt à importer (${String(r.parsedEntity.name)})`
                          : `ERREUR : ${r.errors.join(', ')}`}
                      </div>
                    ))}
                  </div>
                  <label className="flex items-center gap-2 text-slate-700">
                    <input
                      type="checkbox"
                      checked={allowSkipImportErrors}
                      onChange={(e) => setAllowSkipImportErrors(e.target.checked)}
                    />
                    Ignorer les lignes en erreur et importer uniquement les lignes valides (par
                    défaut : bloquer tout le lot en cas d&apos;erreur critique — Règle 25)
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={handleCommitImport}
                      className="px-4 py-1.5 bg-[#1D4ED8] text-white font-medium rounded"
                    >
                      Exécuter la Transaction d&apos;Import
                    </button>
                    <button
                      type="button"
                      onClick={() => setImportReport(null)}
                      className="px-3 py-1.5 border border-slate-300 rounded"
                    >
                      Annuler
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Restauration JSON vérifiée sous Code PIN Maître (Règle 26) */}
          <form
            onSubmit={handleRestoreBackup}
            className="bg-white border border-slate-200 rounded-lg p-5 space-y-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <Database className="w-4 h-4 text-amber-700" />
                  Restauration Vérifiée sous Code PIN Maître (Règle 26)
                </h2>
                <p className="text-slate-600 mt-1">
                  Vérifie la version du schéma, l&apos;absence d&apos;IDs dupliqués, les relations
                  clients/ventes et la chaîne des mouvements de stock avant de restaurer.
                </p>
              </div>
              <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded text-[11px] font-bold bg-amber-100 text-amber-800 border border-amber-300 shrink-0">
                <Lock className="w-3.5 h-3.5 text-amber-700" /> Protection PIN Maître
              </span>
            </div>

            <div className="p-3 bg-amber-50 border border-amber-200 rounded-md text-amber-900 text-xs flex items-start gap-2.5">
              <Lock className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <span className="font-bold">Opération Sensible — Code PIN Maître Strictement Requis</span>
                <p className="text-[11px] leading-relaxed text-amber-800">
                  La restauration remplace intégralement les collections de la base par le fichier de sauvegarde. Pour empêcher tout écrasement accidentel ou non autorisé, la saisie du <strong>Code PIN Maître</strong> d&apos;un Administrateur est obligatoire.
                </p>
              </div>
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Coller le contenu JSON de la sauvegarde ou charger un fichier .json
              </label>
              <input
                type="file"
                accept=".json"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (f) setRestoreJsonText(await f.text());
                }}
                className="mb-2 block text-xs"
              />
              <textarea
                rows={6}
                value={restoreJsonText}
                onChange={(e) => setRestoreJsonText(e.target.value)}
                placeholder='{"app": "ATLAS_SOFT_WATER", "schemaVersion": 3, "tables": { ... }}'
                className="w-full p-2.5 font-mono text-[11px] border border-slate-300 rounded"
              />
            </div>

            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Mot de passe de déchiffrement (uniquement si sauvegarde chiffrée AES-GCM)
              </label>
              <input
                type="password"
                value={restorePassphrase}
                onChange={(e) => setRestorePassphrase(e.target.value)}
                placeholder="Laisser vide si la sauvegarde n'est pas chiffrée"
                className="w-full px-3 py-1.5 border border-slate-300 rounded"
              />
            </div>

            <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-md space-y-2">
              <label className="block font-semibold text-slate-800 flex items-center justify-between">
                <span className="flex items-center gap-1.5">
                  <KeyRound className="w-4 h-4 text-[#D9A95B]" />
                  Code PIN Maître Administrateur (Obligatoire) *
                </span>
                {company.isDemoData && (
                  <span className="text-[10px] text-amber-700 font-normal">
                    Mode Démo : PIN Maître = <strong>135790</strong>
                  </span>
                )}
              </label>
              <input
                type="password"
                required
                value={restoreMasterPin}
                onChange={(e) => {
                  setRestoreMasterPin(e.target.value);
                  if (restoreMasterPinError) setRestoreMasterPinError(null);
                }}
                placeholder="Saisissez le Code PIN Maître Administrateur (ex: 135790)..."
                className="w-full px-3.5 py-2 font-mono text-sm border border-slate-300 rounded-md bg-white focus:outline-none focus:border-amber-600"
              />
              <p className="text-[11px] text-slate-500">
                Seul le Code PIN Maître d&apos;un compte Administrateur autorise le déverrouillage de la restauration.
              </p>
            </div>

            {restoreMasterPinError && (
              <div className="p-3 bg-rose-50 border border-rose-300 rounded text-rose-900 font-medium flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
                <span>{restoreMasterPinError}</span>
              </div>
            )}

            <label className="flex items-start gap-2 cursor-pointer select-none text-[11px] text-slate-700">
              <input
                type="checkbox"
                checked={restoreConfirmedCheck}
                onChange={(e) => setRestoreConfirmedCheck(e.target.checked)}
                className="mt-0.5 rounded text-amber-600 focus:ring-amber-500"
              />
              <span>
                Je confirme vouloir remplacer l&apos;intégralité des données actuelles par cette sauvegarde (une sauvegarde de secours automatique sera créée en IndexedDB avant écrasement).
              </span>
            </label>

            <button
              type="submit"
              disabled={isRestoring || !restoreJsonText.trim() || !restoreMasterPin.trim() || !restoreConfirmedCheck}
              className="px-4 py-2.5 bg-amber-700 hover:bg-amber-800 text-white font-semibold rounded shadow-xs disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2 transition-colors cursor-pointer"
            >
              <Lock className="w-4 h-4 text-[#D9A95B]" />
              <span>
                {isRestoring
                  ? 'Vérification intégrité & Restauration en cours...'
                  : "Vérifier l'Intégrité sous PIN Maître & Restaurer"}
              </span>
            </button>
          </form>
        </div>
      )}

      {subTab === 'DIAGNOSTIC' && (
        <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-slate-900">
                Diagnostic & Intégrité de la Base de Données IndexedDB (Section 42)
              </h2>
              <p className="text-slate-500">
                Contrôle : IDs dupliqués, références cassées, chaîne stockBefore + qty = stockAfter,
                cohérence paiements/factures, créances clients et dettes fournisseurs.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => runDatabaseDiagnostic().then(setDiagReport)}
                className="px-3 py-1.5 border border-slate-300 rounded hover:bg-slate-50 inline-flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Relancer l&apos;analyse
              </button>
              <button
                type="button"
                onClick={async () => {
                  const res = await executeAutoRepairDatabase();
                  setDiagReport(res.postReport);
                  onChanged();
                  setFeedback({
                    type: 'success',
                    msg: `Réparation automatique sécurisée terminée (${res.repairedCount} anomalie(s) corrigée(s) après backup d'urgence).`,
                  });
                }}
                className="px-4 py-1.5 bg-[#0F172A] text-white font-medium rounded hover:bg-slate-800 inline-flex items-center gap-1.5"
              >
                <Wrench className="w-3.5 h-3.5" /> Réparation Automatique Sécurisée
              </button>
            </div>
          </div>

          {diagReport && (
            <div className="space-y-3">
              <div
                className={`p-4 rounded-md border flex items-center justify-between ${
                  diagReport.healthy
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                    : 'bg-amber-50 border-amber-300 text-amber-900'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  {diagReport.healthy ? (
                    <CheckCircle2 className="w-5 h-5 text-emerald-700" />
                  ) : (
                    <AlertTriangle className="w-5 h-5 text-amber-700" />
                  )}
                  <div>
                    <div className="font-bold text-sm">
                      {diagReport.healthy
                        ? 'Base de données 100% intègre et cohérente'
                        : `${diagReport.issues.length} anomalie(s) détectée(s)`}
                    </div>
                    <div className="font-mono text-[11px]">
                      Version schéma : v{diagReport.schemaVersion} · Entités inspectées :{' '}
                      {diagReport.totalEntitiesChecked}
                    </div>
                  </div>
                </div>
              </div>

              {diagReport.issues.length > 0 && (
                <div className="divide-y divide-slate-100 border border-slate-200 rounded">
                  {diagReport.issues.map((iss) => (
                    <div key={iss.id} className="p-3 flex items-center justify-between">
                      <div>
                        <span className="font-mono font-bold text-red-700 mr-2">
                          [{iss.category}]
                        </span>
                        <span>{iss.description}</span>
                      </div>
                      <span className="font-mono text-[11px] text-slate-500">
                        {iss.autoRepairSafe ? 'Réparable auto' : 'Inspection manuelle'}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {subTab === 'TESTS' && (
        <div className="space-y-6 text-xs">
          {/* Exécuteur des 18 Tests Automatisés Obligatoires */}
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5 text-[#1D4ED8]" />
                  Suite de Tests Automatisés des Contradictions Métier (Bac à sable isolé)
                </h2>
                <p className="text-slate-500">
                  Exécute en conditions réelles les 17 scénarios transactionnels obligatoires (Stock
                  insuffisant, Stock négatif, Annulation vente payée, Retour client, Trop-perçu,
                  Réception partielle, Inventaire sur stock négatif, Multi-TVA, Fuseau Casablanca,
                  Concurrence numérotation, Rollback atomique, Import erroné, Restauration).
                </p>
              </div>
              <button
                type="button"
                disabled={runningTests}
                onClick={handleRunTests}
                className="px-5 py-2.5 bg-[#1D4ED8] text-white font-semibold rounded-md hover:bg-blue-800 disabled:opacity-50 inline-flex items-center gap-2"
              >
                <Play className="w-4 h-4" />
                {runningTests
                  ? 'Exécution des transactions de test...'
                  : 'Lancer les 17 Tests Automatisés'}
              </button>
            </div>

            {testSuiteReport && (
              <div className="space-y-3">
                <div className="p-3.5 bg-slate-900 text-white rounded-md flex items-center justify-between font-mono">
                  <span>
                    Résultat : {testSuiteReport.passedCount} / {testSuiteReport.totalTests} TESTS
                    RÉUSSIS ({testSuiteReport.failedCount} échec)
                  </span>
                  <span>Durée totale : {testSuiteReport.totalDurationMs} ms</span>
                </div>

                <div className="divide-y divide-slate-100 border border-slate-200 rounded-md">
                  {testSuiteReport.results.map((r) => (
                    <div
                      key={r.id}
                      className="p-3 flex flex-wrap items-center justify-between gap-2"
                    >
                      <div className="space-y-0.5">
                        <div className="font-semibold text-slate-900 flex items-center gap-2">
                          <span
                            className={`font-mono px-1.5 py-0.5 rounded text-[11px] ${
                              r.passed
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {r.passed ? 'PASS' : 'FAIL'}
                          </span>
                          <span className="font-mono text-slate-500">[{r.ruleNumber}]</span>
                          <span>{r.name}</span>
                        </div>
                        <div className="text-slate-600 pl-14">{r.assertionSummary}</div>
                        {r.errorDetails && (
                          <div className="text-red-700 font-mono pl-14">{r.errorDetails}</div>
                        )}
                      </div>
                      <span className="font-mono-tabular text-slate-400">{r.durationMs} ms</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Référentiel des 26 Règles d'Arbitrage documentées */}
          <div className="bg-white border border-slate-200 rounded-lg p-5 space-y-3">
            <h2 className="text-base font-bold text-slate-900">
              Catalogue Explicite des Règles d&apos;Arbitrage Métier Centralisées
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {Object.values(ARBITRAGE_RULES_CATALOG).map((rule) => (
                <div key={rule.ruleCode} className="p-3 border border-slate-200 rounded space-y-1">
                  <div className="flex items-center justify-between font-mono text-[11px]">
                    <span className="font-bold text-[#1D4ED8]">{rule.ruleCode}</span>
                    <span className="text-slate-500">Priorité : {rule.priorityApplied}</span>
                  </div>
                  <div className="font-semibold text-slate-900">{rule.title}</div>
                  <div className="text-[11px] text-slate-600">
                    Conflit arbitré : {rule.conflictingRules[0]} vs {rule.conflictingRules[1]}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    Modules : {rule.impactedModules.join(' · ')}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {subTab === 'AUDIT' && (
        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden text-xs">
          <div className="px-4 py-3 border-b border-slate-200 font-bold text-slate-900">
            Journal d&apos;Audit Inaltérable & Arbitrages Enregistrés ({auditLogs.length} derniers
            événements)
          </div>
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-left text-slate-600">
                <th className="py-2.5 px-4">Horodatage (Maroc)</th>
                <th className="py-2.5 px-4">Utilisateur</th>
                <th className="py-2.5 px-4">Action</th>
                <th className="py-2.5 px-4">Règle d&apos;Arbitrage</th>
                <th className="py-2.5 px-4">Résumé de l&apos;opération</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {auditLogs.map((log) => (
                <tr key={log.id}>
                  <td className="py-2.5 px-4 font-mono-tabular whitespace-nowrap">
                    {formatMoroccoDateTime(log.timestamp)}
                  </td>
                  <td className="py-2.5 px-4">
                    {log.userName} <span className="font-mono text-[10px]">[{log.userRole}]</span>
                  </td>
                  <td className="py-2.5 px-4 font-mono font-semibold">{log.action}</td>
                  <td className="py-2.5 px-4 font-mono text-[11px] text-[#1D4ED8]">
                    {log.contradictionArbitrated || '—'}
                  </td>
                  <td className="py-2.5 px-4 text-slate-700">{log.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {subTab === 'SETTINGS' && currentProfile?.role !== 'ADMIN' && (
        <div className="bg-white border border-rose-300 rounded-lg p-8 max-w-xl mx-auto text-center space-y-3 text-xs">
          <div className="w-12 h-12 rounded-full bg-rose-100 text-rose-700 flex items-center justify-center mx-auto">
            <Lock className="w-6 h-6" />
          </div>
          <h2 className="text-base font-bold text-slate-900">
            Accès Interdit — Réservé à l&apos;Administrateur
          </h2>
          <p className="text-slate-600 leading-relaxed">
            L&apos;utilisateur actif (<strong>{currentProfile?.name}</strong> —{' '}
            <code className="font-mono">[{currentProfile?.role}]</code>) ne dispose pas des droits
            d&apos;accès aux <strong>Paramètres</strong>. Seul un Administrateur muni du{' '}
            <strong>Code PIN Maître</strong> peut accéder à cette section.
          </p>
        </div>
      )}

      {subTab === 'SETTINGS' && currentProfile?.role === 'ADMIN' && !masterPinUnlocked && (
        <div className="bg-white border border-slate-200 rounded-lg p-8 max-w-md mx-auto space-y-5 text-xs shadow-xs">
          <div className="flex items-start gap-3.5">
            <div className="w-11 h-11 rounded-lg bg-[#0F172A] text-[#D9A95B] flex items-center justify-center shrink-0">
              <KeyRound className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h2 className="text-base font-bold text-slate-900">
                Code PIN Maître Requis — Accès aux Paramètres
              </h2>
              <p className="text-slate-600 leading-relaxed">
                Pour protéger la configuration de l&apos;entreprise, la gestion des utilisateurs et
                la sécurité après le 1er démarrage de paramétrage, veuillez saisir le{' '}
                <strong>Code PIN Maître</strong> de l&apos;Administrateur (
                <strong>{currentProfile.name}</strong>).
              </p>
            </div>
          </div>

          <form onSubmit={handleVerifyMasterPinForSettings} className="space-y-4">
            <div>
              <label className="block font-semibold text-slate-700 mb-1.5">
                Code PIN Maître Administrateur *
              </label>
              <input
                type="password"
                autoFocus
                required
                value={masterPinInput}
                onChange={(e) => {
                  setMasterPinInput(e.target.value);
                  if (masterPinError) setMasterPinError(null);
                }}
                placeholder="Saisissez votre Code PIN Maître..."
                className="w-full px-3.5 py-2.5 font-mono text-sm border border-slate-300 rounded-md focus:outline-none focus:border-[#1D4ED8]"
              />
              {company.isDemoData && (
                <div className="text-[11px] text-slate-500 font-mono mt-1.5">
                  Mode Démonstration : Code PIN Maître par défaut = <strong>135790</strong>
                </div>
              )}
            </div>

            {masterPinError && (
              <div className="p-3 bg-rose-50 border border-rose-300 rounded text-rose-900 font-medium flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
                <span>{masterPinError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={verifyingMasterPin}
              className="w-full py-2.5 bg-[#0F172A] hover:bg-slate-800 text-white font-semibold rounded-md transition-colors flex items-center justify-center gap-2"
            >
              <Lock className="w-4 h-4 text-[#D9A95B]" />
              {verifyingMasterPin
                ? 'Vérification du Code PIN Maître...'
                : 'Déverrouiller les Paramètres'}
            </button>
          </form>

          <div className="pt-3 border-t border-slate-200 flex items-center justify-center">
            <button
              type="button"
              onClick={() => {
                setShowResetModal(true);
                setResetMasterPin('');
                setResetError(null);
                setResetMode('ZERO_OPERATIONS');
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/40 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-700 rounded-md font-semibold text-xs transition-colors shadow-2xs"
              title="Remise à zéro de l'application sous Code PIN Maître"
            >
              <Trash2 className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
              <span>Remise à 0 de l&apos;app (PIN Maître)</span>
            </button>
          </div>
        </div>
      )}

      {subTab === 'SETTINGS' && currentProfile?.role === 'ADMIN' && masterPinUnlocked && (
        <form
          onSubmit={handleSaveSettings}
          className="bg-white border border-slate-200 rounded-lg p-6 space-y-6 text-xs"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
            <h2 className="text-base font-bold text-slate-900">
              Paramètres Généraux (Utilisateurs, Logo, Filigrane PDF, Entreprise, Fiscalité, POS & Sécurité)
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowResetModal(true);
                  setResetMasterPin('');
                  setResetError(null);
                  setResetMode('ZERO_OPERATIONS');
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-rose-50 hover:bg-rose-100 dark:bg-rose-950/40 dark:hover:bg-rose-900/60 text-rose-700 dark:text-rose-300 border border-rose-300 dark:border-rose-700 rounded-md font-semibold text-xs transition-colors shadow-2xs"
                title="Remise à zéro de l'application sous Code PIN Maître"
              >
                <Trash2 className="w-3.5 h-3.5 text-rose-600 dark:text-rose-400" />
                <span>Remise à 0 de l&apos;app (PIN Maître)</span>
              </button>
              {company.isDemoData && (
                <button
                  type="button"
                  onClick={onOpenWizard}
                  className="px-3 py-1.5 border border-slate-300 rounded hover:bg-slate-50 font-medium"
                >
                  Assistant 1er Démarrage / Réinitialiser Base
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMasterPinUnlocked(false);
                  setMasterPinInput('');
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 text-white rounded hover:bg-slate-800 font-medium"
              >
                <Lock className="w-3.5 h-3.5 text-[#D9A95B]" />
                Verrouiller les Paramètres
              </button>
            </div>
          </div>

          {/* Bloc Gestion des Utilisateurs & Profils Opérateurs */}
          <div className="p-5 bg-slate-50 border border-slate-200 rounded-lg space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <Users className="w-4 h-4 text-[#1D4ED8]" />
                  Gestion des Utilisateurs & Profils Opérateurs ({userProfiles.length})
                </h3>
                <p className="text-slate-600 mt-0.5">
                  Ajoutez, renommez, modifiez le rôle ou le code PIN, basculez d&apos;opérateur actif
                  ou supprimez les profils qui apparaissent en bas du menu latéral et sur
                  l&apos;écran de verrouillage.
                </p>
              </div>
              <button
                type="button"
                onClick={() =>
                  setEditingUserForm({
                    name: '',
                    role: 'SELLER',
                    pin: '2468',
                    masterPin: '135790',
                    active: true,
                  })
                }
                className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#0F172A] text-white font-semibold rounded-md hover:bg-slate-800 shadow-xs"
              >
                <UserPlus className="w-3.5 h-3.5 text-amber-400" />
                + Ajouter un Utilisateur / Opérateur
              </button>
            </div>

            {editingUserForm && (
              <div className="p-4 bg-white border-2 border-[#1D4ED8] rounded-lg space-y-3 shadow-xs">
                <div className="flex items-center justify-between border-b border-slate-200 pb-2">
                  <div className="font-bold text-slate-900 text-xs">
                    {editingUserForm.id
                      ? `Modifier l'utilisateur : ${editingUserForm.name}`
                      : 'Créer un nouvel utilisateur / opérateur'}
                  </div>
                  <button
                    type="button"
                    onClick={() => setEditingUserForm(null)}
                    className="text-slate-500 hover:text-slate-800 font-medium"
                  >
                    Fermer ✕
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                  <div className="md:col-span-2">
                    <label className="block font-semibold text-slate-700 mb-1">
                      Nom complet & Fonction *
                    </label>
                    <input
                      type="text"
                      value={editingUserForm.name}
                      onChange={(e) =>
                        setEditingUserForm({ ...editingUserForm, name: e.target.value })
                      }
                      placeholder="Ex: Mohammed Alami (Dirigeant)"
                      className="w-full px-3 py-2 border border-slate-300 rounded font-medium text-slate-900"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-slate-700 mb-1">
                      Rôle & Accès *
                    </label>
                    <select
                      value={editingUserForm.role}
                      onChange={(e) =>
                        setEditingUserForm({
                          ...editingUserForm,
                          role: e.target.value as UserRole,
                        })
                      }
                      className="w-full px-3 py-2 border border-slate-300 rounded bg-white font-medium text-slate-900"
                    >
                      <option value="ADMIN">ADMIN — Dirigeant / Administrateur</option>
                      <option value="MANAGER">MANAGER — Gérant / Responsable</option>
                      <option value="SELLER">SELLER — Vendeur / Caissier POS</option>
                      <option value="TECHNICIAN">TECHNICIAN — Technicien SAV</option>
                      <option value="ACCOUNTANT">ACCOUNTANT — Comptabilité</option>
                    </select>
                  </div>

                  <div className="flex items-end pb-1.5">
                    <label className="flex items-center gap-2 cursor-pointer font-semibold text-slate-800">
                      <input
                        type="checkbox"
                        checked={editingUserForm.active}
                        onChange={(e) =>
                          setEditingUserForm({ ...editingUserForm, active: e.target.checked })
                        }
                      />
                      Profil Actif (Autorisé à se connecter)
                    </label>
                  </div>

                  <div className="md:col-span-2">
                    <label className="block font-semibold text-slate-700 mb-1">
                      {editingUserForm.id
                        ? 'Nouveau Code PIN Personnel (laisser vide pour ne pas changer)'
                        : 'Code PIN Personnel (min. 4 caractères) *'}
                    </label>
                    <input
                      type="password"
                      value={editingUserForm.pin}
                      onChange={(e) =>
                        setEditingUserForm({ ...editingUserForm, pin: e.target.value })
                      }
                      placeholder={
                        editingUserForm.id
                          ? 'Laisser vide pour conserver le PIN actuel'
                          : 'Ex: 2468'
                      }
                      className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="block font-semibold text-slate-700 mb-1">
                      {editingUserForm.id
                        ? 'Nouveau Code PIN Maître de Secours (laisser vide pour conserver)'
                        : 'Code PIN Maître de Secours (min. 4 caractères) *'}
                    </label>
                    <input
                      type="password"
                      value={editingUserForm.masterPin}
                      onChange={(e) =>
                        setEditingUserForm({ ...editingUserForm, masterPin: e.target.value })
                      }
                      placeholder={
                        editingUserForm.id
                          ? 'Laisser vide pour conserver le PIN Maître actuel'
                          : 'Ex: 135790'
                      }
                      className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
                    />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={() => setEditingUserForm(null)}
                    className="px-3 py-1.5 border border-slate-300 rounded bg-white hover:bg-slate-50"
                  >
                    Annuler
                  </button>
                  <button
                    type="button"
                    onClick={handleSaveUserProfile}
                    className="px-4 py-1.5 bg-[#1D4ED8] text-white font-semibold rounded hover:bg-blue-800"
                  >
                    {editingUserForm.id
                      ? 'Enregistrer les modifications de cet utilisateur'
                      : 'Créer cet utilisateur'}
                  </button>
                </div>
              </div>
            )}

            <div className="bg-white border border-slate-200 rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="bg-slate-100 border-b border-slate-200 text-left text-slate-600">
                    <th className="py-2.5 px-3">Nom de l&apos;Utilisateur / Opérateur</th>
                    <th className="py-2.5 px-3">Rôle</th>
                    <th className="py-2.5 px-3">Statut</th>
                    <th className="py-2.5 px-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {userProfiles.map((u) => {
                    const isCurrent = currentProfile?.id === u.id;
                    return (
                      <tr key={u.id} className={isCurrent ? 'bg-blue-50/40' : 'hover:bg-slate-50'}>
                        <td className="py-2.5 px-3 font-semibold text-slate-900">
                          <div className="flex items-center gap-2">
                            <span>{u.name}</span>
                            {isCurrent && (
                              <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-mono text-[10px] font-bold">
                                SESSION ACTIVE
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 font-mono font-bold text-slate-700">
                          [{u.role}]
                        </td>
                        <td className="py-2.5 px-3">
                          {u.active !== false ? (
                            <span className="text-emerald-700 font-medium">Actif</span>
                          ) : (
                            <span className="text-slate-400">Désactivé</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right space-x-1.5 whitespace-nowrap">
                          {!isCurrent && u.active !== false && onSelectProfile && (
                            <button
                              type="button"
                              onClick={() => {
                                onSelectProfile(u);
                                setFeedback({
                                  type: 'success',
                                  msg: `Session active basculée sur « ${u.name} » [${u.role}].`,
                                });
                              }}
                              className="px-2.5 py-1 bg-emerald-50 border border-emerald-300 text-emerald-900 rounded hover:bg-emerald-100 font-medium"
                            >
                              Activer ce profil
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() =>
                              setEditingUserForm({
                                id: u.id,
                                name: u.name,
                                role: u.role,
                                pin: '',
                                masterPin: '',
                                active: u.active !== false,
                              })
                            }
                            className="px-2.5 py-1 bg-blue-50 border border-blue-300 text-blue-900 rounded hover:bg-blue-100 font-medium"
                          >
                            Modifier (Nom / Rôle / PIN)
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteUserProfile(u)}
                            className="px-2.5 py-1 bg-rose-50 border border-rose-300 text-rose-900 rounded hover:bg-rose-100 font-medium"
                          >
                            Supprimer
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Bloc Logo de l'Entreprise */}
          <div className="p-4 bg-slate-50 border border-slate-200 rounded-lg flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {companyForm.logoDataUrl ? (
                <div className="w-24 h-16 rounded-md bg-white border border-slate-300 p-1.5 flex items-center justify-center shrink-0">
                  <img
                    src={companyForm.logoDataUrl}
                    alt={companyForm.name}
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
              ) : (
                <div className="w-16 h-16 rounded-md bg-[#0F172A] text-[#D9A95B] border border-amber-700 flex items-center justify-center font-display text-2xl font-bold shrink-0">
                  {(companyForm.logoText || companyForm.name || 'A')
                    .trim()
                    .slice(0, 3)
                    .toUpperCase()}
                </div>
              )}
              <div className="space-y-1">
                <div className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                  <ImageIcon className="w-4 h-4 text-[#1D4ED8]" />
                  Logo de l&apos;Entreprise (Interface Application uniquement)
                </div>
                <p className="text-slate-600 max-w-xl">
                  Ce logo s&apos;affiche uniquement dans la barre supérieure et le menu de
                  l&apos;application. Conformément à votre configuration pour papier préimprimé, il
                  ne figure jamais sur les documents à imprimer ou à télécharger.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#1D4ED8] text-white font-semibold rounded-md hover:bg-blue-800">
                <Upload className="w-3.5 h-3.5" />
                {companyForm.logoDataUrl ? 'Changer le Logo' : 'Ajouter un Logo (PNG, JPG, SVG)'}
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleUploadCompanyLogo}
                  className="hidden"
                />
              </label>
              {companyForm.logoDataUrl && (
                <button
                  type="button"
                  onClick={handleRemoveCompanyLogo}
                  className="inline-flex items-center gap-1 px-3 py-2 bg-rose-50 border border-rose-300 text-rose-900 font-medium rounded-md hover:bg-rose-100"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Supprimer le logo
                </button>
              )}
            </div>
          </div>

          {/* Bloc Filigrane PDF (Facultatif) & Structure En-tête / Pied de page des Documents à Imprimer */}
          <div className="p-5 bg-amber-50/40 border border-amber-200 rounded-lg space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="space-y-1 max-w-2xl">
                <div className="text-sm font-bold text-slate-900 flex items-center gap-2">
                  <FileText className="w-4 h-4 text-amber-700" />
                  Filigrane PDF (Facultatif) & En-tête / Pied de Page des Documents à Imprimer
                </div>
                <p className="text-slate-600 leading-relaxed">
                  Sur tous les documents à imprimer ou télécharger :{' '}
                  <strong>l&apos;en-tête de page</strong> affiche le nom de l&apos;entreprise et les
                  mentions y attachées, tandis que <strong>le pied de page</strong> regroupe
                  l&apos;adresse, les coordonnées (Tél, WhatsApp, Email) et les identifiants légaux.
                  Vous pouvez également télécharger ci-dessous un <strong>filigrane PDF</strong> (ou
                  image) en option, ou garder vos documents sans filigrane.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <label className="cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 bg-[#0F172A] text-white font-semibold rounded-md hover:bg-slate-800 shadow-xs">
                  <Upload className="w-3.5 h-3.5 text-amber-400" />
                  {companyForm.watermarkDataUrl
                    ? 'Remplacer le Filigrane (.PDF / Image)'
                    : 'Télécharger un Filigrane PDF (.pdf, .png, .jpg)'}
                  <input
                    type="file"
                    accept=".pdf,application/pdf,image/*"
                    onChange={handleUploadWatermarkFile}
                    className="hidden"
                  />
                </label>

                <button
                  type="button"
                  onClick={handleLoadDefaultWatermark}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-white border border-slate-300 text-slate-800 font-medium rounded-md hover:bg-slate-100"
                >
                  <FileText className="w-3.5 h-3.5 text-sky-600" />
                  Modèle Filigrane « Eau Saine »
                </button>

                {companyForm.watermarkDataUrl && (
                  <button
                    type="button"
                    onClick={handleRemoveWatermark}
                    className="inline-flex items-center gap-1 px-3 py-2 bg-rose-50 border border-rose-300 text-rose-900 font-medium rounded-md hover:bg-rose-100"
                  >
                    <Trash2 className="w-3.5 h-3.5" /> Sans filigrane (Supprimer)
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 pt-2 border-t border-amber-200/70">
              <div className="lg:col-span-2 space-y-3">
                <div>
                  <label className="block font-semibold text-slate-800 mb-1">
                    Mentions attachées au nom de l&apos;entreprise (En-tête de page des documents)
                  </label>
                  <input
                    type="text"
                    value={companyForm.headerMentions ?? ''}
                    onChange={(e) =>
                      setCompanyForm({ ...companyForm, headerMentions: e.target.value })
                    }
                    placeholder="Ex: Traitement de l'eau, Filtration et Purificateur d'eau domestique et industriel"
                    className="w-full px-3 py-2 bg-white border border-slate-300 rounded font-medium text-slate-900"
                  />
                  <span className="text-[11px] text-slate-500 mt-0.5 block">
                    Apparaît juste sous le nom « {companyForm.name} » dans l&apos;en-tête de tous
                    vos documents imprimables.
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="flex items-start gap-2.5 p-3 bg-white border border-slate-200 rounded-md cursor-pointer">
                    <input
                      type="checkbox"
                      checked={
                        Boolean(companyForm.watermarkDataUrl) &&
                        companyForm.watermarkEnabled !== false
                      }
                      disabled={!companyForm.watermarkDataUrl}
                      onChange={(e) => handleToggleWatermarkEnabled(e.target.checked)}
                      className="mt-0.5"
                    />
                    <div>
                      <div className="font-semibold text-slate-900">
                        Afficher le filigrane sur les documents à imprimer (Facultatif)
                      </div>
                      <div className="text-[11px] text-slate-500">
                        {companyForm.watermarkDataUrl
                          ? `Fichier actif : ${companyForm.watermarkFileName || 'Filigrane A4'}. Décochez pour imprimer sans filigrane.`
                          : 'Aucun filigrane chargé (impression standard sans filigrane).'}
                      </div>
                    </div>
                  </label>

                  <div className="p-3 bg-white border border-slate-200 rounded-md space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-slate-800">
                        Intensité / Opacité du filigrane
                      </span>
                      <span className="font-mono font-bold text-slate-900">
                        {companyForm.watermarkOpacity ?? 100}%
                      </span>
                    </div>
                    <input
                      type="range"
                      min={10}
                      max={100}
                      step={5}
                      disabled={
                        !companyForm.watermarkDataUrl || companyForm.watermarkEnabled === false
                      }
                      value={companyForm.watermarkOpacity ?? 100}
                      onChange={(e) =>
                        setCompanyForm({
                          ...companyForm,
                          watermarkOpacity: Number(e.target.value),
                        })
                      }
                      className="w-full accent-[#0F172A]"
                    />
                    <div className="text-[11px] text-slate-500 pt-1 border-t border-slate-100 flex items-start gap-1.5">
                      <span className="text-emerald-600 font-bold">✓</span>
                      <span>
                        <strong>Règle d&apos;impression :</strong> lorsque le filigrane est actif, l&apos;en-tête (Nom) et le pied de page (Adresse/ICE) sont masqués automatiquement pour laisser place au papier à en-tête, et le document est centré verticalement sur la feuille A4.
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Aperçu miniature A4 temps réel En-tête + Filigrane + Pied de page */}
              <div className="bg-white border border-slate-300 rounded-md p-3 flex flex-col justify-between relative overflow-hidden min-h-[190px] shadow-2xs">
                {companyForm.watermarkDataUrl && companyForm.watermarkEnabled !== false && (
                  <img
                    src={companyForm.watermarkDataUrl}
                    alt="Aperçu Filigrane"
                    style={{ opacity: (companyForm.watermarkOpacity ?? 100) / 100 }}
                    className="absolute inset-0 w-full h-full object-fill pointer-events-none"
                  />
                )}
                <div className="relative z-10 border-b border-slate-300 pb-1 bg-white/80 rounded-t px-1">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-slate-900 text-white">
                      Aperçu Page A4
                    </span>
                    <span className="text-[10px] font-mono font-semibold text-slate-700">
                      {companyForm.watermarkDataUrl && companyForm.watermarkEnabled !== false
                        ? 'Avec Filigrane (En-tête & Bas masqués)'
                        : 'Sans Filigrane (Standard)'}
                    </span>
                  </div>
                  {(!companyForm.watermarkDataUrl || companyForm.watermarkEnabled === false) && (
                    <div className="mt-1">
                      <div className="font-display font-bold text-sm text-slate-900 leading-tight">
                        {companyForm.name || 'Nom Entreprise'}
                      </div>
                      <div className="text-[9px] font-semibold text-amber-800 uppercase truncate">
                        {companyForm.headerMentions ||
                          "Traitement de l'eau, Filtration et Purificateur d'eau domestique et industriel"}
                      </div>
                    </div>
                  )}
                </div>

                <div className="relative z-10 my-auto text-center text-[10px] text-slate-700 font-semibold bg-white/75 rounded py-2 px-3 border border-slate-200/80 mx-1">
                  {companyForm.watermarkDataUrl && companyForm.watermarkEnabled !== false
                    ? '✦ Impression centrée verticalement sur la feuille A4 (Dégagement haut & bas)'
                    : '[ Corps du document : Facture / Devis / BL / État ]'}
                </div>

                {(!companyForm.watermarkDataUrl || companyForm.watermarkEnabled === false) && (
                  <div className="relative z-10 border-t border-slate-800 pt-1.5 text-center bg-white/85 text-[9px] text-slate-700 leading-tight rounded-b">
                    <div className="font-bold text-slate-900 truncate">
                      {companyForm.address} — {companyForm.city} · Tél : {companyForm.phone}
                    </div>
                    <div className="font-mono text-[8.5px] text-slate-600 truncate">
                      ICE : {companyForm.ice} · IF : {companyForm.ifNumber} · RC : {companyForm.rc}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block font-medium text-slate-700 mb-1">Nom commercial</label>
              <input
                type="text"
                value={companyForm.name}
                onChange={(e) => setCompanyForm({ ...companyForm, name: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Raison sociale</label>
              <input
                type="text"
                value={companyForm.legalName}
                onChange={(e) => setCompanyForm({ ...companyForm, legalName: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Initiales Monogramme (si pas de logo image)
              </label>
              <input
                type="text"
                maxLength={4}
                value={companyForm.logoText}
                onChange={(e) => setCompanyForm({ ...companyForm, logoText: e.target.value })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">ICE</label>
              <input
                type="text"
                value={companyForm.ice}
                onChange={(e) => setCompanyForm({ ...companyForm, ice: e.target.value })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Identifiant Fiscal (IF)</label>
              <input
                type="text"
                value={companyForm.ifNumber}
                onChange={(e) => setCompanyForm({ ...companyForm, ifNumber: e.target.value })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Registre de Commerce (RC)</label>
              <input
                type="text"
                value={companyForm.rc}
                onChange={(e) => setCompanyForm({ ...companyForm, rc: e.target.value })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Téléphone</label>
              <input
                type="text"
                value={companyForm.phone}
                onChange={(e) => setCompanyForm({ ...companyForm, phone: e.target.value })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">WhatsApp</label>
              <input
                type="text"
                value={companyForm.whatsapp}
                onChange={(e) => setCompanyForm({ ...companyForm, whatsapp: e.target.value })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Ville</label>
              <input
                type="text"
                value={companyForm.city}
                onChange={(e) => setCompanyForm({ ...companyForm, city: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block font-medium text-slate-700 mb-1">Adresse complète</label>
              <input
                type="text"
                value={companyForm.address}
                onChange={(e) => setCompanyForm({ ...companyForm, address: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Email</label>
              <input
                type="email"
                value={companyForm.email}
                onChange={(e) => setCompanyForm({ ...companyForm, email: e.target.value })}
                className="w-full px-3 py-2 border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">Patente</label>
              <input
                type="text"
                value={companyForm.patente}
                onChange={(e) => setCompanyForm({ ...companyForm, patente: e.target.value })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">CNSS</label>
              <input
                type="text"
                value={companyForm.cnss}
                onChange={(e) => setCompanyForm({ ...companyForm, cnss: e.target.value })}
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">RIB Bancaire (Optionnel)</label>
              <input
                type="text"
                value={companyForm.rib ?? ''}
                onChange={(e) => setCompanyForm({ ...companyForm, rib: e.target.value })}
                placeholder="Ex: 007 780 0001234567890123 45"
                className="w-full px-3 py-2 font-mono border border-slate-300 rounded"
              />
            </div>
            <div className="md:col-span-3 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Conditions de règlement (Pied de page)
                </label>
                <input
                  type="text"
                  value={companyForm.paymentTerms}
                  onChange={(e) => setCompanyForm({ ...companyForm, paymentTerms: e.target.value })}
                  className="w-full px-3 py-2 border border-slate-300 rounded"
                />
              </div>
              <div>
                <label className="block font-medium text-slate-700 mb-1">
                  Mentions légales & Garantie (Pied de page)
                </label>
                <input
                  type="text"
                  value={companyForm.legalMentions}
                  onChange={(e) =>
                    setCompanyForm({ ...companyForm, legalMentions: e.target.value })
                  }
                  className="w-full px-3 py-2 border border-slate-300 rounded"
                />
              </div>
            </div>
          </div>

          <div className="border-t border-slate-200 pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="flex items-start gap-2.5 p-3 border border-slate-200 rounded bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={settingsForm.allowNegativeStock}
                onChange={(e) =>
                  setSettingsForm({ ...settingsForm, allowNegativeStock: e.target.checked })
                }
                className="mt-0.5"
              />
              <div>
                <div className="font-semibold text-slate-900">
                  Autoriser la vente avec stock négatif (Règle 1)
                </div>
                <div className="text-slate-500">
                  Désactivé par défaut. Si activé, toute vente faisant passer le stock sous zéro est
                  automatiquement enregistrée dans le journal d&apos;audit.
                </div>
              </div>
            </label>

            <label className="flex items-start gap-2.5 p-3 border border-slate-200 rounded bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={settingsForm.allowOverpayment}
                onChange={(e) =>
                  setSettingsForm({ ...settingsForm, allowOverpayment: e.target.checked })
                }
                className="mt-0.5"
              />
              <div>
                <div className="font-semibold text-slate-900">
                  Autoriser les trop-perçus clients avec génération d&apos;avoir/crédit (Règle 19)
                </div>
                <div className="text-slate-500">
                  Désactivé par défaut. Si activé, un paiement supérieur au solde dû peut être
                  affecté en crédit client après confirmation.
                </div>
              </div>
            </label>
          </div>

          <div className="border-t border-slate-200 pt-4 grid grid-cols-1 md:grid-cols-4 gap-4">
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Préfixe Ventes (ex: V)
              </label>
              <input
                type="text"
                value={settingsForm.prefixes.sale}
                onChange={(e) =>
                  setSettingsForm({
                    ...settingsForm,
                    prefixes: { ...settingsForm.prefixes, sale: e.target.value },
                  })
                }
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Préfixe Factures (ex: FAC)
              </label>
              <input
                type="text"
                value={settingsForm.prefixes.invoice}
                onChange={(e) =>
                  setSettingsForm({
                    ...settingsForm,
                    prefixes: { ...settingsForm.prefixes, invoice: e.target.value },
                  })
                }
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Nouveau PIN Administrateur (PBKDF2)
              </label>
              <input
                type="password"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value)}
                placeholder="Laisser vide pour conserver"
                className="w-full px-3 py-1.5 font-mono border border-slate-300 rounded"
              />
            </div>
            <div className="md:col-span-2">
              <label className="block font-medium text-slate-700 dark:text-slate-200 mb-1.5 text-xs">
                Thème Visuel de l'Application
              </label>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-2.5">
                {/* 1. Clair */}
                <button
                  type="button"
                  onClick={() =>
                    setSettingsForm({
                      ...settingsForm,
                      theme: 'light',
                    })
                  }
                  className={`p-3 rounded-lg border text-left transition-all cursor-pointer flex flex-col justify-between ${
                    settingsForm.theme === 'light'
                      ? 'border-amber-500 bg-amber-50/70 dark:bg-amber-950/30 ring-2 ring-amber-500/20 shadow-xs'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <Sun className="w-5 h-5 text-amber-500" />
                    {settingsForm.theme === 'light' && (
                      <span className="text-[10px] font-bold text-amber-600 bg-amber-100 dark:bg-amber-900/50 px-1.5 py-0.5 rounded">
                        Actif
                      </span>
                    )}
                  </div>
                  <div>
                    <div className="font-bold text-xs text-slate-900 dark:text-white">Clair</div>
                    <div className="text-[10px] text-slate-500">Sable & Ivoire</div>
                  </div>
                </button>

                {/* 2. Sombre */}
                <button
                  type="button"
                  onClick={() =>
                    setSettingsForm({
                      ...settingsForm,
                      theme: 'dark',
                    })
                  }
                  className={`p-3 rounded-lg border text-left transition-all cursor-pointer flex flex-col justify-between ${
                    settingsForm.theme === 'dark'
                      ? 'border-blue-500 bg-slate-900 text-white ring-2 ring-blue-500/30 shadow-xs'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <Moon className="w-5 h-5 text-blue-400" />
                    {settingsForm.theme === 'dark' && (
                      <span className="text-[10px] font-bold text-blue-300 bg-blue-900/60 px-1.5 py-0.5 rounded">
                        Actif
                      </span>
                    )}
                  </div>
                  <div>
                    <div className="font-bold text-xs text-slate-900 dark:text-white">Sombre</div>
                    <div className="text-[10px] text-slate-500">Bleu Nuit Atlas</div>
                  </div>
                </button>

                {/* 3. Vert printemps */}
                <button
                  type="button"
                  onClick={() =>
                    setSettingsForm({
                      ...settingsForm,
                      theme: 'green',
                    })
                  }
                  className={`p-3 rounded-lg border text-left transition-all cursor-pointer flex flex-col justify-between ${
                    settingsForm.theme === 'green'
                      ? 'border-emerald-500 bg-emerald-50/80 dark:bg-emerald-950/30 ring-2 ring-emerald-500/20 shadow-xs'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <Leaf className="w-5 h-5 text-emerald-600" />
                    {settingsForm.theme === 'green' && (
                      <span className="text-[10px] font-bold text-emerald-700 bg-emerald-100 dark:bg-emerald-900/50 px-1.5 py-0.5 rounded">
                        Actif
                      </span>
                    )}
                  </div>
                  <div>
                    <div className="font-bold text-xs text-slate-900 dark:text-white">Vert printemps</div>
                    <div className="text-[10px] text-slate-500">Émeraude & Sauge profonde</div>
                  </div>
                </button>

                {/* 4. Orange joyeux */}
                <button
                  type="button"
                  onClick={() =>
                    setSettingsForm({
                      ...settingsForm,
                      theme: 'orange',
                    })
                  }
                  className={`p-3 rounded-lg border text-left transition-all cursor-pointer flex flex-col justify-between ${
                    settingsForm.theme === 'orange'
                      ? 'border-orange-500 bg-orange-50/80 dark:bg-orange-950/30 ring-2 ring-orange-500/20 shadow-xs'
                      : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <Sparkles className="w-5 h-5 text-orange-500" />
                    {settingsForm.theme === 'orange' && (
                      <span className="text-[10px] font-bold text-orange-700 bg-orange-100 dark:bg-orange-900/50 px-1.5 py-0.5 rounded">
                        Actif
                      </span>
                    )}
                  </div>
                  <div>
                    <div className="font-bold text-xs text-slate-900 dark:text-white">Orange joyeux</div>
                    <div className="text-[10px] text-slate-500">Terracotta & Ambre noble</div>
                  </div>
                </button>
              </div>

              <select
                value={settingsForm.theme}
                onChange={(e) =>
                  setSettingsForm({
                    ...settingsForm,
                    theme: e.target.value as 'light' | 'dark' | 'green' | 'orange' | 'system',
                  })
                }
                className="w-full px-3 py-1.5 border border-slate-300 dark:border-slate-700 rounded bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 text-xs"
              >
                <option value="light">☀️ Clair (Sable & Ivoire Marocain)</option>
                <option value="dark">🌙 Sombre (Bleu Nuit Atlas)</option>
                <option value="green">🌿 Vert printemps (Fraîcheur & Émeraude)</option>
                <option value="orange">🍊 Orange joyeux (Dynamique & Chaleureux)</option>
                <option value="system">💻 Système (Selon les préférences OS)</option>
              </select>
            </div>
          </div>

          {/* Bloc Zone Danger & Remise à 0 de l'application */}
          <div className="p-4 bg-rose-50/60 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-900/50 rounded-lg flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="font-bold text-rose-900 dark:text-rose-200 text-xs flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-600 dark:text-rose-400" />
                <span>Zone de Réinitialisation / Remise à zéro</span>
              </div>
              <p className="text-[11px] text-rose-700 dark:text-rose-300 mt-0.5">
                Remettre à zéro l&apos;ensemble des opérations (ventes, achats, stock à 0, caisse à 0 DH, compteurs à 1) sous contrôle strict du Code PIN Maître.
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                setShowResetModal(true);
                setResetMasterPin('');
                setResetError(null);
                setResetMode('ZERO_OPERATIONS');
              }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded font-medium text-xs shadow-xs transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Remise à 0 de l&apos;app</span>
            </button>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              className="px-5 py-2 bg-[#0F172A] text-white font-semibold rounded-md hover:bg-slate-800"
            >
              Enregistrer les Paramètres
            </button>
          </div>
        </form>
      )}

      {/* MODALE DE REMISE À ZÉRO DE L'APPLICATION SOUS CODE PIN MAÎTRE */}
      {showResetModal && (
        <div className="fixed inset-0 z-50 bg-slate-950/70 flex items-center justify-center p-4 overflow-y-auto">
          <form
            onSubmit={handleConfirmResetApp}
            className="bg-white border border-rose-200 rounded-xl max-w-lg w-full p-6 space-y-4 text-xs shadow-2xl my-8"
          >
            <div className="flex items-start justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-lg bg-rose-100 text-rose-700 flex items-center justify-center shrink-0">
                  <Trash2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-slate-900">
                    Remise à Zéro de l&apos;Application
                  </h3>
                  <div className="text-[11px] text-rose-700 font-semibold mt-0.5 flex items-center gap-1">
                    <KeyRound className="w-3 h-3 text-rose-600" />
                    <span>Autorisation obligatoire par Code PIN Maître</span>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowResetModal(false)}
                className="text-slate-400 hover:text-slate-700 text-lg font-bold"
              >
                ✕
              </button>
            </div>

            <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-lg text-amber-900 leading-relaxed space-y-1">
              <div className="font-bold flex items-center gap-1.5">
                <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" />
                <span>Attention : Action irréversible</span>
              </div>
              <p className="text-[11px]">
                Cette opération permet de purger les données pour démarrer l&apos;activité réelle de votre entreprise ou repartir sur une base propre.
              </p>
            </div>

            <div className="space-y-2">
              <label className="block font-semibold text-slate-800">
                Mode de remise à zéro souhaité :
              </label>

              <label className={`block p-3 border rounded-lg cursor-pointer transition-colors ${
                resetMode === 'ZERO_OPERATIONS'
                  ? 'border-blue-500 bg-blue-50/50'
                  : 'border-slate-200 hover:bg-slate-50'
              }`}>
                <div className="flex items-start gap-2.5">
                  <input
                    type="radio"
                    name="resetMode"
                    value="ZERO_OPERATIONS"
                    checked={resetMode === 'ZERO_OPERATIONS'}
                    onChange={() => setResetMode('ZERO_OPERATIONS')}
                    className="mt-0.5 text-blue-600"
                  />
                  <div>
                    <div className="font-bold text-slate-900">
                      1. Base d&apos;exploitation vierge (Recommandé)
                    </div>
                    <p className="text-slate-600 text-[11px] mt-0.5 leading-relaxed">
                      • <strong>Conserve :</strong> Vos coordonnées d&apos;entreprise (Nom, ICE, Logo, RIB...), les profils utilisateurs et le catalogue articles.<br />
                      • <strong>Remet à zéro :</strong> Ventes, devis, factures, achats, règlements, SAV, dépenses, mouvements de stocks (stock remis à 0), <strong>solde de caisse remis à 0 DH</strong>, et tous les compteurs réinitialisés à 1.
                    </p>
                  </div>
                </div>
              </label>

              <label className={`block p-3 border rounded-lg cursor-pointer transition-colors ${
                resetMode === 'FACTORY_RESET'
                  ? 'border-rose-500 bg-rose-50/50'
                  : 'border-slate-200 hover:bg-slate-50'
              }`}>
                <div className="flex items-start gap-2.5">
                  <input
                    type="radio"
                    name="resetMode"
                    value="FACTORY_RESET"
                    checked={resetMode === 'FACTORY_RESET'}
                    onChange={() => setResetMode('FACTORY_RESET')}
                    className="mt-0.5 text-rose-600"
                  />
                  <div>
                    <div className="font-bold text-slate-900">
                      2. Réinitialisation complète d&apos;usine
                    </div>
                    <p className="text-slate-600 text-[11px] mt-0.5 leading-relaxed">
                      Efface la totalité de la base de données et relance l&apos;Assistant initial de configuration (comme à la première installation).
                    </p>
                  </div>
                </div>
              </label>
            </div>

            <div>
              <label className="block font-semibold text-slate-800 mb-1">
                Saisissez le Code PIN Maître Administrateur *
              </label>
              <input
                type="password"
                required
                autoFocus
                value={resetMasterPin}
                onChange={(e) => {
                  setResetMasterPin(e.target.value);
                  if (resetError) setResetError(null);
                }}
                placeholder="Code PIN Maître (ex: 135790)..."
                className="w-full px-3.5 py-2 font-mono text-sm border border-slate-300 rounded-md bg-white focus:outline-none focus:border-rose-600"
              />
            </div>

            {resetError && (
              <div className="p-3 bg-rose-50 border border-rose-300 rounded text-rose-900 font-medium flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-rose-700 shrink-0 mt-0.5" />
                <span>{resetError}</span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setShowResetModal(false)}
                className="px-4 py-2 border border-slate-300 text-slate-700 rounded-md hover:bg-slate-100 font-medium"
              >
                Annuler
              </button>
              <button
                type="submit"
                disabled={isResetting || !resetMasterPin.trim()}
                className="inline-flex items-center gap-2 px-5 py-2 bg-rose-700 hover:bg-rose-800 text-white font-semibold rounded-md shadow-xs disabled:opacity-50"
              >
                <Trash2 className="w-4 h-4" />
                <span>{isResetting ? 'Remise à zéro en cours...' : 'Confirmer la Remise à 0'}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
