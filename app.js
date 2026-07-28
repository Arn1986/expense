import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const STORAGE_KEY = "ledgerly-data-v2-local";
const LEGACY_STORAGE_KEY = "ledgerly-data-v1";
const CURRENCY = "AED";
const RECEIPT_BUCKET = "receipts";
const CARD_ARTWORK_BUCKET = "card-artwork";
const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const MAX_CARD_ARTWORK_BYTES = 5 * 1024 * 1024;
const TESSERACT_ESM_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.esm.min.js";
const OCR_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DASHBOARD_WIDGETS = [
  { id: "net-worth", label: "Net worth", description: "Total value of included accounts" },
  { id: "income", label: "Income this month", description: "Monthly money received" },
  { id: "expenses", label: "Expenses this month", description: "Monthly money spent" },
  { id: "cash-flow", label: "Net cash flow", description: "Income minus expenses" },
  { id: "accounts", label: "Account balances", description: "Current balance of your accounts" },
  { id: "budgets", label: "Budget progress", description: "Monthly category budget usage" },
  { id: "credit-cards", label: "Credit-card overview", description: "Debt, utilization, and statement status" },
  { id: "bills", label: "Bills and reminders", description: "Upcoming and overdue payments" },
  { id: "cash-flow-chart", label: "Cash-flow chart", description: "Income and expenses for six months" },
  { id: "spending-categories", label: "Spending by category", description: "Current month category breakdown" },
  { id: "recent-transactions", label: "Recent transactions", description: "Latest account activity" },
];
const ALLOWED_RECEIPT_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const ALLOWED_CARD_ARTWORK_TYPES = ALLOWED_RECEIPT_TYPES;
const CARD_NETWORKS = new Set(["visa", "mastercard", "amex", "discover", "unionpay", "jcb", "diners", "rupay", "other"]);
const amountFormatter = new Intl.NumberFormat("en-AE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const compactAmountFormatter = new Intl.NumberFormat("en-AE", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" });

const DEFAULT_EXPENSE_CATEGORIES = [
  ["Groceries", "#22c55e"], ["Eating out", "#f97316"], ["Transport", "#0ea5e9"],
  ["Housing", "#8b5cf6"], ["Utilities", "#6366f1"], ["Shopping", "#ec4899"],
  ["Health", "#ef4444"], ["Entertainment", "#eab308"], ["Travel", "#14b8a6"],
  ["Education", "#3b82f6"], ["Insurance", "#64748b"], ["Other", "#94a3b8"],
];
const DEFAULT_INCOME_CATEGORIES = [
  ["Salary", "#16a34a"], ["Bonus", "#65a30d"], ["Dividend", "#0891b2"],
  ["Interest", "#0284c7"], ["Freelance", "#7c3aed"], ["Rental income", "#c026d3"],
  ["Gift", "#db2777"], ["Refund", "#475569"], ["Other", "#94a3b8"],
];
const ACCOUNT_COLORS = {
  current: "#2563eb", savings: "#059669", credit: "#dc2626",
  cash: "#d97706", investment: "#9333ea", other: "#475569",
};

const configuredForCloud = Boolean(
  SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY &&
  !SUPABASE_URL.includes("YOUR_") && !SUPABASE_PUBLISHABLE_KEY.includes("YOUR_")
);
let supabase = null;

let mode = configuredForCloud ? "cloud" : "local";
let user = null;
let authMode = "signin";
let activeView = "dashboard";
let toastTimer = null;
let state = emptyState();
let transactionImportSourceRows = [];
let transactionImportValidation = [];
let transactionImportFileName = "";
let spreadsheetModulePromise = null;
let selectedReceiptFile = null;
let removeExistingReceipt = false;
let receiptPreviewObjectUrl = "";
let selectedCardArtworkFile = null;
let removeExistingCardArtwork = false;
let cardArtworkPreviewObjectUrl = "";
let existingCardArtworkPreviewUrl = "";
let cardArtworkRenderToken = 0;
let calendarCursor = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let selectedCalendarDate = todayISO();
let postingRecurringEntries = false;
let reconciliationBusy = false;
let importRuleReturnToImport = false;
let pendingBillPaymentId = "";
let reminderNoticeShown = false;
let receiptOcrBusy = false;
let receiptOcrResult = null;
let dashboardPreferenceDraft = [];

const el = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));

initialize();

async function initialize() {
  el.todayLabel.textContent = new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric",
  }).format(new Date());
  el.entryDate.value = todayISO();
  el.recurringStartDate.value = todayISO();
  el.reportMonth.value = todayISO().slice(0, 7);
  el.reconcileStatementDate.value = todayISO();
  el.billDueDate.value = todayISO();
  bindEvents();

  if (!configuredForCloud) {
    el.setupNotice.hidden = false;
    el.authForm.hidden = true;
    el.authFootnote.textContent = "Cloud synchronization becomes available after adding your Supabase project settings.";
    return;
  }

  try {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
  } catch (error) {
    mode = "local";
    el.setupNotice.hidden = false;
    el.authForm.hidden = true;
    el.authFootnote.textContent = "Supabase could not be loaded. Check your internet connection or continue in local preview.";
    showAuthError(friendlyError(error));
    return;
  }

  setAuthBusy(true);
  const { data, error } = await supabase.auth.getSession();
  setAuthBusy(false);
  if (error) showAuthError(error.message);
  if (data?.session?.user) {
    await enterCloudApp(data.session.user);
  } else {
    showAuthScreen();
  }

  supabase.auth.onAuthStateChange((event, session) => {
    window.setTimeout(async () => {
      if (event === "SIGNED_OUT" || !session?.user) {
        user = null;
        showAuthScreen();
      } else if (session.user && (!user || session.user.id !== user.id)) {
        await enterCloudApp(session.user);
      }
    }, 0);
  });
}

function bindEvents() {
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.addEventListener("click", () => setAuthMode(button.dataset.authMode));
  });
  el.authForm.addEventListener("submit", handleAuthSubmit);
  el.continueLocalButton.addEventListener("click", enterLocalApp);
  el.signOutButton.addEventListener("click", handleSignOut);
  el.menuButton.addEventListener("click", () => el.sidebar.classList.toggle("open"));

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  document.querySelectorAll("[data-go-to]").forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.goTo));
  });
  document.querySelectorAll("[data-close-modal]").forEach((button) => {
    button.addEventListener("click", () => closeModal(document.getElementById(button.dataset.closeModal)));
  });
  document.querySelectorAll(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal(backdrop);
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      document.querySelectorAll(".modal-backdrop").forEach(closeModal);
      el.sidebar.classList.remove("open");
    }
  });

  el.openTransactionButton.addEventListener("click", () => openTransactionModal());
  el.openDashboardCustomizationButton.addEventListener("click", openDashboardCustomizationModal);
  el.dashboardCustomizationForm.addEventListener("submit", saveDashboardCustomization);
  el.resetDashboardCustomizationButton.addEventListener("click", resetDashboardCustomizationDraft);
  el.dashboardWidgetList.addEventListener("click", handleDashboardWidgetListClick);
  el.dashboardWidgetList.addEventListener("change", handleDashboardWidgetVisibilityChange);
  el.openTransactionImportButton.addEventListener("click", openTransactionImportModal);
  el.openImportRuleButton.addEventListener("click", () => openImportRuleModal());
  el.testImportRulesButton.addEventListener("click", openImportRuleTestModal);
  el.importRuleTransactionType.addEventListener("change", updateImportRuleRouteFields);
  el.importRuleForm.addEventListener("submit", handleImportRuleSubmit);
  el.importRuleTestForm.addEventListener("submit", handleImportRuleTest);
  el.openRecurringButton.addEventListener("click", () => openRecurringModal());
  el.openBillButton.addEventListener("click", () => openBillModal());
  el.openRecurringBillButton.addEventListener("click", () => openRecurringModal(null, "expense"));
  el.billForm.addEventListener("submit", handleBillSubmit);
  [el.billStatusFilter, el.billRangeFilter].forEach((input) => input.addEventListener("input", renderBills));
  el.reminderButton.addEventListener("click", toggleReminderPopover);
  el.closeReminderPopover.addEventListener("click", closeReminderPopover);
  [el.reconcileAccount, el.reconcileStatementDate, el.reconcileStatementBalance].forEach((input) => input.addEventListener("input", renderReconciliation));
  el.reconcileShowReconciled.addEventListener("change", renderReconciliation);
  el.reconcileMarkAllButton.addEventListener("click", () => bulkSetReconciliationCleared(true));
  el.reconcileUnclearAllButton.addEventListener("click", () => bulkSetReconciliationCleared(false));
  el.completeReconciliationButton.addEventListener("click", completeReconciliation);
  el.calendarPreviousMonth.addEventListener("click", () => moveCalendarMonth(-1));
  el.calendarNextMonth.addEventListener("click", () => moveCalendarMonth(1));
  el.calendarTodayButton.addEventListener("click", showCalendarToday);
  el.calendarAccountFilter.addEventListener("input", renderCalendar);
  el.calendarAddEntryButton.addEventListener("click", () => openTransactionModal(null, selectedCalendarDate));
  el.calendarGrid.addEventListener("click", handleCalendarClick);
  el.calendarGrid.addEventListener("keydown", handleCalendarKeydown);
  el.openAccountButton.addEventListener("click", () => openAccountModal());
  el.openCreditCardStatementButton.addEventListener("click", () => openCreditCardStatementModal());
  el.openBudgetButton.addEventListener("click", () => openBudgetModal());
  el.openCategoryButton.addEventListener("click", () => openCategoryModal());

  document.querySelectorAll("[data-entry-type]").forEach((button) => {
    button.addEventListener("click", () => setEntryType(button.dataset.entryType));
  });
  document.querySelectorAll("[data-recurring-type]").forEach((button) => {
    button.addEventListener("click", () => setRecurringType(button.dataset.recurringType));
  });
  el.recurringFrequency.addEventListener("change", updateRecurringIntervalUnit);
  el.recurringInterval.addEventListener("input", updateRecurringIntervalUnit);
  el.recurringEndMode.addEventListener("change", updateRecurringEndDateVisibility);
  el.accountType.addEventListener("change", () => {
    if (!el.accountId.value) el.accountColor.value = ACCOUNT_COLORS[el.accountType.value] || ACCOUNT_COLORS.other;
    updateCreditCardAccountFields();
  });
  [el.accountName, el.accountColor, el.accountCardAccentColor, el.accountCardNetwork, el.accountCardLastFour].forEach((input) => input.addEventListener("input", updateAccountCardPreview));
  el.accountCardArtwork.addEventListener("change", handleCardArtworkSelection);
  el.viewCardArtworkButton.addEventListener("click", viewCardArtworkFromForm);
  el.removeCardArtworkButton.addEventListener("click", removeCardArtworkFromForm);
  el.creditCardStatementAccount.addEventListener("change", updateCreditCardStatementDueDate);
  el.creditCardStatementDate.addEventListener("change", updateCreditCardStatementDueDate);

  el.authForm.addEventListener("input", () => showAuthError(""));
  el.transactionForm.addEventListener("submit", handleTransactionSubmit);
  el.entryAmount.addEventListener("input", updateSplitSummary);
  el.entrySplitEnabled.addEventListener("change", () => setSplitMode(el.entrySplitEnabled.checked));
  el.addSplitRowButton.addEventListener("click", () => addSplitRow());
  el.entrySplitRows.addEventListener("input", updateSplitSummary);
  el.entrySplitRows.addEventListener("change", updateSplitSummary);
  el.entrySplitRows.addEventListener("click", (event) => {
    const button = event.target.closest("[data-remove-split]");
    if (!button) return;
    button.closest(".split-row")?.remove();
    ensureMinimumSplitRows();
    updateSplitSummary();
  });
  el.entryReceipt.addEventListener("change", handleReceiptSelection);
  el.viewReceiptButton.addEventListener("click", viewReceiptFromForm);
  el.removeReceiptButton.addEventListener("click", removeReceiptFromForm);
  el.scanReceiptButton.addEventListener("click", scanReceiptWithOcr);
  el.applyReceiptOcrButton.addEventListener("click", applyReceiptOcrResult);
  el.accountForm.addEventListener("submit", handleAccountSubmit);
  el.creditCardStatementForm.addEventListener("submit", handleCreditCardStatementSubmit);
  el.budgetForm.addEventListener("submit", handleBudgetSubmit);
  el.categoryForm.addEventListener("submit", handleCategorySubmit);
  el.recurringForm.addEventListener("submit", handleRecurringSubmit);

  [el.transactionSearch, el.transactionTypeFilter, el.transactionAccountFilter, el.transactionMonthFilter]
    .forEach((input) => input.addEventListener("input", renderAllTransactions));
  [el.reportPeriod, el.reportMonth].forEach((input) => input.addEventListener("input", renderReports));
  [el.recurringStatusFilter, el.recurringTypeFilter].forEach((input) => input.addEventListener("input", renderRecurringEntries));

  el.exportButton.addEventListener("click", exportJSON);
  el.exportCsvButton.addEventListener("click", exportCSV);
  el.importInput.addEventListener("change", importJSON);
  el.transactionImportInput.addEventListener("change", handleTransactionImportFile);
  el.importDefaultAccount.addEventListener("change", validateTransactionImport);
  el.importBlankTypeMode.addEventListener("change", validateTransactionImport);
  el.importApplyRules.addEventListener("change", validateTransactionImport);
  el.importCreateCategories.addEventListener("change", validateTransactionImport);
  el.importSkipDuplicates.addEventListener("change", validateTransactionImport);
  el.importTransactionsButton.addEventListener("click", importValidatedTransactions);
  el.resetButton.addEventListener("click", resetApplication);

  document.body.addEventListener("click", async (event) => {
    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) return;
    const { action, id } = actionTarget.dataset;
    const actions = {
      "edit-account": () => openAccountModal(id),
      "delete-account": () => deleteAccount(id),
      "edit-credit-card-settings": () => openAccountModal(id),
      "add-credit-card-statement": () => openCreditCardStatementModal(null, id),
      "edit-credit-card-statement": () => openCreditCardStatementModal(id),
      "delete-credit-card-statement": () => deleteCreditCardStatement(id),
      "record-credit-card-payment": () => openCreditCardPayment(id),
      "edit-transaction": () => openTransactionModal(id),
      "open-receipt": () => openTransactionReceipt(id),
      "delete-transaction": () => deleteTransaction(id),
      "edit-budget": () => openBudgetModal(id),
      "delete-budget": () => deleteBudget(id),
      "edit-category": () => openCategoryModal(id),
      "delete-category": () => deleteCategory(id),
      "edit-import-rule": () => openImportRuleModal(id),
      "toggle-import-rule": () => toggleImportRule(id),
      "delete-import-rule": () => deleteImportRule(id),
      "create-rule-from-import": () => openImportRuleFromPreview(Number(actionTarget.dataset.index)),
      "edit-recurring": () => openRecurringModal(id),
      "toggle-recurring": () => toggleRecurringEntry(id),
      "post-recurring": () => postRecurringOccurrenceById(id, actionTarget.dataset.date),
      "delete-recurring": () => deleteRecurringEntry(id),
      "edit-bill": () => openBillModal(id),
      "delete-bill": () => deleteBill(id),
      "record-bill-payment": () => recordBillPayment(id),
      "mark-bill-paid": () => markBillPaid(id),
      "reopen-bill": () => reopenBill(id),
      "snooze-bill": () => snoozeBill(id),
      "open-reconcile-account": () => openReconciliationForAccount(id),
      "toggle-reconciliation-cleared": () => toggleTransactionCleared(id, actionTarget.dataset.accountId),
      "undo-reconciliation": () => undoReconciliation(id),
    };
    if (actions[action]) await actions[action]();
  });
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  showAuthError("");
  const email = el.authEmail.value.trim();
  const password = el.authPassword.value;
  setAuthBusy(true);
  try {
    if (authMode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session?.user) await enterCloudApp(data.session.user);
      else {
        showToast("Check your email to confirm the new account.");
        setAuthMode("signin");
      }
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await enterCloudApp(data.user);
    }
  } catch (error) {
    showAuthError(friendlyError(error));
  } finally {
    setAuthBusy(false);
  }
}

async function enterCloudApp(authUser) {
  mode = "cloud";
  user = authUser;
  showAppScreen();
  setSyncStatus("syncing", "Loading cloud data");
  try {
    await loadCloudState();
    if (!state.categories.length) await seedDefaultCategories();
    await postDueRecurringEntries();
    setSyncStatus("cloud", "Cloud synchronized");
    render();
    showReminderNoticeOnce();
  } catch (error) {
    setSyncStatus("local", "Sync error");
    showToast(friendlyError(error), true);
  }
}

function enterLocalApp() {
  mode = "local";
  user = { id: "local-user", email: "Local preview" };
  state = loadLocalState();
  showAppScreen();
  setSyncStatus("local", "Local browser only");
  postDueRecurringEntries().finally(() => { render(); showReminderNoticeOnce(); });
}

async function handleSignOut() {
  if (mode === "cloud") {
    const { error } = await supabase.auth.signOut();
    if (error) return showToast(friendlyError(error), true);
  }
  user = null;
  showAuthScreen();
}

function showAuthScreen() {
  el.appShell.hidden = true;
  el.authScreen.hidden = false;
  el.authPassword.value = "";
  showAuthError("");
}

function showAppScreen() {
  el.authScreen.hidden = true;
  el.appShell.hidden = false;
  el.localBanner.hidden = mode !== "local";
  el.signedInEmail.textContent = user?.email || "";
  el.signOutButton.textContent = mode === "cloud" ? "Sign out" : "Exit local preview";
}

function setAuthMode(nextMode) {
  authMode = nextMode;
  document.querySelectorAll("[data-auth-mode]").forEach((button) => {
    button.classList.toggle("active", button.dataset.authMode === nextMode);
  });
  el.authSubmitButton.textContent = nextMode === "signup" ? "Create account" : "Sign in";
  el.authPassword.autocomplete = nextMode === "signup" ? "new-password" : "current-password";
  showAuthError("");
}

function setAuthBusy(busy) {
  el.authSubmitButton.disabled = busy;
  el.authSubmitButton.textContent = busy ? "Please wait…" : authMode === "signup" ? "Create account" : "Sign in";
}

function showAuthError(message) { el.authError.textContent = message; }

async function loadCloudState() {
  const [accountsResult, categoriesResult, transactionsResult, transactionSplitsResult, budgetsResult, recurringResult, billsResult, reconciliationsResult, clearingsResult, cardStatementsResult, importRulesResult, preferencesResult] = await Promise.all([
    supabase.from("accounts").select("*").order("created_at", { ascending: true }),
    supabase.from("categories").select("*").order("kind").order("name"),
    supabase.from("transactions").select("*").order("entry_date", { ascending: false }).order("created_at", { ascending: false }),
    supabase.from("transaction_splits").select("*").order("created_at", { ascending: true }),
    supabase.from("budgets").select("*").order("created_at", { ascending: true }),
    supabase.from("recurring_entries").select("*").order("created_at", { ascending: true }),
    supabase.from("bills").select("*").order("due_date", { ascending: true }).order("created_at", { ascending: true }),
    supabase.from("reconciliations").select("*").order("statement_date", { ascending: false }).order("completed_at", { ascending: false }),
    supabase.from("transaction_clearings").select("*").order("created_at", { ascending: true }),
    supabase.from("credit_card_statements").select("*").order("statement_date", { ascending: false }),
    supabase.from("import_rules").select("*").order("priority", { ascending: true }).order("created_at", { ascending: true }),
    supabase.from("user_preferences").select("*").eq("user_id", user.id).maybeSingle(),
  ]);
  [accountsResult, categoriesResult, transactionsResult, transactionSplitsResult, budgetsResult, recurringResult, billsResult, reconciliationsResult, clearingsResult, cardStatementsResult, importRulesResult, preferencesResult].forEach((result) => {
    if (result.error) throw result.error;
  });
  state = {
    version: 9,
    accounts: accountsResult.data || [],
    categories: categoriesResult.data || [],
    transactions: transactionsResult.data || [],
    transactionSplits: transactionSplitsResult.data || [],
    budgets: budgetsResult.data || [],
    recurringEntries: recurringResult.data || [],
    bills: billsResult.data || [],
    reconciliations: reconciliationsResult.data || [],
    transactionClearings: clearingsResult.data || [],
    creditCardStatements: cardStatementsResult.data || [],
    importRules: importRulesResult.data || [],
    preferences: normalizePreferences(preferencesResult.data),
  };
}

async function seedDefaultCategories() {
  const rows = defaultCategoryRows().map((row) => ({ ...row, user_id: user.id }));
  const { data, error } = await supabase.from("categories").insert(rows).select();
  if (error) throw error;
  state.categories = data || [];
}

function emptyState() {
  return { version: 9, accounts: [], categories: [], transactions: [], transactionSplits: [], budgets: [], recurringEntries: [], bills: [], reconciliations: [], transactionClearings: [], creditCardStatements: [], importRules: [], preferences: defaultPreferences() };
}

function normalizeState(value) {
  return {
    version: 9,
    accounts: Array.isArray(value?.accounts) ? value.accounts : [],
    categories: Array.isArray(value?.categories) ? value.categories : [],
    transactions: Array.isArray(value?.transactions) ? value.transactions : [],
    transactionSplits: Array.isArray(value?.transactionSplits) ? value.transactionSplits : Array.isArray(value?.transaction_splits) ? value.transaction_splits : [],
    budgets: Array.isArray(value?.budgets) ? value.budgets : [],
    recurringEntries: Array.isArray(value?.recurringEntries) ? value.recurringEntries : Array.isArray(value?.recurring_entries) ? value.recurring_entries : [],
    bills: Array.isArray(value?.bills) ? value.bills : [],
    reconciliations: Array.isArray(value?.reconciliations) ? value.reconciliations : [],
    transactionClearings: Array.isArray(value?.transactionClearings) ? value.transactionClearings : Array.isArray(value?.transaction_clearings) ? value.transaction_clearings : [],
    creditCardStatements: Array.isArray(value?.creditCardStatements) ? value.creditCardStatements : Array.isArray(value?.credit_card_statements) ? value.credit_card_statements : [],
    importRules: Array.isArray(value?.importRules) ? value.importRules : Array.isArray(value?.import_rules) ? value.import_rules : [],
    preferences: normalizePreferences(value?.preferences || value?.user_preferences),
  };
}

function defaultDashboardWidgets() {
  return DASHBOARD_WIDGETS.map((widget, index) => ({ id: widget.id, visible: true, order: index }));
}

function defaultPreferences() {
  return { dashboard_widgets: defaultDashboardWidgets() };
}

function normalizeDashboardWidgets(value) {
  const source = Array.isArray(value) ? value : [];
  const sourceMap = new Map(source.map((item, index) => [String(item?.id || ""), { visible: item?.visible !== false, order: Number.isFinite(Number(item?.order)) ? Number(item.order) : index }]));
  return DASHBOARD_WIDGETS.map((widget, index) => {
    const saved = sourceMap.get(widget.id);
    return { id: widget.id, visible: saved?.visible !== false, order: saved ? saved.order : index };
  }).sort((a, b) => a.order - b.order || DASHBOARD_WIDGETS.findIndex((item) => item.id === a.id) - DASHBOARD_WIDGETS.findIndex((item) => item.id === b.id)).map((item, index) => ({ ...item, order: index }));
}

function normalizePreferences(value) {
  const row = value && typeof value === "object" ? value : {};
  return { dashboard_widgets: normalizeDashboardWidgets(row.dashboard_widgets) };
}

function dashboardWidgets() {
  state.preferences = normalizePreferences(state.preferences);
  return state.preferences.dashboard_widgets;
}

function defaultLocalState() {
  return {
    version: 9,
    accounts: [
      localRow({ name: "Current Account", type: "current", opening_balance: 0, color: ACCOUNT_COLORS.current, include_in_net_worth: true }),
      localRow({ name: "Savings", type: "savings", opening_balance: 0, color: ACCOUNT_COLORS.savings, include_in_net_worth: true }),
      localRow({ name: "Cash", type: "cash", opening_balance: 0, color: ACCOUNT_COLORS.cash, include_in_net_worth: true }),
    ],
    categories: defaultCategoryRows().map(localRow),
    transactions: [],
    transactionSplits: [],
    budgets: [],
    recurringEntries: [],
    bills: [],
    reconciliations: [],
    transactionClearings: [],
    creditCardStatements: [],
    importRules: [],
    preferences: defaultPreferences(),
  };
}

function defaultCategoryRows() {
  return [
    ...DEFAULT_EXPENSE_CATEGORIES.map(([name, color]) => ({ name, color, kind: "expense" })),
    ...DEFAULT_INCOME_CATEGORIES.map(([name, color]) => ({ name, color, kind: "income" })),
  ];
}

function localRow(row) {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), created_at: now, updated_at: now, ...row };
}

function loadLocalState() {
  try {
    const current = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (isValidState(current)) return normalizeState(current);
    const legacy = JSON.parse(localStorage.getItem(LEGACY_STORAGE_KEY));
    if (legacy?.accounts && legacy?.transactions) {
      const migrated = migrateLegacyState(legacy);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
      return migrated;
    }
  } catch (error) {
    console.warn("Could not load local data", error);
  }
  const fresh = defaultLocalState();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(fresh));
  return fresh;
}

function migrateLegacyState(legacy) {
  const categories = defaultCategoryRows().map(localRow);
  const categoryByName = new Map(categories.map((item) => [`${item.kind}:${item.name.toLowerCase()}`, item.id]));
  const ensureCategory = (kind, name) => {
    const cleanName = String(name || "Other").trim() || "Other";
    const key = `${kind}:${cleanName.toLowerCase()}`;
    if (!categoryByName.has(key)) {
      const category = localRow({ name: cleanName, kind, color: "#94a3b8" });
      categories.push(category);
      categoryByName.set(key, category.id);
    }
    return categoryByName.get(key);
  };
  const accounts = (legacy.accounts || []).map((account) => ({
    id: account.id || crypto.randomUUID(),
    name: account.name || "Account",
    type: account.type || "other",
    opening_balance: number(account.openingBalance ?? account.opening_balance),
    color: ACCOUNT_COLORS[account.type] || ACCOUNT_COLORS.other,
    include_in_net_worth: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
  const transactions = (legacy.transactions || []).map((transaction) => {
    const type = transaction.type || "expense";
    const categoryName = transaction.category || "Other";
    return localRow({
      type,
      amount: Math.abs(number(transaction.amount)),
      entry_date: transaction.date || todayISO(),
      description: transaction.description || "",
      category_id: type === "transfer" ? null : ensureCategory(type, categoryName),
      account_id: transaction.accountId || transaction.account_id || null,
      from_account_id: transaction.fromAccountId || transaction.from_account_id || null,
      to_account_id: transaction.toAccountId || transaction.to_account_id || null,
    });
  });
  return { version: 9, accounts, categories, transactions, transactionSplits: [], budgets: [], recurringEntries: [], bills: [], reconciliations: [], transactionClearings: [], creditCardStatements: [], importRules: [], preferences: defaultPreferences() };
}

function persistLocal() {
  if (mode === "local") localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

async function insertRow(table, row) {
  if (mode === "cloud") {
    setSyncStatus("syncing", "Saving changes");
    const { data, error } = await supabase.from(table).insert({ ...row, user_id: user.id }).select().single();
    if (error) throw error;
    setSyncStatus("cloud", "Cloud synchronized");
    return data;
  }
  return localRow(row);
}

async function updateRow(table, id, changes) {
  if (mode === "cloud") {
    setSyncStatus("syncing", "Saving changes");
    const { data, error } = await supabase.from(table).update(changes).eq("id", id).select().single();
    if (error) throw error;
    setSyncStatus("cloud", "Cloud synchronized");
    return data;
  }
  return { ...changes, updated_at: new Date().toISOString() };
}

async function deleteRow(table, id) {
  if (mode === "cloud") {
    setSyncStatus("syncing", "Saving changes");
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error) throw error;
    setSyncStatus("cloud", "Cloud synchronized");
  }
}

function setSyncStatus(status, text) {
  el.syncPill.classList.remove("local", "syncing");
  if (status === "local") el.syncPill.classList.add("local");
  if (status === "syncing") el.syncPill.classList.add("syncing");
  el.syncText.textContent = text;
}

function switchView(view) {
  activeView = view;
  document.querySelectorAll(".view").forEach((section) => section.classList.toggle("active", section.id === `${view}View`));
  document.querySelectorAll(".nav-item").forEach((button) => button.classList.toggle("active", button.dataset.view === view));
  const titles = { dashboard: "Dashboard", accounts: "Accounts", creditcards: "Credit cards", transactions: "Transactions", rules: "Import rules", reconcile: "Reconcile", calendar: "Calendar", recurring: "Recurring", bills: "Bills & reminders", budgets: "Budgets", reports: "Reports", categories: "Categories", settings: "Data & settings" };
  el.pageTitle.textContent = titles[view] || "Ledgerly";
  el.sidebar.classList.remove("open");
  if (view === "reports") renderReports();
  if (view === "rules") renderImportRules();
  if (view === "creditcards") renderCreditCards();
  if (view === "reconcile") renderReconciliation();
  if (view === "calendar") renderCalendar();
  if (view === "recurring") renderRecurringEntries();
  if (view === "bills") renderBills();
}

function render() {
  applyDashboardPreferences();
  renderSelectors();
  renderSummary();
  renderAccounts();
  renderCreditCards();
  renderTransactions();
  renderImportRules();
  renderReconciliation();
  renderCalendar();
  renderRecurringEntries();
  renderBills();
  renderReminderCenter();
  renderCategoryChart();
  renderCashFlowChart();
  renderBudgets();
  renderCategories();
  renderReports();
  renderSettings();
}

function applyDashboardPreferences() {
  dashboardWidgets().forEach((preference, index) => {
    const widget = document.querySelector(`[data-dashboard-widget="${preference.id}"]`);
    if (!widget) return;
    widget.style.order = String(index);
    widget.classList.toggle("dashboard-user-hidden", preference.visible === false);
  });
}

function openDashboardCustomizationModal() {
  dashboardPreferenceDraft = dashboardWidgets().map((item) => ({ ...item }));
  el.dashboardCustomizationError.textContent = "";
  renderDashboardCustomizationList();
  openModal(el.dashboardCustomizationModal);
}

function renderDashboardCustomizationList() {
  const metadata = new Map(DASHBOARD_WIDGETS.map((item) => [item.id, item]));
  el.dashboardWidgetList.innerHTML = dashboardPreferenceDraft.map((preference, index) => {
    const widget = metadata.get(preference.id);
    return `<div class="dashboard-widget-option" data-widget-id="${escapeHTML(preference.id)}">
      <label class="dashboard-widget-toggle"><input type="checkbox" data-dashboard-visible="${escapeHTML(preference.id)}" ${preference.visible !== false ? "checked" : ""} /><span><strong>${escapeHTML(widget?.label || preference.id)}</strong><small>${escapeHTML(widget?.description || "")}</small></span></label>
      <div class="dashboard-widget-order"><button class="icon-button compact-icon" type="button" data-dashboard-move="up" data-widget-id="${escapeHTML(preference.id)}" aria-label="Move ${escapeHTML(widget?.label || preference.id)} up" ${index === 0 ? "disabled" : ""}>↑</button><button class="icon-button compact-icon" type="button" data-dashboard-move="down" data-widget-id="${escapeHTML(preference.id)}" aria-label="Move ${escapeHTML(widget?.label || preference.id)} down" ${index === dashboardPreferenceDraft.length - 1 ? "disabled" : ""}>↓</button></div>
    </div>`;
  }).join("");
}

function handleDashboardWidgetListClick(event) {
  const button = event.target.closest("[data-dashboard-move]");
  if (!button) return;
  const index = dashboardPreferenceDraft.findIndex((item) => item.id === button.dataset.widgetId);
  const target = button.dataset.dashboardMove === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= dashboardPreferenceDraft.length) return;
  [dashboardPreferenceDraft[index], dashboardPreferenceDraft[target]] = [dashboardPreferenceDraft[target], dashboardPreferenceDraft[index]];
  renderDashboardCustomizationList();
}

function handleDashboardWidgetVisibilityChange(event) {
  const checkbox = event.target.closest("[data-dashboard-visible]");
  if (!checkbox) return;
  const preference = dashboardPreferenceDraft.find((item) => item.id === checkbox.dataset.dashboardVisible);
  if (preference) preference.visible = checkbox.checked;
}

function resetDashboardCustomizationDraft() {
  dashboardPreferenceDraft = defaultDashboardWidgets();
  renderDashboardCustomizationList();
}

async function saveDashboardCustomization(event) {
  event.preventDefault();
  const normalized = normalizeDashboardWidgets(dashboardPreferenceDraft);
  if (!normalized.some((item) => item.visible)) return showFormError(el.dashboardCustomizationError, "Keep at least one dashboard widget visible.");
  const preferences = { dashboard_widgets: normalized };
  try {
    if (mode === "cloud") {
      setSyncStatus("syncing", "Saving dashboard");
      const { data, error } = await supabase.from("user_preferences").upsert({ user_id: user.id, dashboard_widgets: normalized, updated_at: new Date().toISOString() }, { onConflict: "user_id" }).select().single();
      if (error) throw error;
      state.preferences = normalizePreferences(data);
      setSyncStatus("cloud", "Cloud synchronized");
    } else {
      state.preferences = preferences;
      persistLocal();
    }
    applyDashboardPreferences();
    closeModal(el.dashboardCustomizationModal);
    showToast("Dashboard preferences saved.");
  } catch (error) {
    showFormError(el.dashboardCustomizationError, friendlyError(error));
  }
}

function renderSummary() {
  const month = todayISO().slice(0, 7);
  const monthTx = state.transactions.filter((item) => item.entry_date?.startsWith(month));
  const income = sumTransactions(monthTx, "income");
  const expenses = sumTransactions(monthTx, "expense");
  const netWorth = calculateNetWorth();
  const cashFlow = income - expenses;
  const budget = budgetMetrics("monthly", month);
  el.summaryNetWorth.innerHTML = summaryCard("Net worth", netWorth, `${state.accounts.filter((a) => a.include_in_net_worth !== false).length} included accounts`, tone(netWorth));
  el.summaryIncome.innerHTML = summaryCard("Income this month", income, `${monthTx.filter((item) => item.type === "income").length} entries`, "positive");
  el.summaryExpenses.innerHTML = summaryCard("Expenses this month", expenses, budget.total ? `${Math.round((expenses / budget.total) * 100)}% of monthly budget` : `${monthTx.filter((item) => item.type === "expense").length} entries`, expenses ? "negative" : "");
  el.summaryCashFlow.innerHTML = summaryCard("Net cash flow", cashFlow, "Income minus expenses", tone(cashFlow));
}

function renderAccounts() {
  if (!state.accounts.length) {
    const empty = emptyHTML("No accounts yet", "Add a current, savings, credit-card, cash, investment, or custom account.");
    el.dashboardAccounts.innerHTML = empty;
    el.accountsGrid.innerHTML = empty;
    return;
  }
  el.dashboardAccounts.innerHTML = state.accounts.slice(0, 6).map(accountRowHTML).join("");
  el.accountsGrid.innerHTML = state.accounts.map((account) => {
    const balance = calculateAccountBalance(account.id);
    return `
      <article class="account-card" style="--account-color:${safeColor(account.color)}">
        <div class="account-card-top">
          <span class="account-card-type">${escapeHTML(account.type)}</span>
          <div class="account-card-actions">
            <button class="account-menu-button" data-action="edit-account" data-id="${account.id}" aria-label="Edit ${escapeHTML(account.name)}">✎</button>
            <button class="account-menu-button" data-action="delete-account" data-id="${account.id}" aria-label="Delete ${escapeHTML(account.name)}">×</button>
          </div>
        </div>
        <h3>${escapeHTML(account.name)}</h3>
        <p class="large-balance">${formatMoneyHTML(balance)}</p>
        <p class="opening-balance">Starting balance: ${formatMoneyHTML(number(account.opening_balance))}${account.include_in_net_worth === false ? " · excluded from net worth" : ""}</p>
        ${account.type === "credit" ? `<p class="account-credit-meta">${number(account.credit_limit) > 0 ? `${creditCardUtilization(account).toFixed(1)}% of ${formatMoneyHTML(account.credit_limit)} limit` : "Credit limit not configured"}</p>` : ""}
        <div class="account-card-footer-actions"><button class="account-reconcile-button" data-action="open-reconcile-account" data-id="${account.id}" type="button">✓ Reconcile</button>${account.type === "credit" ? `<button class="account-reconcile-button" data-action="add-credit-card-statement" data-id="${account.id}" type="button">▤ Statement</button>` : ""}</div>
      </article>`;
  }).join("");
}

function accountRowHTML(account) {
  const balance = calculateAccountBalance(account.id);
  return `<div class="account-row">
    <span class="account-icon" style="--account-color:${safeColor(account.color)}">${escapeHTML(account.name.slice(0, 1).toUpperCase())}</span>
    <div class="account-details"><strong>${escapeHTML(account.name)}</strong><span>${escapeHTML(account.type)}</span></div>
    <span class="account-balance ${tone(balance)}">${formatMoneyHTML(balance)}</span>
  </div>`;
}


function creditCardAccounts() {
  return state.accounts.filter((account) => account.type === "credit");
}

function creditCardDebt(account) {
  return Math.max(0, -calculateAccountBalance(account.id));
}

function creditCardAvailableCredit(account) {
  const limit = Math.max(0, number(account.credit_limit));
  return limit ? Math.max(0, limit - creditCardDebt(account)) : 0;
}

function creditCardUtilization(account) {
  const limit = Math.max(0, number(account.credit_limit));
  return limit ? (creditCardDebt(account) / limit) * 100 : 0;
}

function normalizeCardNetwork(value) {
  const network = String(value || "other").toLowerCase();
  return CARD_NETWORKS.has(network) ? network : "other";
}

function cardNetworkLabel(value) {
  return {
    visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover",
    unionpay: "UnionPay", jcb: "JCB", diners: "Diners Club", rupay: "RuPay", other: "Card",
  }[normalizeCardNetwork(value)];
}

function creditCardBrandHTML(account, compact = false) {
  const network = normalizeCardNetwork(account?.card_network);
  const label = cardNetworkLabel(network);
  if (network === "mastercard") {
    return `<span class="card-brand mastercard${compact ? " compact" : ""}" role="img" aria-label="${label}"><i></i><i></i><b>${compact ? "" : "mastercard"}</b></span>`;
  }
  const text = { visa: "VISA", amex: "AMEX", discover: "DISCOVER", unionpay: "UnionPay", jcb: "JCB", diners: "DINERS", rupay: "RuPay", other: "CARD" }[network];
  return `<span class="card-brand ${network}${compact ? " compact" : ""}" role="img" aria-label="${label}">${escapeHTML(text)}</span>`;
}

function creditCardVisualStyle(account) {
  return `--account-color:${safeColor(account?.color)};--card-accent-color:${safeColor(account?.card_accent_color || "#0f172a")}`;
}

async function hydrateCreditCardArtwork() {
  if (mode !== "cloud" || !supabase) return;
  const token = ++cardArtworkRenderToken;
  const images = [...document.querySelectorAll("img[data-card-artwork-path]")];
  await Promise.all(images.map(async (image) => {
    const path = image.dataset.cardArtworkPath;
    if (!path) return;
    try {
      const url = await createCardArtworkSignedUrl(path, 600);
      if (token !== cardArtworkRenderToken || !image.isConnected) return;
      image.src = url;
      image.hidden = false;
      image.closest(".credit-card-management-head")?.classList.add("has-artwork");
    } catch (error) {
      console.warn("Could not load card artwork", error);
    }
  }));
}

function renderCreditCards() {
  if (!el.creditCardsGrid) return;
  const cards = creditCardAccounts();
  const totalDebt = cards.reduce((sum, account) => sum + creditCardDebt(account), 0);
  const totalLimit = cards.reduce((sum, account) => sum + Math.max(0, number(account.credit_limit)), 0);
  const available = cards.reduce((sum, account) => sum + creditCardAvailableCredit(account), 0);
  const utilization = totalLimit ? (totalDebt / totalLimit) * 100 : 0;
  const openStatements = state.creditCardStatements.map((statement) => creditCardStatementStatus(statement));
  const attentionCount = openStatements.filter((item) => ["overdue", "due-soon"].includes(item.key)).length;

  el.openCreditCardStatementButton.disabled = cards.length === 0;
  el.creditCardSummary.innerHTML = [
    summaryCard("Total card debt", totalDebt, `${cards.length} credit-card account${cards.length === 1 ? "" : "s"}`, totalDebt ? "negative" : ""),
    summaryCard("Available credit", available, totalLimit ? `${formatMoneyText(totalLimit)} combined limit` : "Add card limits to calculate this", "positive"),
    summaryCard("Utilization", utilization, totalLimit ? "Current debt divided by total limit" : "No credit limits configured", utilization >= 70 ? "negative" : utilization >= 30 ? "warning" : "positive", false, "%"),
    summaryCard("Needs attention", attentionCount, attentionCount ? "Overdue or due within 7 days" : "No urgent card statements", attentionCount ? "negative" : "positive", false),
  ].join("");

  if (!cards.length) {
    el.creditCardsGrid.innerHTML = emptyHTML("No credit cards configured", "Add an account with the Credit card type, then enter its limit and cycle dates.");
    el.creditCardStatementsList.innerHTML = emptyHTML("No card statements", "Statements will appear here after a credit-card account is added.");
    el.dashboardCreditCardsPanel.hidden = true;
    el.dashboardCreditCards.innerHTML = "";
    return;
  }

  el.creditCardsGrid.innerHTML = cards.map(creditCardAccountCardHTML).join("");
  void hydrateCreditCardArtwork();
  const statements = [...state.creditCardStatements].sort((a, b) => String(b.statement_date).localeCompare(String(a.statement_date)));
  el.creditCardStatementsList.innerHTML = statements.length
    ? `<div class="credit-card-statement-list">${statements.map(creditCardStatementRowHTML).join("")}</div>`
    : emptyHTML("No statements saved", "Add the latest statement for each card to track its amount due and payment status.");

  el.dashboardCreditCardsPanel.hidden = false;
  el.dashboardCreditCards.innerHTML = `<div class="credit-card-dashboard-list">${cards.slice(0, 4).map(creditCardDashboardRowHTML).join("")}</div>`;
}

function creditCardDashboardRowHTML(account) {
  const debt = creditCardDebt(account);
  const utilization = creditCardUtilization(account);
  const latest = latestCreditCardStatement(account.id);
  const status = latest ? creditCardStatementStatus(latest) : null;
  const lastFour = /^\d{4}$/.test(String(account.card_last_four || "")) ? ` · •••• ${account.card_last_four}` : "";
  return `<div class="credit-card-dashboard-row">
    <span class="card-network-mini" style="${creditCardVisualStyle(account)}">${creditCardBrandHTML(account, true)}</span>
    <div class="credit-card-dashboard-copy"><strong>${escapeHTML(account.name)}</strong><span>${escapeHTML(cardNetworkLabel(account.card_network))}${lastFour}${number(account.credit_limit) > 0 ? ` · ${utilization.toFixed(1)}% utilized` : " · Credit limit not set"}${status ? ` · ${escapeHTML(status.label)}` : ""}</span></div>
    <div class="credit-card-dashboard-amount"><strong>${formatMoneyHTML(debt)}</strong><span>owed</span></div>
  </div>`;
}

function creditCardAccountCardHTML(account) {
  const debt = creditCardDebt(account);
  const limit = Math.max(0, number(account.credit_limit));
  const available = creditCardAvailableCredit(account);
  const utilization = creditCardUtilization(account);
  const latest = latestCreditCardStatement(account.id);
  const status = latest ? creditCardStatementStatus(latest) : null;
  const nextClose = account.statement_closing_day ? nextDayOfMonth(number(account.statement_closing_day)) : "";
  const nextDue = latest && status?.outstanding > 0
    ? latest.due_date
    : account.payment_due_day ? nextDayOfMonth(number(account.payment_due_day)) : "";
  const progress = latest && number(latest.statement_balance) > 0 ? Math.min(100, (status.paid / number(latest.statement_balance)) * 100) : 0;
  const lastFour = /^\d{4}$/.test(String(account.card_last_four || "")) ? `•••• ${account.card_last_four}` : cardNetworkLabel(account.card_network);
  const artwork = account.card_artwork_path
    ? `<img class="credit-card-artwork-image" data-card-artwork-path="${escapeHTML(account.card_artwork_path)}" alt="" hidden />`
    : "";
  return `<article class="credit-card-management-card" style="${creditCardVisualStyle(account)}">
    <div class="credit-card-management-head">
      ${artwork}<span class="credit-card-artwork-shade" aria-hidden="true"></span>
      <div class="credit-card-brand-row"><span class="credit-card-chip"></span>${creditCardBrandHTML(account)}</div>
      <p class="credit-card-display-name">${escapeHTML(account.name)}</p>
      <span class="credit-card-balance-label">Current debt</span>
      <strong class="credit-card-current-debt">${formatMoneyHTML(debt)}</strong>
      <span class="credit-card-last-four">${escapeHTML(lastFour)}</span>
    </div>
    <div class="credit-card-limit-section">
      <div class="credit-card-metric"><span>Credit limit</span><strong>${limit ? formatMoneyHTML(limit) : "Not set"}</strong></div>
      <div class="credit-card-metric"><span>Available</span><strong class="positive">${limit ? formatMoneyHTML(available) : "—"}</strong></div>
      <div class="credit-card-metric"><span>Utilization</span><strong class="${utilization >= 70 ? "negative" : utilization >= 30 ? "warning" : "positive"}">${limit ? `${utilization.toFixed(1)}%` : "—"}</strong></div>
      <div class="credit-utilization-track"><span class="${utilization >= 70 ? "high" : utilization >= 30 ? "medium" : ""}" style="width:${Math.min(100, utilization)}%"></span></div>
    </div>
    <div class="credit-card-cycle-grid">
      <div><span>Next statement close</span><strong>${nextClose ? formatDate(nextClose) : "Not configured"}</strong></div>
      <div><span>Next payment date</span><strong>${nextDue ? formatDate(nextDue) : "Not configured"}</strong></div>
    </div>
    ${latest ? `<div class="credit-card-latest-statement">
      <div class="credit-card-statement-title"><div><span>Latest statement</span><strong>${formatDate(latest.statement_date)}</strong></div><span class="credit-card-status ${status.key}">${escapeHTML(status.label)}</span></div>
      <div class="credit-card-statement-figures"><span>Due ${formatMoneyHTML(latest.statement_balance)}</span><span>Paid ${formatMoneyHTML(status.paid)}</span><span>Remaining ${formatMoneyHTML(status.outstanding)}</span></div>
      <div class="credit-payment-track"><span style="width:${progress}%"></span></div>
      <p>${escapeHTML(status.detail)}</p>
    </div>` : `<div class="credit-card-latest-statement empty"><strong>No statement saved</strong><p>Add a statement to track its due date, minimum payment, and payment progress.</p></div>`}
    <div class="credit-card-actions">
      <button class="secondary-button" data-action="record-credit-card-payment" data-id="${account.id}" type="button">Record payment</button>
      <button class="secondary-button" data-action="add-credit-card-statement" data-id="${account.id}" type="button">Add statement</button>
      <button class="text-button" data-action="edit-credit-card-settings" data-id="${account.id}" type="button">Edit settings</button>
    </div>
  </article>`;
}

function creditCardStatementRowHTML(statement) {
  const account = accountById(statement.account_id);
  if (!account) return "";
  const status = creditCardStatementStatus(statement);
  return `<div class="credit-card-statement-row">
    <div class="credit-card-statement-account"><span class="card-network-mini" style="${creditCardVisualStyle(account)}">${creditCardBrandHTML(account, true)}</span><div><strong>${escapeHTML(account.name)}</strong><span>Statement ${formatDate(statement.statement_date)}</span></div></div>
    <div><span class="history-label">Amount due</span><strong>${formatMoneyHTML(statement.statement_balance)}</strong></div>
    <div><span class="history-label">Minimum</span><strong>${formatMoneyHTML(statement.minimum_payment)}</strong></div>
    <div><span class="history-label">Due date</span><strong>${formatDate(statement.due_date)}</strong></div>
    <div><span class="history-label">Paid</span><strong>${formatMoneyHTML(status.paid)}</strong></div>
    <div class="credit-card-statement-status-cell"><span class="credit-card-status ${status.key}">${escapeHTML(status.label)}</span><small>${escapeHTML(status.detail)}</small></div>
    <div class="row-actions"><button class="row-action" data-action="edit-credit-card-statement" data-id="${statement.id}" aria-label="Edit card statement">✎</button><button class="row-action danger" data-action="delete-credit-card-statement" data-id="${statement.id}" aria-label="Delete card statement">×</button></div>
  </div>`;
}

function latestCreditCardStatement(accountId) {
  return state.creditCardStatements
    .filter((statement) => statement.account_id === accountId)
    .sort((a, b) => String(b.statement_date).localeCompare(String(a.statement_date)))[0] || null;
}

function nextCreditCardStatement(statement) {
  return state.creditCardStatements
    .filter((item) => item.account_id === statement.account_id && item.statement_date > statement.statement_date)
    .sort((a, b) => String(a.statement_date).localeCompare(String(b.statement_date)))[0] || null;
}

function creditCardPaymentTransactions(statement) {
  const next = nextCreditCardStatement(statement);
  return state.transactions
    .filter((transaction) => transaction.type === "transfer"
      && transaction.to_account_id === statement.account_id
      && transaction.entry_date >= statement.statement_date
      && transaction.entry_date <= todayISO()
      && (!next || transaction.entry_date < next.statement_date))
    .sort((a, b) => String(a.entry_date).localeCompare(String(b.entry_date)) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

function creditCardStatementStatus(statement) {
  const amountDue = Math.max(0, number(statement.statement_balance));
  const minimum = Math.max(0, number(statement.minimum_payment));
  const payments = creditCardPaymentTransactions(statement);
  let paid = 0;
  let paidInFullDate = "";
  let minimumPaidDate = minimum === 0 ? statement.statement_date : "";
  for (const transaction of payments) {
    paid += number(transaction.amount);
    if (!minimumPaidDate && paid + 0.005 >= minimum) minimumPaidDate = transaction.entry_date;
    if (!paidInFullDate && paid + 0.005 >= amountDue) paidInFullDate = transaction.entry_date;
  }
  const outstanding = Math.max(0, amountDue - paid);
  const dueIn = daysBetweenISO(todayISO(), statement.due_date);
  let key = "open";
  let label = "Open";
  let detail = `${formatMoneyText(outstanding)} remains due by ${formatDate(statement.due_date)}.`;
  if (amountDue <= 0.005 || paid + 0.005 >= amountDue) {
    key = paidInFullDate && paidInFullDate > statement.due_date ? "paid-late" : "paid";
    label = key === "paid-late" ? "Paid late" : "Paid";
    detail = paidInFullDate ? `Paid in full on ${formatDate(paidInFullDate)}.` : "No payment is due for this statement.";
  } else if (statement.due_date < todayISO() && (minimum === 0 || paid + 0.005 < minimum)) {
    key = "overdue";
    label = "Overdue";
    detail = minimum > 0
      ? `${formatMoneyText(Math.max(0, minimum - paid))} is still needed to meet the minimum payment.`
      : `${formatMoneyText(outstanding)} remains unpaid after the due date.`;
  } else if (minimum > 0 && paid + 0.005 >= minimum) {
    key = "minimum-paid";
    label = "Minimum paid";
    detail = `${formatMoneyText(outstanding)} remains on the statement after the minimum payment.`;
  } else if (dueIn >= 0 && dueIn <= 7) {
    key = "due-soon";
    label = dueIn === 0 ? "Due today" : "Due soon";
    detail = `${formatMoneyText(Math.max(0, minimum - paid))} is needed for the minimum payment${dueIn === 0 ? " today" : ` in ${dueIn} day${dueIn === 1 ? "" : "s"}`}.`;
  }
  return { key, label, detail, paid, outstanding, paidInFullDate, minimumPaidDate, payments };
}

function nextDayOfMonth(day, fromISO = todayISO()) {
  const rawDay = Math.round(number(day));
  if (!rawDay) return "";
  const safeDay = Math.max(1, Math.min(31, rawDay));
  const from = new Date(`${fromISO}T12:00:00`);
  for (let offset = 0; offset < 24; offset += 1) {
    const candidate = dateForMonthDay(from.getFullYear(), from.getMonth() + offset, safeDay);
    if (candidate >= fromISO) return candidate;
  }
  return "";
}

function dateForMonthDay(year, zeroBasedMonth, day) {
  const date = new Date(year, zeroBasedMonth, 1);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  return localISODate(new Date(date.getFullYear(), date.getMonth(), Math.min(day, last)));
}

function configuredDueDateForStatement(account, statementDate) {
  const rawDueDay = Math.round(number(account?.payment_due_day));
  if (!rawDueDay || !statementDate) return "";
  const dueDay = Math.max(1, Math.min(31, rawDueDay));
  const date = new Date(`${statementDate}T12:00:00`);
  const sameMonth = dateForMonthDay(date.getFullYear(), date.getMonth(), dueDay);
  return sameMonth > statementDate ? sameMonth : dateForMonthDay(date.getFullYear(), date.getMonth() + 1, dueDay);
}

function daysBetweenISO(fromISO, toISO) {
  if (!fromISO || !toISO) return 0;
  const from = new Date(`${fromISO}T12:00:00`);
  const to = new Date(`${toISO}T12:00:00`);
  return Math.round((to - from) / 86400000);
}

function renderTransactions() {
  renderRecentTransactions();
  renderAllTransactions();
}

function renderRecentTransactions() {
  const items = sortedTransactions().slice(0, 7);
  el.recentTransactions.innerHTML = items.length ? transactionListHTML(items, false) : emptyHTML("No entries yet", "Add an expense, income, or transfer to start your history.");
}

function renderAllTransactions() {
  const search = (el.transactionSearch.value || "").trim().toLowerCase();
  const type = el.transactionTypeFilter.value || "all";
  const account = el.transactionAccountFilter.value || "all";
  const month = el.transactionMonthFilter.value || "";
  const items = sortedTransactions().filter((transaction) => {
    const category = transactionCategorySearchText(transaction);
    const accountText = transactionAccountText(transaction);
    const matchesSearch = !search || [transaction.description, transaction.remarks, category, accountText].some((value) => String(value || "").toLowerCase().includes(search));
    const matchesType = type === "all" || transaction.type === type;
    const matchesAccount = account === "all" || [transaction.account_id, transaction.from_account_id, transaction.to_account_id].includes(account);
    const matchesMonth = !month || transaction.entry_date?.startsWith(month);
    return matchesSearch && matchesType && matchesAccount && matchesMonth;
  });
  el.allTransactions.innerHTML = items.length ? transactionListHTML(items, true) : emptyHTML("No matching entries", "Try changing the filters or add a new entry.");
}

function transactionListHTML(items, showActions) {
  return `<div class="transaction-list">${items.map((transaction) => {
    const category = categoryById(transaction.category_id);
    const splitCount = splitsForTransaction(transaction.id).length;
    const categorySummary = transactionCategorySummary(transaction);
    const title = transaction.description || (transaction.type === "transfer" ? "Account transfer" : splitCount ? "Split transaction" : category?.name || capitalize(transaction.type));
    const subtitle = transaction.type === "transfer" ? transactionAccountText(transaction) : `${categorySummary} · ${transactionAccountText(transaction)}`;
    const sign = transaction.type === "expense" ? "−" : transaction.type === "income" ? "+" : "";
    const remarks = String(transaction.remarks || "").trim();
    const reconciliationBadge = transactionReconciliationBadgeHTML(transaction);
    const receiptAction = transaction.receipt_path ? `<button class="row-action receipt-action" data-action="open-receipt" data-id="${transaction.id}" aria-label="Open receipt" title="Open receipt">▧</button>` : "";
    return `<div class="transaction-row">
      <div class="transaction-main">
        <span class="transaction-icon ${transaction.type}">${transaction.type === "expense" ? "↓" : transaction.type === "income" ? "↑" : "⇄"}</span>
        <div style="min-width:0"><div class="transaction-title">${escapeHTML(title)}</div><div class="transaction-subtitle">${escapeHTML(subtitle)}${splitCount ? ` · <span class="split-indicator">${splitCount} splits</span>` : ""}${transaction.recurring_entry_id ? ' · <span class="recurring-indicator">Recurring</span>' : ""}${transaction.receipt_path ? ' · <span class="receipt-indicator">Receipt</span>' : ""}${reconciliationBadge}</div>${remarks ? `<div class="transaction-remarks">${escapeHTML(remarks)}</div>` : ""}</div>
      </div>
      <div class="transaction-meta account-column">${escapeHTML(transactionAccountText(transaction))}</div>
      <div class="transaction-meta">${formatDate(transaction.entry_date)}</div>
      <div class="amount ${transaction.type}">${sign}${formatMoneyHTML(number(transaction.amount))}</div>
      <div class="row-actions">${receiptAction}${showActions ? `<button class="row-action" data-action="edit-transaction" data-id="${transaction.id}" aria-label="Edit entry">✎</button><button class="row-action danger" data-action="delete-transaction" data-id="${transaction.id}" aria-label="Delete entry">×</button>` : ""}</div>
    </div>`;
  }).join("")}</div>`;
}

function openReconciliationForAccount(accountId) {
  if (!state.accounts.some((account) => account.id === accountId)) return;
  switchView("reconcile");
  el.reconcileAccount.value = accountId;
  el.reconcileStatementBalance.value = "";
  el.reconcileNotes.value = "";
  renderReconciliation();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderReconciliation() {
  if (!el.reconcileSummary) return;
  if (!state.accounts.length) {
    el.reconcileAccount.innerHTML = '<option value="">No accounts available</option>';
    el.reconcileSummary.innerHTML = "";
    el.reconcileTransactionsList.innerHTML = emptyHTML("No accounts to reconcile", "Add an account first, then return here with a statement balance.");
    el.reconciliationHistory.innerHTML = emptyHTML("No reconciliation history", "Completed reconciliations will appear here.");
    el.reconcileLastStatus.textContent = "";
    el.completeReconciliationButton.disabled = true;
    return;
  }

  if (!state.accounts.some((account) => account.id === el.reconcileAccount.value)) {
    el.reconcileAccount.value = state.accounts[0].id;
  }
  const accountId = el.reconcileAccount.value;
  const account = accountById(accountId);
  const statementDate = el.reconcileStatementDate.value || todayISO();
  const hasStatementBalance = String(el.reconcileStatementBalance.value || "").trim() !== "";
  const statementBalance = number(el.reconcileStatementBalance.value);
  const ledgerBalance = calculateAccountBalance(accountId, statementDate);
  const clearedBalance = calculateClearedBalance(accountId, statementDate);
  const difference = hasStatementBalance ? statementBalance - clearedBalance : null;
  const allTransactions = reconciliationTransactions(accountId, statementDate);
  const pendingCount = allTransactions.filter((transaction) => {
    const clearing = clearingFor(transaction.id, accountId);
    return !clearing?.reconciliation_id && !clearing?.is_cleared;
  }).length;
  const clearedPendingCount = allTransactions.filter((transaction) => {
    const clearing = clearingFor(transaction.id, accountId);
    return !clearing?.reconciliation_id && clearing?.is_cleared;
  }).length;

  el.reconcileSummary.innerHTML = [
    reconciliationMoneyCard("Book balance", ledgerBalance, `All entries through ${formatDate(statementDate)}`, tone(ledgerBalance)),
    reconciliationMoneyCard("Cleared balance", clearedBalance, `${clearedPendingCount} newly cleared transaction${clearedPendingCount === 1 ? "" : "s"}`, tone(clearedBalance)),
    reconciliationMoneyCard("Statement balance", statementBalance, hasStatementBalance ? `Ending ${formatDate(statementDate)}` : "Enter the balance from your statement", tone(statementBalance), hasStatementBalance),
    reconciliationMoneyCard("Difference", difference || 0, hasStatementBalance ? "Statement minus cleared balance" : "Waiting for statement balance", difference === null ? "" : Math.abs(difference) < 0.005 ? "positive" : "negative", difference !== null),
  ].join("");

  const last = latestReconciliation(accountId);
  const statementDateIsNew = !last || statementDate > last.statement_date;
  el.reconcileLastStatus.innerHTML = last
    ? `<span class="reconciliation-status-badge">Last reconciled ${formatDate(last.statement_date)} · ${formatMoneyHTML(last.statement_balance)}</span>`
    : '<span class="reconciliation-status-badge pending">Not reconciled yet</span>';

  const showReconciled = el.reconcileShowReconciled.checked;
  const visibleTransactions = allTransactions.filter((transaction) => showReconciled || !clearingFor(transaction.id, accountId)?.reconciliation_id);
  el.reconcileTransactionsList.innerHTML = visibleTransactions.length
    ? `<div class="reconciliation-transaction-list">${visibleTransactions.map((transaction) => reconciliationTransactionHTML(transaction, accountId)).join("")}</div>`
    : emptyHTML(showReconciled ? "No transactions through this date" : "No pending transactions", showReconciled ? "Add entries or choose a later statement date." : "All transactions through this date have already been reconciled.");

  const canFinish = hasStatementBalance && Math.abs(difference) < 0.005 && statementDateIsNew && !reconciliationBusy;
  el.completeReconciliationButton.disabled = !canFinish;
  el.reconcileMarkAllButton.disabled = reconciliationBusy || !visibleTransactions.some((transaction) => !clearingFor(transaction.id, accountId)?.reconciliation_id);
  el.reconcileUnclearAllButton.disabled = reconciliationBusy || !allTransactions.some((transaction) => {
    const clearing = clearingFor(transaction.id, accountId);
    return clearing?.is_cleared && !clearing?.reconciliation_id;
  });
  if (!statementDateIsNew) {
    el.reconcileDifferenceLabel.textContent = "Choose a date after the last reconciliation";
    el.reconcileCompletionHint.textContent = `The latest completed statement ends ${formatDate(last.statement_date)}.`;
  } else if (!hasStatementBalance) {
    el.reconcileDifferenceLabel.textContent = "Enter a statement balance";
    el.reconcileCompletionHint.textContent = `${pendingCount} transaction${pendingCount === 1 ? "" : "s"} not yet cleared.`;
  } else if (Math.abs(difference) < 0.005) {
    el.reconcileDifferenceLabel.textContent = "Difference is zero — ready to finish";
    el.reconcileCompletionHint.textContent = "Finishing locks the cleared transactions into this statement history.";
  } else {
    el.reconcileDifferenceLabel.textContent = `${formatMoneyText(difference)} difference remaining`;
    el.reconcileCompletionHint.textContent = difference > 0 ? "The statement is higher than the cleared balance. Look for missing income or an uncleared debit." : "The statement is lower than the cleared balance. Look for missing expenses or an incorrectly cleared entry.";
  }

  renderReconciliationHistory(accountId);
}

function reconciliationMoneyCard(label, value, detail, className = "", hasValue = true) {
  const display = hasValue ? formatMoneyHTML(value) : '<span class="reconciliation-not-entered">—</span>';
  return `<article class="summary-card"><p class="card-label">${escapeHTML(label)}</p><p class="card-value ${className}">${display}</p><p class="card-detail">${escapeHTML(detail)}</p></article>`;
}

function reconciliationTransactions(accountId, statementDate) {
  return sortedTransactions().filter((transaction) => transaction.entry_date <= statementDate && transactionEffectForAccount(transaction, accountId) !== 0);
}

function reconciliationTransactionHTML(transaction, accountId) {
  const clearing = clearingFor(transaction.id, accountId);
  const reconciled = Boolean(clearing?.reconciliation_id);
  const checked = Boolean(clearing?.is_cleared);
  const effect = transactionEffectForAccount(transaction, accountId);
  const category = categoryById(transaction.category_id);
  const splitCount = splitsForTransaction(transaction.id).length;
  const title = transaction.description || (transaction.type === "transfer" ? "Account transfer" : splitCount ? "Split transaction" : category?.name || capitalize(transaction.type));
  const subtitle = transaction.type === "transfer"
    ? reconciliationTransferText(transaction, accountId)
    : `${transactionCategorySummary(transaction)} · ${formatDate(transaction.entry_date)}`;
  const reconciliation = reconciled ? reconciliationById(clearing.reconciliation_id) : null;
  const status = reconciled
    ? `<span class="reconciliation-row-status reconciled">Reconciled ${reconciliation ? formatDate(reconciliation.statement_date) : ""}</span>`
    : checked
      ? '<span class="reconciliation-row-status cleared">Cleared</span>'
      : '<span class="reconciliation-row-status outstanding">Outstanding</span>';
  return `<div class="reconciliation-transaction-row ${reconciled ? "locked" : ""}">
    <label class="reconciliation-check" title="${reconciled ? "Undo the reconciliation to change this item" : checked ? "Mark as outstanding" : "Mark as cleared"}">
      <input type="checkbox" ${checked ? "checked" : ""} ${reconciled || reconciliationBusy ? "disabled" : ""} data-action="toggle-reconciliation-cleared" data-id="${transaction.id}" data-account-id="${accountId}" />
      <span aria-hidden="true"></span>
    </label>
    <span class="transaction-icon ${transaction.type}">${transaction.type === "expense" ? "↓" : transaction.type === "income" ? "↑" : "⇄"}</span>
    <div class="reconciliation-transaction-copy"><strong>${escapeHTML(title)}</strong><span>${escapeHTML(subtitle)}</span>${transaction.remarks ? `<small>${escapeHTML(transaction.remarks)}</small>` : ""}</div>
    <div class="reconciliation-row-status-wrap">${status}</div>
    <div class="reconciliation-effect ${tone(effect)}">${effect > 0 ? "+" : effect < 0 ? "−" : ""}${formatMoneyHTML(Math.abs(effect))}</div>
  </div>`;
}

function reconciliationTransferText(transaction, accountId) {
  if (transaction.from_account_id === accountId) return `Transfer to ${accountById(transaction.to_account_id)?.name || "Unknown account"} · ${formatDate(transaction.entry_date)}`;
  return `Transfer from ${accountById(transaction.from_account_id)?.name || "Unknown account"} · ${formatDate(transaction.entry_date)}`;
}

function renderReconciliationHistory(accountId) {
  const history = [...state.reconciliations]
    .filter((item) => item.account_id === accountId)
    .sort((a, b) => String(b.statement_date).localeCompare(String(a.statement_date)) || String(b.completed_at).localeCompare(String(a.completed_at)));
  if (!history.length) {
    el.reconciliationHistory.innerHTML = emptyHTML("No completed reconciliations", "When the difference reaches zero, finish the reconciliation to create an audit record.");
    return;
  }
  el.reconciliationHistory.innerHTML = `<div class="reconciliation-history-list">${history.map((item) => {
    const transactionCount = state.transactionClearings.filter((clearing) => clearing.reconciliation_id === item.id).length;
    return `<article class="reconciliation-history-row">
      <div class="reconciliation-history-date"><strong>${formatDate(item.statement_date)}</strong><span>${escapeHTML(item.notes || "Statement reconciliation")}</span></div>
      <div><span class="history-label">Statement</span><strong>${formatMoneyHTML(item.statement_balance)}</strong></div>
      <div><span class="history-label">Book balance</span><strong>${formatMoneyHTML(item.ledger_balance)}</strong></div>
      <div><span class="history-label">Transactions</span><strong>${transactionCount.toLocaleString("en-AE")}</strong></div>
      <button class="row-action wide danger" data-action="undo-reconciliation" data-id="${item.id}" type="button">Undo</button>
    </article>`;
  }).join("")}</div>`;
}

async function toggleTransactionCleared(transactionId, accountId) {
  if (reconciliationBusy) return;
  const transaction = state.transactions.find((item) => item.id === transactionId);
  if (!transaction || transactionEffectForAccount(transaction, accountId) === 0) return;
  const existing = clearingFor(transactionId, accountId);
  if (existing?.reconciliation_id) return showToast("This transaction is locked by a completed reconciliation.", true);
  await saveClearingStates([{ transactionId, accountId }], !existing?.is_cleared);
}

async function bulkSetReconciliationCleared(isCleared) {
  if (reconciliationBusy) return;
  const accountId = el.reconcileAccount.value;
  const statementDate = el.reconcileStatementDate.value || todayISO();
  const pairs = reconciliationTransactions(accountId, statementDate)
    .filter((transaction) => {
      const clearing = clearingFor(transaction.id, accountId);
      return !clearing?.reconciliation_id && Boolean(clearing?.is_cleared) !== isCleared;
    })
    .map((transaction) => ({ transactionId: transaction.id, accountId }));
  if (!pairs.length) return;
  await saveClearingStates(pairs, isCleared);
}

async function saveClearingStates(pairs, isCleared) {
  reconciliationBusy = true;
  renderReconciliation();
  const now = new Date().toISOString();
  try {
    if (mode === "cloud") {
      setSyncStatus("syncing", "Saving cleared transactions");
      const rows = pairs.map(({ transactionId, accountId }) => ({
        user_id: user.id,
        transaction_id: transactionId,
        account_id: accountId,
        is_cleared: isCleared,
        cleared_at: isCleared ? now : null,
        reconciliation_id: null,
      }));
      const { data, error } = await supabase.from("transaction_clearings")
        .upsert(rows, { onConflict: "user_id,transaction_id,account_id" })
        .select();
      if (error) throw error;
      mergeTransactionClearings(data || []);
      setSyncStatus("cloud", "Cloud synchronized");
    } else {
      pairs.forEach(({ transactionId, accountId }) => {
        const index = state.transactionClearings.findIndex((item) => item.transaction_id === transactionId && item.account_id === accountId);
        if (index >= 0) {
          state.transactionClearings[index] = { ...state.transactionClearings[index], is_cleared: isCleared, cleared_at: isCleared ? now : null, reconciliation_id: null, updated_at: now };
        } else {
          state.transactionClearings.push(localRow({ transaction_id: transactionId, account_id: accountId, is_cleared: isCleared, cleared_at: isCleared ? now : null, reconciliation_id: null }));
        }
      });
      persistLocal();
    }
  } catch (error) {
    setSyncStatus(mode === "cloud" ? "local" : "local", mode === "cloud" ? "Sync error" : "Local browser only");
    showToast(friendlyError(error), true);
  } finally {
    reconciliationBusy = false;
    render();
  }
}

function mergeTransactionClearings(rows) {
  const incoming = new Map(rows.map((row) => [`${row.transaction_id}:${row.account_id}`, row]));
  state.transactionClearings = state.transactionClearings.map((row) => incoming.get(`${row.transaction_id}:${row.account_id}`) || row);
  const existingKeys = new Set(state.transactionClearings.map((row) => `${row.transaction_id}:${row.account_id}`));
  rows.forEach((row) => {
    const key = `${row.transaction_id}:${row.account_id}`;
    if (!existingKeys.has(key)) state.transactionClearings.push(row);
  });
}

async function completeReconciliation() {
  if (reconciliationBusy) return;
  el.reconcileFormError.textContent = "";
  const accountId = el.reconcileAccount.value;
  const statementDate = el.reconcileStatementDate.value;
  const balanceText = String(el.reconcileStatementBalance.value || "").trim();
  const notes = el.reconcileNotes.value.trim();
  if (!accountId) return showFormError(el.reconcileFormError, "Choose an account.");
  if (!statementDate) return showFormError(el.reconcileFormError, "Choose the statement ending date.");
  if (!balanceText) return showFormError(el.reconcileFormError, "Enter the statement ending balance.");
  if (notes.length > 300) return showFormError(el.reconcileFormError, "Statement note must be 300 characters or fewer.");
  const last = latestReconciliation(accountId);
  if (last && statementDate <= last.statement_date) return showFormError(el.reconcileFormError, `Choose a statement date after ${formatDate(last.statement_date)}, or undo that reconciliation first.`);
  const statementBalance = number(balanceText);
  const clearedBalance = calculateClearedBalance(accountId, statementDate);
  const ledgerBalance = calculateAccountBalance(accountId, statementDate);
  const difference = statementBalance - clearedBalance;
  if (Math.abs(difference) >= 0.005) return showFormError(el.reconcileFormError, `The difference must be zero before finishing. Current difference: ${formatMoneyText(difference)}.`);

  const pendingClearings = state.transactionClearings.filter((clearing) => {
    if (clearing.account_id !== accountId || !clearing.is_cleared || clearing.reconciliation_id) return false;
    const transaction = state.transactions.find((item) => item.id === clearing.transaction_id);
    return transaction && transaction.entry_date <= statementDate && transactionEffectForAccount(transaction, accountId) !== 0;
  });
  const row = {
    account_id: accountId,
    statement_date: statementDate,
    statement_balance: statementBalance,
    cleared_balance: clearedBalance,
    ledger_balance: ledgerBalance,
    difference,
    notes,
    completed_at: new Date().toISOString(),
  };

  reconciliationBusy = true;
  renderReconciliation();
  let inserted = null;
  try {
    inserted = await insertRow("reconciliations", row);
    const clearingIds = pendingClearings.map((item) => item.id);
    if (mode === "cloud" && clearingIds.length) {
      setSyncStatus("syncing", "Finishing reconciliation");
      const { data, error } = await supabase.from("transaction_clearings")
        .update({ reconciliation_id: inserted.id, cleared_at: new Date().toISOString() })
        .in("id", clearingIds)
        .select();
      if (error) throw error;
      mergeTransactionClearings(data || []);
      setSyncStatus("cloud", "Cloud synchronized");
    } else if (mode === "local") {
      state.transactionClearings = state.transactionClearings.map((item) => clearingIds.includes(item.id) ? { ...item, reconciliation_id: inserted.id, updated_at: new Date().toISOString() } : item);
    }
    state.reconciliations.unshift(inserted);
    persistLocal();
    el.reconcileStatementBalance.value = "";
    el.reconcileNotes.value = "";
    showToast(`Reconciliation completed for ${accountById(accountId)?.name || "account"}.`);
  } catch (error) {
    if (inserted?.id) {
      try { await deleteRow("reconciliations", inserted.id); } catch (rollbackError) { console.warn("Could not roll back reconciliation", rollbackError); }
    }
    showFormError(el.reconcileFormError, friendlyError(error));
  } finally {
    reconciliationBusy = false;
    render();
  }
}

async function undoReconciliation(id) {
  if (reconciliationBusy) return;
  const reconciliation = reconciliationById(id);
  if (!reconciliation) return;
  const account = accountById(reconciliation.account_id);
  if (!confirm(`Undo the ${formatDate(reconciliation.statement_date)} reconciliation for ${account?.name || "this account"}? The linked transactions will become outstanding again.`)) return;
  reconciliationBusy = true;
  try {
    if (mode === "cloud") {
      setSyncStatus("syncing", "Undoing reconciliation");
      const { data, error } = await supabase.from("transaction_clearings")
        .update({ reconciliation_id: null, is_cleared: false, cleared_at: null })
        .eq("reconciliation_id", id)
        .select();
      if (error) throw error;
      mergeTransactionClearings(data || []);
      await deleteRow("reconciliations", id);
      setSyncStatus("cloud", "Cloud synchronized");
    } else {
      state.transactionClearings = state.transactionClearings.map((item) => item.reconciliation_id === id ? { ...item, reconciliation_id: null, is_cleared: false, cleared_at: null, updated_at: new Date().toISOString() } : item);
    }
    state.reconciliations = state.reconciliations.filter((item) => item.id !== id);
    persistLocal();
    el.reconcileAccount.value = reconciliation.account_id;
    el.reconcileStatementDate.value = reconciliation.statement_date;
    el.reconcileStatementBalance.value = number(reconciliation.statement_balance).toFixed(2);
    el.reconcileNotes.value = reconciliation.notes || "";
    showToast("Reconciliation undone. Review the transactions and finish again when ready.");
  } catch (error) {
    showToast(friendlyError(error), true);
  } finally {
    reconciliationBusy = false;
    render();
  }
}

function calculateClearedBalance(accountId, throughDate) {
  const account = accountById(accountId);
  if (!account) return 0;
  return state.transactions.reduce((balance, transaction) => {
    if (throughDate && transaction.entry_date > throughDate) return balance;
    const effect = transactionEffectForAccount(transaction, accountId);
    if (!effect) return balance;
    const clearing = clearingFor(transaction.id, accountId);
    return clearing?.is_cleared ? balance + effect : balance;
  }, number(account.opening_balance));
}

function transactionEffectForAccount(transaction, accountId) {
  const amount = number(transaction.amount);
  if (transaction.type === "income" && transaction.account_id === accountId) return amount;
  if (transaction.type === "expense" && transaction.account_id === accountId) return -amount;
  if (transaction.type === "transfer" && transaction.from_account_id === accountId) return -amount;
  if (transaction.type === "transfer" && transaction.to_account_id === accountId) return amount;
  return 0;
}

function affectedAccountIds(transaction) {
  return transaction.type === "transfer"
    ? [transaction.from_account_id, transaction.to_account_id].filter(Boolean)
    : [transaction.account_id].filter(Boolean);
}

function clearingFor(transactionId, accountId) {
  return state.transactionClearings.find((item) => item.transaction_id === transactionId && item.account_id === accountId);
}

function reconciliationById(id) {
  return state.reconciliations.find((item) => item.id === id);
}

function latestReconciliation(accountId) {
  return [...state.reconciliations]
    .filter((item) => item.account_id === accountId)
    .sort((a, b) => String(b.statement_date).localeCompare(String(a.statement_date)) || String(b.completed_at).localeCompare(String(a.completed_at)))[0] || null;
}

function transactionHasReconciledSide(transaction) {
  return affectedAccountIds(transaction).some((accountId) => Boolean(clearingFor(transaction.id, accountId)?.reconciliation_id));
}

function transactionReconciliationBadgeHTML(transaction) {
  const statuses = affectedAccountIds(transaction).map((accountId) => clearingFor(transaction.id, accountId)).filter(Boolean);
  if (!statuses.length) return "";
  const reconciledCount = statuses.filter((item) => item.reconciliation_id).length;
  const clearedCount = statuses.filter((item) => item.is_cleared).length;
  if (reconciledCount === affectedAccountIds(transaction).length) return ' · <span class="reconciled-indicator">Reconciled</span>';
  if (reconciledCount) return ' · <span class="reconciled-indicator partial">Partly reconciled</span>';
  if (clearedCount) return ' · <span class="cleared-indicator">Cleared</span>';
  return "";
}

async function cleanupTransactionClearingsForTransaction(transactionId, transaction) {
  const validAccounts = new Set(affectedAccountIds(transaction));
  const stale = state.transactionClearings.filter((item) => item.transaction_id === transactionId && !validAccounts.has(item.account_id) && !item.reconciliation_id);
  if (!stale.length) return;
  if (mode === "cloud") {
    const { error } = await supabase.from("transaction_clearings").delete().in("id", stale.map((item) => item.id));
    if (error) throw error;
  }
  const staleIds = new Set(stale.map((item) => item.id));
  state.transactionClearings = state.transactionClearings.filter((item) => !staleIds.has(item.id));
}


function renderCategoryChart() {
  const month = todayISO().slice(0, 7);
  const totals = categoryTotals(state.transactions.filter((item) => item.type === "expense" && item.entry_date?.startsWith(month)));
  el.categoryChart.innerHTML = categoryBarsHTML(totals, "No spending this month");
}

function renderCashFlowChart() {
  el.cashFlowChart.innerHTML = cashFlowBarsHTML(monthSeries(6, new Date()));
}



function renderRecurringEntries() {
  if (!el.recurringEntriesList) return;
  const entries = state.recurringEntries || [];
  const status = el.recurringStatusFilter.value || "all";
  const type = el.recurringTypeFilter.value || "all";
  const inThirtyDays = addDaysISO(todayISO(), 30);
  const upcoming = plannedOccurrencesBetween(todayISO(), inThirtyDays);
  const activeCount = entries.filter((item) => item.active !== false).length;
  const autoCount = entries.filter((item) => item.active !== false && item.auto_post !== false).length;
  const upcomingExpenses = upcoming.filter((item) => item.rule.type === "expense").reduce((sum, item) => sum + number(item.rule.amount), 0);
  const upcomingIncome = upcoming.filter((item) => item.rule.type === "income").reduce((sum, item) => sum + number(item.rule.amount), 0);

  el.recurringSummary.innerHTML = [
    summaryCard("Active schedules", activeCount, `${autoCount} post automatically`, activeCount ? "positive" : "", false),
    summaryCard("Next 30 days", upcoming.length, "Planned occurrences", "", false),
    summaryCard("Planned expenses", upcomingExpenses, "Next 30 days", upcomingExpenses ? "negative" : ""),
    summaryCard("Planned income", upcomingIncome, "Next 30 days", upcomingIncome ? "positive" : ""),
  ].join("");

  const filtered = entries
    .filter((item) => status === "all" || (status === "active" ? item.active !== false : item.active === false))
    .filter((item) => type === "all" || item.type === type)
    .sort((a, b) => Number(b.active !== false) - Number(a.active !== false) || String(a.start_date).localeCompare(String(b.start_date)));

  el.recurringEntriesList.innerHTML = filtered.length
    ? `<div class="recurring-list">${filtered.map(recurringCardHTML).join("")}</div>`
    : emptyHTML("No matching recurring entries", "Create a schedule for salary, subscriptions, bills, loan payments, or transfers.");
}

function recurringCardHTML(rule) {
  const active = rule.active !== false;
  const dueDate = earliestDueUnpostedOccurrence(rule);
  const nextDate = nextUnpostedOccurrence(rule, todayISO());
  const target = recurringTargetText(rule);
  const icon = rule.type === "expense" ? "↓" : rule.type === "income" ? "↑" : "⇄";
  const sign = rule.type === "expense" ? "−" : rule.type === "income" ? "+" : "";
  const title = rule.description || (rule.type === "transfer" ? "Recurring transfer" : categoryById(rule.category_id)?.name || `Recurring ${rule.type}`);
  const nextCopy = dueDate
    ? `Due ${formatDate(dueDate)}`
    : nextDate
      ? `Next ${formatDate(nextDate)}`
      : active ? "No future occurrence" : "Schedule paused";
  const endCopy = rule.end_date ? `Ends ${formatDate(rule.end_date)}` : "Continues until stopped";
  return `<article class="recurring-card ${active ? "" : "paused"}">
    <div class="recurring-card-main">
      <div class="recurring-card-heading">
        <span class="recurring-type-icon ${rule.type}">${icon}</span>
        <div class="recurring-card-title"><strong>${escapeHTML(title)}</strong><span>${escapeHTML(target)}</span></div>
      </div>
      <div class="recurring-card-details">
        <span class="recurring-chip ${active ? "active" : "paused"}">${active ? "Active" : "Paused"}</span>
        <span class="recurring-chip">${escapeHTML(recurringScheduleText(rule))}</span>
        <span class="recurring-chip">${escapeHTML(endCopy)}</span>
        ${rule.auto_post !== false ? '<span class="recurring-chip auto">Auto-post</span>' : '<span class="recurring-chip">Manual posting</span>'}
        <span class="recurring-chip">${escapeHTML(nextCopy)}</span>
      </div>
      ${rule.remarks ? `<div class="recurring-card-remarks">${escapeHTML(rule.remarks)}</div>` : ""}
    </div>
    <div class="recurring-card-side">
      <div class="recurring-card-amount amount ${rule.type}">${sign}${formatMoneyHTML(rule.amount)}</div>
      <div class="recurring-card-actions">
        ${dueDate ? `<button class="row-action wide" data-action="post-recurring" data-id="${rule.id}" data-date="${dueDate}" title="Post the due occurrence">Post due</button>` : ""}
        <button class="row-action wide" data-action="toggle-recurring" data-id="${rule.id}">${active ? "Pause" : "Resume"}</button>
        <button class="row-action" data-action="edit-recurring" data-id="${rule.id}" aria-label="Edit recurring entry">✎</button>
        <button class="row-action danger" data-action="delete-recurring" data-id="${rule.id}" aria-label="Delete recurring entry">×</button>
      </div>
    </div>
  </article>`;
}

function recurringScheduleText(rule) {
  const interval = Math.max(1, Math.trunc(number(rule.interval_value) || 1));
  const unit = recurrenceUnit(rule.frequency, interval);
  return `Every ${interval === 1 ? "" : `${interval} `}${unit} · starts ${formatDate(rule.start_date)}`;
}

function recurringTargetText(rule) {
  if (rule.type === "transfer") {
    return `${accountById(rule.from_account_id)?.name || "Unknown"} → ${accountById(rule.to_account_id)?.name || "Unknown"}`;
  }
  return `${categoryById(rule.category_id)?.name || "Uncategorized"} · ${accountById(rule.account_id)?.name || "Unknown account"}`;
}

function setRecurringType(type) {
  el.recurringType.value = type;
  document.querySelectorAll("[data-recurring-type]").forEach((button) => button.classList.toggle("active", button.dataset.recurringType === type));
  document.querySelectorAll(".recurring-expense-income-field").forEach((field) => field.hidden = type === "transfer");
  document.querySelectorAll(".recurring-transfer-field").forEach((field) => field.hidden = type !== "transfer");
  document.querySelectorAll(".recurring-reminder-field").forEach((field) => field.hidden = type !== "expense");
  el.recurringAccountLabel.textContent = type === "income" ? "Add to account" : "Pay from account";
  el.recurringCategoryLabel.textContent = type === "income" ? "Income category" : "Expense category";
  renderRecurringCategories(type);
}

function updateRecurringIntervalUnit() {
  const interval = Math.max(1, Math.trunc(number(el.recurringInterval.value) || 1));
  el.recurringIntervalUnit.textContent = recurrenceUnit(el.recurringFrequency.value, interval);
}

function recurrenceUnit(frequency, interval = 1) {
  const singular = { daily: "day", weekly: "week", monthly: "month", yearly: "year" }[frequency] || "month";
  return interval === 1 ? singular : `${singular}s`;
}

function updateRecurringEndDateVisibility() {
  const hasEnd = el.recurringEndMode.value === "date";
  el.recurringEndDateField.hidden = !hasEnd;
  el.recurringEndDate.required = hasEnd;
  if (!hasEnd) el.recurringEndDate.value = "";
}

function openRecurringModal(id = null, presetType = "expense") {
  if (!state.accounts.length) return showToast("Add an account before creating a recurring entry.", true);
  el.recurringForm.reset();
  el.recurringId.value = "";
  el.recurringStartDate.value = todayISO();
  el.recurringFrequency.value = "monthly";
  el.recurringInterval.value = "1";
  el.recurringEndMode.value = "never";
  el.recurringAutoPost.checked = true;
  el.recurringReminderDays.value = "3";
  el.recurringFormError.textContent = "";
  let type = presetType || "expense";
  if (id) {
    const rule = state.recurringEntries.find((item) => item.id === id);
    if (!rule) return;
    type = rule.type;
    el.recurringId.value = rule.id;
    el.recurringAmount.value = number(rule.amount);
    el.recurringDescription.value = rule.description || "";
    el.recurringRemarks.value = rule.remarks || "";
    el.recurringFrequency.value = rule.frequency || "monthly";
    el.recurringInterval.value = Math.max(1, Math.trunc(number(rule.interval_value) || 1));
    el.recurringStartDate.value = rule.start_date || todayISO();
    el.recurringEndMode.value = rule.end_date ? "date" : "never";
    el.recurringEndDate.value = rule.end_date || "";
    el.recurringAutoPost.checked = rule.auto_post !== false;
    el.recurringReminderDays.value = String(Math.max(0, Math.trunc(number(rule.reminder_days_before) || 0)));
    setRecurringType(type);
    if (type === "transfer") {
      el.recurringFromAccount.value = rule.from_account_id || "";
      el.recurringToAccount.value = rule.to_account_id || "";
    } else {
      el.recurringAccount.value = rule.account_id || "";
      el.recurringCategory.value = rule.category_id || "";
    }
    el.recurringModalTitle.textContent = "Edit recurring entry";
  } else {
    setRecurringType(type);
    el.recurringModalTitle.textContent = "Add recurring entry";
  }
  updateRecurringIntervalUnit();
  updateRecurringEndDateVisibility();
  openModal(el.recurringModal);
  el.recurringAmount.focus();
}

async function handleRecurringSubmit(event) {
  event.preventDefault();
  el.recurringFormError.textContent = "";
  const id = el.recurringId.value;
  const type = el.recurringType.value;
  const amount = number(el.recurringAmount.value);
  const interval = Math.trunc(number(el.recurringInterval.value));
  const row = {
    type,
    amount,
    description: el.recurringDescription.value.trim(),
    remarks: el.recurringRemarks.value.trim(),
    frequency: el.recurringFrequency.value,
    interval_value: interval,
    start_date: el.recurringStartDate.value,
    end_date: el.recurringEndMode.value === "date" ? el.recurringEndDate.value : null,
    auto_post: el.recurringAutoPost.checked,
    reminder_days_before: Math.max(0, Math.min(365, Math.trunc(number(el.recurringReminderDays.value) || 0))),
    account_id: null,
    category_id: null,
    from_account_id: null,
    to_account_id: null,
  };
  if (!(amount > 0)) return showFormError(el.recurringFormError, "Enter an amount greater than zero.");
  if (!(interval >= 1 && interval <= 365)) return showFormError(el.recurringFormError, "Repeat every must be between 1 and 365.");
  if (!row.start_date) return showFormError(el.recurringFormError, "Choose a start date.");
  if (row.end_date && row.end_date < row.start_date) return showFormError(el.recurringFormError, "End date cannot be before the start date.");
  if (row.description.length > 120) return showFormError(el.recurringFormError, "Description must be 120 characters or fewer.");
  if (row.remarks.length > 2000) return showFormError(el.recurringFormError, "Remarks must be 2,000 characters or fewer.");
  if (type === "transfer") {
    row.from_account_id = el.recurringFromAccount.value;
    row.to_account_id = el.recurringToAccount.value;
    if (!row.from_account_id || !row.to_account_id) return showFormError(el.recurringFormError, "Choose both transfer accounts.");
    if (row.from_account_id === row.to_account_id) return showFormError(el.recurringFormError, "Choose two different accounts.");
  } else {
    row.account_id = el.recurringAccount.value;
    row.category_id = el.recurringCategory.value || null;
    if (!row.account_id) return showFormError(el.recurringFormError, "Choose an account.");
    if (!row.category_id) return showFormError(el.recurringFormError, `Create or select an ${type} category.`);
  }

  try {
    if (id) {
      const updated = await updateRow("recurring_entries", id, row);
      state.recurringEntries = state.recurringEntries.map((item) => item.id === id ? { ...item, ...updated } : item);
      showToast("Recurring entry updated.");
    } else {
      state.recurringEntries.push(await insertRow("recurring_entries", { ...row, active: true }));
      showToast("Recurring entry created.");
    }
    persistLocal();
    closeModal(el.recurringModal);
    await postDueRecurringEntries();
    render();
  } catch (error) {
    showFormError(el.recurringFormError, friendlyError(error));
  }
}

async function toggleRecurringEntry(id) {
  const rule = state.recurringEntries.find((item) => item.id === id);
  if (!rule) return;
  try {
    const updated = await updateRow("recurring_entries", id, { active: rule.active === false });
    state.recurringEntries = state.recurringEntries.map((item) => item.id === id ? { ...item, ...updated } : item);
    persistLocal();
    if (updated.active !== false) await postDueRecurringEntries();
    render();
    showToast(updated.active === false ? "Recurring entry paused." : "Recurring entry resumed.");
  } catch (error) { showToast(friendlyError(error), true); }
}

async function deleteRecurringEntry(id) {
  const rule = state.recurringEntries.find((item) => item.id === id);
  if (!rule || !confirm("Delete this recurring schedule? Transactions already posted from it will remain.")) return;
  try {
    await deleteRow("recurring_entries", id);
    state.recurringEntries = state.recurringEntries.filter((item) => item.id !== id);
    state.transactions = state.transactions.map((transaction) => transaction.recurring_entry_id === id ? { ...transaction, recurring_entry_id: null } : transaction);
    persistLocal();
    render();
    showToast("Recurring schedule deleted. Posted transactions were kept.");
  } catch (error) { showToast(friendlyError(error), true); }
}

async function postDueRecurringEntries() {
  if (postingRecurringEntries || !(state.recurringEntries || []).length) return 0;
  postingRecurringEntries = true;
  try {
    const today = todayISO();
    const existing = new Set(state.transactions.filter((item) => item.recurring_entry_id && item.scheduled_date).map(transactionOccurrenceKey));
    const rows = [];
    for (const rule of state.recurringEntries) {
      if (rule.active === false || rule.auto_post === false) continue;
      const occurrences = recurringOccurrencesBetween(rule, rule.start_date, today, 5000);
      for (const date of occurrences) {
        const key = `${rule.id}|${date}`;
        if (!existing.has(key)) {
          rows.push(transactionFromRecurring(rule, date));
          existing.add(key);
        }
      }
    }
    if (!rows.length) return 0;
    if (rows.length > 5000) throw new Error("This schedule would create more than 5,000 due entries. Shorten its date range before enabling automatic posting.");
    if (mode === "cloud") {
      setSyncStatus("syncing", "Posting recurring entries");
      for (const batch of chunk(rows, 100)) {
        const { data, error } = await supabase.from("transactions").insert(batch.map((row) => ({ ...row, user_id: user.id }))).select();
        if (error) throw error;
        state.transactions.push(...(data || []));
      }
      setSyncStatus("cloud", "Cloud synchronized");
    } else {
      state.transactions.push(...rows.map(localRow));
      persistLocal();
    }
    showToast(`${rows.length} recurring ${rows.length === 1 ? "entry" : "entries"} posted.`);
    return rows.length;
  } finally {
    postingRecurringEntries = false;
  }
}

async function postRecurringOccurrenceById(id, date) {
  const rule = state.recurringEntries.find((item) => item.id === id);
  if (!rule || !date) return;
  if (date > todayISO()) return showToast("Future recurring entries remain planned until their date arrives.", true);
  if (hasPostedOccurrence(rule.id, date)) return showToast("This recurring occurrence is already posted.", true);
  try {
    const inserted = await insertRow("transactions", transactionFromRecurring(rule, date));
    state.transactions.push(inserted);
    persistLocal();
    render();
    showToast("Recurring occurrence posted.");
  } catch (error) { showToast(friendlyError(error), true); }
}

function transactionFromRecurring(rule, date) {
  return {
    type: rule.type,
    amount: number(rule.amount),
    entry_date: date,
    scheduled_date: date,
    recurring_entry_id: rule.id,
    description: rule.description || "",
    remarks: rule.remarks || "",
    account_id: rule.type === "transfer" ? null : rule.account_id,
    category_id: rule.type === "transfer" ? null : rule.category_id,
    from_account_id: rule.type === "transfer" ? rule.from_account_id : null,
    to_account_id: rule.type === "transfer" ? rule.to_account_id : null,
  };
}

function transactionOccurrenceKey(transaction) {
  return `${transaction.recurring_entry_id}|${transaction.scheduled_date}`;
}

function hasPostedOccurrence(ruleId, date) {
  return state.transactions.some((transaction) => transaction.recurring_entry_id === ruleId && transaction.scheduled_date === date);
}

function earliestDueUnpostedOccurrence(rule) {
  if (rule.active === false) return "";
  return recurringOccurrencesBetween(rule, rule.start_date, todayISO(), 50000).find((date) => !hasPostedOccurrence(rule.id, date)) || "";
}

function nextUnpostedOccurrence(rule, fromDate = todayISO()) {
  if (rule.active === false) return "";
  const horizon = rule.end_date || addYearsISO(fromDate, 5);
  return recurringOccurrencesBetween(rule, fromDate, horizon, 2500).find((date) => !hasPostedOccurrence(rule.id, date)) || "";
}

function plannedOccurrencesBetween(startDate, endDate, accountId = "all") {
  const occurrences = [];
  for (const rule of state.recurringEntries || []) {
    if (rule.active === false || !recurringMatchesAccount(rule, accountId)) continue;
    for (const date of recurringOccurrencesBetween(rule, startDate, endDate, 5000)) {
      if (!hasPostedOccurrence(rule.id, date)) occurrences.push({ rule, date });
    }
  }
  return occurrences.sort((a, b) => a.date.localeCompare(b.date) || String(a.rule.created_at).localeCompare(String(b.rule.created_at)));
}

function plannedOccurrencesForDate(date, accountId = "all") {
  return plannedOccurrencesBetween(date, date, accountId);
}

function recurringMatchesAccount(rule, accountId) {
  return accountId === "all" || [rule.account_id, rule.from_account_id, rule.to_account_id].includes(accountId);
}

function recurringOccurrencesBetween(rule, rangeStart, rangeEnd, maxOccurrences = 5000) {
  if (!rule?.start_date || !rangeStart || !rangeEnd || rangeEnd < rangeStart) return [];
  const effectiveEnd = rule.end_date && rule.end_date < rangeEnd ? rule.end_date : rangeEnd;
  if (effectiveEnd < rule.start_date || effectiveEnd < rangeStart) return [];
  const interval = Math.max(1, Math.trunc(number(rule.interval_value) || 1));
  let index = approximateOccurrenceIndex(rule, rangeStart, interval);
  const results = [];
  for (let guard = 0; guard < maxOccurrences + 2; guard += 1, index += 1) {
    const date = recurringOccurrenceDate(rule, index, interval);
    if (!date || date > effectiveEnd) break;
    if (date >= rangeStart && date >= rule.start_date) results.push(date);
    if (results.length > maxOccurrences) throw new Error("Recurring date range is too large. Shorten the schedule or increase its repeat interval.");
  }
  return results;
}

function approximateOccurrenceIndex(rule, rangeStart, interval) {
  const start = parseISODate(rule.start_date);
  const range = parseISODate(rangeStart);
  if (!start || !range || range <= start) return 0;
  if (rule.frequency === "daily") return Math.max(0, Math.floor(daysBetween(start, range) / interval) - 1);
  if (rule.frequency === "weekly") return Math.max(0, Math.floor(daysBetween(start, range) / (interval * 7)) - 1);
  if (rule.frequency === "yearly") return Math.max(0, Math.floor((range.getFullYear() - start.getFullYear()) / interval) - 1);
  const months = (range.getFullYear() - start.getFullYear()) * 12 + range.getMonth() - start.getMonth();
  return Math.max(0, Math.floor(months / interval) - 1);
}

function recurringOccurrenceDate(rule, index, interval) {
  const start = parseISODate(rule.start_date);
  if (!start) return "";
  const year = start.getFullYear();
  const month = start.getMonth();
  const day = start.getDate();
  let date;
  if (rule.frequency === "daily") {
    date = new Date(year, month, day + index * interval);
  } else if (rule.frequency === "weekly") {
    date = new Date(year, month, day + index * interval * 7);
  } else if (rule.frequency === "yearly") {
    const targetYear = year + index * interval;
    date = new Date(targetYear, month, Math.min(day, daysInMonth(targetYear, month)));
  } else {
    const targetMonthIndex = month + index * interval;
    const targetYear = year + Math.floor(targetMonthIndex / 12);
    const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
    date = new Date(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
  }
  return localISODate(date);
}

function parseISODate(value) {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function daysBetween(start, end) {
  const dayMs = 86400000;
  return Math.floor((Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) - Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) / dayMs);
}

function addDaysISO(value, days) {
  const date = parseISODate(value);
  if (!date) return value;
  date.setDate(date.getDate() + days);
  return localISODate(date);
}

function addYearsISO(value, years) {
  const date = parseISODate(value);
  if (!date) return value;
  const targetYear = date.getFullYear() + years;
  return validISODate(targetYear, date.getMonth() + 1, Math.min(date.getDate(), daysInMonth(targetYear, date.getMonth())));
}




function billById(id) {
  return state.bills.find((bill) => bill.id === id);
}

function billStatusInfo(bill) {
  if (bill.status === "paid") {
    return { key: "paid", label: "Paid", detail: bill.paid_at ? `Paid ${formatDate(String(bill.paid_at).slice(0, 10))}` : "Marked paid" };
  }
  const today = todayISO();
  const days = daysBetweenISO(today, bill.due_date);
  if (bill.due_date < today) return { key: "overdue", label: "Overdue", detail: `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue` };
  if (days === 0) return { key: "due-today", label: "Due today", detail: "Payment is due today" };
  const snoozed = bill.snoozed_until && bill.snoozed_until > today;
  const reminderDays = Math.max(0, Math.trunc(number(bill.reminder_days_before) || 0));
  if (!snoozed && days <= reminderDays) return { key: "due-soon", label: "Reminder", detail: `Due in ${days} day${days === 1 ? "" : "s"}` };
  if (snoozed) return { key: "snoozed", label: "Snoozed", detail: `Hidden until ${formatDate(bill.snoozed_until)}` };
  return { key: "upcoming", label: "Upcoming", detail: `Due in ${days} day${days === 1 ? "" : "s"}` };
}

function openOneTimeBills() {
  return state.bills.filter((bill) => bill.status !== "paid");
}

function billsDueBetween(startDate, endDate, accountId = "all") {
  return state.bills
    .filter((bill) => bill.status !== "paid" && bill.due_date >= startDate && bill.due_date <= endDate)
    .filter((bill) => accountId === "all" || bill.account_id === accountId)
    .sort((a, b) => a.due_date.localeCompare(b.due_date) || String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

function billReminderItems() {
  const today = todayISO();
  return openOneTimeBills()
    .filter((bill) => !bill.snoozed_until || bill.snoozed_until <= today)
    .filter((bill) => bill.due_date <= addDaysISO(today, Math.max(0, Math.trunc(number(bill.reminder_days_before) || 0))))
    .map((bill) => ({ kind: "bill", date: bill.due_date, amount: number(bill.amount), bill, title: bill.name, status: billStatusInfo(bill) }));
}

function recurringBillReminderItems() {
  const today = todayISO();
  const items = [];
  for (const rule of state.recurringEntries.filter((item) => item.type === "expense" && item.active !== false)) {
    const reminderDays = Math.max(0, Math.trunc(number(rule.reminder_days_before) || 0));
    const overdueDate = earliestDueUnpostedOccurrence(rule);
    const date = overdueDate || nextUnpostedOccurrence(rule, today);
    if (!date || (!overdueDate && date > addDaysISO(today, reminderDays))) continue;
    const days = daysBetweenISO(today, date);
    items.push({
      kind: "recurring",
      date,
      amount: number(rule.amount),
      rule,
      title: rule.description || categoryById(rule.category_id)?.name || "Recurring expense",
      status: date < today
        ? { key: "overdue", label: "Overdue", detail: `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue` }
        : date === today
          ? { key: "due-today", label: "Due today", detail: "Scheduled for today" }
          : { key: "due-soon", label: "Reminder", detail: `Due in ${days} day${days === 1 ? "" : "s"}` },
    });
  }
  return items;
}

function creditCardReminderItems() {
  return state.creditCardStatements.flatMap((statement) => {
    const status = creditCardStatementStatus(statement);
    if (["paid", "paid-late"].includes(status.key)) return [];
    const days = daysBetweenISO(todayISO(), statement.due_date);
    if (days > 7) return [];
    const account = accountById(statement.account_id);
    if (!account) return [];
    return [{ kind: "card", date: statement.due_date, amount: status.outstanding, statement, account, title: `${account.name} payment`, status: days < 0 ? { ...status, key: "overdue", label: "Overdue" } : status }];
  });
}

function allReminderItems() {
  return [...billReminderItems(), ...recurringBillReminderItems(), ...creditCardReminderItems()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

function renderBills() {
  if (!el.billsList) return;
  const today = todayISO();
  const open = openOneTimeBills();
  const overdue = open.filter((bill) => bill.due_date < today);
  const dueToday = open.filter((bill) => bill.due_date === today);
  const nextSeven = open.filter((bill) => bill.due_date >= today && bill.due_date <= addDaysISO(today, 7));
  const nextThirtyAmount = open.filter((bill) => bill.due_date >= today && bill.due_date <= addDaysISO(today, 30)).reduce((sum, bill) => sum + number(bill.amount), 0);
  el.billSummary.innerHTML = [
    summaryCard("Overdue", overdue.length, overdue.length ? `${formatMoneyText(overdue.reduce((sum, bill) => sum + number(bill.amount), 0))} outstanding` : "Nothing overdue", overdue.length ? "negative" : "positive", false),
    summaryCard("Due today", dueToday.length, dueToday.length ? `${formatMoneyText(dueToday.reduce((sum, bill) => sum + number(bill.amount), 0))} due` : "No bills today", dueToday.length ? "warning" : "", false),
    summaryCard("Next 7 days", nextSeven.length, `${formatMoneyText(nextSeven.reduce((sum, bill) => sum + number(bill.amount), 0))} scheduled`, nextSeven.length ? "warning" : "", false),
    summaryCard("Next 30 days", nextThirtyAmount, `${open.filter((bill) => bill.due_date >= today && bill.due_date <= addDaysISO(today, 30)).length} one-time bills`, nextThirtyAmount ? "negative" : ""),
  ].join("");

  const statusFilter = el.billStatusFilter.value || "open";
  const range = el.billRangeFilter.value || "30";
  const rangeEnd = range === "all" ? "9999-12-31" : addDaysISO(today, number(range));
  const filtered = [...state.bills]
    .filter((bill) => {
      if (statusFilter === "paid") return bill.status === "paid";
      if (statusFilter === "overdue") return bill.status !== "paid" && bill.due_date < today;
      if (statusFilter === "open") return bill.status !== "paid";
      return true;
    })
    .filter((bill) => bill.status === "paid" || range === "all" || bill.due_date <= rangeEnd)
    .sort((a, b) => Number(a.status === "paid") - Number(b.status === "paid") || a.due_date.localeCompare(b.due_date));
  el.billsList.innerHTML = filtered.length ? `<div class="bill-list">${filtered.map(billRowHTML).join("")}</div>` : emptyHTML("No matching bills", "Add a one-time bill or change the filters.");

  const recurring = state.recurringEntries
    .filter((rule) => rule.type === "expense")
    .sort((a, b) => Number(b.active !== false) - Number(a.active !== false) || String(nextUnpostedOccurrence(a) || "9999").localeCompare(String(nextUnpostedOccurrence(b) || "9999")));
  el.recurringBillsList.innerHTML = recurring.length ? `<div class="bill-list recurring-bill-list">${recurring.map(recurringBillRowHTML).join("")}</div>` : emptyHTML("No recurring bills", "Create a recurring expense for rent, subscriptions, loan payments, or utilities.");

  renderDashboardBills();
}

function billRowHTML(bill) {
  const status = billStatusInfo(bill);
  const account = accountById(bill.account_id);
  const category = categoryById(bill.category_id);
  return `<article class="bill-row ${status.key}">
    <div class="bill-date-block"><span>${new Intl.DateTimeFormat("en-US", { month: "short" }).format(new Date(`${bill.due_date}T12:00:00`))}</span><strong>${Number(bill.due_date.slice(8, 10))}</strong></div>
    <div class="bill-main"><div class="bill-title-line"><strong>${escapeHTML(bill.name)}</strong><span class="bill-status ${status.key}">${escapeHTML(status.label)}</span></div><span>${escapeHTML(category?.name || "Uncategorized")} · ${escapeHTML(account?.name || "No account")} · ${escapeHTML(status.detail)}</span>${bill.notes ? `<small>${escapeHTML(bill.notes)}</small>` : ""}</div>
    <strong class="bill-amount">${formatMoneyHTML(bill.amount)}</strong>
    <div class="bill-actions">${bill.status === "paid" ? `<button class="secondary-button" data-action="reopen-bill" data-id="${bill.id}" type="button">Reopen</button>` : `<button class="primary-button" data-action="record-bill-payment" data-id="${bill.id}" type="button">Record payment</button><button class="secondary-button" data-action="mark-bill-paid" data-id="${bill.id}" type="button">Mark paid</button><button class="row-action" data-action="snooze-bill" data-id="${bill.id}" title="Snooze reminder for one day">Zz</button>`}<button class="row-action" data-action="edit-bill" data-id="${bill.id}" aria-label="Edit bill">✎</button><button class="row-action danger" data-action="delete-bill" data-id="${bill.id}" aria-label="Delete bill">×</button></div>
  </article>`;
}

function recurringBillRowHTML(rule) {
  const next = nextUnpostedOccurrence(rule);
  const active = rule.active !== false;
  const due = earliestDueUnpostedOccurrence(rule);
  return `<article class="bill-row recurring-bill-row ${active ? "" : "paused"}">
    <div class="bill-date-block"><span>${next ? new Intl.DateTimeFormat("en-US", { month: "short" }).format(new Date(`${next}T12:00:00`)) : "—"}</span><strong>${next ? Number(next.slice(8, 10)) : "—"}</strong></div>
    <div class="bill-main"><div class="bill-title-line"><strong>${escapeHTML(rule.description || categoryById(rule.category_id)?.name || "Recurring expense")}</strong><span class="bill-status ${active ? "upcoming" : "snoozed"}">${active ? "Recurring" : "Paused"}</span></div><span>${escapeHTML(recurringTargetText(rule))} · ${escapeHTML(recurringScheduleText(rule))}</span><small>Reminder ${number(rule.reminder_days_before) ? `${number(rule.reminder_days_before)} day${number(rule.reminder_days_before) === 1 ? "" : "s"} before` : "on the due date"}</small></div>
    <strong class="bill-amount">${formatMoneyHTML(rule.amount)}</strong>
    <div class="bill-actions">${due ? `<button class="primary-button" data-action="post-recurring" data-id="${rule.id}" data-date="${due}" type="button">Post due</button>` : ""}<button class="secondary-button" data-action="edit-recurring" data-id="${rule.id}" type="button">Edit</button></div>
  </article>`;
}

function renderDashboardBills() {
  if (!el.dashboardBills) return;
  const today = todayISO();
  const upcomingOneTime = openOneTimeBills().filter((bill) => bill.due_date <= addDaysISO(today, 14)).map((bill) => ({ kind: "bill", date: bill.due_date, title: bill.name, amount: bill.amount, id: bill.id, status: billStatusInfo(bill) }));
  const upcomingRecurring = plannedOccurrencesBetween(today, addDaysISO(today, 14)).filter((item) => item.rule.type === "expense").map(({ rule, date }) => ({ kind: "recurring", date, title: rule.description || categoryById(rule.category_id)?.name || "Recurring expense", amount: rule.amount, id: rule.id, status: { key: date === today ? "due-today" : "upcoming", label: date === today ? "Due today" : "Planned" } }));
  const items = [...upcomingOneTime, ...upcomingRecurring].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
  el.dashboardBills.innerHTML = items.length ? `<div class="dashboard-bill-list">${items.map((item) => `<div class="dashboard-bill-row"><span class="dashboard-bill-date">${formatDate(item.date)}</span><div><strong>${escapeHTML(item.title)}</strong><span class="bill-status ${item.status.key}">${escapeHTML(item.status.label)}</span></div><strong>${formatMoneyHTML(item.amount)}</strong>${item.kind === "bill" ? `<button class="text-button" data-action="record-bill-payment" data-id="${item.id}" type="button">Pay</button>` : ""}</div>`).join("")}</div>` : emptyHTML("No bills in the next 14 days", "Upcoming one-time and recurring bills will appear here.");
}

function openBillModal(id = null) {
  if (!state.accounts.length) return showToast("Add an account before creating a bill.", true);
  el.billForm.reset();
  el.billId.value = "";
  el.billDueDate.value = todayISO();
  el.billReminderDays.value = "3";
  el.billFormError.textContent = "";
  if (id) {
    const bill = billById(id);
    if (!bill) return;
    el.billId.value = bill.id;
    el.billName.value = bill.name || "";
    el.billAmount.value = number(bill.amount);
    el.billDueDate.value = bill.due_date || todayISO();
    el.billAccount.value = bill.account_id || "";
    el.billCategory.value = bill.category_id || "";
    el.billReminderDays.value = String(Math.max(0, Math.trunc(number(bill.reminder_days_before) || 0)));
    el.billNotes.value = bill.notes || "";
    el.billModalTitle.textContent = "Edit bill";
  } else {
    el.billModalTitle.textContent = "Add one-time bill";
  }
  openModal(el.billModal);
  el.billName.focus();
}

async function handleBillSubmit(event) {
  event.preventDefault();
  el.billFormError.textContent = "";
  const id = el.billId.value;
  const row = {
    name: el.billName.value.trim(),
    amount: number(el.billAmount.value),
    due_date: el.billDueDate.value,
    account_id: el.billAccount.value,
    category_id: el.billCategory.value,
    reminder_days_before: Math.max(0, Math.min(365, Math.trunc(number(el.billReminderDays.value) || 0))),
    notes: el.billNotes.value.trim(),
  };
  if (!row.name) return showFormError(el.billFormError, "Enter a bill name.");
  if (!(row.amount > 0)) return showFormError(el.billFormError, "Enter an amount greater than zero.");
  if (!row.due_date) return showFormError(el.billFormError, "Choose a due date.");
  if (!row.account_id) return showFormError(el.billFormError, "Choose the account used to pay this bill.");
  if (!row.category_id) return showFormError(el.billFormError, "Choose an expense category.");
  if (row.notes.length > 1000) return showFormError(el.billFormError, "Notes must be 1,000 characters or fewer.");
  try {
    if (id) {
      const updated = await updateRow("bills", id, row);
      state.bills = state.bills.map((bill) => bill.id === id ? { ...bill, ...updated } : bill);
      showToast("Bill updated.");
    } else {
      state.bills.push(await insertRow("bills", { ...row, status: "open", snoozed_until: null, paid_at: null, paid_transaction_id: null }));
      showToast("Bill reminder created.");
    }
    persistLocal();
    closeModal(el.billModal);
    render();
  } catch (error) { showFormError(el.billFormError, friendlyError(error)); }
}

function recordBillPayment(id) {
  const bill = billById(id);
  if (!bill || bill.status === "paid") return;
  openTransactionModal(null, bill.due_date <= todayISO() ? bill.due_date : todayISO(), id);
  setEntryType("expense");
  el.entryAmount.value = number(bill.amount);
  el.entryAccount.value = bill.account_id || "";
  el.entryCategory.value = bill.category_id || "";
  el.entryDescription.value = bill.name || "";
  el.entryRemarks.value = bill.notes || "";
  updateSplitSummary();
}

async function completeBillWithTransaction(id, transactionId) {
  const bill = billById(id);
  if (!bill) return;
  const changes = { status: "paid", paid_at: new Date().toISOString(), paid_transaction_id: transactionId, snoozed_until: null };
  const updated = await updateRow("bills", id, changes);
  state.bills = state.bills.map((item) => item.id === id ? { ...item, ...updated } : item);
}

async function markBillPaid(id) {
  const bill = billById(id);
  if (!bill || !confirm(`Mark ${bill.name} as paid without adding a transaction?`)) return;
  try {
    const changes = { status: "paid", paid_at: new Date().toISOString(), paid_transaction_id: null, snoozed_until: null };
    const updated = await updateRow("bills", id, changes);
    state.bills = state.bills.map((item) => item.id === id ? { ...item, ...updated } : item);
    persistLocal(); render(); showToast("Bill marked paid.");
  } catch (error) { showToast(friendlyError(error), true); }
}

async function reopenBill(id) {
  const bill = billById(id);
  if (!bill) return;
  try {
    const updated = await updateRow("bills", id, { status: "open", paid_at: null, paid_transaction_id: null });
    state.bills = state.bills.map((item) => item.id === id ? { ...item, ...updated } : item);
    persistLocal(); render(); showToast("Bill reopened.");
  } catch (error) { showToast(friendlyError(error), true); }
}

async function snoozeBill(id) {
  const bill = billById(id);
  if (!bill) return;
  try {
    const updated = await updateRow("bills", id, { snoozed_until: addDaysISO(todayISO(), 1) });
    state.bills = state.bills.map((item) => item.id === id ? { ...item, ...updated } : item);
    persistLocal(); render(); showToast("Reminder snoozed until tomorrow.");
  } catch (error) { showToast(friendlyError(error), true); }
}

async function deleteBill(id) {
  const bill = billById(id);
  if (!bill || !confirm(`Delete ${bill.name}?`)) return;
  try {
    await deleteRow("bills", id);
    state.bills = state.bills.filter((item) => item.id !== id);
    persistLocal(); render(); showToast("Bill deleted.");
  } catch (error) { showToast(friendlyError(error), true); }
}

function renderReminderCenter() {
  if (!el.reminderBadge) return;
  const items = allReminderItems();
  el.reminderBadge.hidden = !items.length;
  el.reminderBadge.textContent = items.length > 99 ? "99+" : String(items.length);
  el.reminderButton.classList.toggle("has-reminders", Boolean(items.length));
  el.reminderPopoverList.innerHTML = items.length ? `<div class="reminder-list">${items.slice(0, 8).map(reminderItemHTML).join("")}</div>${items.length > 8 ? `<p class="reminder-more">${items.length - 8} more reminder${items.length - 8 === 1 ? "" : "s"}</p>` : ""}` : emptyHTML("You're all caught up", "No bill reminders need attention right now.");
}

function reminderItemHTML(item) {
  const action = item.kind === "bill"
    ? `<button class="text-button" data-action="record-bill-payment" data-id="${item.bill.id}" type="button">Record</button>`
    : item.kind === "recurring"
      ? (item.date <= todayISO() ? `<button class="text-button" data-action="post-recurring" data-id="${item.rule.id}" data-date="${item.date}" type="button">Post</button>` : "")
      : `<button class="text-button" data-action="record-credit-card-payment" data-id="${item.account.id}" type="button">Pay</button>`;
  return `<div class="reminder-item"><span class="reminder-item-icon ${item.status.key}">!</span><div><strong>${escapeHTML(item.title)}</strong><span>${formatDate(item.date)} · ${escapeHTML(item.status.label)} · ${formatMoneyText(item.amount)}</span></div>${action}</div>`;
}

function toggleReminderPopover() {
  const open = el.reminderPopover.hidden;
  el.reminderPopover.hidden = !open;
  el.reminderButton.setAttribute("aria-expanded", String(open));
}

function closeReminderPopover() {
  el.reminderPopover.hidden = true;
  el.reminderButton.setAttribute("aria-expanded", "false");
}

function showReminderNoticeOnce() {
  if (reminderNoticeShown) return;
  reminderNoticeShown = true;
  const count = allReminderItems().length;
  if (count) showToast(`${count} bill reminder${count === 1 ? " needs" : "s need"} your attention.`);
}

function oneTimeBillsAgendaHTML(bills) {
  return `<div class="bill-calendar-agenda"><div class="planned-agenda-heading"><strong>Bill reminders</strong><span>One-time bills do not affect balances until paid</span></div>${bills.map((bill) => { const status = billStatusInfo(bill); return `<div class="planned-row"><div class="planned-row-main"><span class="card-reminder-icon due">$</span><div class="planned-row-copy"><strong>${escapeHTML(bill.name)}</strong><span>${escapeHTML(accountById(bill.account_id)?.name || "No account")} · ${escapeHTML(categoryById(bill.category_id)?.name || "Uncategorized")}</span></div></div><div class="planned-row-side"><span class="bill-status ${status.key}">${escapeHTML(status.label)}</span><strong>${formatMoneyHTML(bill.amount)}</strong><button class="secondary-button" data-action="record-bill-payment" data-id="${bill.id}" type="button">Record payment</button></div></div>`; }).join("")}</div>`;
}

function moveCalendarMonth(offset) {
  calendarCursor = new Date(calendarCursor.getFullYear(), calendarCursor.getMonth() + offset, 1);
  const selected = new Date(`${selectedCalendarDate}T12:00:00`);
  if (selected.getFullYear() !== calendarCursor.getFullYear() || selected.getMonth() !== calendarCursor.getMonth()) {
    selectedCalendarDate = validISODate(calendarCursor.getFullYear(), calendarCursor.getMonth() + 1, 1);
  }
  renderCalendar();
}

function showCalendarToday() {
  const today = new Date();
  calendarCursor = new Date(today.getFullYear(), today.getMonth(), 1);
  selectedCalendarDate = todayISO();
  renderCalendar();
}

function handleCalendarClick(event) {
  const addButton = event.target.closest("[data-calendar-add]");
  if (addButton) {
    selectCalendarDate(addButton.dataset.calendarAdd);
    openTransactionModal(null, selectedCalendarDate);
    return;
  }
  const dayButton = event.target.closest("[data-calendar-date]");
  if (dayButton) selectCalendarDate(dayButton.dataset.calendarDate);
}

function handleCalendarKeydown(event) {
  if (!['Enter', ' '].includes(event.key)) return;
  const dayButton = event.target.closest("[data-calendar-date]");
  if (!dayButton) return;
  event.preventDefault();
  selectCalendarDate(dayButton.dataset.calendarDate);
}

function selectCalendarDate(date) {
  if (!date) return;
  selectedCalendarDate = date;
  const selected = new Date(`${date}T12:00:00`);
  if (selected.getFullYear() !== calendarCursor.getFullYear() || selected.getMonth() !== calendarCursor.getMonth()) {
    calendarCursor = new Date(selected.getFullYear(), selected.getMonth(), 1);
  }
  renderCalendar();
}

function renderCalendar() {
  if (!el.calendarGrid) return;
  const year = calendarCursor.getFullYear();
  const month = calendarCursor.getMonth();
  const monthKey = `${year}-${String(month + 1).padStart(2, "0")}`;
  const monthStart = `${monthKey}-01`;
  const monthEnd = endOfMonthISO(calendarCursor);
  const accountId = el.calendarAccountFilter.value || "all";
  const monthEntries = state.transactions.filter((transaction) => transaction.entry_date?.startsWith(monthKey) && transactionMatchesAccount(transaction, accountId));
  const monthPlanned = plannedOccurrencesBetween(monthStart, monthEnd, accountId);
  const monthCardEvents = creditCardCalendarEventsBetween(monthStart, monthEnd, accountId);
  const monthBills = billsDueBetween(monthStart, monthEnd, accountId);
  const monthIncome = sumTransactions(monthEntries, "income");
  const monthExpenses = sumTransactions(monthEntries, "expense");
  const activeDays = new Set([...monthEntries.map((transaction) => transaction.entry_date), ...monthPlanned.map((item) => item.date), ...monthCardEvents.map((item) => item.date), ...monthBills.map((item) => item.due_date)]).size;
  const transferCount = monthEntries.filter((transaction) => transaction.type === "transfer").length;

  el.calendarMonthLabel.textContent = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(calendarCursor);
  el.calendarSummary.innerHTML = [
    summaryCard("Income", monthIncome, `${monthEntries.filter((item) => item.type === "income").length} posted entries`, "positive"),
    summaryCard("Expenses", monthExpenses, `${monthEntries.filter((item) => item.type === "expense").length} posted entries`, monthExpenses ? "negative" : ""),
    summaryCard("Net cash flow", monthIncome - monthExpenses, "Posted income minus expenses", tone(monthIncome - monthExpenses)),
    summaryCard("Upcoming", monthPlanned.length + monthCardEvents.length + monthBills.length, `${monthBills.length} bill${monthBills.length === 1 ? "" : "s"} · ${monthPlanned.length} recurring · ${monthCardEvents.length} card reminder${monthCardEvents.length === 1 ? "" : "s"} · ${activeDays} active day${activeDays === 1 ? "" : "s"}`, "warning", false),
  ].join("");

  const first = new Date(year, month, 1);
  const gridStart = new Date(year, month, 1 - first.getDay());
  const cells = [];
  for (let index = 0; index < 42; index += 1) {
    const date = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + index);
    const iso = localISODate(date);
    const dayEntries = state.transactions.filter((transaction) => transaction.entry_date === iso && transactionMatchesAccount(transaction, accountId));
    const planned = plannedOccurrencesForDate(iso, accountId);
    const cardEvents = creditCardCalendarEventsForDate(iso, accountId);
    const bills = billsDueBetween(iso, iso, accountId);
    const income = sumTransactions(dayEntries, "income");
    const expenses = sumTransactions(dayEntries, "expense");
    const transfers = dayEntries.filter((transaction) => transaction.type === "transfer").length;
    const plannedIncome = planned.filter((item) => item.rule.type === "income").reduce((sum, item) => sum + number(item.rule.amount), 0);
    const plannedExpenses = planned.filter((item) => item.rule.type === "expense").reduce((sum, item) => sum + number(item.rule.amount), 0);
    const plannedTransfers = planned.filter((item) => item.rule.type === "transfer").length;
    const isCurrentMonth = date.getMonth() === month;
    const hasActivity = dayEntries.length || planned.length || cardEvents.length || bills.length;
    const classes = [
      "calendar-day",
      isCurrentMonth ? "" : "outside-month",
      iso === todayISO() ? "today" : "",
      iso === selectedCalendarDate ? "selected" : "",
      hasActivity ? "has-activity" : "",
    ].filter(Boolean).join(" ");
    const aria = `${formatDate(iso)}. ${income ? `${formatMoneyText(income)} posted income. ` : ""}${expenses ? `${formatMoneyText(expenses)} posted expenses. ` : ""}${transfers ? `${transfers} posted transfers. ` : ""}${planned.length ? `${planned.length} planned recurring entries. ` : ""}${cardEvents.length ? `${cardEvents.length} credit-card reminder${cardEvents.length === 1 ? "" : "s"}. ` : ""}${bills.length ? `${bills.length} bill${bills.length === 1 ? "" : "s"} due.` : ""}`;
    cells.push(`<div class="${classes}">
      <button class="calendar-day-body" type="button" data-calendar-date="${iso}" aria-label="${escapeHTML(aria)}">
        <span class="calendar-day-number">${date.getDate()}</span>
        <span class="calendar-day-totals">
          ${income ? `<span class="calendar-day-total income"><span>+</span>${formatMoneyCompactHTML(income)}</span>` : ""}
          ${expenses ? `<span class="calendar-day-total expense"><span>−</span>${formatMoneyCompactHTML(expenses)}</span>` : ""}
          ${transfers ? `<span class="calendar-transfer-count">⇄ ${transfers}</span>` : ""}
          ${plannedIncome ? `<span class="calendar-planned-total income">Planned +${formatMoneyCompactHTML(plannedIncome)}</span>` : ""}
          ${plannedExpenses ? `<span class="calendar-planned-total expense">Planned −${formatMoneyCompactHTML(plannedExpenses)}</span>` : ""}
          ${plannedTransfers ? `<span class="calendar-planned-count">Planned ⇄ ${plannedTransfers}</span>` : ""}
          ${bills.slice(0, 2).map((bill) => `<span class="calendar-bill-reminder ${bill.due_date < todayISO() ? "overdue" : ""}">Bill ${formatMoneyCompactHTML(bill.amount)}</span>`).join("")}
          ${cardEvents.slice(0, 2).map((item) => `<span class="calendar-card-reminder ${item.type === "payment-due" ? "due" : "close"}">${item.type === "payment-due" ? "Card due" : "Card closes"}</span>`).join("")}
          ${!hasActivity ? `<span class="calendar-no-activity">No entries</span>` : ""}
        </span>
      </button>
      <button class="calendar-day-add" type="button" data-calendar-add="${iso}" aria-label="Add entry on ${escapeHTML(formatDate(iso))}" title="Add entry">+</button>
    </div>`);
  }
  el.calendarGrid.innerHTML = cells.join("");
  renderSelectedCalendarDay(accountId);
}

function renderSelectedCalendarDay(accountId = "all") {
  const entries = sortedTransactions().filter((transaction) => transaction.entry_date === selectedCalendarDate && transactionMatchesAccount(transaction, accountId));
  const planned = plannedOccurrencesForDate(selectedCalendarDate, accountId);
  const cardEvents = creditCardCalendarEventsForDate(selectedCalendarDate, accountId);
  const bills = billsDueBetween(selectedCalendarDate, selectedCalendarDate, accountId);
  const income = sumTransactions(entries, "income");
  const expenses = sumTransactions(entries, "expense");
  const transfers = entries.filter((transaction) => transaction.type === "transfer").length;
  el.calendarDayHeading.textContent = formatDate(selectedCalendarDate);
  el.calendarDaySummary.innerHTML = [
    dayMetricHTML("Income", income, "positive"),
    dayMetricHTML("Expenses", expenses, expenses ? "negative" : ""),
    dayMetricHTML("Net cash flow", income - expenses, tone(income - expenses)),
    dayMetricHTML("Reminders", planned.length + cardEvents.length + bills.length, planned.length || cardEvents.length || bills.length ? "warning" : "", false),
  ].join("");
  const billsHTML = bills.length ? oneTimeBillsAgendaHTML(bills) : "";
  const cardHTML = cardEvents.length ? creditCardCalendarAgendaHTML(cardEvents) : "";
  const plannedHTML = planned.length ? plannedAgendaHTML(planned) : "";
  const postedHTML = entries.length
    ? transactionListHTML(entries, true)
    : emptyHTML("No posted entries on this day", planned.length || bills.length ? "The planned items above do not affect balances until posted or paid." : "Use Add entry for this day to record an expense, income, or transfer.");
  el.calendarDayTransactions.innerHTML = `${billsHTML}${cardHTML}${plannedHTML}${postedHTML}`;
}


function creditCardCalendarEventsBetween(startDate, endDate, accountId = "all") {
  const cards = creditCardAccounts().filter((account) => accountId === "all" || account.id === accountId);
  const events = [];
  const start = new Date(`${startDate}T12:00:00`);
  const end = new Date(`${endDate}T12:00:00`);
  for (const account of cards) {
    if (account.statement_closing_day) {
      for (let cursor = new Date(start.getFullYear(), start.getMonth(), 1); cursor <= end; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
        const date = dateForMonthDay(cursor.getFullYear(), cursor.getMonth(), number(account.statement_closing_day));
        if (date >= startDate && date <= endDate) events.push({ type: "statement-close", date, account, statement: null });
      }
    }
    const statements = state.creditCardStatements.filter((statement) => statement.account_id === account.id && statement.due_date >= startDate && statement.due_date <= endDate);
    for (const statement of statements) events.push({ type: "payment-due", date: statement.due_date, account, statement, status: creditCardStatementStatus(statement) });
    if (account.payment_due_day) {
      for (let cursor = new Date(start.getFullYear(), start.getMonth(), 1); cursor <= end; cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1)) {
        const date = dateForMonthDay(cursor.getFullYear(), cursor.getMonth(), number(account.payment_due_day));
        const hasStatement = statements.some((statement) => statement.due_date === date);
        if (!hasStatement && date >= startDate && date <= endDate) events.push({ type: "payment-due", date, account, statement: null, status: null });
      }
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type) || a.account.name.localeCompare(b.account.name));
}

function creditCardCalendarEventsForDate(date, accountId = "all") {
  return creditCardCalendarEventsBetween(date, date, accountId);
}

function creditCardCalendarAgendaHTML(events) {
  return `<div class="card-reminder-agenda">
    <div class="planned-agenda-heading"><strong>Credit-card reminders</strong><span>Cycle dates and saved statement deadlines</span></div>
    ${events.map((event) => {
      const isDue = event.type === "payment-due";
      const status = event.status;
      const title = isDue ? `${event.account.name} payment due` : `${event.account.name} statement closes`;
      const detail = event.statement
        ? `${formatMoneyText(event.statement.statement_balance)} statement · minimum ${formatMoneyText(event.statement.minimum_payment)}`
        : isDue ? "Configured monthly payment reminder" : "Configured monthly statement closing date";
      return `<div class="card-reminder-row">
        <div class="planned-row-main"><span class="card-reminder-icon ${isDue ? "due" : "close"}">${isDue ? "!" : "▤"}</span><div class="planned-row-copy"><strong>${escapeHTML(title)}</strong><span>${escapeHTML(detail)}</span></div></div>
        <div class="planned-row-side">${status ? `<span class="credit-card-status ${status.key}">${escapeHTML(status.label)}</span>` : `<span class="planned-label">Reminder</span>`}${event.statement && status?.outstanding > 0 ? `<button class="secondary-button" data-action="record-credit-card-payment" data-id="${event.account.id}" type="button">Record payment</button>` : ""}</div>
      </div>`;
    }).join("")}
  </div>`;
}

function plannedAgendaHTML(planned) {
  return `<div class="planned-agenda">
    <div class="planned-agenda-heading"><strong>Planned recurring entries</strong><span>Not included in balances or reports until posted</span></div>
    ${planned.map(({ rule, date }) => {
      const title = rule.description || (rule.type === "transfer" ? "Recurring transfer" : categoryById(rule.category_id)?.name || `Recurring ${rule.type}`);
      const icon = rule.type === "expense" ? "↓" : rule.type === "income" ? "↑" : "⇄";
      const sign = rule.type === "expense" ? "−" : rule.type === "income" ? "+" : "";
      const canPost = date <= todayISO();
      return `<div class="planned-row">
        <div class="planned-row-main">
          <span class="recurring-type-icon ${rule.type}">${icon}</span>
          <div class="planned-row-copy"><strong>${escapeHTML(title)}</strong><span>${escapeHTML(recurringTargetText(rule))} · ${escapeHTML(recurringScheduleText(rule))}</span></div>
        </div>
        <div class="planned-row-side">
          <span class="planned-label">Planned</span>
          <span class="amount ${rule.type}">${sign}${formatMoneyHTML(rule.amount)}</span>
          ${canPost ? `<button class="secondary-button" data-action="post-recurring" data-id="${rule.id}" data-date="${date}" type="button">Post now</button>` : ""}
        </div>
      </div>`;
    }).join("")}
  </div>`;
}


function transactionMatchesAccount(transaction, accountId) {
  return accountId === "all" || [transaction.account_id, transaction.from_account_id, transaction.to_account_id].includes(accountId);
}

function dayMetricHTML(label, value, className = "", money = true) {
  return `<div class="calendar-day-metric"><span>${escapeHTML(label)}</span><strong class="${className}">${money ? formatMoneyHTML(value) : escapeHTML(value)}</strong></div>`;
}

function localISODate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatMoneyCompactHTML(value) {
  const absolute = Math.abs(number(value));
  return `<span class="money compact-money"><span class="aed-symbol" aria-hidden="true"></span><span class="money-number">${escapeHTML(compactAmountFormatter.format(absolute))}</span></span>`;
}

function renderBudgets() {
  const monthKey = todayISO().slice(0, 7);
  const metrics = budgetMetrics("monthly", monthKey);
  const budgetCards = [
    summaryCard("Monthly budget", metrics.total, `${metrics.count} category limit${metrics.count === 1 ? "" : "s"}`, ""),
    summaryCard("Spent", metrics.spent, metrics.total ? `${Math.round(metrics.percentage)}% used` : "No monthly limits", metrics.spent > metrics.total && metrics.total ? "negative" : ""),
    summaryCard("Remaining", metrics.total - metrics.spent, metrics.total ? "Across monthly budgets" : "Create a budget to begin", tone(metrics.total - metrics.spent)),
    summaryCard("Categories over", metrics.overCount, "Exceeded spending limit", metrics.overCount ? "negative" : "positive", false),
  ];
  el.budgetSummary.innerHTML = budgetCards.join("");

  if (!state.budgets.length) {
    const empty = emptyHTML("No budgets yet", "Create a monthly or yearly maximum for an expense category.");
    el.budgetsList.innerHTML = empty;
    el.dashboardBudgets.innerHTML = empty;
    return;
  }
  const currentAnchor = todayISO().slice(0, 7);
  const rows = state.budgets.map((budget) => budgetRowHTML(budget, true, currentAnchor)).join("");
  el.budgetsList.innerHTML = `<div class="budget-list">${rows}</div>`;
  const monthly = state.budgets.filter((item) => item.period === "monthly").slice(0, 5);
  el.dashboardBudgets.innerHTML = monthly.length ? `<div class="budget-list">${monthly.map((budget) => budgetRowHTML(budget, false, currentAnchor)).join("")}</div>` : emptyHTML("No monthly budgets", "Add a monthly category limit to see progress here.");
}

function budgetRowHTML(budget, showActions = true, anchor = todayISO().slice(0, 7)) {
  const category = categoryById(budget.category_id);
  const actual = spendingForBudget(budget, anchor);
  const amount = number(budget.amount);
  const percent = amount ? (actual / amount) * 100 : 0;
  const over = actual > amount;
  return `<div class="budget-row">
    <div class="budget-row-top">
      <strong><span class="category-dot" style="--category-color:${safeColor(category?.color)}"></span>${escapeHTML(category?.name || "Deleted category")}</strong>
      <div class="budget-inline-actions">
        <span>${capitalize(budget.period)}</span>
        ${showActions ? `<button class="row-action" data-action="edit-budget" data-id="${budget.id}" aria-label="Edit budget">✎</button><button class="row-action danger" data-action="delete-budget" data-id="${budget.id}" aria-label="Delete budget">×</button>` : ""}
      </div>
    </div>
    <div class="budget-track"><div class="budget-fill ${over ? "over" : ""}" style="width:${Math.min(percent, 100)}%;--category-color:${safeColor(category?.color)}"></div></div>
    <div class="budget-row-bottom"><span>${formatMoneyHTML(actual)} spent</span><strong class="${over ? "negative" : ""}">${Math.round(percent)}% of ${formatMoneyHTML(amount)}</strong></div>
  </div>`;
}

function renderCategories() {
  el.expenseCategoryList.innerHTML = categoryManagerHTML("expense");
  el.incomeCategoryList.innerHTML = categoryManagerHTML("income");
}

function categoryManagerHTML(kind) {
  const categories = state.categories.filter((category) => category.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
  if (!categories.length) return emptyHTML(`No ${kind} categories`, "Add a category to organize entries.");
  return categories.map((category) => `<div class="category-manager-row">
    <span class="category-dot" style="--category-color:${safeColor(category.color)}"></span>
    <strong>${escapeHTML(category.name)}</strong>
    <div class="category-manager-actions"><button class="row-action" data-action="edit-category" data-id="${category.id}" aria-label="Edit ${escapeHTML(category.name)}">✎</button><button class="row-action danger" data-action="delete-category" data-id="${category.id}" aria-label="Delete ${escapeHTML(category.name)}">×</button></div>
  </div>`).join("");
}

function renderReports() {
  if (!el.reportMonth.value) return;
  const period = el.reportPeriod.value;
  const anchor = el.reportMonth.value;
  const predicate = period === "yearly" ? (item) => item.entry_date?.startsWith(anchor.slice(0, 4)) : (item) => item.entry_date?.startsWith(anchor);
  const entries = state.transactions.filter(predicate);
  const income = sumTransactions(entries, "income");
  const expenses = sumTransactions(entries, "expense");
  const net = income - expenses;
  const savingsRate = income ? (net / income) * 100 : 0;
  const budget = budgetMetrics(period, anchor);
  el.reportSummary.innerHTML = [
    summaryCard("Net worth now", calculateNetWorth(), "Current included account balances", tone(calculateNetWorth())),
    summaryCard(`${capitalize(period)} expenses`, expenses, `${entries.filter((item) => item.type === "expense").length} entries`, expenses ? "negative" : ""),
    summaryCard("Cash flow", net, `${formatMoneyText(income)} income`, tone(net)),
    summaryCard("Savings rate", savingsRate, budget.total ? `${Math.round(budget.percentage)}% of budget used` : "Net cash flow ÷ income", tone(savingsRate), false, "%"),
  ].join("");

  const expenseTotals = categoryTotals(entries.filter((item) => item.type === "expense"));
  const incomeTotals = categoryTotals(entries.filter((item) => item.type === "income"));
  el.reportExpenseChart.innerHTML = categoryBarsHTML(expenseTotals, "No expenses in this period");
  el.incomeCategoryChart.innerHTML = categoryBarsHTML(incomeTotals, "No income in this period");

  const chartMonths = period === "yearly" ? monthsInYear(Number(anchor.slice(0, 4))) : monthSeries(6, dateFromMonth(anchor));
  el.reportCashFlowChart.innerHTML = cashFlowBarsHTML(chartMonths);
  el.netWorthChart.innerHTML = netWorthLineHTML(monthSeries(12, dateFromMonth(anchor)));
  el.reportMonth.parentElement.querySelector("span").textContent = period === "yearly" ? "Year anchor" : "Month";
}

function renderSettings() {
  const cloud = mode === "cloud";
  el.settingsStatus.innerHTML = `<span class="status-dot"></span><div><strong>${cloud ? "Supabase cloud sync active" : "Local preview active"}</strong><span>${cloud ? `Signed in as ${escapeHTML(user?.email || "")}. Changes are saved to your Supabase database.` : "Data is currently saved only in this browser's localStorage and will not appear on another device."}</span></div>`;
}

function renderSelectors() {
  const accountOptions = state.accounts.map((account) => `<option value="${account.id}">${escapeHTML(account.name)} (${formatMoneyText(calculateAccountBalance(account.id))})</option>`).join("");
  [el.entryAccount, el.transferFromAccount, el.transferToAccount, el.recurringAccount, el.recurringFromAccount, el.recurringToAccount, el.billAccount].forEach((select) => {
    const previous = select.value;
    select.innerHTML = accountOptions || `<option value="">No accounts available</option>`;
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  });
  const filterPrevious = el.transactionAccountFilter.value;
  el.transactionAccountFilter.innerHTML = `<option value="all">All accounts</option>${state.accounts.map((account) => `<option value="${account.id}">${escapeHTML(account.name)}</option>`).join("")}`;
  if ([...el.transactionAccountFilter.options].some((option) => option.value === filterPrevious)) el.transactionAccountFilter.value = filterPrevious;
  const calendarAccountPrevious = el.calendarAccountFilter.value;
  el.calendarAccountFilter.innerHTML = `<option value="all">All accounts</option>${state.accounts.map((account) => `<option value="${account.id}">${escapeHTML(account.name)}</option>`).join("")}`;
  if ([...el.calendarAccountFilter.options].some((option) => option.value === calendarAccountPrevious)) el.calendarAccountFilter.value = calendarAccountPrevious;
  const reconcileAccountPrevious = el.reconcileAccount.value;
  el.reconcileAccount.innerHTML = state.accounts.map((account) => `<option value="${account.id}">${escapeHTML(account.name)} (${formatMoneyText(calculateAccountBalance(account.id))})</option>`).join("") || `<option value="">No accounts available</option>`;
  if ([...el.reconcileAccount.options].some((option) => option.value === reconcileAccountPrevious)) el.reconcileAccount.value = reconcileAccountPrevious;
  const importAccountPrevious = el.importDefaultAccount.value;
  el.importDefaultAccount.innerHTML = `<option value="">Use account names from file</option>${state.accounts.map((account) => `<option value="${account.id}">${escapeHTML(account.name)}</option>`).join("")}`;
  if ([...el.importDefaultAccount.options].some((option) => option.value === importAccountPrevious)) el.importDefaultAccount.value = importAccountPrevious;
  renderEntryCategories(el.entryType.value);
  renderRecurringCategories(el.recurringType.value);
  const billCategoryPrevious = el.billCategory.value;
  el.billCategory.innerHTML = state.categories.filter((category) => category.kind === "expense").sort((a, b) => a.name.localeCompare(b.name)).map((category) => `<option value="${category.id}">${escapeHTML(category.name)}</option>`).join("") || `<option value="">No expense categories</option>`;
  if ([...el.billCategory.options].some((option) => option.value === billCategoryPrevious)) el.billCategory.value = billCategoryPrevious;
  const budgetPrevious = el.budgetCategory.value;
  el.budgetCategory.innerHTML = state.categories.filter((category) => category.kind === "expense").sort((a, b) => a.name.localeCompare(b.name)).map((category) => `<option value="${category.id}">${escapeHTML(category.name)}</option>`).join("") || `<option value="">No expense categories</option>`;
  if ([...el.budgetCategory.options].some((option) => option.value === budgetPrevious)) el.budgetCategory.value = budgetPrevious;
}

function renderEntryCategories(type) {
  if (type === "transfer") return;
  const previous = el.entryCategory.value;
  el.entryCategory.innerHTML = entryCategoryOptionsHTML(type);
  if ([...el.entryCategory.options].some((option) => option.value === previous)) el.entryCategory.value = previous;
  refreshSplitCategoryOptions(type);
}

function entryCategoryOptionsHTML(type, selected = "") {
  const categories = state.categories.filter((category) => category.kind === type).sort((a, b) => a.name.localeCompare(b.name));
  return categories.length
    ? categories.map((category) => `<option value="${category.id}" ${category.id === selected ? "selected" : ""}>${escapeHTML(category.name)}</option>`).join("")
    : `<option value="">No ${type} categories</option>`;
}

function refreshSplitCategoryOptions(type = el.entryType.value) {
  if (type === "transfer" || !el.entrySplitRows) return;
  el.entrySplitRows.querySelectorAll(".split-category").forEach((select) => {
    const current = select.value;
    select.innerHTML = entryCategoryOptionsHTML(type, current);
    if ([...select.options].some((option) => option.value === current)) select.value = current;
  });
}

function splitsForTransaction(transactionId) {
  return state.transactionSplits.filter((split) => split.transaction_id === transactionId).sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")));
}

function transactionAllocations(transaction) {
  const splits = splitsForTransaction(transaction.id);
  if (splits.length) return splits.map((split) => ({ category_id: split.category_id, amount: number(split.amount) }));
  return transaction.category_id ? [{ category_id: transaction.category_id, amount: number(transaction.amount) }] : [];
}

function transactionCategorySearchText(transaction) {
  return transactionAllocations(transaction).map((allocation) => categoryById(allocation.category_id)?.name || "Uncategorized").join(" ");
}

function transactionCategorySummary(transaction) {
  const allocations = transactionAllocations(transaction);
  if (!allocations.length) return "Uncategorized";
  if (allocations.length === 1) return categoryById(allocations[0].category_id)?.name || "Uncategorized";
  const visible = allocations.slice(0, 3).map((allocation) => `${categoryById(allocation.category_id)?.name || "Uncategorized"} ${formatMoneyText(allocation.amount)}`);
  return `Split: ${visible.join(" + ")}${allocations.length > 3 ? ` + ${allocations.length - 3} more` : ""}`;
}

function setSplitMode(enabled, rows = null) {
  const type = el.entryType.value;
  const active = Boolean(enabled && type !== "transfer");
  el.entrySplitEnabled.checked = active;
  el.entryCategoryField.hidden = type === "transfer" || active;
  el.entrySplitEditor.hidden = !active;
  if (active) {
    if (rows) {
      el.entrySplitRows.innerHTML = "";
      rows.forEach((row) => addSplitRow(row, true));
    }
    ensureMinimumSplitRows();
    refreshSplitCategoryOptions(type);
  }
  updateSplitSummary();
}

function addSplitRow(row = {}, deferSummary = false) {
  const type = el.entryType.value;
  if (type === "transfer") return;
  const wrapper = document.createElement("div");
  wrapper.className = "split-row";
  wrapper.innerHTML = `<label class="field"><span>Category</span><select class="split-category">${entryCategoryOptionsHTML(type, row.category_id || "")}</select></label><label class="field"><span>Amount</span><div class="money-input"><span class="aed-symbol" aria-hidden="true"></span><input class="split-amount" type="number" min="0.01" step="0.01" inputmode="decimal" value="${row.amount ? escapeHTML(number(row.amount).toFixed(2)) : ""}" placeholder="0.00" /></div></label><button class="row-action danger split-remove" type="button" data-remove-split aria-label="Remove split">×</button>`;
  el.entrySplitRows.append(wrapper);
  if (!deferSummary) updateSplitSummary();
}

function ensureMinimumSplitRows() {
  if (!el.entrySplitEnabled.checked || el.entryType.value === "transfer") return;
  while (el.entrySplitRows.children.length < 2) addSplitRow();
  el.entrySplitRows.querySelectorAll("[data-remove-split]").forEach((button) => { button.disabled = el.entrySplitRows.children.length <= 2; });
}

function collectSplitRows() {
  if (!el.entrySplitEnabled.checked || el.entryType.value === "transfer") return [];
  const rows = [...el.entrySplitRows.querySelectorAll(".split-row")].map((row) => ({
    category_id: row.querySelector(".split-category")?.value || "",
    amount: roundMoney(row.querySelector(".split-amount")?.value),
  }));
  if (rows.length < 2) throw new Error("Add at least two category splits.");
  if (rows.some((row) => !row.category_id)) throw new Error("Choose a category for every split.");
  if (rows.some((row) => !(row.amount > 0))) throw new Error("Every split amount must be greater than zero.");
  if (new Set(rows.map((row) => row.category_id)).size !== rows.length) throw new Error("Use each category only once in a split transaction.");
  const type = el.entryType.value;
  if (rows.some((row) => categoryById(row.category_id)?.kind !== type)) throw new Error(`Every split must use an ${type} category.`);
  const total = roundMoney(rows.reduce((sum, row) => sum + row.amount, 0));
  const transactionAmount = roundMoney(el.entryAmount.value);
  if (Math.abs(total - transactionAmount) >= 0.005) throw new Error(`Split amounts must equal ${formatMoneyText(transactionAmount)}. ${formatMoneyText(transactionAmount - total)} remains.`);
  return rows;
}

function updateSplitSummary() {
  if (!el.entrySplitSummary) return;
  const total = roundMoney([...el.entrySplitRows.querySelectorAll(".split-amount")].reduce((sum, input) => sum + number(input.value), 0));
  const amount = roundMoney(el.entryAmount.value);
  const remaining = roundMoney(amount - total);
  const balanced = amount > 0 && Math.abs(remaining) < 0.005;
  el.entrySplitSummary.classList.toggle("balanced", balanced);
  el.entrySplitSummary.classList.toggle("unbalanced", !balanced && el.entrySplitEnabled.checked);
  el.entrySplitTotal.textContent = formatMoneyText(total);
  el.entrySplitRemaining.textContent = balanced ? "Balanced" : `${formatMoneyText(remaining)} remaining`;
  ensureMinimumSplitRows();
}

function roundMoney(value) {
  return Math.round(number(value) * 100) / 100;
}

function renderRecurringCategories(type) {
  if (type === "transfer") return;
  const previous = el.recurringCategory.value;
  el.recurringCategory.innerHTML = state.categories.filter((category) => category.kind === type).sort((a, b) => a.name.localeCompare(b.name)).map((category) => `<option value="${category.id}">${escapeHTML(category.name)}</option>`).join("") || `<option value="">No ${type} categories</option>`;
  if ([...el.recurringCategory.options].some((option) => option.value === previous)) el.recurringCategory.value = previous;
}

function setEntryType(type) {
  el.entryType.value = type;
  document.querySelectorAll("[data-entry-type]").forEach((button) => button.classList.toggle("active", button.dataset.entryType === type));
  document.querySelectorAll(".expense-income-field").forEach((field) => field.hidden = type === "transfer");
  document.querySelectorAll(".transfer-field").forEach((field) => field.hidden = type !== "transfer");
  el.accountLabel.textContent = type === "income" ? "Add to account" : "Pay from account";
  el.categoryLabel.textContent = type === "income" ? "Income category" : "Expense category";
  renderEntryCategories(type);
  if (type === "transfer") setSplitMode(false);
  else setSplitMode(el.entrySplitEnabled.checked);
}

function openTransactionModal(id = null, presetDate = "", billId = "") {
  pendingBillPaymentId = billId || "";
  if (!state.accounts.length) return showToast("Add an account before recording an entry.", true);
  clearReceiptFormState();
  resetReceiptOcrState();
  el.transactionForm.reset();
  el.transactionId.value = "";
  el.entrySplitRows.innerHTML = "";
  el.entrySplitEnabled.checked = false;
  el.entryDate.value = presetDate || todayISO();
  el.transactionFormError.textContent = "";
  el.receiptFileHelp.textContent = mode === "cloud"
    ? "Receipts are stored privately in your Supabase project and are available on your signed-in devices."
    : "Receipt uploads require Supabase cloud sync. Remarks are still saved in local preview.";
  let type = "expense";
  if (id) {
    const transaction = state.transactions.find((item) => item.id === id);
    if (!transaction) return;
    if (transactionHasReconciledSide(transaction)) return showToast("Undo the related reconciliation before editing this entry.", true);
    type = transaction.type;
    el.transactionId.value = id;
    el.entryAmount.value = number(transaction.amount);
    el.entryDate.value = transaction.entry_date;
    el.entryDescription.value = transaction.description || "";
    el.entryRemarks.value = transaction.remarks || "";
    setEntryType(type);
    if (type === "transfer") {
      el.transferFromAccount.value = transaction.from_account_id || "";
      el.transferToAccount.value = transaction.to_account_id || "";
    } else {
      el.entryAccount.value = transaction.account_id || "";
      const splits = splitsForTransaction(transaction.id);
      if (splits.length) setSplitMode(true, splits);
      else {
        el.entryCategory.value = transaction.category_id || "";
        setSplitMode(false);
      }
    }
    el.transactionModalTitle.textContent = "Edit entry";
    if (transaction.receipt_path) showExistingReceiptPreview(transaction);
  } else {
    setEntryType(type);
    setSplitMode(false);
    el.transactionModalTitle.textContent = "Add entry";
  }
  openModal(el.transactionModal);
  el.entryAmount.focus();
}

async function handleTransactionSubmit(event) {
  event.preventDefault();
  el.transactionFormError.textContent = "";
  const id = el.transactionId.value;
  const type = el.entryType.value;
  const amount = number(el.entryAmount.value);
  const remarks = el.entryRemarks.value.trim();
  const existing = id ? state.transactions.find((item) => item.id === id) : null;
  let splitRows = [];
  const base = {
    type, amount, entry_date: el.entryDate.value, description: el.entryDescription.value.trim(), remarks,
    account_id: null, category_id: null, from_account_id: null, to_account_id: null,
  };
  if (!(amount > 0)) return showFormError(el.transactionFormError, "Enter an amount greater than zero.");
  if (!base.entry_date) return showFormError(el.transactionFormError, "Choose a transaction date.");
  if (base.description.length > 120) return showFormError(el.transactionFormError, "Description must be 120 characters or fewer.");
  if (remarks.length > 2000) return showFormError(el.transactionFormError, "Remarks must be 2,000 characters or fewer.");
  if (selectedReceiptFile && mode !== "cloud") return showFormError(el.transactionFormError, "Receipt uploads require Supabase cloud sync.");
  if (type === "transfer") {
    base.from_account_id = el.transferFromAccount.value;
    base.to_account_id = el.transferToAccount.value;
    if (!base.from_account_id || !base.to_account_id) return showFormError(el.transactionFormError, "Choose both transfer accounts.");
    if (base.from_account_id === base.to_account_id) return showFormError(el.transactionFormError, "Choose two different accounts.");
  } else {
    base.account_id = el.entryAccount.value;
    if (!base.account_id) return showFormError(el.transactionFormError, "Choose an account.");
    try {
      splitRows = collectSplitRows();
    } catch (error) {
      return showFormError(el.transactionFormError, friendlyError(error));
    }
    base.category_id = splitRows.length ? null : el.entryCategory.value || null;
    if (!splitRows.length && !base.category_id) return showFormError(el.transactionFormError, `Create or select an ${type} category.`);
  }

  let newlyUploadedPath = "";
  let newlyInsertedId = "";
  try {
    if (id) {
      let receiptChanges = {};
      if (selectedReceiptFile) {
        receiptChanges = await uploadReceipt(id, selectedReceiptFile);
        newlyUploadedPath = receiptChanges.receipt_path;
      } else if (removeExistingReceipt) {
        receiptChanges = { receipt_path: null, receipt_name: null, receipt_mime_type: null, receipt_size: null };
      }
      const updated = await updateRow("transactions", id, { ...base, ...receiptChanges });
      const mergedTransaction = { ...existing, ...updated };
      state.transactions = state.transactions.map((item) => item.id === id ? mergedTransaction : item);
      await replaceTransactionSplits(id, splitRows);
      await cleanupTransactionClearingsForTransaction(id, mergedTransaction);
      if ((selectedReceiptFile || removeExistingReceipt) && existing?.receipt_path && existing.receipt_path !== updated.receipt_path) {
        await removeReceiptFile(existing.receipt_path, false);
      }
      newlyUploadedPath = "";
      pendingBillPaymentId = "";
      showToast(selectedReceiptFile ? "Entry and receipt updated." : "Entry updated.");
    } else {
      let inserted = await insertRow("transactions", base);
      newlyInsertedId = inserted.id;
      if (selectedReceiptFile) {
        const receiptChanges = await uploadReceipt(inserted.id, selectedReceiptFile);
        newlyUploadedPath = receiptChanges.receipt_path;
        const updated = await updateRow("transactions", inserted.id, receiptChanges);
        inserted = { ...inserted, ...updated };
      }
      state.transactions.push(inserted);
      await replaceTransactionSplits(inserted.id, splitRows);
      if (pendingBillPaymentId) await completeBillWithTransaction(pendingBillPaymentId, inserted.id);
      pendingBillPaymentId = "";
      newlyInsertedId = "";
      newlyUploadedPath = "";
      showToast(selectedReceiptFile ? "Entry and receipt added." : "Entry added.");
    }
    persistLocal();
    closeModal(el.transactionModal);
    clearReceiptFormState();
    render();
  } catch (error) {
    if (newlyUploadedPath) await removeReceiptFile(newlyUploadedPath, false);
    if (newlyInsertedId) {
      try { await deleteRow("transactions", newlyInsertedId); } catch (rollbackError) { console.warn("Could not roll back transaction", rollbackError); }
      state.transactionSplits = state.transactionSplits.filter((split) => split.transaction_id !== newlyInsertedId);
    }
    pendingBillPaymentId = "";
    showFormError(el.transactionFormError, friendlyError(error));
  }
}

async function replaceTransactionSplits(transactionId, rows) {
  const cleanRows = rows.map((row) => ({ category_id: row.category_id, amount: roundMoney(row.amount) }));
  if (mode === "cloud") {
    setSyncStatus("syncing", "Saving category splits");
    const { data, error } = await supabase.rpc("replace_transaction_splits", {
      p_transaction_id: transactionId,
      p_splits: cleanRows,
    });
    if (error) throw error;
    state.transactionSplits = state.transactionSplits.filter((split) => split.transaction_id !== transactionId);
    state.transactionSplits.push(...(data || []));
    setSyncStatus("cloud", "Cloud synchronized");
    return;
  }
  state.transactionSplits = state.transactionSplits.filter((split) => split.transaction_id !== transactionId);
  state.transactionSplits.push(...cleanRows.map((row) => localRow({ ...row, transaction_id: transactionId })));
}

function handleReceiptSelection(event) {
  const file = event.target.files?.[0] || null;
  if (!file) {
    selectedReceiptFile = null;
    const existing = state.transactions.find((item) => item.id === el.transactionId.value);
    if (existing?.receipt_path && !removeExistingReceipt) showExistingReceiptPreview(existing);
    else hideReceiptPreview();
    resetReceiptOcrState();
    updateReceiptOcrAvailability();
    return;
  }
  try {
    validateReceiptFile(file);
    if (mode !== "cloud") throw new Error("Receipt uploads require Supabase cloud sync.");
    selectedReceiptFile = file;
    removeExistingReceipt = false;
    el.receiptFileHelp.textContent = "The selected receipt will be uploaded privately when you save this entry.";
    showSelectedReceiptPreview(file);
    updateReceiptOcrAvailability();
  } catch (error) {
    event.target.value = "";
    selectedReceiptFile = null;
    updateReceiptOcrAvailability();
    showFormError(el.transactionFormError, friendlyError(error));
  }
}

function resetReceiptOcrState() {
  receiptOcrBusy = false;
  receiptOcrResult = null;
  if (!el.receiptOcrPanel) return;
  el.receiptOcrPanel.hidden = true;
  el.receiptOcrMerchant.value = "";
  el.receiptOcrDate.value = "";
  el.receiptOcrTotal.value = "";
  el.receiptOcrTax.value = "";
  el.receiptOcrReference.value = "";
  el.receiptOcrRawText.value = "";
  el.receiptOcrConfidence.textContent = "";
  el.receiptOcrRuleHint.textContent = "";
  el.receiptOcrStatus.textContent = "Choose a receipt image to scan.";
  el.scanReceiptButton.textContent = "⌕ Scan receipt";
}

function currentReceiptForOcr() {
  if (selectedReceiptFile) return { source: selectedReceiptFile, type: receiptMimeType(selectedReceiptFile), name: selectedReceiptFile.name };
  const transaction = state.transactions.find((item) => item.id === el.transactionId.value);
  if (transaction?.receipt_path && !removeExistingReceipt) return { source: transaction.receipt_path, type: String(transaction.receipt_mime_type || "").toLowerCase(), name: transaction.receipt_name || "Receipt" };
  return null;
}

function updateReceiptOcrAvailability() {
  if (!el.scanReceiptButton) return;
  const receipt = currentReceiptForOcr();
  const supported = receipt && OCR_IMAGE_TYPES.has(receipt.type);
  el.scanReceiptButton.disabled = receiptOcrBusy || !supported;
  if (receiptOcrBusy) return;
  if (!receipt) el.receiptOcrStatus.textContent = "Choose a receipt image to scan.";
  else if (!supported) el.receiptOcrStatus.textContent = "OCR supports JPEG, PNG, or WebP. HEIC/HEIF can still be attached.";
  else el.receiptOcrStatus.textContent = "Ready to scan in this browser.";
}

async function scanReceiptWithOcr() {
  if (receiptOcrBusy) return;
  const receipt = currentReceiptForOcr();
  if (!receipt) return showFormError(el.transactionFormError, "Choose or open a receipt before scanning.");
  if (!OCR_IMAGE_TYPES.has(receipt.type)) return showFormError(el.transactionFormError, "Receipt OCR supports JPEG, PNG, and WebP images.");
  receiptOcrBusy = true;
  receiptOcrResult = null;
  el.transactionFormError.textContent = "";
  el.scanReceiptButton.disabled = true;
  el.scanReceiptButton.textContent = "Scanning…";
  el.receiptOcrStatus.textContent = "Preparing receipt image…";
  el.receiptOcrPanel.hidden = true;
  let worker = null;
  try {
    const image = await prepareReceiptImageForOcr(receipt);
    const { createWorker } = await import(TESSERACT_ESM_URL);
    worker = await createWorker("eng", 1, {
      logger: (message) => {
        if (!message?.status) return;
        const progress = Number.isFinite(message.progress) ? ` ${Math.round(message.progress * 100)}%` : "";
        el.receiptOcrStatus.textContent = `${capitalize(message.status.replaceAll("_", " "))}${progress}`;
      },
    });
    const { data } = await worker.recognize(image, { rotateAuto: true });
    const parsed = parseReceiptText(data?.text || "");
    receiptOcrResult = { ...parsed, rawText: data?.text || "", confidence: number(data?.confidence) };
    showReceiptOcrResult(receiptOcrResult);
    el.receiptOcrStatus.textContent = "Scan complete. Review the detected values below.";
  } catch (error) {
    el.receiptOcrStatus.textContent = "Could not scan this receipt.";
    showFormError(el.transactionFormError, `Receipt OCR failed: ${friendlyError(error)}`);
  } finally {
    if (worker) await worker.terminate().catch(() => {});
    receiptOcrBusy = false;
    el.scanReceiptButton.textContent = "⌕ Scan again";
    updateReceiptOcrAvailability();
  }
}

async function prepareReceiptImageForOcr(receipt) {
  let sourceUrl = "";
  let revoke = false;
  if (receipt.source instanceof File || receipt.source instanceof Blob) {
    sourceUrl = URL.createObjectURL(receipt.source);
    revoke = true;
  } else {
    sourceUrl = await createReceiptSignedUrl(receipt.source, 300);
  }
  try {
    const image = await loadImageElement(sourceUrl);
    const longest = Math.max(image.naturalWidth, image.naturalHeight);
    const scale = Math.min(2.4, Math.max(1, 1900 / Math.max(1, longest)));
    const maxDimension = 2800;
    const finalScale = Math.min(scale, maxDimension / Math.max(1, longest));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * finalScale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * finalScale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.filter = "grayscale(1) contrast(1.35) brightness(1.05)";
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Could not prepare the receipt image.")), "image/png", 0.95));
  } finally {
    if (revoke) URL.revokeObjectURL(sourceUrl);
  }
}

function loadImageElement(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The receipt image could not be opened for OCR."));
    image.src = url;
  });
}

function parseReceiptText(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const merchant = detectReceiptMerchant(lines);
  const date = detectReceiptDate(lines);
  const total = detectReceiptAmount(lines, ["grand total", "amount due", "total due", "net total", "balance due", "total"], ["subtotal", "sub total", "tax", "vat", "change"]);
  const tax = detectReceiptAmount(lines, ["vat", "tax"], ["total"]);
  const reference = detectReceiptReference(lines);
  return { merchant, date, total, tax, reference, lineCount: lines.length };
}

function detectReceiptMerchant(lines) {
  const banned = /\b(receipt|tax invoice|invoice|date|time|tel|phone|mobile|trn|vat|total|subtotal|cashier|branch|address|www\.|https?|thank you)\b/i;
  const candidate = lines.slice(0, 10).find((line) => /[A-Za-z]{3}/.test(line) && !banned.test(line) && !/^\W*\d/.test(line) && line.length >= 3 && line.length <= 80);
  return candidate ? candidate.replace(/[^\p{L}\p{N}&.'’\- ]/gu, "").trim().slice(0, 120) : "";
}

function detectReceiptDate(lines) {
  const joined = lines.join(" | ");
  const patterns = [
    /\b(20\d{2})[\/.\-](\d{1,2})[\/.\-](\d{1,2})\b/,
    /\b(\d{1,2})[\/.\-](\d{1,2})[\/.\-](20\d{2}|\d{2})\b/,
    /\b(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(20\d{2}|\d{2})\b/i,
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2}),?\s+(20\d{2}|\d{2})\b/i,
  ];
  for (let index = 0; index < patterns.length; index += 1) {
    const match = joined.match(patterns[index]);
    if (!match) continue;
    let year; let month; let day;
    if (index === 0) [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (index === 1) [day, month, year] = [Number(match[1]), Number(match[2]), normalizeReceiptYear(match[3])];
    if (index === 2) [day, month, year] = [Number(match[1]), receiptMonthNumber(match[2]), normalizeReceiptYear(match[3])];
    if (index === 3) [month, day, year] = [receiptMonthNumber(match[1]), Number(match[2]), normalizeReceiptYear(match[3])];
    const iso = validISODate(year, month, day);
    if (iso) return iso;
  }
  return "";
}

function normalizeReceiptYear(value) {
  const year = Number(value);
  return year < 100 ? 2000 + year : year;
}

function receiptMonthNumber(value) {
  return ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(String(value || "").slice(0, 3).toLowerCase()) + 1;
}

function detectReceiptAmount(lines, keywords, exclusions = []) {
  const amountPattern = /(?:AED|DHS?|د\.?\s?إ\.?)?\s*([0-9]{1,3}(?:[, ]?[0-9]{3})*(?:[.,][0-9]{2})|[0-9]+(?:[.,][0-9]{2}))\s*(?:AED|DHS?|د\.?\s?إ\.?)?/gi;
  const candidates = [];
  lines.forEach((line, lineIndex) => {
    const lower = line.toLowerCase();
    const keywordIndex = keywords.findIndex((keyword) => lower.includes(keyword));
    if (keywordIndex < 0 || exclusions.some((keyword) => lower.includes(keyword))) return;
    const matches = [...line.matchAll(amountPattern)];
    matches.forEach((match) => {
      const amount = parseReceiptNumber(match[1]);
      if (amount > 0) candidates.push({ amount, score: (keywords.length - keywordIndex) * 100 + lineIndex });
    });
  });
  if (candidates.length) return candidates.sort((a, b) => b.score - a.score || b.amount - a.amount)[0].amount;
  if (keywords.includes("total")) {
    const all = lines.flatMap((line, lineIndex) => [...line.matchAll(amountPattern)].map((match) => ({ amount: parseReceiptNumber(match[1]), lineIndex }))).filter((item) => item.amount > 0);
    return all.sort((a, b) => b.lineIndex - a.lineIndex || b.amount - a.amount)[0]?.amount || 0;
  }
  return 0;
}

function parseReceiptNumber(value) {
  const raw = String(value || "").replace(/\s/g, "");
  if (raw.includes(",") && raw.includes(".")) return number(raw.replace(/,/g, ""));
  if (raw.includes(",") && /,\d{2}$/.test(raw)) return number(raw.replace(",", "."));
  return number(raw.replace(/,/g, ""));
}

function detectReceiptReference(lines) {
  const pattern = /\b(?:receipt|invoice|bill|reference|ref|transaction)\s*(?:no\.?|number|#)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9\/-]{3,})\b/i;
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return match[1].slice(0, 120);
  }
  return "";
}

function showReceiptOcrResult(result) {
  el.receiptOcrMerchant.value = result.merchant || "";
  el.receiptOcrDate.value = result.date || "";
  el.receiptOcrTotal.value = result.total ? result.total.toFixed(2) : "";
  el.receiptOcrTax.value = result.tax ? result.tax.toFixed(2) : "";
  el.receiptOcrReference.value = result.reference || "";
  el.receiptOcrRawText.value = result.rawText || "";
  el.receiptOcrConfidence.textContent = result.confidence ? `${Math.round(result.confidence)}% OCR confidence` : "";
  const rule = result.merchant ? findMatchingImportRule({ description: result.merchant, remarks: "", type: el.entryType.value }) : null;
  el.receiptOcrRuleHint.textContent = rule ? `Matching rule: ${rule.name}` : "No matching import rule found.";
  el.receiptOcrPanel.hidden = false;
}

function applyReceiptOcrResult() {
  if (!receiptOcrResult) return;
  const merchant = el.receiptOcrMerchant.value.trim();
  const date = el.receiptOcrDate.value;
  const total = number(el.receiptOcrTotal.value);
  const tax = number(el.receiptOcrTax.value);
  const reference = el.receiptOcrReference.value.trim();
  if (merchant) el.entryDescription.value = merchant;
  if (date) el.entryDate.value = date;
  if (total > 0) {
    el.entryAmount.value = total.toFixed(2);
    updateSplitSummary();
  }
  const detailParts = [];
  if (tax > 0) detailParts.push(`VAT: ${formatMoneyText(tax)}`);
  if (reference) detailParts.push(`Receipt reference: ${reference}`);
  if (detailParts.length) {
    const existing = el.entryRemarks.value.trim();
    const addition = detailParts.join(" · ");
    if (!existing.toLowerCase().includes(addition.toLowerCase())) el.entryRemarks.value = [existing, addition].filter(Boolean).join("\n");
  }
  const rule = merchant ? findMatchingImportRule({ description: merchant, remarks: el.entryRemarks.value, type: el.entryType.value }) : null;
  if (rule && rule.transaction_type === el.entryType.value && rule.transaction_type !== "transfer") {
    if (rule.account_id && [...el.entryAccount.options].some((option) => option.value === rule.account_id)) el.entryAccount.value = rule.account_id;
    if (!el.entrySplitEnabled.checked && rule.category_id && [...el.entryCategory.options].some((option) => option.value === rule.category_id)) el.entryCategory.value = rule.category_id;
    showToast(`Receipt details applied with rule “${rule.name}”.`);
  } else {
    showToast("Receipt details applied. Review them before saving.");
  }
}

function validateReceiptFile(file) {
  const type = receiptMimeType(file);
  if (!file || !ALLOWED_RECEIPT_TYPES.has(type)) throw new Error("Choose a JPEG, PNG, WebP, HEIC, or HEIF image.");
  if (file.size > MAX_RECEIPT_BYTES) throw new Error("Receipt image must be 8 MB or smaller.");
}

function receiptMimeType(file) {
  const browserType = String(file?.type || "").toLowerCase();
  if (ALLOWED_RECEIPT_TYPES.has(browserType)) return browserType;
  const extension = String(file?.name || "").toLowerCase().split(".").pop();
  return ({ jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" })[extension] || "";
}

function clearReceiptFormState() {
  resetReceiptOcrState();
  selectedReceiptFile = null;
  removeExistingReceipt = false;
  if (el.entryReceipt) el.entryReceipt.value = "";
  hideReceiptPreview();
  updateReceiptOcrAvailability();
}

function revokeReceiptPreviewUrl() {
  if (receiptPreviewObjectUrl) URL.revokeObjectURL(receiptPreviewObjectUrl);
  receiptPreviewObjectUrl = "";
}

function hideReceiptPreview() {
  revokeReceiptPreviewUrl();
  if (!el.receiptPreview) return;
  el.receiptPreview.hidden = true;
  el.receiptPreviewImage.removeAttribute("src");
  el.receiptPreviewImage.hidden = true;
  el.receiptPreviewFallback.hidden = false;
}

function showSelectedReceiptPreview(file) {
  revokeReceiptPreviewUrl();
  receiptPreviewObjectUrl = URL.createObjectURL(file);
  el.receiptPreview.hidden = false;
  el.receiptPreviewName.textContent = file.name;
  el.receiptPreviewInfo.textContent = `New receipt · ${formatFileSize(file.size)}`;
  el.receiptPreviewImage.src = receiptPreviewObjectUrl;
  el.receiptPreviewImage.hidden = false;
  el.receiptPreviewFallback.hidden = true;
  el.receiptPreviewImage.onerror = () => {
    el.receiptPreviewImage.hidden = true;
    el.receiptPreviewFallback.hidden = false;
  };
}

async function showExistingReceiptPreview(transaction) {
  revokeReceiptPreviewUrl();
  el.receiptPreview.hidden = false;
  el.receiptPreviewName.textContent = transaction.receipt_name || "Receipt image";
  el.receiptPreviewInfo.textContent = `${formatFileSize(transaction.receipt_size)} · Stored privately`;
  el.receiptPreviewImage.hidden = true;
  el.receiptPreviewFallback.hidden = false;
  updateReceiptOcrAvailability();
  if (mode !== "cloud") return;
  try {
    const url = await createReceiptSignedUrl(transaction.receipt_path, 300);
    if (el.transactionId.value !== transaction.id || selectedReceiptFile || removeExistingReceipt) return;
    el.receiptPreviewImage.src = url;
    el.receiptPreviewImage.hidden = false;
    el.receiptPreviewFallback.hidden = true;
    el.receiptPreviewImage.onerror = () => {
      el.receiptPreviewImage.hidden = true;
      el.receiptPreviewFallback.hidden = false;
    };
  } catch (error) {
    console.warn("Could not load receipt preview", error);
  } finally {
    updateReceiptOcrAvailability();
  }
}

function removeReceiptFromForm() {
  const existing = state.transactions.find((item) => item.id === el.transactionId.value);
  selectedReceiptFile = null;
  el.entryReceipt.value = "";
  removeExistingReceipt = Boolean(existing?.receipt_path);
  hideReceiptPreview();
  resetReceiptOcrState();
  updateReceiptOcrAvailability();
  el.receiptFileHelp.textContent = removeExistingReceipt
    ? "The existing receipt will be removed when you save this entry."
    : mode === "cloud"
      ? "Receipts are stored privately in your Supabase project and are available on your signed-in devices."
      : "Receipt uploads require Supabase cloud sync. Remarks are still saved in local preview.";
}

async function viewReceiptFromForm() {
  if (selectedReceiptFile && receiptPreviewObjectUrl) {
    window.open(receiptPreviewObjectUrl, "_blank", "noopener,noreferrer");
    return;
  }
  const transaction = state.transactions.find((item) => item.id === el.transactionId.value);
  if (transaction?.receipt_path && !removeExistingReceipt) await openReceiptPath(transaction.receipt_path);
}

async function openTransactionReceipt(id) {
  const transaction = state.transactions.find((item) => item.id === id);
  if (!transaction?.receipt_path) return showToast("This entry does not have a receipt.", true);
  await openReceiptPath(transaction.receipt_path);
}

async function openReceiptPath(path) {
  if (mode !== "cloud") return showToast("Receipt viewing requires Supabase cloud sync.", true);
  const popup = window.open("about:blank", "_blank");
  try {
    const url = await createReceiptSignedUrl(path, 120);
    if (popup) popup.location.href = url;
    else window.open(url, "_blank", "noopener,noreferrer");
  } catch (error) {
    if (popup) popup.close();
    showToast(friendlyError(error), true);
  }
}

async function createReceiptSignedUrl(path, expiresIn = 120) {
  const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(path, expiresIn);
  if (error) throw error;
  const url = data?.signedUrl || data?.signedURL;
  if (!url) throw new Error("Could not create a secure receipt link.");
  return url;
}

async function uploadReceipt(transactionId, file) {
  validateReceiptFile(file);
  if (mode !== "cloud") throw new Error("Receipt uploads require Supabase cloud sync.");
  setSyncStatus("syncing", "Uploading receipt");
  const safeName = sanitizeReceiptFilename(file.name);
  const path = `${user.id}/${transactionId}/${crypto.randomUUID()}-${safeName}`;
  const mimeType = receiptMimeType(file);
  const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: mimeType,
  });
  if (error) throw error;
  setSyncStatus("cloud", "Cloud synchronized");
  return {
    receipt_path: data?.path || path,
    receipt_name: file.name.slice(0, 255),
    receipt_mime_type: mimeType.slice(0, 100),
    receipt_size: file.size,
  };
}

async function removeReceiptFile(path, showError = true) {
  if (!path || mode !== "cloud") return true;
  const { error } = await supabase.storage.from(RECEIPT_BUCKET).remove([path]);
  if (error) {
    if (showError) showToast(`The entry was saved, but the old receipt could not be removed: ${friendlyError(error)}`, true);
    else console.warn("Could not remove receipt", error);
    return false;
  }
  return true;
}

function sanitizeReceiptFilename(name) {
  const cleaned = String(name || "receipt.jpg").normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return (cleaned || "receipt.jpg").slice(-120);
}

function formatFileSize(bytes) {
  const value = number(bytes);
  if (!value) return "Size unavailable";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function resetCardArtworkFormState() {
  selectedCardArtworkFile = null;
  removeExistingCardArtwork = false;
  existingCardArtworkPreviewUrl = "";
  if (cardArtworkPreviewObjectUrl) URL.revokeObjectURL(cardArtworkPreviewObjectUrl);
  cardArtworkPreviewObjectUrl = "";
  el.accountCardArtwork.value = "";
  el.viewCardArtworkButton.hidden = true;
  el.removeCardArtworkButton.hidden = true;
}

function openAccountModal(id = null) {
  el.accountForm.reset();
  resetCardArtworkFormState();
  el.accountId.value = "";
  el.accountOpeningBalance.value = "0";
  el.accountIncludeNetWorth.checked = true;
  el.accountType.value = "current";
  el.accountColor.value = ACCOUNT_COLORS.current;
  el.accountCardNetwork.value = "visa";
  el.accountCardLastFour.value = "";
  el.accountCardAccentColor.value = "#0f172a";
  el.accountCreditLimit.value = "";
  el.accountStatementClosingDay.value = "";
  el.accountPaymentDueDay.value = "";
  el.accountFormError.textContent = "";
  if (id) {
    const account = state.accounts.find((item) => item.id === id);
    if (!account) return;
    el.accountId.value = id;
    el.accountName.value = account.name;
    el.accountType.value = account.type;
    el.accountOpeningBalance.value = number(account.opening_balance);
    el.accountColor.value = safeColor(account.color);
    el.accountIncludeNetWorth.checked = account.include_in_net_worth !== false;
    el.accountCardNetwork.value = normalizeCardNetwork(account.card_network);
    el.accountCardLastFour.value = /^\d{4}$/.test(String(account.card_last_four || "")) ? account.card_last_four : "";
    el.accountCardAccentColor.value = safeColor(account.card_accent_color || "#0f172a");
    el.accountCreditLimit.value = account.credit_limit == null ? "" : number(account.credit_limit);
    el.accountStatementClosingDay.value = account.statement_closing_day || "";
    el.accountPaymentDueDay.value = account.payment_due_day || "";
    el.accountModalTitle.textContent = "Edit account";
    if (account.card_artwork_path) void loadExistingCardArtworkPreview(account);
  } else {
    el.accountModalTitle.textContent = "Add account";
  }
  updateCreditCardAccountFields();
  openModal(el.accountModal);
  el.accountName.focus();
}

function updateCreditCardAccountFields() {
  const isCreditCard = el.accountType.value === "credit";
  el.creditCardAccountFields.hidden = !isCreditCard;
  [el.accountCardNetwork, el.accountCardLastFour, el.accountCardAccentColor, el.accountCardArtwork, el.accountCreditLimit, el.accountStatementClosingDay, el.accountPaymentDueDay].forEach((input) => {
    input.disabled = !isCreditCard;
  });
  el.accountCardArtwork.disabled = !isCreditCard || mode !== "cloud";
  if (isCreditCard && mode !== "cloud") el.cardArtworkHelp.textContent = "Card colors and network work locally. Artwork upload requires Supabase cloud sync.";
  updateAccountCardPreview();
}

function accountCardPreviewObject() {
  return {
    name: el.accountName.value.trim() || "Credit card",
    color: safeColor(el.accountColor.value),
    card_accent_color: safeColor(el.accountCardAccentColor.value || "#0f172a"),
    card_network: normalizeCardNetwork(el.accountCardNetwork.value),
    card_last_four: /^\d{4}$/.test(el.accountCardLastFour.value.trim()) ? el.accountCardLastFour.value.trim() : "",
  };
}

function updateAccountCardPreview() {
  if (!el.accountCardPreview) return;
  const account = accountCardPreviewObject();
  const previewUrl = removeExistingCardArtwork ? "" : cardArtworkPreviewObjectUrl || existingCardArtworkPreviewUrl;
  const lastFour = account.card_last_four ? `•••• ${account.card_last_four}` : cardNetworkLabel(account.card_network);
  el.accountCardPreview.style.cssText = creditCardVisualStyle(account);
  el.accountCardPreview.classList.toggle("has-artwork", Boolean(previewUrl));
  el.accountCardPreview.innerHTML = `${previewUrl ? `<img src="${escapeHTML(previewUrl)}" alt="Selected card artwork preview" />` : ""}<span class="credit-card-artwork-shade" aria-hidden="true"></span><div class="credit-card-brand-row"><span class="credit-card-chip"></span>${creditCardBrandHTML(account)}</div><strong>${escapeHTML(account.name)}</strong><span>${escapeHTML(lastFour)}</span>`;
  const hasArtwork = Boolean(selectedCardArtworkFile || (!removeExistingCardArtwork && state.accounts.find((item) => item.id === el.accountId.value)?.card_artwork_path));
  el.viewCardArtworkButton.hidden = !hasArtwork;
  el.removeCardArtworkButton.hidden = !hasArtwork;
  if (selectedCardArtworkFile) el.cardArtworkHelp.textContent = `${selectedCardArtworkFile.name} · ${formatFileSize(selectedCardArtworkFile.size)} · uploads privately when saved.`;
  else if (removeExistingCardArtwork) el.cardArtworkHelp.textContent = "The existing artwork will be removed when you save.";
  else if (hasArtwork) el.cardArtworkHelp.textContent = "Artwork is stored privately in Supabase Storage. Use only a cropped image with sensitive details hidden.";
  else if (mode === "cloud") el.cardArtworkHelp.textContent = "Use colors for a clean digital card, or upload a cropped artwork image with all sensitive card details hidden.";
}

async function loadExistingCardArtworkPreview(account) {
  if (mode !== "cloud" || !account.card_artwork_path) return;
  try {
    existingCardArtworkPreviewUrl = await createCardArtworkSignedUrl(account.card_artwork_path, 600);
    if (el.accountId.value === account.id && !removeExistingCardArtwork && !selectedCardArtworkFile) updateAccountCardPreview();
  } catch (error) {
    el.cardArtworkHelp.textContent = `Artwork preview unavailable: ${friendlyError(error)}`;
  }
}

function validateCardArtworkFile(file) {
  if (!file) throw new Error("Choose an image file.");
  const type = String(file.type || "").toLowerCase();
  if (!ALLOWED_CARD_ARTWORK_TYPES.has(type)) throw new Error("Card artwork must be JPEG, PNG, WebP, HEIC, or HEIF.");
  if (file.size > MAX_CARD_ARTWORK_BYTES) throw new Error("Card artwork must be 5 MB or smaller.");
}

function handleCardArtworkSelection(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    validateCardArtworkFile(file);
    if (mode !== "cloud") throw new Error("Card artwork uploads require Supabase cloud sync.");
    selectedCardArtworkFile = file;
    removeExistingCardArtwork = false;
    if (cardArtworkPreviewObjectUrl) URL.revokeObjectURL(cardArtworkPreviewObjectUrl);
    cardArtworkPreviewObjectUrl = URL.createObjectURL(file);
    updateAccountCardPreview();
  } catch (error) {
    el.accountCardArtwork.value = "";
    showFormError(el.accountFormError, friendlyError(error));
  }
}

function removeCardArtworkFromForm() {
  const existing = state.accounts.find((item) => item.id === el.accountId.value);
  selectedCardArtworkFile = null;
  if (cardArtworkPreviewObjectUrl) URL.revokeObjectURL(cardArtworkPreviewObjectUrl);
  cardArtworkPreviewObjectUrl = "";
  el.accountCardArtwork.value = "";
  removeExistingCardArtwork = Boolean(existing?.card_artwork_path);
  updateAccountCardPreview();
}

async function viewCardArtworkFromForm() {
  if (selectedCardArtworkFile && cardArtworkPreviewObjectUrl) {
    window.open(cardArtworkPreviewObjectUrl, "_blank", "noopener,noreferrer");
    return;
  }
  const existing = state.accounts.find((item) => item.id === el.accountId.value);
  if (!existing?.card_artwork_path || removeExistingCardArtwork) return;
  const popup = window.open("about:blank", "_blank", "noopener,noreferrer");
  try {
    const url = await createCardArtworkSignedUrl(existing.card_artwork_path, 120);
    if (popup) popup.location.href = url;
    else window.open(url, "_blank", "noopener,noreferrer");
  } catch (error) {
    if (popup) popup.close();
    showToast(friendlyError(error), true);
  }
}

async function createCardArtworkSignedUrl(path, expiresIn = 120) {
  const { data, error } = await supabase.storage.from(CARD_ARTWORK_BUCKET).createSignedUrl(path, expiresIn);
  if (error) throw new Error(`Card artwork: ${error.message || error}`);
  const url = data?.signedUrl || data?.signedURL;
  if (!url) throw new Error("Card artwork: Could not create a secure link.");
  return url;
}

async function uploadCardArtwork(accountId, file) {
  validateCardArtworkFile(file);
  if (mode !== "cloud") throw new Error("Card artwork uploads require Supabase cloud sync.");
  setSyncStatus("syncing", "Uploading card artwork");
  const safeName = sanitizeCardArtworkFilename(file.name);
  const path = `${user.id}/${accountId}/${crypto.randomUUID()}-${safeName}`;
  const mimeType = String(file.type || "image/jpeg").toLowerCase();
  const { data, error } = await supabase.storage.from(CARD_ARTWORK_BUCKET).upload(path, file, {
    cacheControl: "3600",
    upsert: false,
    contentType: mimeType,
  });
  if (error) throw new Error(`Card artwork: ${error.message || error}`);
  setSyncStatus("cloud", "Cloud synchronized");
  return {
    card_artwork_path: data?.path || path,
    card_artwork_name: file.name.slice(0, 255),
    card_artwork_mime_type: mimeType.slice(0, 100),
    card_artwork_size: file.size,
  };
}

async function removeCardArtworkFile(path, showError = true) {
  if (!path || mode !== "cloud") return true;
  const { error } = await supabase.storage.from(CARD_ARTWORK_BUCKET).remove([path]);
  if (error) {
    const wrapped = new Error(`Card artwork: ${error.message || error}`);
    if (showError) showToast(`The account was saved, but the old card artwork could not be removed: ${friendlyError(wrapped)}`, true);
    else console.warn("Could not remove card artwork", error);
    return false;
  }
  return true;
}

function sanitizeCardArtworkFilename(name) {
  const cleaned = String(name || "card-artwork.jpg").normalize("NFKD").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return (cleaned || "card-artwork.jpg").slice(-120);
}

function optionalAccountDay(input) {
  const raw = String(input.value || "").trim();
  return raw ? Math.round(number(raw)) : null;
}

async function handleAccountSubmit(event) {
  event.preventDefault();
  el.accountFormError.textContent = "";
  const id = el.accountId.value;
  const existing = id ? state.accounts.find((item) => item.id === id) : null;
  const isCreditCard = el.accountType.value === "credit";
  const creditLimitRaw = String(el.accountCreditLimit.value || "").trim();
  const creditLimit = creditLimitRaw ? number(creditLimitRaw) : null;
  const closingDay = optionalAccountDay(el.accountStatementClosingDay);
  const dueDay = optionalAccountDay(el.accountPaymentDueDay);
  const lastFour = el.accountCardLastFour.value.trim();
  const row = {
    name: el.accountName.value.trim(),
    type: el.accountType.value,
    opening_balance: number(el.accountOpeningBalance.value),
    color: safeColor(el.accountColor.value),
    include_in_net_worth: el.accountIncludeNetWorth.checked,
    credit_limit: isCreditCard ? creditLimit : null,
    statement_closing_day: isCreditCard ? closingDay : null,
    payment_due_day: isCreditCard ? dueDay : null,
    card_network: isCreditCard ? normalizeCardNetwork(el.accountCardNetwork.value) : null,
    card_last_four: isCreditCard && lastFour ? lastFour : null,
    card_accent_color: isCreditCard ? safeColor(el.accountCardAccentColor.value || "#0f172a") : null,
  };
  if (!row.name) return showFormError(el.accountFormError, "Enter an account name.");
  if (isCreditCard && lastFour && !/^\d{4}$/.test(lastFour)) return showFormError(el.accountFormError, "Last 4 digits must contain exactly four numbers.");
  if (isCreditCard && creditLimitRaw && !(creditLimit > 0)) return showFormError(el.accountFormError, "Credit limit must be greater than zero.");
  if (closingDay !== null && (closingDay < 1 || closingDay > 31)) return showFormError(el.accountFormError, "Statement closing day must be between 1 and 31.");
  if (dueDay !== null && (dueDay < 1 || dueDay > 31)) return showFormError(el.accountFormError, "Payment due day must be between 1 and 31.");
  if (selectedCardArtworkFile && mode !== "cloud") return showFormError(el.accountFormError, "Card artwork uploads require Supabase cloud sync.");
  if (id && !isCreditCard && state.creditCardStatements.some((statement) => statement.account_id === id)) {
    return showFormError(el.accountFormError, "Delete this account's credit-card statements before changing it to another account type.");
  }
  const duplicate = state.accounts.some((account) => account.id !== id && account.name.toLowerCase() === row.name.toLowerCase());
  if (duplicate) return showFormError(el.accountFormError, "An account with that name already exists.");
  let newlyUploadedPath = "";
  let newlyInsertedId = "";
  try {
    if (id) {
      let artworkChanges = {};
      if (isCreditCard && selectedCardArtworkFile) {
        artworkChanges = await uploadCardArtwork(id, selectedCardArtworkFile);
        newlyUploadedPath = artworkChanges.card_artwork_path;
      } else if (!isCreditCard || removeExistingCardArtwork) {
        artworkChanges = { card_artwork_path: null, card_artwork_name: null, card_artwork_mime_type: null, card_artwork_size: null };
      }
      const updated = await updateRow("accounts", id, { ...row, ...artworkChanges });
      state.accounts = state.accounts.map((item) => item.id === id ? { ...item, ...updated } : item);
      if ((selectedCardArtworkFile || removeExistingCardArtwork || !isCreditCard) && existing?.card_artwork_path && existing.card_artwork_path !== updated.card_artwork_path) {
        await removeCardArtworkFile(existing.card_artwork_path, false);
      }
      showToast(selectedCardArtworkFile ? "Account and card artwork updated." : "Account updated.");
    } else {
      let inserted = await insertRow("accounts", row);
      newlyInsertedId = inserted.id;
      if (isCreditCard && selectedCardArtworkFile) {
        const artworkChanges = await uploadCardArtwork(inserted.id, selectedCardArtworkFile);
        newlyUploadedPath = artworkChanges.card_artwork_path;
        const updated = await updateRow("accounts", inserted.id, artworkChanges);
        inserted = { ...inserted, ...updated };
      }
      state.accounts.push(inserted);
      newlyInsertedId = "";
      showToast(selectedCardArtworkFile ? "Account and card artwork added." : "Account added.");
    }
    persistLocal(); closeModal(el.accountModal); resetCardArtworkFormState(); render();
  } catch (error) {
    if (newlyUploadedPath) await removeCardArtworkFile(newlyUploadedPath, false);
    if (newlyInsertedId) await deleteRow("accounts", newlyInsertedId).catch(() => {});
    showFormError(el.accountFormError, friendlyError(error));
  }
}

function openCreditCardStatementModal(id = null, presetAccountId = "") {
  const cards = creditCardAccounts();
  if (!cards.length) return showToast("Add a credit-card account first.", true);
  el.creditCardStatementForm.reset();
  el.creditCardStatementId.value = "";
  el.creditCardStatementFormError.textContent = "";
  el.creditCardStatementAccount.innerHTML = cards.map((account) => `<option value="${account.id}">${escapeHTML(account.name)}</option>`).join("");
  el.creditCardStatementDate.value = todayISO();
  el.creditCardMinimumPayment.value = "0";
  if (id) {
    const statement = state.creditCardStatements.find((item) => item.id === id);
    if (!statement) return;
    el.creditCardStatementId.value = statement.id;
    el.creditCardStatementAccount.value = statement.account_id;
    el.creditCardStatementDate.value = statement.statement_date;
    el.creditCardDueDate.value = statement.due_date;
    el.creditCardStatementBalance.value = number(statement.statement_balance);
    el.creditCardMinimumPayment.value = number(statement.minimum_payment);
    el.creditCardStatementNotes.value = statement.notes || "";
    el.creditCardStatementModalTitle.textContent = "Edit statement";
  } else {
    if (presetAccountId && cards.some((account) => account.id === presetAccountId)) el.creditCardStatementAccount.value = presetAccountId;
    el.creditCardStatementModalTitle.textContent = "Add statement";
    updateCreditCardStatementDueDate();
  }
  openModal(el.creditCardStatementModal);
  el.creditCardStatementBalance.focus();
}

function updateCreditCardStatementDueDate() {
  if (el.creditCardStatementId.value) return;
  const account = accountById(el.creditCardStatementAccount.value);
  const dueDate = configuredDueDateForStatement(account, el.creditCardStatementDate.value);
  if (dueDate) el.creditCardDueDate.value = dueDate;
}

async function handleCreditCardStatementSubmit(event) {
  event.preventDefault();
  el.creditCardStatementFormError.textContent = "";
  const id = el.creditCardStatementId.value;
  const row = {
    account_id: el.creditCardStatementAccount.value,
    statement_date: el.creditCardStatementDate.value,
    due_date: el.creditCardDueDate.value,
    statement_balance: number(el.creditCardStatementBalance.value),
    minimum_payment: number(el.creditCardMinimumPayment.value),
    notes: el.creditCardStatementNotes.value.trim(),
  };
  const account = accountById(row.account_id);
  if (!account || account.type !== "credit") return showFormError(el.creditCardStatementFormError, "Choose a credit-card account.");
  if (!row.statement_date || !row.due_date) return showFormError(el.creditCardStatementFormError, "Choose both the statement and payment due dates.");
  if (row.due_date < row.statement_date) return showFormError(el.creditCardStatementFormError, "Payment due date cannot be before the statement date.");
  if (row.statement_balance < 0) return showFormError(el.creditCardStatementFormError, "Statement amount due cannot be negative.");
  if (row.minimum_payment < 0) return showFormError(el.creditCardStatementFormError, "Minimum payment cannot be negative.");
  if (row.minimum_payment > row.statement_balance) return showFormError(el.creditCardStatementFormError, "Minimum payment cannot exceed the statement amount due.");
  if (row.notes.length > 500) return showFormError(el.creditCardStatementFormError, "Notes must be 500 characters or fewer.");
  const duplicate = state.creditCardStatements.some((statement) => statement.id !== id && statement.account_id === row.account_id && statement.statement_date === row.statement_date);
  if (duplicate) return showFormError(el.creditCardStatementFormError, "A statement already exists for this card and closing date.");
  try {
    if (id) {
      const updated = await updateRow("credit_card_statements", id, row);
      state.creditCardStatements = state.creditCardStatements.map((item) => item.id === id ? { ...item, ...updated } : item);
      showToast("Card statement updated.");
    } else {
      state.creditCardStatements.push(await insertRow("credit_card_statements", row));
      showToast("Card statement added.");
    }
    persistLocal(); closeModal(el.creditCardStatementModal); render();
  } catch (error) { showFormError(el.creditCardStatementFormError, friendlyError(error)); }
}

async function deleteCreditCardStatement(id) {
  const statement = state.creditCardStatements.find((item) => item.id === id);
  if (!statement || !confirm(`Delete the ${formatDate(statement.statement_date)} card statement?`)) return;
  try {
    await deleteRow("credit_card_statements", id);
    state.creditCardStatements = state.creditCardStatements.filter((item) => item.id !== id);
    persistLocal(); render(); showToast("Card statement deleted.");
  } catch (error) { showToast(friendlyError(error), true); }
}

function openCreditCardPayment(accountId) {
  const card = accountById(accountId);
  if (!card || card.type !== "credit") return;
  const source = state.accounts.find((account) => account.id !== accountId && account.type !== "credit") || state.accounts.find((account) => account.id !== accountId);
  if (!source) return showToast("Add another account to pay this credit card from.", true);
  openTransactionModal();
  setEntryType("transfer");
  el.transferFromAccount.value = source.id;
  el.transferToAccount.value = accountId;
  el.entryDescription.value = `${card.name} payment`;
  const latest = latestCreditCardStatement(accountId);
  if (latest) {
    const status = creditCardStatementStatus(latest);
    el.entryAmount.value = status.outstanding > 0 ? status.outstanding.toFixed(2) : "";
    el.entryRemarks.value = `Payment for statement dated ${formatDate(latest.statement_date)}`;
  }
  el.entryAmount.focus();
}

function openBudgetModal(id = null) {
  if (!state.categories.some((category) => category.kind === "expense")) return showToast("Add an expense category first.", true);
  el.budgetForm.reset();
  el.budgetId.value = "";
  el.budgetFormError.textContent = "";
  renderSelectors();
  if (id) {
    const budget = state.budgets.find((item) => item.id === id);
    if (!budget) return;
    el.budgetId.value = id;
    el.budgetCategory.value = budget.category_id;
    el.budgetAmount.value = number(budget.amount);
    el.budgetPeriod.value = budget.period;
    el.budgetModalTitle.textContent = "Edit budget";
  } else {
    el.budgetModalTitle.textContent = "Create budget";
  }
  openModal(el.budgetModal);
}

async function handleBudgetSubmit(event) {
  event.preventDefault();
  el.budgetFormError.textContent = "";
  const id = el.budgetId.value;
  const row = { category_id: el.budgetCategory.value, amount: number(el.budgetAmount.value), period: el.budgetPeriod.value };
  if (!row.category_id) return showFormError(el.budgetFormError, "Choose an expense category.");
  if (!(row.amount > 0)) return showFormError(el.budgetFormError, "Enter a budget greater than zero.");
  const duplicate = state.budgets.some((budget) => budget.id !== id && budget.category_id === row.category_id && budget.period === row.period);
  if (duplicate) return showFormError(el.budgetFormError, "A budget already exists for that category and period.");
  try {
    if (id) {
      const updated = await updateRow("budgets", id, row);
      state.budgets = state.budgets.map((item) => item.id === id ? { ...item, ...updated } : item);
      showToast("Budget updated.");
    } else {
      state.budgets.push(await insertRow("budgets", row));
      showToast("Budget created.");
    }
    persistLocal(); closeModal(el.budgetModal); render();
  } catch (error) { showFormError(el.budgetFormError, friendlyError(error)); }
}

function openCategoryModal(id = null) {
  el.categoryForm.reset();
  el.categoryId.value = "";
  el.categoryKind.value = "expense";
  el.categoryColor.value = "#64748b";
  el.categoryFormError.textContent = "";
  if (id) {
    const category = state.categories.find((item) => item.id === id);
    if (!category) return;
    el.categoryId.value = id;
    el.categoryKind.value = category.kind;
    el.categoryColor.value = safeColor(category.color);
    el.categoryName.value = category.name;
    el.categoryModalTitle.textContent = "Edit category";
  } else {
    el.categoryModalTitle.textContent = "Add category";
  }
  openModal(el.categoryModal);
  el.categoryName.focus();
}

async function handleCategorySubmit(event) {
  event.preventDefault();
  el.categoryFormError.textContent = "";
  const id = el.categoryId.value;
  const row = { name: el.categoryName.value.trim(), kind: el.categoryKind.value, color: safeColor(el.categoryColor.value) };
  if (!row.name) return showFormError(el.categoryFormError, "Enter a category name.");
  const duplicate = state.categories.some((category) => category.id !== id && category.kind === row.kind && category.name.toLowerCase() === row.name.toLowerCase());
  if (duplicate) return showFormError(el.categoryFormError, "That category already exists for this entry type.");
  if (id) {
    const usedByWrongType = state.transactions.some((transaction) => transaction.category_id === id && transaction.type !== row.kind) || state.transactionSplits.some((split) => split.category_id === id && state.transactions.find((transaction) => transaction.id === split.transaction_id)?.type !== row.kind) || state.recurringEntries.some((rule) => rule.category_id === id && rule.type !== row.kind) || state.importRules.some((rule) => rule.category_id === id && rule.transaction_type !== row.kind) || state.bills.some((bill) => bill.category_id === id && row.kind !== "expense");
    if (usedByWrongType) return showFormError(el.categoryFormError, "The category type cannot change while entries use it.");
  }
  try {
    if (id) {
      const updated = await updateRow("categories", id, row);
      state.categories = state.categories.map((item) => item.id === id ? { ...item, ...updated } : item);
      showToast("Category updated.");
    } else {
      state.categories.push(await insertRow("categories", row));
      showToast("Category added.");
    }
    persistLocal(); closeModal(el.categoryModal); render();
  } catch (error) { showFormError(el.categoryFormError, friendlyError(error)); }
}

async function deleteAccount(id) {
  const account = state.accounts.find((item) => item.id === id);
  if (!account) return;
  const inUse = state.transactions.some((transaction) => [transaction.account_id, transaction.from_account_id, transaction.to_account_id].includes(id)) || state.recurringEntries.some((rule) => [rule.account_id, rule.from_account_id, rule.to_account_id].includes(id)) || state.reconciliations.some((item) => item.account_id === id) || state.creditCardStatements.some((item) => item.account_id === id) || state.importRules.some((rule) => [rule.account_id, rule.from_account_id, rule.to_account_id].includes(id)) || state.bills.some((bill) => bill.account_id === id);
  if (inUse) return showToast("Delete or move this account's transactions, bills, recurring schedules, import rules, statements, and reconciliation history first.", true);
  if (!confirm(`Delete ${account.name}?`)) return;
  try {
    await deleteRow("accounts", id);
    const artworkRemoved = account.card_artwork_path ? await removeCardArtworkFile(account.card_artwork_path, false) : true;
    state.accounts = state.accounts.filter((item) => item.id !== id);
    persistLocal(); render(); showToast(artworkRemoved ? "Account deleted." : "Account deleted, but its card artwork could not be cleaned up.", !artworkRemoved);
  } catch (error) { showToast(friendlyError(error), true); }
}

async function deleteTransaction(id) {
  const transaction = state.transactions.find((item) => item.id === id);
  if (transaction && transactionHasReconciledSide(transaction)) return showToast("Undo the related reconciliation before deleting this entry.", true);
  const warning = transaction?.recurring_entry_id
    ? "Delete this entry? It came from a recurring schedule and may be posted again while that schedule remains active."
    : "Delete this entry?";
  if (!confirm(warning)) return;
  try {
    await deleteRow("transactions", id);
    state.transactions = state.transactions.filter((item) => item.id !== id);
    state.transactionSplits = state.transactionSplits.filter((item) => item.transaction_id !== id);
    state.transactionClearings = state.transactionClearings.filter((item) => item.transaction_id !== id);
    const linkedBills = state.bills.filter((bill) => bill.paid_transaction_id === id);
    for (const bill of linkedBills) {
      const updated = await updateRow("bills", bill.id, { status: "open", paid_at: null, paid_transaction_id: null });
      state.bills = state.bills.map((item) => item.id === bill.id ? { ...item, ...updated } : item);
    }
    const receiptRemoved = transaction?.receipt_path ? await removeReceiptFile(transaction.receipt_path, false) : true;
    persistLocal(); render();
    showToast(receiptRemoved ? "Entry deleted." : "Entry deleted, but its receipt file could not be cleaned up.", !receiptRemoved);
  } catch (error) { showToast(friendlyError(error), true); }
}

async function deleteBudget(id) {
  if (!confirm("Delete this budget?")) return;
  try {
    await deleteRow("budgets", id);
    state.budgets = state.budgets.filter((item) => item.id !== id);
    persistLocal(); render(); showToast("Budget deleted.");
  } catch (error) { showToast(friendlyError(error), true); }
}

async function deleteCategory(id) {
  const category = state.categories.find((item) => item.id === id);
  if (!category) return;
  const inUse = state.transactions.some((transaction) => transaction.category_id === id) || state.transactionSplits.some((split) => split.category_id === id) || state.budgets.some((budget) => budget.category_id === id) || state.recurringEntries.some((rule) => rule.category_id === id) || state.importRules.some((rule) => rule.category_id === id) || state.bills.some((bill) => bill.category_id === id);
  if (inUse) return showToast("Remove this category from transactions, bills, budgets, recurring schedules, and import rules first.", true);
  if (!confirm(`Delete ${category.name}?`)) return;
  try {
    await deleteRow("categories", id);
    state.categories = state.categories.filter((item) => item.id !== id);
    persistLocal(); render(); showToast("Category deleted.");
  } catch (error) { showToast(friendlyError(error), true); }
}

function calculateAccountBalance(accountId, throughDate = null) {
  const account = state.accounts.find((item) => item.id === accountId);
  if (!account) return 0;
  return state.transactions.reduce((balance, transaction) => {
    if (throughDate && transaction.entry_date > throughDate) return balance;
    const amount = number(transaction.amount);
    if (transaction.type === "income" && transaction.account_id === accountId) return balance + amount;
    if (transaction.type === "expense" && transaction.account_id === accountId) return balance - amount;
    if (transaction.type === "transfer" && transaction.from_account_id === accountId) balance -= amount;
    if (transaction.type === "transfer" && transaction.to_account_id === accountId) balance += amount;
    return balance;
  }, number(account.opening_balance));
}

function calculateNetWorth(throughDate = null) {
  return state.accounts.filter((account) => account.include_in_net_worth !== false).reduce((sum, account) => sum + calculateAccountBalance(account.id, throughDate), 0);
}

function sumTransactions(transactions, type) {
  return transactions.filter((item) => item.type === type).reduce((sum, item) => sum + number(item.amount), 0);
}

function categoryTotals(transactions) {
  const map = new Map();
  transactions.forEach((transaction) => {
    transactionAllocations(transaction).forEach((allocation) => {
      const category = categoryById(allocation.category_id) || { id: "uncategorized", name: "Uncategorized", color: "#94a3b8" };
      const current = map.get(category.id) || { id: category.id, name: category.name, color: category.color, amount: 0 };
      current.amount += number(allocation.amount);
      map.set(category.id, current);
    });
  });
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

function categoryBarsHTML(items, emptyMessage) {
  if (!items.length) return emptyHTML(emptyMessage, "Category totals will appear after you add entries.");
  const max = Math.max(...items.map((item) => item.amount), 1);
  return items.slice(0, 10).map((item) => `<div class="category-row">
    <span class="category-name"><span class="category-dot" style="--category-color:${safeColor(item.color)}"></span>${escapeHTML(item.name)}</span>
    <span class="category-bar-track"><span class="category-bar" style="width:${(item.amount / max) * 100}%;--category-color:${safeColor(item.color)}"></span></span>
    <span class="category-amount">${formatMoneyHTML(item.amount)}</span>
  </div>`).join("");
}

function spendingForBudget(budget, anchorMonth) {
  const prefix = budget.period === "yearly" ? anchorMonth.slice(0, 4) : anchorMonth;
  return state.transactions
    .filter((transaction) => transaction.type === "expense" && transaction.entry_date?.startsWith(prefix))
    .reduce((sum, transaction) => sum + transactionAllocations(transaction).filter((allocation) => allocation.category_id === budget.category_id).reduce((allocationSum, allocation) => allocationSum + number(allocation.amount), 0), 0);
}

function budgetMetrics(period, anchorMonth) {
  const budgets = state.budgets.filter((item) => item.period === period);
  const total = budgets.reduce((sum, item) => sum + number(item.amount), 0);
  const spent = budgets.reduce((sum, item) => sum + spendingForBudget(item, anchorMonth), 0);
  return {
    count: budgets.length, total, spent,
    percentage: total ? (spent / total) * 100 : 0,
    overCount: budgets.filter((item) => spendingForBudget(item, anchorMonth) > number(item.amount)).length,
  };
}

function monthSeries(count, endDate) {
  const result = [];
  const end = new Date(endDate.getFullYear(), endDate.getMonth(), 1);
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(end.getFullYear(), end.getMonth() - offset, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const entries = state.transactions.filter((item) => item.entry_date?.startsWith(key));
    result.push({ key, label: monthFormatter.format(date), date, income: sumTransactions(entries, "income"), expenses: sumTransactions(entries, "expense") });
  }
  return result;
}

function monthsInYear(year) {
  return Array.from({ length: 12 }, (_, month) => {
    const date = new Date(year, month, 1);
    const key = `${year}-${String(month + 1).padStart(2, "0")}`;
    const entries = state.transactions.filter((item) => item.entry_date?.startsWith(key));
    return { key, label: monthFormatter.format(date), date, income: sumTransactions(entries, "income"), expenses: sumTransactions(entries, "expense") };
  });
}

function cashFlowBarsHTML(series) {
  const max = Math.max(...series.flatMap((item) => [item.income, item.expenses]), 1);
  return `<div class="cash-flow-chart">${series.map((item) => `<div class="cash-month" title="${escapeHTML(item.label)}: ${formatMoneyText(item.income)} income, ${formatMoneyText(item.expenses)} expenses">
    <div class="cash-bars"><span class="cash-bar income" style="height:${Math.max((item.income / max) * 100, item.income ? 2 : 0)}%"></span><span class="cash-bar expense" style="height:${Math.max((item.expenses / max) * 100, item.expenses ? 2 : 0)}%"></span></div>
    <span class="cash-month-label">${escapeHTML(item.label)}</span>
  </div>`).join("")}</div><div class="chart-legend"><span class="legend-key"><span class="legend-swatch income"></span>Income</span><span class="legend-key"><span class="legend-swatch expense"></span>Expenses</span></div>`;
}

function netWorthLineHTML(series) {
  const points = series.map((item) => ({ ...item, value: calculateNetWorth(endOfMonthISO(item.date)) }));
  if (!points.length) return emptyHTML("No trend data", "Net-worth history appears after accounts are created.");
  const width = 720, height = 220, padX = 44, padTop = 24, padBottom = 36;
  const values = points.map((item) => item.value);
  const min = Math.min(...values, 0), max = Math.max(...values, 0);
  const range = max - min || 1;
  const coords = points.map((item, index) => ({
    ...item,
    x: padX + (index * (width - padX * 2)) / Math.max(points.length - 1, 1),
    y: padTop + ((max - item.value) / range) * (height - padTop - padBottom),
  }));
  const line = coords.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = `${line} L${coords.at(-1).x.toFixed(1)},${height - padBottom} L${coords[0].x.toFixed(1)},${height - padBottom} Z`;
  const grid = [0, .5, 1].map((ratio) => {
    const y = padTop + ratio * (height - padTop - padBottom);
    const value = max - ratio * range;
    return `<line class="line-chart-grid" x1="${padX}" x2="${width - padX}" y1="${y}" y2="${y}"/><text class="line-chart-value" x="2" y="${y + 3}">${escapeHTML(formatCompactMoneyText(value))}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Net worth over time">
    <defs><linearGradient id="netWorthGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b82f6" stop-opacity=".25"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path class="line-chart-area" d="${area}"/><path class="line-chart-line" d="${line}"/>
    ${coords.map((point) => `<circle class="line-chart-dot" cx="${point.x}" cy="${point.y}" r="4"><title>${escapeHTML(point.label)}: ${formatMoneyText(point.value)}</title></circle>`).join("")}
    ${coords.map((point, index) => index % Math.ceil(coords.length / 6) === 0 || index === coords.length - 1 ? `<text class="line-chart-label" text-anchor="middle" x="${point.x}" y="${height - 12}">${escapeHTML(point.label)}</text>` : "").join("")}
  </svg>`;
}

function summaryCard(label, value, detail, className = "", money = true, suffix = "") {
  const display = money
    ? formatMoneyHTML(number(value))
    : escapeHTML(suffix ? `${Number(value).toFixed(1)}${suffix}` : Math.round(number(value)).toLocaleString("en-AE"));
  return `<article class="summary-card"><p class="card-label">${escapeHTML(label)}</p><p class="card-value ${className}">${display}</p><p class="card-detail">${escapeHTML(detail)}</p></article>`;
}

function formatMoneyText(value) {
  const amount = number(value);
  const sign = amount < 0 ? "−" : "";
  return `${sign}${CURRENCY} ${amountFormatter.format(Math.abs(amount))}`;
}

function formatCompactMoneyText(value) {
  const amount = number(value);
  const sign = amount < 0 ? "−" : "";
  return `${sign}${CURRENCY} ${compactAmountFormatter.format(Math.abs(amount))}`;
}

function formatMoneyHTML(value) {
  const amount = number(value);
  const sign = amount < 0 ? '<span class="money-sign" aria-hidden="true">−</span>' : "";
  const accessible = escapeHTML(formatMoneyText(amount));
  return `<span class="money" role="text" aria-label="${accessible}">${sign}<span class="aed-symbol" aria-hidden="true"></span><span class="money-number">${amountFormatter.format(Math.abs(amount))}</span></span>`;
}

function sortedTransactions() {
  return [...state.transactions].sort((a, b) => String(b.entry_date).localeCompare(String(a.entry_date)) || String(b.created_at).localeCompare(String(a.created_at)));
}

function categoryById(id) { return state.categories.find((item) => item.id === id); }
function accountById(id) { return state.accounts.find((item) => item.id === id); }
function transactionAccountText(transaction) {
  if (transaction.type === "transfer") return `${accountById(transaction.from_account_id)?.name || "Unknown"} → ${accountById(transaction.to_account_id)?.name || "Unknown"}`;
  return accountById(transaction.account_id)?.name || "Unknown account";
}



function sortedImportRules() {
  return [...state.importRules].sort((a, b) => number(a.priority) - number(b.priority) || String(a.created_at).localeCompare(String(b.created_at)));
}

function renderImportRules() {
  const rules = sortedImportRules();
  const active = rules.filter((rule) => rule.enabled !== false);
  const counts = { expense: 0, income: 0, transfer: 0 };
  active.forEach((rule) => { if (counts[rule.transaction_type] !== undefined) counts[rule.transaction_type] += 1; });
  el.importRuleSummary.innerHTML = [
    summaryCard("Active rules", active.length, `${rules.length - active.length} paused`, active.length ? "positive" : "", false, ""),
    summaryCard("Expense rules", counts.expense, "Merchant spending", "", false, ""),
    summaryCard("Income rules", counts.income, "Salary and deposits", "", false, ""),
    summaryCard("Transfer rules", counts.transfer, "Payments and movements", "", false, ""),
  ].join("");
  if (!rules.length) {
    el.importRulesList.innerHTML = emptyHTML("No import rules yet", "Create a rule for merchants, salary descriptions, card payments, or recurring bank text.");
    return;
  }
  el.importRulesList.innerHTML = `<div class="import-rule-list">${rules.map((rule) => {
    const enabled = rule.enabled !== false;
    const matchLabel = `${importRuleFieldLabel(rule.match_field)} ${importRuleMatchLabel(rule.match_type)} “${rule.match_value}”`;
    const route = importRuleRouteText(rule);
    return `<article class="import-rule-row ${enabled ? "" : "paused"}">
      <div class="import-rule-priority" title="Priority">${number(rule.priority)}</div>
      <div class="import-rule-copy"><div class="import-rule-title-line"><strong>${escapeHTML(rule.name)}</strong><span class="transaction-type ${escapeHTML(rule.transaction_type)}">${escapeHTML(capitalize(rule.transaction_type))}</span>${enabled ? `<span class="rule-state active">Active</span>` : `<span class="rule-state">Paused</span>`}</div><span>${escapeHTML(matchLabel)}</span><small>${escapeHTML(route)}</small></div>
      <div class="row-actions"><button class="row-action wide" data-action="toggle-import-rule" data-id="${rule.id}" type="button">${enabled ? "Pause" : "Enable"}</button><button class="row-action" data-action="edit-import-rule" data-id="${rule.id}" aria-label="Edit rule">✎</button><button class="row-action danger" data-action="delete-import-rule" data-id="${rule.id}" aria-label="Delete rule">×</button></div>
    </article>`;
  }).join("")}</div>`;
}

function importRuleFieldLabel(value) {
  return ({ description: "Description", remarks: "Remarks", description_remarks: "Description + remarks" })[value] || "Description";
}

function importRuleMatchLabel(value) {
  return ({ contains: "contains", starts_with: "starts with", ends_with: "ends with", equals: "equals" })[value] || "contains";
}

function importRuleRouteText(rule) {
  if (rule.transaction_type === "transfer") return `${accountById(rule.from_account_id)?.name || "Unknown account"} → ${accountById(rule.to_account_id)?.name || "Unknown account"}`;
  return `${categoryById(rule.category_id)?.name || "Unknown category"} · ${accountById(rule.account_id)?.name || "Unknown account"}`;
}

function openImportRuleModal(id = null, preset = null) {
  if (!state.accounts.length) return showToast("Add an account before creating an import rule.", true);
  el.importRuleForm.reset();
  el.importRuleId.value = "";
  el.importRulePriority.value = "100";
  el.importRuleEnabled.checked = true;
  el.importRuleFormError.textContent = "";
  const existing = id ? state.importRules.find((rule) => rule.id === id) : null;
  const source = existing || preset;
  const type = source?.transaction_type || "expense";
  el.importRuleModalTitle.textContent = existing ? "Edit import rule" : "Add import rule";
  el.importRuleId.value = existing?.id || "";
  el.importRuleName.value = source?.name || "";
  el.importRulePriority.value = source?.priority || 100;
  el.importRuleEnabled.checked = source?.enabled !== false;
  el.importRuleMatchField.value = source?.match_field || "description";
  el.importRuleMatchType.value = source?.match_type || "contains";
  el.importRuleMatchValue.value = source?.match_value || "";
  el.importRuleTransactionType.value = type;
  renderImportRuleRouteOptions(type, source);
  updateImportRuleRouteFields();
  openModal(el.importRuleModal);
  window.setTimeout(() => el.importRuleName.focus(), 0);
}

function renderImportRuleRouteOptions(type, source = null) {
  const accountOptions = state.accounts.map((account) => `<option value="${account.id}">${escapeHTML(account.name)}</option>`).join("");
  [el.importRuleAccount, el.importRuleFromAccount, el.importRuleToAccount].forEach((select) => { select.innerHTML = accountOptions || `<option value="">No accounts available</option>`; });
  const categories = state.categories.filter((category) => category.kind === type).sort((a, b) => a.name.localeCompare(b.name));
  el.importRuleCategory.innerHTML = categories.map((category) => `<option value="${category.id}">${escapeHTML(category.name)}</option>`).join("") || `<option value="">No ${escapeHTML(type)} categories</option>`;
  if (source?.category_id && [...el.importRuleCategory.options].some((option) => option.value === source.category_id)) el.importRuleCategory.value = source.category_id;
  if (source?.account_id && [...el.importRuleAccount.options].some((option) => option.value === source.account_id)) el.importRuleAccount.value = source.account_id;
  if (source?.from_account_id && [...el.importRuleFromAccount.options].some((option) => option.value === source.from_account_id)) el.importRuleFromAccount.value = source.from_account_id;
  if (source?.to_account_id && [...el.importRuleToAccount.options].some((option) => option.value === source.to_account_id)) el.importRuleToAccount.value = source.to_account_id;
}

function updateImportRuleRouteFields() {
  const type = el.importRuleTransactionType.value;
  document.querySelectorAll(".rule-expense-income-field").forEach((field) => field.hidden = type === "transfer");
  document.querySelectorAll(".rule-transfer-field").forEach((field) => field.hidden = type !== "transfer");
  const currentCategory = el.importRuleCategory.value;
  const categories = state.categories.filter((category) => category.kind === type).sort((a, b) => a.name.localeCompare(b.name));
  el.importRuleCategory.innerHTML = categories.map((category) => `<option value="${category.id}">${escapeHTML(category.name)}</option>`).join("") || `<option value="">No ${escapeHTML(type)} categories</option>`;
  if ([...el.importRuleCategory.options].some((option) => option.value === currentCategory)) el.importRuleCategory.value = currentCategory;
}

async function handleImportRuleSubmit(event) {
  event.preventDefault();
  el.importRuleFormError.textContent = "";
  const id = el.importRuleId.value;
  const type = el.importRuleTransactionType.value;
  const row = {
    name: el.importRuleName.value.trim(),
    enabled: el.importRuleEnabled.checked,
    priority: Math.trunc(number(el.importRulePriority.value)),
    match_field: el.importRuleMatchField.value,
    match_type: el.importRuleMatchType.value,
    match_value: el.importRuleMatchValue.value.trim(),
    transaction_type: type,
    category_id: type === "transfer" ? null : el.importRuleCategory.value || null,
    account_id: type === "transfer" ? null : el.importRuleAccount.value || null,
    from_account_id: type === "transfer" ? el.importRuleFromAccount.value || null : null,
    to_account_id: type === "transfer" ? el.importRuleToAccount.value || null : null,
  };
  if (!row.name) return showFormError(el.importRuleFormError, "Enter a rule name.");
  if (!(row.priority >= 1 && row.priority <= 9999)) return showFormError(el.importRuleFormError, "Priority must be between 1 and 9,999.");
  if (!row.match_value) return showFormError(el.importRuleFormError, "Enter text to match.");
  if (type === "transfer" && (!row.from_account_id || !row.to_account_id || row.from_account_id === row.to_account_id)) return showFormError(el.importRuleFormError, "Choose two different transfer accounts.");
  if (type !== "transfer" && (!row.category_id || !row.account_id)) return showFormError(el.importRuleFormError, "Choose a category and account.");
  try {
    if (mode === "cloud") {
      setSyncStatus("syncing", "Saving import rule");
      const query = id ? supabase.from("import_rules").update(row).eq("id", id).eq("user_id", user.id) : supabase.from("import_rules").insert({ ...row, user_id: user.id });
      const { data, error } = await query.select().single();
      if (error) throw error;
      if (id) state.importRules = state.importRules.map((rule) => rule.id === id ? data : rule);
      else state.importRules.push(data);
      setSyncStatus("cloud", "Cloud synchronized");
    } else {
      if (id) state.importRules = state.importRules.map((rule) => rule.id === id ? { ...rule, ...row, updated_at: new Date().toISOString() } : rule);
      else state.importRules.push(localRow(row));
      persistLocal();
    }
    closeModal(el.importRuleModal);
    renderImportRules();
    if (transactionImportSourceRows.length) validateTransactionImport();
    showToast(id ? "Import rule updated." : "Import rule created.");
  } catch (error) { showFormError(el.importRuleFormError, friendlyError(error)); }
}

async function toggleImportRule(id) {
  const rule = state.importRules.find((item) => item.id === id);
  if (!rule) return;
  const enabled = rule.enabled === false;
  try {
    if (mode === "cloud") {
      const { data, error } = await supabase.from("import_rules").update({ enabled }).eq("id", id).eq("user_id", user.id).select().single();
      if (error) throw error;
      state.importRules = state.importRules.map((item) => item.id === id ? data : item);
    } else {
      rule.enabled = enabled; rule.updated_at = new Date().toISOString(); persistLocal();
    }
    renderImportRules();
    if (transactionImportSourceRows.length) validateTransactionImport();
    showToast(enabled ? "Rule enabled." : "Rule paused.");
  } catch (error) { showToast(friendlyError(error), true); }
}

async function deleteImportRule(id) {
  const rule = state.importRules.find((item) => item.id === id);
  if (!rule || !confirm(`Delete the import rule “${rule.name}”?`)) return;
  try {
    if (mode === "cloud") {
      const { error } = await supabase.from("import_rules").delete().eq("id", id).eq("user_id", user.id);
      if (error) throw error;
    }
    state.importRules = state.importRules.filter((item) => item.id !== id);
    persistLocal();
    renderImportRules();
    if (transactionImportSourceRows.length) validateTransactionImport();
    showToast("Import rule deleted.");
  } catch (error) { showToast(friendlyError(error), true); }
}

function openImportRuleTestModal() {
  el.importRuleTestForm.reset();
  el.importRuleTestResult.innerHTML = "<span>Enter text to see which enabled rule wins.</span>";
  openModal(el.importRuleTestModal);
  window.setTimeout(() => el.importRuleTestText.focus(), 0);
}

function handleImportRuleTest(event) {
  event.preventDefault();
  const text = el.importRuleTestText.value.trim();
  const rule = findMatchingImportRule({ description: text, remarks: "", type: "" });
  el.importRuleTestResult.innerHTML = rule ? `<strong>${escapeHTML(rule.name)}</strong><span>${escapeHTML(capitalize(rule.transaction_type))} · ${escapeHTML(importRuleRouteText(rule))}</span><small>Priority ${number(rule.priority)} · ${escapeHTML(importRuleFieldLabel(rule.match_field))} ${escapeHTML(importRuleMatchLabel(rule.match_type))} “${escapeHTML(rule.match_value)}”</small>` : `<strong>No rule matched</strong><span>This row would need values from the file or import fallback options.</span>`;
}

function openImportRuleFromPreview(index) {
  const row = transactionImportValidation[index];
  if (!row) return;
  const normalized = row.normalized;
  const description = normalized.description || String(row.source.description || "").trim();
  const matchValue = suggestedImportRuleMatch(description);
  const type = normalized.type || "expense";
  importRuleReturnToImport = true;
  openImportRuleModal(null, {
    name: matchValue ? `${matchValue} → ${capitalize(type)}` : `Imported ${capitalize(type)} rule`,
    priority: 100,
    enabled: true,
    match_field: "description",
    match_type: "contains",
    match_value: matchValue,
    transaction_type: type,
    category_id: state.categories.find((category) => category.kind === type && normalizeLookup(category.name) === normalizeLookup(normalized.categoryName))?.id || null,
    account_id: state.accounts.find((account) => normalizeLookup(account.name) === normalizeLookup(normalized.accountName))?.id || null,
    from_account_id: state.accounts.find((account) => normalizeLookup(account.name) === normalizeLookup(normalized.fromAccountName))?.id || null,
    to_account_id: state.accounts.find((account) => normalizeLookup(account.name) === normalizeLookup(normalized.toAccountName))?.id || null,
  });
}

function suggestedImportRuleMatch(description) {
  const cleaned = String(description || "").trim().replace(/\s+/g, " ");
  if (!cleaned) return "";
  const withoutReference = cleaned.replace(/\b\d{4,}\b/g, "").replace(/\s+/g, " ").trim();
  return (withoutReference || cleaned).slice(0, 80);
}

function findMatchingImportRule(source) {
  const sourceType = normalizeImportType(source.type);
  return sortedImportRules().find((rule) => {
    if (rule.enabled === false) return false;
    if (sourceType && sourceType !== rule.transaction_type) return false;
    const description = String(source.description ?? "");
    const remarks = String(source.remarks ?? "");
    const haystack = rule.match_field === "remarks" ? remarks : rule.match_field === "description_remarks" ? `${description} ${remarks}` : description;
    return importRuleTextMatches(haystack, rule.match_value, rule.match_type);
  }) || null;
}

function importRuleTextMatches(haystack, needle, method) {
  const left = normalizeLookup(haystack);
  const right = normalizeLookup(needle);
  if (!left || !right) return false;
  if (method === "equals") return left === right;
  if (method === "starts_with") return left.startsWith(right);
  if (method === "ends_with") return left.endsWith(right);
  return left.includes(right);
}

function applyImportRule(source, normalized) {
  if (!el.importApplyRules.checked) return null;
  const rule = findMatchingImportRule(source);
  if (!rule) return null;
  if (!normalized.type) normalized.type = rule.transaction_type;
  if (normalized.type !== rule.transaction_type) return null;
  if (rule.transaction_type === "transfer") {
    if (!normalized.fromAccountName) normalized.fromAccountName = accountById(rule.from_account_id)?.name || "";
    if (!normalized.toAccountName) normalized.toAccountName = accountById(rule.to_account_id)?.name || "";
  } else {
    if (!normalized.splitItems?.length && !normalized.categoryName) normalized.categoryName = categoryById(rule.category_id)?.name || "";
    if (!normalized.accountName) normalized.accountName = accountById(rule.account_id)?.name || "";
  }
  return rule;
}

function openTransactionImportModal() {
  if (!state.accounts.length) return showToast("Add an account before importing transactions.", true);
  transactionImportSourceRows = [];
  transactionImportValidation = [];
  transactionImportFileName = "";
  el.transactionImportInput.value = "";
  el.importDefaultAccount.value = "";
  el.importBlankTypeMode.value = "require";
  el.importApplyRules.checked = true;
  el.importCreateCategories.checked = true;
  el.importSkipDuplicates.checked = true;
  el.transactionImportError.textContent = "";
  el.transactionImportStatus.innerHTML = "<span>Select a CSV or Excel file to validate it before importing.</span>";
  el.transactionImportPreview.innerHTML = "";
  el.importTransactionsButton.disabled = true;
  openModal(el.transactionImportModal);
}

async function handleTransactionImportFile(event) {
  const file = event.target.files?.[0];
  transactionImportSourceRows = [];
  transactionImportValidation = [];
  transactionImportFileName = file?.name || "";
  el.transactionImportError.textContent = "";
  el.importTransactionsButton.disabled = true;
  el.transactionImportPreview.innerHTML = "";
  if (!file) {
    el.transactionImportStatus.innerHTML = "<span>Select a CSV or Excel file to validate it before importing.</span>";
    return;
  }
  el.transactionImportStatus.innerHTML = `<span>Reading ${escapeHTML(file.name)}…</span>`;
  try {
    transactionImportSourceRows = await readTransactionImportFile(file);
    validateTransactionImport();
  } catch (error) {
    el.transactionImportStatus.innerHTML = `<span class="negative">Could not read ${escapeHTML(file.name)}.</span>`;
    el.transactionImportError.textContent = friendlyError(error);
  }
}

async function getSpreadsheetModule() {
  if (!spreadsheetModulePromise) {
    spreadsheetModulePromise = import("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/+esm").then((module) => module.default?.read ? module.default : module);
  }
  return spreadsheetModulePromise;
}

async function readTransactionImportFile(file) {
  const XLSX = await getSpreadsheetModule();
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
  if (!workbook.SheetNames.length) throw new Error("The workbook does not contain a worksheet.");
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true, blankrows: false });
  const firstRowIndex = matrix.findIndex((row) => Array.isArray(row) && row.some((cell) => String(cell ?? "").trim()));
  if (firstRowIndex < 0) throw new Error("The file is empty.");
  const headers = matrix[firstRowIndex].map(normalizeImportHeader);
  const indexByKey = {};
  headers.forEach((key, index) => {
    if (key && indexByKey[key] === undefined) indexByKey[key] = index;
  });
  for (const required of ["date", "amount"]) {
    if (indexByKey[required] === undefined) throw new Error(`Missing required column: ${capitalize(required)}.`);
  }
  return matrix.slice(firstRowIndex + 1).map((row, offset) => ({
    sourceRow: firstRowIndex + offset + 2,
    date: row[indexByKey.date] ?? "",
    type: row[indexByKey.type] ?? "",
    amount: row[indexByKey.amount] ?? "",
    description: row[indexByKey.description] ?? "",
    remarks: row[indexByKey.remarks] ?? "",
    category: row[indexByKey.category] ?? "",
    splitDetails: row[indexByKey.splitDetails] ?? "",
    account: row[indexByKey.account] ?? "",
    fromAccount: row[indexByKey.fromAccount] ?? "",
    toAccount: row[indexByKey.toAccount] ?? "",
    currency: row[indexByKey.currency] ?? "",
  })).filter((row) => [row.date, row.type, row.amount, row.description, row.remarks, row.category, row.splitDetails, row.account, row.fromAccount, row.toAccount, row.currency].some((value) => String(value ?? "").trim()));
}

function normalizeImportHeader(value) {
  const key = String(value ?? "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  const aliases = {
    date: "date", entrydate: "date", transactiondate: "date",
    type: "type", transactiontype: "type", entrytype: "type",
    amount: "amount", value: "amount",
    description: "description", details: "description", memo: "description", narrative: "description",
    remarks: "remarks", remark: "remarks", comments: "remarks", comment: "remarks", notes: "remarks", note: "remarks",
    category: "category", categoryname: "category",
    splitdetails: "splitDetails", splits: "splitDetails", splitcategories: "splitDetails", categorysplits: "splitDetails",
    account: "account", accountname: "account",
    fromaccount: "fromAccount", sourceaccount: "fromAccount", from: "fromAccount",
    toaccount: "toAccount", destinationaccount: "toAccount", to: "toAccount",
    currency: "currency", currencycode: "currency",
  };
  return aliases[key] || "";
}

function validateTransactionImport() {
  if (!transactionImportSourceRows.length) {
    el.importTransactionsButton.disabled = true;
    return;
  }
  const fallbackAccount = state.accounts.find((account) => account.id === el.importDefaultAccount.value) || null;
  const accountMap = new Map(state.accounts.map((account) => [normalizeLookup(account.name), account]));
  const categoryMap = new Map(state.categories.map((category) => [`${category.kind}:${normalizeLookup(category.name)}`, category]));
  const createCategories = el.importCreateCategories.checked;
  const skipDuplicates = el.importSkipDuplicates.checked;
  const blankTypeMode = el.importBlankTypeMode.value;
  const knownFingerprints = new Set(state.transactions.map(transactionFingerprintFromState));
  const fileFingerprints = new Set();

  transactionImportValidation = transactionImportSourceRows.map((source) => {
    const errors = [];
    const entryDate = parseImportDate(source.date);
    const signedAmount = parseImportSignedAmount(source.amount);
    const amount = Math.round(Math.abs(signedAmount) * 100) / 100;
    const description = String(source.description ?? "").trim().replace(/\s+/g, " ");
    const remarks = String(source.remarks ?? "").trim();
    const currency = String(source.currency ?? "").trim().toUpperCase();
    const normalized = {
      type: normalizeImportType(source.type),
      amount,
      entry_date: entryDate,
      description,
      remarks,
      categoryName: String(source.category ?? "").trim(),
      splitDetails: String(source.splitDetails ?? "").trim(),
      splitItems: [],
      splitCreateCategories: [],
      accountName: String(source.account ?? "").trim(),
      fromAccountName: String(source.fromAccount ?? "").trim(),
      toAccountName: String(source.toAccount ?? "").trim(),
      createCategory: false,
      matchedRuleId: null,
      matchedRuleName: "",
    };

    const parsedSplits = parseImportSplits(normalized.splitDetails);
    normalized.splitItems = parsedSplits.items;
    if (normalized.splitItems.length) normalized.splitDetails = normalized.splitItems.map((split) => `${split.categoryName}=${number(split.amount).toFixed(2)}`).sort().join("|");
    errors.push(...parsedSplits.errors);

    const matchedRule = applyImportRule(source, normalized);
    if (matchedRule) {
      normalized.matchedRuleId = matchedRule.id;
      normalized.matchedRuleName = matchedRule.name;
    }
    if (!normalized.type) {
      if (blankTypeMode === "expense" || blankTypeMode === "income") normalized.type = blankTypeMode;
      else if (blankTypeMode === "signed" && signedAmount !== 0) normalized.type = signedAmount < 0 ? "expense" : "income";
    }

    if (!entryDate) errors.push("Invalid date. Use YYYY-MM-DD.");
    if (!normalized.type) errors.push("Type is blank and no rule or fallback supplied it.");
    if (!(amount > 0)) errors.push("Amount must be greater than zero.");
    if (description.length > 120) errors.push("Description is longer than 120 characters.");
    if (remarks.length > 2000) errors.push("Remarks are longer than 2,000 characters.");
    if (currency && currency !== CURRENCY) errors.push(`Currency must be ${CURRENCY} or blank.`);

    if (normalized.type === "expense" || normalized.type === "income") {
      normalized.accountName = normalized.accountName || fallbackAccount?.name || "";
      const account = accountMap.get(normalizeLookup(normalized.accountName));
      if (!normalized.accountName) errors.push("Account is required.");
      else if (!account) errors.push(`Account “${normalized.accountName}” does not exist.`);
      if (normalized.splitItems.length) {
        if (normalized.splitItems.length < 2) errors.push("Split Details must contain at least two category amounts.");
        const splitTotal = roundMoney(normalized.splitItems.reduce((sum, split) => sum + split.amount, 0));
        if (Math.abs(splitTotal - amount) >= 0.005) errors.push(`Split Details total ${formatMoneyText(splitTotal)} does not equal transaction amount ${formatMoneyText(amount)}.`);
        const names = normalized.splitItems.map((split) => normalizeLookup(split.categoryName));
        if (new Set(names).size !== names.length) errors.push("Split Details cannot repeat the same category.");
        normalized.splitItems.forEach((split) => {
          if (split.categoryName.length > 50) errors.push(`Split category “${split.categoryName}” is longer than 50 characters.`);
          const key = `${normalized.type}:${normalizeLookup(split.categoryName)}`;
          if (!categoryMap.has(key) && !createCategories) errors.push(`${capitalize(normalized.type)} category “${split.categoryName}” does not exist.`);
          else if (!categoryMap.has(key)) normalized.splitCreateCategories.push(split.categoryName);
        });
      } else {
        const categoryKey = `${normalized.type}:${normalizeLookup(normalized.categoryName)}`;
        const category = categoryMap.get(categoryKey);
        if (!normalized.categoryName) errors.push("Category is required when Split Details is blank.");
        else if (normalized.categoryName.length > 50) errors.push("Category is longer than 50 characters.");
        else if (!category && !createCategories) errors.push(`${capitalize(normalized.type)} category “${normalized.categoryName}” does not exist.`);
        else if (!category) normalized.createCategory = true;
      }
    } else if (normalized.type === "transfer") {
      normalized.fromAccountName = normalized.fromAccountName || fallbackAccount?.name || "";
      const fromAccount = accountMap.get(normalizeLookup(normalized.fromAccountName));
      const toAccount = accountMap.get(normalizeLookup(normalized.toAccountName));
      if (!normalized.fromAccountName) errors.push("From Account is required.");
      else if (!fromAccount) errors.push(`From Account “${normalized.fromAccountName}” does not exist.`);
      if (!normalized.toAccountName) errors.push("To Account is required.");
      else if (!toAccount) errors.push(`To Account “${normalized.toAccountName}” does not exist.`);
      if (fromAccount && toAccount && fromAccount.id === toAccount.id) errors.push("Transfer accounts must be different.");
    }

    const fingerprint = errors.length ? "" : transactionFingerprintFromImport(normalized);
    const duplicate = Boolean(fingerprint && (knownFingerprints.has(fingerprint) || fileFingerprints.has(fingerprint)));
    if (fingerprint) fileFingerprints.add(fingerprint);
    return {
      sourceRow: source.sourceRow,
      source,
      normalized,
      errors,
      status: errors.length ? "error" : duplicate && skipDuplicates ? "duplicate" : "valid",
    };
  });
  renderTransactionImportPreview();
}

function renderTransactionImportPreview() {
  const validCount = transactionImportValidation.filter((row) => row.status === "valid").length;
  const duplicateCount = transactionImportValidation.filter((row) => row.status === "duplicate").length;
  const errorCount = transactionImportValidation.filter((row) => row.status === "error").length;
  const matchedCount = transactionImportValidation.filter((row) => row.normalized.matchedRuleId).length;
  el.transactionImportStatus.innerHTML = `
    <div><strong>${escapeHTML(transactionImportFileName || "Selected file")}</strong><span>${transactionImportValidation.length} data row${transactionImportValidation.length === 1 ? "" : "s"}</span></div>
    <div class="import-counts"><span class="import-count valid">${validCount} ready</span><span class="import-count rule">${matchedCount} rule-matched</span><span class="import-count duplicate">${duplicateCount} duplicate</span><span class="import-count error">${errorCount} error${errorCount === 1 ? "" : "s"}</span></div>`;
  const previewRows = transactionImportValidation.slice(0, 100);
  el.transactionImportPreview.innerHTML = previewRows.length ? `
    <div class="import-preview-scroll">
      <table class="import-preview-table import-rule-preview-table">
        <thead><tr><th>Row</th><th>Status</th><th>Date</th><th>Type</th><th>Description</th><th>Category / route</th><th>Amount</th><th>Rule</th></tr></thead>
        <tbody>${previewRows.map((row, index) => {
          const route = row.normalized.type === "transfer"
            ? `${row.normalized.fromAccountName || "—"} → ${row.normalized.toAccountName || "—"}`
            : row.normalized.splitItems.length
              ? `Split: ${row.normalized.splitItems.map((split) => `${split.categoryName} ${formatMoneyText(split.amount)}`).join(" + ")} · ${row.normalized.accountName || "—"}`
              : `${row.normalized.categoryName || "—"} · ${row.normalized.accountName || "—"}`;
          const createsCategory = row.normalized.createCategory || row.normalized.splitCreateCategories.length;
          const detail = row.errors.length ? row.errors.join(" ") : row.status === "duplicate" ? "Already in Ledgerly or repeated in this file." : createsCategory ? "Ready · new category will be created." : "Ready to import.";
          const canCreateRule = !row.normalized.splitItems.length && Boolean(row.normalized.description && row.normalized.type && row.normalized.type !== "transfer" ? row.normalized.categoryName && row.normalized.accountName : row.normalized.type === "transfer" && row.normalized.fromAccountName && row.normalized.toAccountName);
          const ruleCell = row.normalized.matchedRuleName ? `<span class="matched-rule-chip">⚡ ${escapeHTML(row.normalized.matchedRuleName)}</span>` : canCreateRule ? `<button class="text-button compact-rule-button" data-action="create-rule-from-import" data-index="${index}" type="button">+ Save rule</button>` : "—";
          return `<tr class="import-row-${row.status}"><td>${row.sourceRow}</td><td><span class="import-row-status ${row.status}">${capitalize(row.status)}</span><small>${escapeHTML(detail)}</small></td><td>${escapeHTML(row.normalized.entry_date || String(row.source.date ?? ""))}</td><td>${escapeHTML(capitalize(row.normalized.type || String(row.source.type ?? "")))}</td><td>${escapeHTML(row.normalized.description || "—")}</td><td>${escapeHTML(route)}</td><td>${row.normalized.amount > 0 ? formatMoneyHTML(row.normalized.amount) : escapeHTML(String(row.source.amount ?? ""))}</td><td>${ruleCell}</td></tr>`;
        }).join("")}</tbody>
      </table>
    </div>
    ${transactionImportValidation.length > 100 ? `<p class="field-help">Showing the first 100 of ${transactionImportValidation.length} rows.</p>` : ""}` : emptyHTML("No data rows", "Add transactions below the header row in your file.");
  el.transactionImportError.textContent = errorCount ? "Correct the highlighted rows in the source file, adjust fallback options, or add a matching rule." : "";
  el.importTransactionsButton.disabled = errorCount > 0 || validCount === 0;
  el.importTransactionsButton.textContent = validCount ? `Import ${validCount} transaction${validCount === 1 ? "" : "s"}` : "Import transactions";
}

async function importValidatedTransactions() {
  validateTransactionImport();
  const errorCount = transactionImportValidation.filter((row) => row.status === "error").length;
  const ready = transactionImportValidation.filter((row) => row.status === "valid");
  if (errorCount || !ready.length) return;
  el.importTransactionsButton.disabled = true;
  el.transactionImportError.textContent = "";
  try {
    const missingCategories = [];
    const missingKeys = new Set();
    for (const row of ready) {
      const names = [row.normalized.createCategory ? row.normalized.categoryName : "", ...row.normalized.splitCreateCategories].filter(Boolean);
      for (const name of names) {
        const key = `${row.normalized.type}:${normalizeLookup(name)}`;
        if (missingKeys.has(key)) continue;
        missingKeys.add(key);
        missingCategories.push({
          kind: row.normalized.type,
          name,
          color: importCategoryColor(name),
        });
      }
    }
    if (missingCategories.length) await insertImportedCategories(missingCategories);

    const accountMap = new Map(state.accounts.map((account) => [normalizeLookup(account.name), account]));
    const categoryMap = new Map(state.categories.map((category) => [`${category.kind}:${normalizeLookup(category.name)}`, category]));
    const importedSplits = [];
    const transactionRows = ready.map(({ normalized }) => {
      const id = crypto.randomUUID();
      const base = {
        id,
        type: normalized.type,
        amount: normalized.amount,
        entry_date: normalized.entry_date,
        description: normalized.description,
        remarks: normalized.remarks,
        category_id: null,
        account_id: null,
        from_account_id: null,
        to_account_id: null,
      };
      if (normalized.type === "transfer") {
        base.from_account_id = accountMap.get(normalizeLookup(normalized.fromAccountName)).id;
        base.to_account_id = accountMap.get(normalizeLookup(normalized.toAccountName)).id;
      } else {
        base.account_id = accountMap.get(normalizeLookup(normalized.accountName)).id;
        if (normalized.splitItems.length) {
          normalized.splitItems.forEach((split) => importedSplits.push({
            transaction_id: id,
            category_id: categoryMap.get(`${normalized.type}:${normalizeLookup(split.categoryName)}`).id,
            amount: split.amount,
          }));
        } else {
          base.category_id = categoryMap.get(`${normalized.type}:${normalizeLookup(normalized.categoryName)}`).id;
        }
      }
      return base;
    });
    await insertImportedTransactions(transactionRows, importedSplits);
    persistLocal();
    render();
    closeModal(el.transactionImportModal);
    const duplicateCount = transactionImportValidation.filter((row) => row.status === "duplicate").length;
    showToast(`${transactionRows.length} transaction${transactionRows.length === 1 ? "" : "s"} imported${duplicateCount ? `; ${duplicateCount} duplicate${duplicateCount === 1 ? "" : "s"} skipped` : ""}.`);
  } catch (error) {
    el.transactionImportError.textContent = friendlyError(error);
    el.importTransactionsButton.disabled = false;
  }
}

async function insertImportedCategories(rows) {
  if (mode === "cloud") {
    setSyncStatus("syncing", "Creating categories");
    const { data, error } = await supabase.from("categories").insert(rows.map((row) => ({ ...row, user_id: user.id }))).select();
    if (error) throw error;
    state.categories.push(...(data || []));
  } else {
    state.categories.push(...rows.map(localRow));
  }
}

async function insertImportedTransactions(rows, splitRows = []) {
  if (mode === "cloud") {
    setSyncStatus("syncing", "Importing transactions");
    const insertedIds = [];
    try {
      for (const batch of chunk(rows, 200)) {
        const { data, error } = await supabase.from("transactions").insert(batch.map((row) => ({ ...row, user_id: user.id }))).select();
        if (error) throw error;
        state.transactions.push(...(data || []));
        insertedIds.push(...(data || []).map((row) => row.id));
      }
      for (const batch of chunk(splitRows, 500)) {
        const { data, error } = await supabase.from("transaction_splits").insert(batch.map((row) => ({ ...row, user_id: user.id }))).select();
        if (error) throw error;
        state.transactionSplits.push(...(data || []));
      }
      setSyncStatus("cloud", "Cloud synchronized");
    } catch (error) {
      if (insertedIds.length) await supabase.from("transactions").delete().in("id", insertedIds);
      state.transactions = state.transactions.filter((transaction) => !insertedIds.includes(transaction.id));
      state.transactionSplits = state.transactionSplits.filter((split) => !insertedIds.includes(split.transaction_id));
      throw error;
    }
  } else {
    state.transactions.push(...rows.map(localRow));
    state.transactionSplits.push(...splitRows.map(localRow));
  }
}

function parseImportSplits(value) {
  const raw = String(value || "").trim();
  if (!raw) return { items: [], errors: [] };
  const items = [];
  const errors = [];
  const parts = raw.split(/\s*[|;]\s*/).filter(Boolean);
  for (const part of parts) {
    const match = part.match(/^(.+?)\s*(?:=|:)\s*(.+)$/);
    if (!match) {
      errors.push(`Invalid split “${part}”. Use Category=Amount separated by |.`);
      continue;
    }
    const categoryName = match[1].trim();
    const amount = parseImportAmount(match[2]);
    if (!categoryName || !(amount > 0)) errors.push(`Invalid split “${part}”. Category and positive amount are required.`);
    else items.push({ categoryName, amount });
  }
  return { items, errors };
}

function normalizeImportType(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["expense", "income", "transfer"].includes(normalized) ? normalized : "";
}

function parseImportDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  }
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let match = raw.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (match) return validISODate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = raw.match(/^(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2}|\d{4})$/);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    return validISODate(year, Number(match[2]), Number(match[1]));
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime()) && /[A-Za-z]/.test(raw)) return validISODate(parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate());
  return "";
}

function validISODate(year, month, day) {
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return "";
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseImportAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(Math.abs(value) * 100) / 100 : 0;
  let raw = String(value ?? "").trim();
  if (!raw) return 0;
  const parenthesized = /^\(.*\)$/.test(raw);
  raw = raw.replace(/[()]/g, "").replace(/,/g, "").replace(/[^0-9.+-]/g, "");
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round(Math.abs(parenthesized ? -parsed : parsed) * 100) / 100;
}

function parseImportSignedAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
  let raw = String(value ?? "").trim();
  if (!raw) return 0;
  const parenthesized = /^\(.*\)$/.test(raw);
  raw = raw.replace(/[()]/g, "").replace(/,/g, "").replace(/[^0-9.+-]/g, "");
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.round((parenthesized ? -Math.abs(parsed) : parsed) * 100) / 100;
}

function normalizeLookup(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function transactionFingerprintFromState(transaction) {
  return transactionFingerprintFromImport({
    type: transaction.type,
    amount: number(transaction.amount),
    entry_date: transaction.entry_date,
    description: transaction.description || "",
    remarks: transaction.remarks || "",
    categoryName: categoryById(transaction.category_id)?.name || "",
    splitDetails: splitsForTransaction(transaction.id).map((split) => `${categoryById(split.category_id)?.name || ""}=${number(split.amount).toFixed(2)}`).sort().join("|"),
    accountName: accountById(transaction.account_id)?.name || "",
    fromAccountName: accountById(transaction.from_account_id)?.name || "",
    toAccountName: accountById(transaction.to_account_id)?.name || "",
  });
}

function transactionFingerprintFromImport(transaction) {
  return [
    transaction.entry_date || "",
    transaction.type || "",
    number(transaction.amount).toFixed(2),
    normalizeLookup(transaction.description),
    normalizeLookup(transaction.remarks),
    normalizeLookup(transaction.categoryName),
    normalizeLookup(transaction.splitDetails),
    normalizeLookup(transaction.accountName),
    normalizeLookup(transaction.fromAccountName),
    normalizeLookup(transaction.toAccountName),
  ].join("|");
}

function importCategoryColor(name) {
  const palette = ["#2563eb", "#059669", "#d97706", "#7c3aed", "#db2777", "#0891b2", "#dc2626", "#65a30d", "#475569"];
  let hash = 0;
  for (const character of String(name || "")) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
  return palette[Math.abs(hash) % palette.length];
}

function chunk(items, size) {
  const batches = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}

function exportJSON() {
  downloadFile(`ledgerly-backup-${todayISO()}.json`, JSON.stringify({ ...state, exported_at: new Date().toISOString() }, null, 2), "application/json");
  showToast("JSON backup downloaded.");
}

function exportCSV() {
  const header = ["Date", "Type", "Description", "Remarks", "Category", "Split Details", "Account", "From account", "To account", "Amount", "Currency", "Cleared accounts", "Reconciled accounts", "Recurring schedule ID", "Scheduled date", "Receipt filename"];
  const rows = sortedTransactions().map((transaction) => [
    transaction.entry_date,
    transaction.type,
    transaction.description || "",
    transaction.remarks || "",
    categoryById(transaction.category_id)?.name || "",
    splitsForTransaction(transaction.id).map((split) => `${categoryById(split.category_id)?.name || "Uncategorized"}=${number(split.amount).toFixed(2)}`).join(" | "),
    accountById(transaction.account_id)?.name || "",
    accountById(transaction.from_account_id)?.name || "",
    accountById(transaction.to_account_id)?.name || "",
    number(transaction.amount).toFixed(2),
    CURRENCY,
    affectedAccountIds(transaction).filter((accountId) => clearingFor(transaction.id, accountId)?.is_cleared).map((accountId) => accountById(accountId)?.name || "").filter(Boolean).join(" | "),
    affectedAccountIds(transaction).filter((accountId) => clearingFor(transaction.id, accountId)?.reconciliation_id).map((accountId) => accountById(accountId)?.name || "").filter(Boolean).join(" | "),
    transaction.recurring_entry_id || "",
    transaction.scheduled_date || "",
    transaction.receipt_name || "",
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  downloadFile(`ledgerly-transactions-${todayISO()}.csv`, csv, "text/csv;charset=utf-8");
  showToast("CSV export downloaded.");
}

async function importJSON(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  if (!confirm("Importing this backup will replace your current Ledgerly data. Continue?")) return;
  try {
    const parsed = JSON.parse(await file.text());
    const imported = parsed.version === 1 ? migrateLegacyState(parsed) : parsed;
    if (!isValidState(imported)) throw new Error("This file is not a valid Ledgerly backup.");
    if (mode === "cloud") await replaceCloudState(imported);
    else {
      state = sanitizeImportedState(imported);
      persistLocal();
    }
    render();
    showToast("Backup restored.");
  } catch (error) { showToast(friendlyError(error), true); }
}

async function replaceCloudState(imported) {
  setSyncStatus("syncing", "Restoring backup");
  for (const table of ["transaction_clearings", "reconciliations", "credit_card_statements", "transaction_splits", "transactions", "bills", "budgets", "recurring_entries", "import_rules", "accounts", "categories", "user_preferences"]) {
    const { error } = await supabase.from(table).delete().eq("user_id", user.id);
    if (error) throw error;
  }
  const clean = sanitizeImportedState(imported);
  const withUser = (rows) => rows.map((row) => ({ ...row, user_id: user.id }));
  for (const [table, rows] of [["categories", clean.categories], ["accounts", clean.accounts], ["import_rules", clean.importRules], ["recurring_entries", clean.recurringEntries], ["budgets", clean.budgets], ["transactions", clean.transactions], ["bills", clean.bills], ["transaction_splits", clean.transactionSplits], ["credit_card_statements", clean.creditCardStatements], ["reconciliations", clean.reconciliations], ["transaction_clearings", clean.transactionClearings]]) {
    if (!rows.length) continue;
    const { error } = await supabase.from(table).insert(withUser(rows));
    if (error) throw error;
  }
  const { error: preferenceError } = await supabase.from("user_preferences").upsert({ user_id: user.id, dashboard_widgets: normalizeDashboardWidgets(clean.preferences?.dashboard_widgets) }, { onConflict: "user_id" });
  if (preferenceError) throw preferenceError;
  await loadCloudState();
  setSyncStatus("cloud", "Cloud synchronized");
}

function sanitizeImportedState(imported) {
  const strip = (row) => {
    const copy = { ...row };
    delete copy.user_id;
    return copy;
  };
  const clean = normalizeState(imported);
  return {
    version: 9,
    accounts: clean.accounts.map(strip),
    categories: clean.categories.map(strip),
    transactions: clean.transactions.map(strip),
    transactionSplits: clean.transactionSplits.map(strip),
    budgets: clean.budgets.map(strip),
    recurringEntries: clean.recurringEntries.map(strip),
    bills: clean.bills.map(strip),
    reconciliations: clean.reconciliations.map(strip),
    transactionClearings: clean.transactionClearings.map(strip),
    creditCardStatements: clean.creditCardStatements.map(strip),
    importRules: clean.importRules.map(strip),
    preferences: normalizePreferences(clean.preferences),
  };
}

async function resetApplication() {
  if (!confirm("Delete all financial data for this Ledgerly account? This cannot be undone unless you have a backup.")) return;
  try {
    if (mode === "cloud") {
      setSyncStatus("syncing", "Resetting data");
      for (const table of ["transaction_clearings", "reconciliations", "credit_card_statements", "transaction_splits", "transactions", "bills", "budgets", "recurring_entries", "import_rules", "accounts", "categories", "user_preferences"]) {
        const { error } = await supabase.from(table).delete().eq("user_id", user.id);
        if (error) throw error;
      }
      state = emptyState();
      await seedDefaultCategories();
      setSyncStatus("cloud", "Cloud synchronized");
    } else {
      state = defaultLocalState();
      persistLocal();
    }
    render(); showToast("Application data reset.");
  } catch (error) { showToast(friendlyError(error), true); }
}

function isValidState(value) {
  return value && Array.isArray(value.accounts) && Array.isArray(value.categories) && Array.isArray(value.transactions) && Array.isArray(value.budgets);
}

function downloadFile(filename, contents, type) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  URL.revokeObjectURL(url);
}

function csvCell(value) { return `"${String(value ?? "").replaceAll('"', '""')}"`; }
function openModal(modal) { modal.hidden = false; document.body.style.overflow = "hidden"; }
function closeModal(modal) { if (!modal) return; modal.hidden = true; if (![...document.querySelectorAll(".modal-backdrop")].some((item) => !item.hidden)) document.body.style.overflow = ""; }
function showFormError(target, message) { target.textContent = message; }
function showToast(message, isError = false) {
  clearTimeout(toastTimer);
  el.toast.textContent = message;
  el.toast.classList.toggle("error", isError);
  el.toast.classList.add("show");
  toastTimer = window.setTimeout(() => el.toast.classList.remove("show"), 3500);
}
function friendlyError(error) {
  const message = String(error?.message || error || "Something went wrong.");
  if (message.includes("Failed to fetch")) return "Could not reach Supabase. Check your connection and project configuration.";
  if (message.includes("user_preferences") && (message.includes("does not exist") || message.includes("schema cache"))) return "Dashboard customization is not ready. Run supabase/add-receipt-ocr-dashboard-customization.sql in the Supabase SQL Editor.";
  if ((message.includes("reconciliations") || message.includes("transaction_clearings")) && (message.includes("does not exist") || message.includes("schema cache"))) return "Account reconciliation is not ready. Run supabase/add-account-reconciliation.sql in the Supabase SQL Editor.";
  if (message.includes("reconciliations_user_id_account_id_statement_date_key") || (message.includes("duplicate key") && message.includes("reconciliations"))) return "This account already has a completed reconciliation for that statement date. Undo it before creating another.";
  if ((message.includes("credit_card_statements") || message.includes("credit_limit") || message.includes("statement_closing_day") || message.includes("payment_due_day")) && (message.includes("does not exist") || message.includes("schema cache") || message.includes("column"))) return "Credit-card management is not ready. Run supabase/add-credit-card-management.sql in the Supabase SQL Editor.";
  if ((message.includes("card_artwork") || message.includes("card_network") || message.includes("card_last_four") || message.includes("card_accent_color")) && (message.includes("does not exist") || message.includes("schema cache") || message.includes("column"))) return "Credit-card appearance is not ready. Run supabase/add-credit-card-appearance.sql in the Supabase SQL Editor.";
  if (message.toLowerCase().includes("card artwork") && message.toLowerCase().includes("bucket not found")) return "Card artwork storage is not ready. Run supabase/add-credit-card-appearance.sql in the Supabase SQL Editor.";
  if (message.toLowerCase().includes("card artwork") && message.toLowerCase().includes("row-level security")) return "Supabase blocked the card artwork. Run the card-artwork storage policies in supabase/add-credit-card-appearance.sql.";
  if (message.includes("credit_card_statements_user_id_account_id_statement_date_key") || (message.includes("duplicate key") && message.includes("credit_card_statements"))) return "A statement already exists for this card and closing date.";
  if (message.includes("import_rules") && (message.includes("does not exist") || message.includes("schema cache"))) return "Import rules are not ready. Run supabase/add-import-rules.sql in the Supabase SQL Editor.";
  if (message.includes("duplicate key")) return "A record with the same name or category already exists.";
  if (message.includes("bills") && (message.includes("does not exist") || message.includes("schema cache"))) return "Bills and reminders are not ready. Run supabase/add-bills-and-reminders.sql in the Supabase SQL Editor.";
  if (message.includes("reminder_days_before") && (message.includes("does not exist") || message.includes("schema cache") || message.includes("column"))) return "Bill reminder settings are not ready. Run supabase/add-bills-and-reminders.sql in the Supabase SQL Editor.";
  if (message.includes("recurring_entries") && (message.includes("does not exist") || message.includes("schema cache"))) return "Recurring schedules are not ready. Run supabase/add-recurring-entries.sql in the Supabase SQL Editor.";
  if ((message.includes("recurring_entry_id") || message.includes("scheduled_date")) && message.includes("column")) return "Recurring transaction columns are not ready. Run supabase/add-recurring-entries.sql in the Supabase SQL Editor.";
  if (message.includes("violates foreign key")) return "This item is still used by another record.";
  if (message.includes("Bucket not found") || message.includes("bucket not found")) return "Receipt storage is not ready. Run the supplied Supabase receipt migration first.";
  if (message.includes("row-level security") && message.toLowerCase().includes("storage")) return "Supabase blocked the receipt. Run the supplied receipt-storage policies in the SQL Editor.";
  return message;
}
function emptyHTML(title, copy) { return `<div class="empty-state"><strong>${escapeHTML(title)}</strong><span>${escapeHTML(copy)}</span></div>`; }
function formatDate(value) { if (!value) return ""; return dateFormatter.format(new Date(`${value}T12:00:00`)); }
function todayISO() { return new Date().toLocaleDateString("en-CA"); }
function dateFromMonth(value) { const [year, month] = value.split("-").map(Number); return new Date(year, month - 1, 1); }
function endOfMonthISO(date) { return new Date(date.getFullYear(), date.getMonth() + 1, 0).toLocaleDateString("en-CA"); }
function number(value) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : 0; }
function tone(value) { return number(value) > 0 ? "positive" : number(value) < 0 ? "negative" : ""; }
function capitalize(value) { return String(value || "").charAt(0).toUpperCase() + String(value || "").slice(1); }
function safeColor(value) { return /^#[0-9a-f]{6}$/i.test(String(value)) ? value : "#64748b"; }
function escapeHTML(value) { return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[character])); }
