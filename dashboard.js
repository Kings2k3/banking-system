const dashboardState = {
  showBalances: true,
  transactionFilter: 'all',
  searchQuery: '',
};

let currentUser = null;
let accounts = [];
let cards = [];
let transactions = [];
let spending = [];
let alerts = [];

document.addEventListener('DOMContentLoaded', () => {
  loadDashboardData();
  initMobileNav();
  initNavbarScroll();
  initReveal();
  initDashboardDate();
  initDashboardActions();
  renderDashboard();
});

function loadDashboardData() {
  currentUser = getCurrentUser();

  if (!currentUser) {
    setText('customer-name', 'Customer');
    accounts = [];
    cards = [];
    transactions = [];
    spending = [];
    alerts = [{
      title: 'No registered account loaded',
      detail: 'Open an account or sign in to see your own dashboard data.',
      level: 'Info',
    }];
    return;
  }

  setText('customer-name', currentUser.firstName || 'Customer');
  accounts = [buildPrimaryAccount(currentUser)];
  cards = readUserDashboardList('cards');
  if (cards.length === 0) cards = buildCards(currentUser);
  transactions = readUserDashboardList('transactions');
  spending = readUserDashboardList('spending');
  alerts = [{
    title: 'Account created',
    detail: `${currentUser.accountLabel} ending in ${currentUser.accountMask} is ready to use.`,
    level: 'Update',
  }];
}

function getCurrentUser() {
  const email = localStorage.getItem('payvexisCurrentUser');
  if (!email) return null;

  try {
    const users = JSON.parse(localStorage.getItem('payvexisUsers')) || [];
    return users.find(user => user.email === email) || null;
  } catch (error) {
    return null;
  }
}

function buildPrimaryAccount(user) {
  return {
    name: user.accountLabel || 'Personal Checking',
    type: accountTypeLabel(user.accountType),
    mask: user.accountMask || '0000',
    balance: Number(user.balance) || 0,
    trend: 'New',
  };
}

function buildCards(user) {
  return [{
    id: `card-${user.id}`,
    name: 'Payvexis Debit',
    mask: user.accountMask || '0000',
    network: 'VISA',
    status: 'Active',
    frozen: false,
    spend: 0,
    limit: 400,
  }];
}

function readUserDashboardList(key) {
  const storageKey = `payvexis:${currentUser.email}:${key}`;
  try {
    return JSON.parse(localStorage.getItem(storageKey)) || [];
  } catch (error) {
    return [];
  }
}

function accountTypeLabel(type) {
  const labels = {
    personal: 'Personal account',
    savings: 'Savings account',
    business: 'Business account',
  };
  return labels[type] || 'Personal account';
}

function initMobileNav() {
  const toggle = document.getElementById('nav-toggle');
  const mobileNav = document.getElementById('mobile-nav');
  const closeBtn = document.getElementById('nav-close');
  if (!toggle || !mobileNav) return;

  function closeMobileNav() {
    mobileNav.classList.remove('open');
    document.body.style.overflow = '';
  }

  toggle.addEventListener('click', () => {
    mobileNav.classList.add('open');
    document.body.style.overflow = 'hidden';
  });

  if (closeBtn) closeBtn.addEventListener('click', closeMobileNav);
  mobileNav.querySelectorAll('a, button:not(#nav-close)').forEach(item => {
    item.addEventListener('click', closeMobileNav);
  });
}

function initNavbarScroll() {
  const nav = document.getElementById('navbar');
  if (!nav) return;

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    requestAnimationFrame(() => {
      nav.classList.toggle('scrolled', window.scrollY > 50);
      ticking = false;
    });
    ticking = true;
  }, { passive: true });
}

function initReveal() {
  const elements = document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -60px 0px' });

  elements.forEach(el => observer.observe(el));
}

function initDashboardDate() {
  const dateEl = document.getElementById('dashboard-date');
  if (!dateEl) return;

  dateEl.textContent = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date());
}

function initDashboardActions() {
  document.querySelectorAll('a[href="index.html"]').forEach(link => {
    link.addEventListener('click', () => {
      localStorage.removeItem('payvexisCurrentUser');
    });
  });

  document.querySelectorAll('#balance-toggle, #mobile-balance-toggle').forEach(button => {
    button.addEventListener('click', () => {
      dashboardState.showBalances = !dashboardState.showBalances;
      renderDashboard();
    });
  });

  document.querySelectorAll('[data-filter]').forEach(button => {
    button.addEventListener('click', () => {
      dashboardState.transactionFilter = button.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.filter === dashboardState.transactionFilter);
      });
      renderTransactions();
    });
  });

  const searchInput = document.getElementById('transaction-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      dashboardState.searchQuery = searchInput.value.trim().toLowerCase();
      renderTransactions();
    });
  }

  document.querySelectorAll('[data-money-action]').forEach(button => {
    button.addEventListener('click', () => openMoneyModal(button.dataset.moneyAction));
  });

  document.querySelectorAll('[data-modal-close]').forEach(button => {
    button.addEventListener('click', closeMoneyModal);
  });

  const moneyModal = document.getElementById('money-modal');
  if (moneyModal) {
    moneyModal.addEventListener('click', event => {
      if (event.target === moneyModal) closeMoneyModal();
    });
  }

  const moneyForm = document.getElementById('money-form');
  if (moneyForm) moneyForm.addEventListener('submit', handleMoneySubmit);

  document.querySelectorAll('[data-statement-action]').forEach(button => {
    button.addEventListener('click', downloadStatement);
  });
}

function openMoneyModal(action) {
  const modal = document.getElementById('money-modal');
  const amountInput = document.getElementById('money-amount');
  const detailInput = document.getElementById('money-detail');
  if (!modal || !amountInput || !detailInput) return;

  const isTransfer = action === 'transfer';
  const isBill = action === 'bill';

  clearMoneyError();
  setText('money-modal-title', getMoneyActionTitle(action));
  setText('money-modal-description', getMoneyActionDescription(action));
  setText('money-detail-label', isTransfer ? 'Recipient' : isBill ? 'Biller' : 'Source');
  setText('money-submit', isTransfer ? 'Transfer' : isBill ? 'Pay Bill' : 'Add Money');

  document.getElementById('money-action-type').value = action;
  detailInput.value = '';
  detailInput.placeholder = isTransfer ? 'Recipient name or account' : isBill ? 'Electric, rent, internet, or phone bill' : 'Payroll, cash deposit, or bank source';
  detailInput.required = isTransfer || isBill;
  amountInput.value = '';
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  amountInput.focus();
}

function closeMoneyModal() {
  const modal = document.getElementById('money-modal');
  if (!modal) return;

  modal.classList.add('hidden');
  document.body.style.overflow = '';
}

function handleMoneySubmit(event) {
  event.preventDefault();

  if (!currentUser || accounts.length === 0) {
    showMoneyError('Please register or sign in before using dashboard actions.');
    return;
  }

  const action = document.getElementById('money-action-type').value;
  const amount = Number(document.getElementById('money-amount').value);
  const detail = document.getElementById('money-detail').value.trim();

  if (!Number.isFinite(amount) || amount <= 0) {
    showMoneyError('Enter an amount greater than 0.');
    return;
  }

  if (action === 'transfer' && !detail) {
    showMoneyError('Enter who you are transferring money to.');
    return;
  }

  if (action === 'bill' && !detail) {
    showMoneyError('Enter the biller name.');
    return;
  }

  if ((action === 'transfer' || action === 'bill') && amount > accounts[0].balance) {
    showMoneyError(action === 'bill' ? 'You do not have enough balance to pay this bill.' : 'You do not have enough balance for this transfer.');
    return;
  }

  if (action === 'transfer') {
    applyBalanceChange(-amount);
    addTransaction({
      merchant: `Transfer to ${detail}`,
      category: 'Transfer',
      amount: -amount,
      type: 'spend',
      account: accounts[0].name,
    });
  } else if (action === 'bill') {
    applyBalanceChange(-amount);
    updateSpendingCategory('Bills', amount, 700);
    addTransaction({
      merchant: detail,
      category: 'Bills',
      amount: -amount,
      type: 'spend',
      account: accounts[0].name,
    });
  } else {
    applyBalanceChange(amount);
    addTransaction({
      merchant: detail || 'Added Money',
      category: 'Deposit',
      amount,
      type: 'income',
      account: accounts[0].name,
    });
  }

  saveDashboardData();
  closeMoneyModal();
  renderDashboard();
}

function getMoneyActionTitle(action) {
  if (action === 'transfer') return 'Transfer Money';
  if (action === 'bill') return 'Pay Bill';
  return 'Add Money';
}

function getMoneyActionDescription(action) {
  if (action === 'transfer') return 'Send money from your active account.';
  if (action === 'bill') return 'Pay a bill from your active account.';
  return 'Deposit funds into your account.';
}

function applyBalanceChange(amount) {
  const nextBalance = Number(((accounts[0].balance || 0) + amount).toFixed(2));
  accounts[0].balance = nextBalance;
  accounts[0].trend = amount >= 0 ? 'Updated' : 'Transfer';
  currentUser.balance = nextBalance;
}

function addTransaction(transaction) {
  transactions.unshift({
    ...transaction,
    date: formatTransactionDate(new Date()),
  });
}

function updateSpendingCategory(label, amount, defaultBudget) {
  const item = spending.find(entry => entry.label === label);
  if (item) {
    item.amount = Number((Number(item.amount || 0) + amount).toFixed(2));
    return;
  }

  spending.push({
    label,
    amount: Number(amount.toFixed(2)),
    budget: defaultBudget,
  });
}

function saveDashboardData() {
  saveCurrentUser();
  saveUserDashboardList('cards', cards);
  saveUserDashboardList('transactions', transactions);
  saveUserDashboardList('spending', spending);
}

function saveCurrentUser() {
  try {
    const users = JSON.parse(localStorage.getItem('payvexisUsers')) || [];
    const index = users.findIndex(user => user.email === currentUser.email);
    if (index >= 0) {
      users[index] = currentUser;
    } else {
      users.push(currentUser);
    }
    localStorage.setItem('payvexisUsers', JSON.stringify(users));
  } catch (error) {
    localStorage.setItem('payvexisUsers', JSON.stringify([currentUser]));
  }
}

function saveUserDashboardList(key, value) {
  localStorage.setItem(`payvexis:${currentUser.email}:${key}`, JSON.stringify(value));
}

function showMoneyError(message) {
  const error = document.getElementById('money-error');
  if (!error) return;

  error.textContent = message;
  error.classList.remove('hidden');
}

function clearMoneyError() {
  const error = document.getElementById('money-error');
  if (!error) return;

  error.textContent = '';
  error.classList.add('hidden');
}

function formatTransactionDate(date) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function downloadStatement() {
  if (!currentUser) {
    alerts.unshift({
      title: 'Sign in required',
      detail: 'Register or sign in before downloading a statement.',
      level: 'Info',
    });
    renderAlerts();
    return;
  }

  const statement = buildStatementText();
  const blob = new Blob([statement], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `payvexis-statement-${currentUser.accountMask || 'account'}.txt`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildStatementText() {
  const totalIncome = transactions.filter(item => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
  const totalSpend = transactions.filter(item => item.type === 'spend').reduce((sum, item) => sum + Math.abs(item.amount), 0);
  const rows = transactions.length > 0
    ? transactions.map(item => `${item.date} | ${item.category} | ${item.merchant} | ${formatMoneyForStatement(item.amount)} | ${item.account}`)
    : ['No transactions yet.'];

  return [
    'Payvexis Account Statement',
    `Generated: ${new Date().toLocaleString('en-GB')}`,
    `Customer: ${currentUser.firstName || ''} ${currentUser.lastName || ''}`.trim(),
    `Email: ${currentUser.email}`,
    `Account: ${accounts[0]?.name || currentUser.accountLabel || 'Account'} ending ${currentUser.accountMask || '0000'}`,
    `Current balance: ${formatMoneyForStatement(accounts[0]?.balance || 0)}`,
    `Income: ${formatMoneyForStatement(totalIncome)}`,
    `Spend: ${formatMoneyForStatement(totalSpend)}`,
    '',
    'Transactions',
    ...rows,
    '',
  ].join('\n');
}

function renderDashboard() {
  renderMetrics();
  renderAccounts();
  renderCards();
  renderSpending();
  renderAlerts();
  renderTransactions();
  syncBalanceButtons();
}

function renderMetrics() {
  const total = accounts.reduce((sum, account) => sum + account.balance, 0);
  const income = transactions.filter(item => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
  const spend = transactions.filter(item => item.type === 'spend').reduce((sum, item) => sum + Math.abs(item.amount), 0);

  setText('available-balance', formatMoney(total));
  setText('total-balance', `${formatMoney(total)} total`);
  setText('monthly-income', formatMoney(income));
  setText('monthly-spend', formatMoney(spend));
  setText('balance-caption', dashboardState.showBalances ? 'Across active accounts' : 'Balances hidden');
}

function renderAccounts() {
  const list = document.getElementById('account-list');
  if (!list) return;

  if (accounts.length === 0) {
    list.innerHTML = '<div class="account-row p-4 text-sm text-slate-500">No registered account found yet.</div>';
    return;
  }

  list.innerHTML = accounts.map(account => `
    <article class="account-row p-4 flex items-center justify-between gap-4">
      <div class="min-w-0">
        <p class="text-sm font-bold text-slate-100">${account.name}</p>
        <p class="text-xs text-slate-500 mt-1">${account.type} - ...${account.mask}</p>
      </div>
      <div class="text-right flex-shrink-0">
        <p class="text-sm font-bold text-slate-100">${formatMoney(account.balance)}</p>
        <p class="text-xs ${getTrendClass(account.trend)} mt-1">${account.trend}</p>
      </div>
    </article>
  `).join('');
}

function renderCards() {
  const list = document.getElementById('card-list');
  if (!list) return;

  setText('card-count', `${cards.length} ${cards.length === 1 ? 'card' : 'cards'}`);

  if (cards.length === 0) {
    list.innerHTML = '<div class="glass-card p-4 !rounded-xl !transform-none text-sm text-slate-500">No card is connected yet.</div>';
    return;
  }

  list.innerHTML = cards.map(card => {
    const used = Math.min(Math.round((card.spend / card.limit) * 100), 100);
    return `
      <article class="glass-card p-4 !rounded-xl !transform-none">
        <div class="flex items-start justify-between gap-3 mb-4">
          <div>
            <p class="text-sm font-bold">${card.name}</p>
            <p class="text-xs text-slate-500 mt-1">${card.network} - ...${card.mask}</p>
          </div>
          <span class="status-pill">${card.frozen ? 'Frozen' : card.status}</span>
        </div>
        <div class="spend-track mb-2">
          <div class="spend-fill" style="width:${used}%"></div>
        </div>
        <div class="flex items-center justify-between text-xs text-slate-500 mb-4">
          <span>${formatMoney(card.spend)} spent</span>
          <span>${formatMoney(card.limit)} limit</span>
        </div>
        <button class="btn-secondary w-full justify-center text-xs py-2.5" type="button" data-card-toggle="${card.id}">
          ${card.frozen ? 'Unfreeze Card' : 'Freeze Card'}
        </button>
      </article>
    `;
  }).join('');

  list.querySelectorAll('[data-card-toggle]').forEach(button => {
    button.addEventListener('click', () => {
      const card = cards.find(item => item.id === button.dataset.cardToggle);
      if (!card) return;
      card.frozen = !card.frozen;
      saveUserDashboardList('cards', cards);
      renderCards();
    });
  });
}

function renderTransactions() {
  const list = document.getElementById('transaction-list');
  if (!list) return;

  const filtered = transactions.filter(item => {
    const matchesFilter = dashboardState.transactionFilter === 'all' || item.type === dashboardState.transactionFilter;
    const text = `${item.merchant} ${item.category} ${item.account}`.toLowerCase();
    return matchesFilter && text.includes(dashboardState.searchQuery);
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="activity-row p-4 text-sm text-slate-500">No transactions match your search.</div>';
    return;
  }

  list.innerHTML = filtered.map(item => `
    <article class="activity-row p-4 flex items-center justify-between gap-4">
      <div class="flex items-center gap-3 min-w-0">
        <span class="action-icon !w-10 !h-10">
          ${item.type === 'income' ? incomeIcon() : spendIcon()}
        </span>
        <div class="min-w-0">
          <p class="text-sm font-bold text-slate-100 truncate">${escapeHtml(item.merchant)}</p>
          <p class="text-xs text-slate-500 mt-1">${escapeHtml(item.category)} - ${escapeHtml(item.date)}</p>
        </div>
      </div>
      <div class="text-right flex-shrink-0">
        <p class="text-sm font-bold ${item.amount >= 0 ? 'text-emerald-400' : 'text-slate-100'}">${formatMoney(item.amount)}</p>
        <p class="text-xs text-slate-500 mt-1">${escapeHtml(item.account)}</p>
      </div>
    </article>
  `).join('');
}

function renderSpending() {
  const list = document.getElementById('spending-list');
  if (!list) return;

  if (spending.length === 0) {
    list.innerHTML = '<div class="text-sm text-slate-500">No spending activity yet.</div>';
    return;
  }

  list.innerHTML = spending.map(item => {
    const used = Math.min(Math.round((item.amount / item.budget) * 100), 100);
    return `
      <div>
        <div class="flex items-center justify-between text-sm mb-2">
          <span class="font-semibold">${item.label}</span>
          <span class="text-slate-500">${formatMoney(item.amount)} / ${formatMoney(item.budget)}</span>
        </div>
        <div class="spend-track">
          <div class="spend-fill" style="width:${used}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderAlerts() {
  const list = document.getElementById('alert-list');
  if (!list) return;

  setText('alert-count', `${alerts.length} open`);
  list.innerHTML = alerts.map(alert => `
    <article class="alert-row p-4">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="text-sm font-bold">${alert.title}</p>
          <p class="text-xs text-slate-500 mt-1 leading-relaxed">${alert.detail}</p>
        </div>
        <span class="status-pill">${alert.level}</span>
      </div>
    </article>
  `).join('');
}

function syncBalanceButtons() {
  const label = dashboardState.showBalances ? 'Hide Balance' : 'Show Balance';
  document.querySelectorAll('#balance-toggle, #mobile-balance-toggle').forEach(button => {
    button.textContent = label;
  });

  document.body.classList.toggle('balances-hidden', !dashboardState.showBalances);
}

function formatMoney(value) {
  if (!dashboardState.showBalances) return '******';
  return formatMoneyForStatement(value);
}

function formatMoneyForStatement(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(value);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getTrendClass(trend) {
  if (trend.startsWith('+')) return 'text-emerald-400';
  if (trend.startsWith('-')) return 'text-red-400';
  return 'text-slate-500';
}

function incomeIcon() {
  return '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m0 0l-6 6m6-6l6 6" /></svg>';
}

function spendIcon() {
  return '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14m0 0l6-6m-6 6l-6-6" /></svg>';
}
