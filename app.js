import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";

const STORAGE_KEY = "ledgerly-data-v2-local";
const LEGACY_STORAGE_KEY = "ledgerly-data-v1";
const CURRENCY = "USD";
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: CURRENCY });
const compactCurrency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: CURRENCY,
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

const el = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));

initialize();

async function initialize() {
  el.todayLabel.textContent = new Intl.DateTimeFormat("en-US", {
    weekday: "long", month: "long", day: "numeric",
  }).format(new Date());
  el.entryDate.value = todayISO();
  el.reportMonth.value = todayISO().slice(0, 7);
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
  el.openAccountButton.addEventListener("click", () => openAccountModal());
  el.openBudgetButton.addEventListener("click", () => openBudgetModal());
  el.openCategoryButton.addEventListener("click", () => openCategoryModal());

  document.querySelectorAll("[data-entry-type]").forEach((button) => {
    button.addEventListener("click", () => setEntryType(button.dataset.entryType));
  });
  el.accountType.addEventListener("change", () => {
    if (!el.accountId.value) el.accountColor.value = ACCOUNT_COLORS[el.accountType.value] || ACCOUNT_COLORS.other;
  });

  el.authForm.addEventListener("input", () => showAuthError(""));
  el.transactionForm.addEventListener("submit", handleTransactionSubmit);
  el.accountForm.addEventListener("submit", handleAccountSubmit);
  el.budgetForm.addEventListener("submit", handleBudgetSubmit);
  el.categoryForm.addEventListener("submit", handleCategorySubmit);

  [el.transactionSearch, el.transactionTypeFilter, el.transactionAccountFilter, el.transactionMonthFilter]
    .forEach((input) => input.addEventListener("input", renderAllTransactions));
  [el.reportPeriod, el.reportMonth].forEach((input) => input.addEventListener("input", renderReports));

  el.exportButton.addEventListener("click", exportJSON);
  el.exportCsvButton.addEventListener("click", exportCSV);
  el.importInput.addEventListener("change", importJSON);
  el.resetButton.addEventListener("click", resetApplication);

  document.body.addEventListener("click", async (event) => {
    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) return;
    const { action, id } = actionTarget.dataset;
    const actions = {
      "edit-account": () => openAccountModal(id),
      "delete-account": () => deleteAccount(id),
      "edit-transaction": () => openTransactionModal(id),
      "delete-transaction": () => deleteTransaction(id),
      "edit-budget": () => openBudgetModal(id),
      "delete-budget": () => deleteBudget(id),
      "edit-category": () => openCategoryModal(id),
      "delete-category": () => deleteCategory(id),
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
    setSyncStatus("cloud", "Cloud synchronized");
    render();
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
  render();
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
  const [accountsResult, categoriesResult, transactionsResult, budgetsResult] = await Promise.all([
    supabase.from("accounts").select("*").order("created_at", { ascending: true }),
    supabase.from("categories").select("*").order("kind").order("name"),
    supabase.from("transactions").select("*").order("entry_date", { ascending: false }).order("created_at", { ascending: false }),
    supabase.from("budgets").select("*").order("created_at", { ascending: true }),
  ]);
  [accountsResult, categoriesResult, transactionsResult, budgetsResult].forEach((result) => {
    if (result.error) throw result.error;
  });
  state = {
    version: 2,
    accounts: accountsResult.data || [],
    categories: categoriesResult.data || [],
    transactions: transactionsResult.data || [],
    budgets: budgetsResult.data || [],
  };
}

async function seedDefaultCategories() {
  const rows = defaultCategoryRows().map((row) => ({ ...row, user_id: user.id }));
  const { data, error } = await supabase.from("categories").insert(rows).select();
  if (error) throw error;
  state.categories = data || [];
}

function emptyState() {
  return { version: 2, accounts: [], categories: [], transactions: [], budgets: [] };
}

function defaultLocalState() {
  return {
    version: 2,
    accounts: [
      localRow({ name: "Current Account", type: "current", opening_balance: 0, color: ACCOUNT_COLORS.current, include_in_net_worth: true }),
      localRow({ name: "Savings", type: "savings", opening_balance: 0, color: ACCOUNT_COLORS.savings, include_in_net_worth: true }),
      localRow({ name: "Cash", type: "cash", opening_balance: 0, color: ACCOUNT_COLORS.cash, include_in_net_worth: true }),
    ],
    categories: defaultCategoryRows().map(localRow),
    transactions: [],
    budgets: [],
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
    if (isValidState(current)) return current;
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
  return { version: 2, accounts, categories, transactions, budgets: [] };
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
  const titles = { dashboard: "Dashboard", accounts: "Accounts", transactions: "Transactions", budgets: "Budgets", reports: "Reports", categories: "Categories", settings: "Data & settings" };
  el.pageTitle.textContent = titles[view] || "Ledgerly";
  el.sidebar.classList.remove("open");
  if (view === "reports") renderReports();
}

function render() {
  renderSelectors();
  renderSummary();
  renderAccounts();
  renderTransactions();
  renderCategoryChart();
  renderCashFlowChart();
  renderBudgets();
  renderCategories();
  renderReports();
  renderSettings();
}

function renderSummary() {
  const month = todayISO().slice(0, 7);
  const monthTx = state.transactions.filter((item) => item.entry_date?.startsWith(month));
  const income = sumTransactions(monthTx, "income");
  const expenses = sumTransactions(monthTx, "expense");
  const netWorth = calculateNetWorth();
  const cashFlow = income - expenses;
  const budget = budgetMetrics("monthly", month);
  const cards = [
    summaryCard("Net worth", netWorth, `${state.accounts.filter((a) => a.include_in_net_worth !== false).length} included accounts`, tone(netWorth)),
    summaryCard("Income this month", income, `${monthTx.filter((item) => item.type === "income").length} entries`, "positive"),
    summaryCard("Expenses this month", expenses, budget.total ? `${Math.round((expenses / budget.total) * 100)}% of monthly budget` : `${monthTx.filter((item) => item.type === "expense").length} entries`, expenses ? "negative" : ""),
    summaryCard("Net cash flow", cashFlow, "Income minus expenses", tone(cashFlow)),
  ];
  el.summaryGrid.innerHTML = cards.join("");
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
        <p class="large-balance">${currency.format(balance)}</p>
        <p class="opening-balance">Starting balance: ${currency.format(number(account.opening_balance))}${account.include_in_net_worth === false ? " · excluded from net worth" : ""}</p>
      </article>`;
  }).join("");
}

function accountRowHTML(account) {
  const balance = calculateAccountBalance(account.id);
  return `<div class="account-row">
    <span class="account-icon" style="--account-color:${safeColor(account.color)}">${escapeHTML(account.name.slice(0, 1).toUpperCase())}</span>
    <div class="account-details"><strong>${escapeHTML(account.name)}</strong><span>${escapeHTML(account.type)}</span></div>
    <span class="account-balance ${tone(balance)}">${currency.format(balance)}</span>
  </div>`;
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
    const category = categoryById(transaction.category_id)?.name || "";
    const accountText = transactionAccountText(transaction);
    const matchesSearch = !search || [transaction.description, category, accountText].some((value) => String(value || "").toLowerCase().includes(search));
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
    const title = transaction.description || (transaction.type === "transfer" ? "Account transfer" : category?.name || capitalize(transaction.type));
    const subtitle = transaction.type === "transfer" ? transactionAccountText(transaction) : `${category?.name || "Uncategorized"} · ${transactionAccountText(transaction)}`;
    const sign = transaction.type === "expense" ? "−" : transaction.type === "income" ? "+" : "";
    return `<div class="transaction-row">
      <div class="transaction-main">
        <span class="transaction-icon ${transaction.type}">${transaction.type === "expense" ? "↓" : transaction.type === "income" ? "↑" : "⇄"}</span>
        <div style="min-width:0"><div class="transaction-title">${escapeHTML(title)}</div><div class="transaction-subtitle">${escapeHTML(subtitle)}</div></div>
      </div>
      <div class="transaction-meta account-column">${escapeHTML(transactionAccountText(transaction))}</div>
      <div class="transaction-meta">${formatDate(transaction.entry_date)}</div>
      <div class="amount ${transaction.type}">${sign}${currency.format(number(transaction.amount))}</div>
      <div class="row-actions">${showActions ? `<button class="row-action" data-action="edit-transaction" data-id="${transaction.id}" aria-label="Edit entry">✎</button><button class="row-action danger" data-action="delete-transaction" data-id="${transaction.id}" aria-label="Delete entry">×</button>` : ""}</div>
    </div>`;
  }).join("")}</div>`;
}

function renderCategoryChart() {
  const month = todayISO().slice(0, 7);
  const totals = categoryTotals(state.transactions.filter((item) => item.type === "expense" && item.entry_date?.startsWith(month)));
  el.categoryChart.innerHTML = categoryBarsHTML(totals, "No spending this month");
}

function renderCashFlowChart() {
  el.cashFlowChart.innerHTML = cashFlowBarsHTML(monthSeries(6, new Date()));
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
    <div class="budget-row-bottom"><span>${currency.format(actual)} spent</span><strong class="${over ? "negative" : ""}">${Math.round(percent)}% of ${currency.format(amount)}</strong></div>
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
    summaryCard("Cash flow", net, `${currency.format(income)} income`, tone(net)),
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
  const accountOptions = state.accounts.map((account) => `<option value="${account.id}">${escapeHTML(account.name)} (${currency.format(calculateAccountBalance(account.id))})</option>`).join("");
  [el.entryAccount, el.transferFromAccount, el.transferToAccount].forEach((select) => {
    const previous = select.value;
    select.innerHTML = accountOptions || `<option value="">No accounts available</option>`;
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  });
  const filterPrevious = el.transactionAccountFilter.value;
  el.transactionAccountFilter.innerHTML = `<option value="all">All accounts</option>${state.accounts.map((account) => `<option value="${account.id}">${escapeHTML(account.name)}</option>`).join("")}`;
  if ([...el.transactionAccountFilter.options].some((option) => option.value === filterPrevious)) el.transactionAccountFilter.value = filterPrevious;
  renderEntryCategories(el.entryType.value);
  const budgetPrevious = el.budgetCategory.value;
  el.budgetCategory.innerHTML = state.categories.filter((category) => category.kind === "expense").sort((a, b) => a.name.localeCompare(b.name)).map((category) => `<option value="${category.id}">${escapeHTML(category.name)}</option>`).join("") || `<option value="">No expense categories</option>`;
  if ([...el.budgetCategory.options].some((option) => option.value === budgetPrevious)) el.budgetCategory.value = budgetPrevious;
}

function renderEntryCategories(type) {
  if (type === "transfer") return;
  const previous = el.entryCategory.value;
  el.entryCategory.innerHTML = state.categories.filter((category) => category.kind === type).sort((a, b) => a.name.localeCompare(b.name)).map((category) => `<option value="${category.id}">${escapeHTML(category.name)}</option>`).join("") || `<option value="">No ${type} categories</option>`;
  if ([...el.entryCategory.options].some((option) => option.value === previous)) el.entryCategory.value = previous;
}

function setEntryType(type) {
  el.entryType.value = type;
  document.querySelectorAll("[data-entry-type]").forEach((button) => button.classList.toggle("active", button.dataset.entryType === type));
  document.querySelectorAll(".expense-income-field").forEach((field) => field.hidden = type === "transfer");
  document.querySelectorAll(".transfer-field").forEach((field) => field.hidden = type !== "transfer");
  el.accountLabel.textContent = type === "income" ? "Add to account" : "Pay from account";
  el.categoryLabel.textContent = type === "income" ? "Income category" : "Expense category";
  renderEntryCategories(type);
}

function openTransactionModal(id = null) {
  if (!state.accounts.length) return showToast("Add an account before recording an entry.", true);
  el.transactionForm.reset();
  el.transactionId.value = "";
  el.entryDate.value = todayISO();
  el.transactionFormError.textContent = "";
  let type = "expense";
  if (id) {
    const transaction = state.transactions.find((item) => item.id === id);
    if (!transaction) return;
    type = transaction.type;
    el.transactionId.value = id;
    el.entryAmount.value = number(transaction.amount);
    el.entryDate.value = transaction.entry_date;
    el.entryDescription.value = transaction.description || "";
    setEntryType(type);
    if (type === "transfer") {
      el.transferFromAccount.value = transaction.from_account_id || "";
      el.transferToAccount.value = transaction.to_account_id || "";
    } else {
      el.entryAccount.value = transaction.account_id || "";
      el.entryCategory.value = transaction.category_id || "";
    }
    el.transactionModalTitle.textContent = "Edit entry";
  } else {
    setEntryType(type);
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
  const base = {
    type, amount, entry_date: el.entryDate.value, description: el.entryDescription.value.trim(),
    account_id: null, category_id: null, from_account_id: null, to_account_id: null,
  };
  if (!(amount > 0)) return showFormError(el.transactionFormError, "Enter an amount greater than zero.");
  if (!base.entry_date) return showFormError(el.transactionFormError, "Choose a transaction date.");
  if (type === "transfer") {
    base.from_account_id = el.transferFromAccount.value;
    base.to_account_id = el.transferToAccount.value;
    if (!base.from_account_id || !base.to_account_id) return showFormError(el.transactionFormError, "Choose both transfer accounts.");
    if (base.from_account_id === base.to_account_id) return showFormError(el.transactionFormError, "Choose two different accounts.");
  } else {
    base.account_id = el.entryAccount.value;
    base.category_id = el.entryCategory.value || null;
    if (!base.account_id) return showFormError(el.transactionFormError, "Choose an account.");
    if (!base.category_id) return showFormError(el.transactionFormError, `Create or select an ${type} category.`);
  }
  try {
    if (id) {
      const updated = await updateRow("transactions", id, base);
      state.transactions = state.transactions.map((item) => item.id === id ? { ...item, ...updated } : item);
      showToast("Entry updated.");
    } else {
      state.transactions.push(await insertRow("transactions", base));
      showToast("Entry added.");
    }
    persistLocal();
    closeModal(el.transactionModal);
    render();
  } catch (error) { showFormError(el.transactionFormError, friendlyError(error)); }
}

function openAccountModal(id = null) {
  el.accountForm.reset();
  el.accountId.value = "";
  el.accountOpeningBalance.value = "0";
  el.accountIncludeNetWorth.checked = true;
  el.accountType.value = "current";
  el.accountColor.value = ACCOUNT_COLORS.current;
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
    el.accountModalTitle.textContent = "Edit account";
  } else {
    el.accountModalTitle.textContent = "Add account";
  }
  openModal(el.accountModal);
  el.accountName.focus();
}

async function handleAccountSubmit(event) {
  event.preventDefault();
  el.accountFormError.textContent = "";
  const id = el.accountId.value;
  const row = {
    name: el.accountName.value.trim(),
    type: el.accountType.value,
    opening_balance: number(el.accountOpeningBalance.value),
    color: safeColor(el.accountColor.value),
    include_in_net_worth: el.accountIncludeNetWorth.checked,
  };
  if (!row.name) return showFormError(el.accountFormError, "Enter an account name.");
  const duplicate = state.accounts.some((account) => account.id !== id && account.name.toLowerCase() === row.name.toLowerCase());
  if (duplicate) return showFormError(el.accountFormError, "An account with that name already exists.");
  try {
    if (id) {
      const updated = await updateRow("accounts", id, row);
      state.accounts = state.accounts.map((item) => item.id === id ? { ...item, ...updated } : item);
      showToast("Account updated.");
    } else {
      state.accounts.push(await insertRow("accounts", row));
      showToast("Account added.");
    }
    persistLocal(); closeModal(el.accountModal); render();
  } catch (error) { showFormError(el.accountFormError, friendlyError(error)); }
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
    const usedByWrongType = state.transactions.some((transaction) => transaction.category_id === id && transaction.type !== row.kind);
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
  const inUse = state.transactions.some((transaction) => [transaction.account_id, transaction.from_account_id, transaction.to_account_id].includes(id));
  if (inUse) return showToast("Delete or move this account's transactions first.", true);
  if (!confirm(`Delete ${account.name}?`)) return;
  try {
    await deleteRow("accounts", id);
    state.accounts = state.accounts.filter((item) => item.id !== id);
    persistLocal(); render(); showToast("Account deleted.");
  } catch (error) { showToast(friendlyError(error), true); }
}

async function deleteTransaction(id) {
  if (!confirm("Delete this entry?")) return;
  try {
    await deleteRow("transactions", id);
    state.transactions = state.transactions.filter((item) => item.id !== id);
    persistLocal(); render(); showToast("Entry deleted.");
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
  const inUse = state.transactions.some((transaction) => transaction.category_id === id) || state.budgets.some((budget) => budget.category_id === id);
  if (inUse) return showToast("Remove this category from transactions and budgets first.", true);
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
    const category = categoryById(transaction.category_id) || { id: "uncategorized", name: "Uncategorized", color: "#94a3b8" };
    const current = map.get(category.id) || { id: category.id, name: category.name, color: category.color, amount: 0 };
    current.amount += number(transaction.amount);
    map.set(category.id, current);
  });
  return [...map.values()].sort((a, b) => b.amount - a.amount);
}

function categoryBarsHTML(items, emptyMessage) {
  if (!items.length) return emptyHTML(emptyMessage, "Category totals will appear after you add entries.");
  const max = Math.max(...items.map((item) => item.amount), 1);
  return items.slice(0, 10).map((item) => `<div class="category-row">
    <span class="category-name"><span class="category-dot" style="--category-color:${safeColor(item.color)}"></span>${escapeHTML(item.name)}</span>
    <span class="category-bar-track"><span class="category-bar" style="width:${(item.amount / max) * 100}%;--category-color:${safeColor(item.color)}"></span></span>
    <span class="category-amount">${currency.format(item.amount)}</span>
  </div>`).join("");
}

function spendingForBudget(budget, anchorMonth) {
  const prefix = budget.period === "yearly" ? anchorMonth.slice(0, 4) : anchorMonth;
  return state.transactions.filter((transaction) => transaction.type === "expense" && transaction.category_id === budget.category_id && transaction.entry_date?.startsWith(prefix)).reduce((sum, item) => sum + number(item.amount), 0);
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
  return `<div class="cash-flow-chart">${series.map((item) => `<div class="cash-month" title="${escapeHTML(item.label)}: ${currency.format(item.income)} income, ${currency.format(item.expenses)} expenses">
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
    return `<line class="line-chart-grid" x1="${padX}" x2="${width - padX}" y1="${y}" y2="${y}"/><text class="line-chart-value" x="2" y="${y + 3}">${escapeHTML(compactCurrency.format(value))}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Net worth over time">
    <defs><linearGradient id="netWorthGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3b82f6" stop-opacity=".25"/><stop offset="100%" stop-color="#3b82f6" stop-opacity="0"/></linearGradient></defs>
    ${grid}<path class="line-chart-area" d="${area}"/><path class="line-chart-line" d="${line}"/>
    ${coords.map((point) => `<circle class="line-chart-dot" cx="${point.x}" cy="${point.y}" r="4"><title>${escapeHTML(point.label)}: ${currency.format(point.value)}</title></circle>`).join("")}
    ${coords.map((point, index) => index % Math.ceil(coords.length / 6) === 0 || index === coords.length - 1 ? `<text class="line-chart-label" text-anchor="middle" x="${point.x}" y="${height - 12}">${escapeHTML(point.label)}</text>` : "").join("")}
  </svg>`;
}

function summaryCard(label, value, detail, className = "", money = true, suffix = "") {
  const display = money ? currency.format(number(value)) : suffix ? `${Number(value).toFixed(1)}${suffix}` : Math.round(number(value)).toLocaleString("en-US");
  return `<article class="summary-card"><p class="card-label">${escapeHTML(label)}</p><p class="card-value ${className}">${escapeHTML(display)}</p><p class="card-detail">${escapeHTML(detail)}</p></article>`;
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

function exportJSON() {
  downloadFile(`ledgerly-backup-${todayISO()}.json`, JSON.stringify({ ...state, exported_at: new Date().toISOString() }, null, 2), "application/json");
  showToast("JSON backup downloaded.");
}

function exportCSV() {
  const header = ["Date", "Type", "Description", "Category", "Account", "From account", "To account", "Amount", "Currency"];
  const rows = sortedTransactions().map((transaction) => [
    transaction.entry_date,
    transaction.type,
    transaction.description || "",
    categoryById(transaction.category_id)?.name || "",
    accountById(transaction.account_id)?.name || "",
    accountById(transaction.from_account_id)?.name || "",
    accountById(transaction.to_account_id)?.name || "",
    number(transaction.amount).toFixed(2),
    CURRENCY,
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
  for (const table of ["transactions", "budgets", "accounts", "categories"]) {
    const { error } = await supabase.from(table).delete().eq("user_id", user.id);
    if (error) throw error;
  }
  const clean = sanitizeImportedState(imported);
  const withUser = (rows) => rows.map((row) => ({ ...row, user_id: user.id }));
  for (const [table, rows] of [["categories", clean.categories], ["accounts", clean.accounts], ["budgets", clean.budgets], ["transactions", clean.transactions]]) {
    if (!rows.length) continue;
    const { error } = await supabase.from(table).insert(withUser(rows));
    if (error) throw error;
  }
  await loadCloudState();
  setSyncStatus("cloud", "Cloud synchronized");
}

function sanitizeImportedState(imported) {
  const strip = (row) => {
    const copy = { ...row };
    delete copy.user_id;
    return copy;
  };
  return {
    version: 2,
    accounts: imported.accounts.map(strip),
    categories: imported.categories.map(strip),
    transactions: imported.transactions.map(strip),
    budgets: imported.budgets.map(strip),
  };
}

async function resetApplication() {
  if (!confirm("Delete all financial data for this Ledgerly account? This cannot be undone unless you have a backup.")) return;
  try {
    if (mode === "cloud") {
      setSyncStatus("syncing", "Resetting data");
      for (const table of ["transactions", "budgets", "accounts", "categories"]) {
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
  if (message.includes("duplicate key")) return "A record with the same name or category already exists.";
  if (message.includes("violates foreign key")) return "This item is still used by another record.";
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
