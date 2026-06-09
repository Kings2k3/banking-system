const activityState = {
  currentUser: null,
  transactions: [],
  filtered: [],
  typeFilter: 'all',
  categoryFilter: 'all',
  rangeFilter: 'all',
  searchQuery: '',
};

document.addEventListener('DOMContentLoaded', () => {
  initMobileNav();
  initNavbarScroll();
  initSignOut();
  initActivityPage();
});

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

function initSignOut() {
  document.querySelectorAll('[data-sign-out]').forEach(link => {
    link.addEventListener('click', () => {
      localStorage.removeItem('payvexisCurrentUser');
    });
  });
}

async function initActivityPage() {
  const token = localStorage.getItem('payvexisToken');
  if (!token) {
    showSignedOutState();
    return;
  }

  try {
    // 1. Get user
    const meRes = await fetch('/api/accounts/me', { headers: { 'Authorization': `Bearer ${token}` } });
    if (!meRes.ok) throw new Error();
    const meData = await meRes.json();
    activityState.currentUser = meData.user;

    // 2. Get transactions
    const txRes = await fetch('/api/transactions', { headers: { 'Authorization': `Bearer ${token}` } });
    if (!txRes.ok) throw new Error();
    const txData = await txRes.json();
    
    activityState.transactions = txData.transactions.map((tx, idx) => normalizeTransaction(tx, idx));
    
    initActivityEvents();
    populateCategoryFilter();
    renderActivityPage();
  } catch(err) {
    showSignedOutState();
  }
}

function showSignedOutState() {
  const empty = document.getElementById('signed-out-state');
  const workspace = document.getElementById('activity-workspace');
  if (empty) empty.classList.add('open');
  if (workspace) workspace.classList.add('workspace-hidden');
}

function initActivityEvents() {
  const search = document.getElementById('activity-search');
  if (search) {
    search.addEventListener('input', () => {
      activityState.searchQuery = search.value.trim().toLowerCase();
      renderActivityPage();
    });
  }

  const category = document.getElementById('category-filter');
  if (category) {
    category.addEventListener('change', () => {
      activityState.categoryFilter = category.value;
      renderActivityPage();
    });
  }

  const range = document.getElementById('range-filter');
  if (range) {
    range.addEventListener('change', () => {
      activityState.rangeFilter = range.value;
      renderActivityPage();
    });
  }

  document.querySelectorAll('[data-type-filter]').forEach(button => {
    button.addEventListener('click', () => {
      activityState.typeFilter = button.dataset.typeFilter;
      document.querySelectorAll('[data-type-filter]').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.typeFilter === activityState.typeFilter);
      });
      renderActivityPage();
    });
  });

  const csv = document.getElementById('download-csv');
  if (csv) csv.addEventListener('click', downloadCsv);

  const statement = document.getElementById('download-statement');
  if (statement) statement.addEventListener('click', downloadStatementAPI);

  document.querySelectorAll('[data-modal-close]').forEach(button => {
    button.addEventListener('click', closeTransactionModal);
  });

  const modal = document.getElementById('transaction-modal');
  if (modal) {
    modal.addEventListener('click', event => {
      if (event.target === modal) closeTransactionModal();
    });
  }
}

async function downloadStatementAPI() {
  const token = localStorage.getItem('payvexisToken');
  try {
    const res = await fetch('/api/transactions/statement', { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `Payvexis_Statement_${activityState.currentUser.accountMask}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch(err) {
    alert('Failed to download statement.');
  }
}

function renderActivityPage() {
  activityState.filtered = getFilteredTransactions();
  renderSummary();
  renderFeed();
  renderCategoryInsights();
  renderCashFlow();
}

function getCurrentUser() { return activityState.currentUser; }
function readTransactions() { return activityState.transactions; }

function normalizeTransaction(transaction, index) {
  const amount = Number(transaction.amount) || 0;
  const type = transaction.type === 'income' || amount > 0 ? 'income' : 'spend';
  const dateValue = getTransactionDate(transaction);
  return {
    id: transaction.id || `txn-${index}-${Math.abs(amount)}-${String(transaction.merchant || 'item').slice(0, 8)}`,
    merchant: cleanText(transaction.merchant || (type === 'income' ? 'Deposit' : 'Payment'), 80),
    category: cleanText(transaction.category || (type === 'income' ? 'Income' : 'General'), 40),
    amount,
    type,
    account: cleanText(transaction.account || activityState.currentUser.accountLabel || 'Account', 60),
    date: cleanText(transaction.date || formatDisplayDate(dateValue), 40),
    createdAt: dateValue ? dateValue.toISOString() : '',
    reference: transaction.reference || makeReference(index),
    status: transaction.status || 'Completed',
    index,
  };
}

function getFilteredTransactions() {
  const now = new Date();
  return activityState.transactions.filter(transaction => {
    const matchesType = activityState.typeFilter === 'all' || transaction.type === activityState.typeFilter;
    const matchesCategory = activityState.categoryFilter === 'all' || transaction.category === activityState.categoryFilter;
    const haystack = `${transaction.merchant} ${transaction.category} ${transaction.account} ${transaction.reference}`.toLowerCase();
    const matchesSearch = haystack.includes(activityState.searchQuery);
    const transactionDate = transaction.createdAt ? new Date(transaction.createdAt) : null;
    const matchesRange = activityState.rangeFilter === 'all'
      || !transactionDate
      || Number.isNaN(transactionDate.getTime())
      || daysBetween(transactionDate, now) <= Number(activityState.rangeFilter);

    return matchesType && matchesCategory && matchesSearch && matchesRange;
  });
}

function renderSummary() {
  const income = activityState.filtered
    .filter(item => item.type === 'income')
    .reduce((sum, item) => sum + item.amount, 0);
  const spend = activityState.filtered
    .filter(item => item.type === 'spend')
    .reduce((sum, item) => sum + Math.abs(item.amount), 0);

  setText('summary-income', formatMoney(income));
  setText('summary-spend', formatMoney(spend));
  setText('summary-net', formatMoney(income - spend));
  setText('summary-count', String(activityState.filtered.length));
}

function renderFeed() {
  const feed = document.getElementById('activity-feed');
  if (!feed) return;

  if (activityState.filtered.length === 0) {
    feed.innerHTML = '<div class="empty-activity">No transactions match your current filters.</div>';
    return;
  }

  feed.innerHTML = activityState.filtered.map(transaction => {
    const isIncome = transaction.type === 'income';
    return `
      <button class="activity-row-card" type="button" data-transaction-id="${escapeHtml(transaction.id)}">
        <span class="activity-row-icon ${isIncome ? '' : 'is-spend'}">
          ${isIncome ? incomeIcon() : spendIcon()}
        </span>
        <span class="min-w-0">
          <span class="activity-row-title block truncate">${escapeHtml(transaction.merchant)}</span>
          <span class="activity-row-meta block">${escapeHtml(transaction.category)} - ${escapeHtml(transaction.date)} - ${escapeHtml(transaction.account)}</span>
        </span>
        <span class="activity-row-amount ${isIncome ? 'is-income' : 'is-spend'}">${formatSignedMoney(transaction.amount)}</span>
      </button>
    `;
  }).join('');

  feed.querySelectorAll('[data-transaction-id]').forEach(button => {
    button.addEventListener('click', () => openTransactionModal(button.dataset.transactionId));
  });
}

function renderCategoryInsights() {
  const list = document.getElementById('category-insights');
  if (!list) return;

  const spendByCategory = new Map();
  activityState.filtered
    .filter(item => item.type === 'spend')
    .forEach(item => {
      spendByCategory.set(item.category, (spendByCategory.get(item.category) || 0) + Math.abs(item.amount));
    });

  const rows = [...spendByCategory.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (rows.length === 0) {
    list.innerHTML = '<div class="empty-activity">No spending categories to show yet.</div>';
    return;
  }

  const max = Math.max(...rows.map(row => row[1]), 1);
  list.innerHTML = rows.map(([category, amount]) => {
    const width = Math.max(Math.round((amount / max) * 100), 4);
    return `
      <div class="insight-row">
        <div class="insight-row-top">
          <span>${escapeHtml(category)}</span>
          <strong>${formatMoney(amount)}</strong>
        </div>
        <div class="insight-track">
          <div class="insight-fill" style="width:${width}%"></div>
        </div>
      </div>
    `;
  }).join('');
}

function renderCashFlow() {
  const incomes = activityState.filtered.filter(item => item.type === 'income');
  const spends = activityState.filtered.filter(item => item.type === 'spend');
  const amounts = activityState.filtered.map(item => Math.abs(item.amount));
  const largestCredit = incomes.length ? Math.max(...incomes.map(item => item.amount)) : 0;
  const largestDebit = spends.length ? Math.max(...spends.map(item => Math.abs(item.amount))) : 0;
  const average = amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) / amounts.length : 0;

  setText('largest-credit', formatMoney(largestCredit));
  setText('largest-debit', formatMoney(largestDebit));
  setText('average-transaction', formatMoney(average));
}

function populateCategoryFilter() {
  const category = document.getElementById('category-filter');
  if (!category) return;

  const categories = [...new Set(activityState.transactions.map(item => item.category))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  category.innerHTML = [
    '<option value="all">All categories</option>',
    ...categories.map(item => `<option value="${escapeHtml(item)}">${escapeHtml(item)}</option>`),
  ].join('');
}

function openTransactionModal(id) {
  const transaction = activityState.transactions.find(item => item.id === id);
  const modal = document.getElementById('transaction-modal');
  if (!transaction || !modal) return;

  setText('transaction-modal-category', transaction.category);
  setText('transaction-modal-title', transaction.merchant);
  setText('transaction-modal-amount', formatSignedMoney(transaction.amount));
  const lines = document.getElementById('transaction-detail-lines');
  if (lines) {
    lines.innerHTML = [
      ['Status', transaction.status],
      ['Date', transaction.date],
      ['Account', transaction.account],
      ['Type', transaction.type === 'income' ? 'Income' : 'Spend'],
      ['Reference', transaction.reference],
    ].map(([label, value]) => `
      <div class="detail-line">
        <span>${escapeHtml(label)}</span>
        <span>${escapeHtml(value)}</span>
      </div>
    `).join('');
  }

  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeTransactionModal() {
  const modal = document.getElementById('transaction-modal');
  if (!modal) return;

  modal.classList.add('hidden');
  document.body.style.overflow = '';
}

function downloadCsv() {
  const rows = activityState.filtered.length > 0 ? activityState.filtered : activityState.transactions;
  const header = ['Date', 'Merchant', 'Category', 'Type', 'Amount', 'Account', 'Status', 'Reference'];
  const csv = [
    header.join(','),
    ...rows.map(item => [
      item.date,
      item.merchant,
      item.category,
      item.type,
      item.amount,
      item.account,
      item.status,
      item.reference,
    ].map(csvCell).join(',')),
  ].join('\n');

  downloadText(`payvexis-activity-${getAccountMask(activityState.currentUser)}.csv`, csv, 'text/csv');
}

function downloadStatement() {
  const rows = activityState.filtered.length > 0 ? activityState.filtered : activityState.transactions;
  const income = rows.filter(item => item.type === 'income').reduce((sum, item) => sum + item.amount, 0);
  const spend = rows.filter(item => item.type === 'spend').reduce((sum, item) => sum + Math.abs(item.amount), 0);
  const statementRows = rows.length > 0
    ? rows.map(item => `${item.date} | ${item.category} | ${item.merchant} | ${formatSignedMoney(item.amount)} | ${item.account} | ${item.reference}`)
    : ['No transactions available.'];

  const text = [
    'Payvexis Activity Statement',
    `Generated: ${new Date().toLocaleString('en-GB')}`,
    `Customer: ${formatHolderName(activityState.currentUser)}`,
    `Email: ${activityState.currentUser.email}`,
    `Account: ${activityState.currentUser.accountLabel || 'Account'} ending ${getAccountMask(activityState.currentUser)}`,
    `Income: ${formatMoney(income)}`,
    `Spend: ${formatMoney(spend)}`,
    `Net movement: ${formatMoney(income - spend)}`,
    '',
    'Transactions',
    ...statementRows,
    '',
  ].join('\n');

  downloadText(`payvexis-statement-${getAccountMask(activityState.currentUser)}.txt`, text, 'text/plain');
}

function downloadText(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function getTransactionDate(transaction) {
  if (transaction.createdAt) {
    const created = new Date(transaction.createdAt);
    if (!Number.isNaN(created.getTime())) return created;
  }
  return new Date();
}

function daysBetween(date, now) {
  return Math.floor((now.getTime() - date.getTime()) / 86400000);
}

function formatDisplayDate(date) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function makeReference(index) {
  const seed = `${Date.now()}${index}`.slice(-8);
  return `PX-${seed}`;
}

function getAccountMask(user) {
  const accountNumber = String(user?.accountNumber || '');
  if (/^\d{10}$/.test(accountNumber)) return accountNumber.slice(-4);
  return String(user?.accountMask || '0000').slice(-4);
}

function formatHolderName(user) {
  const name = `${user?.firstName || ''} ${user?.lastName || ''}`.trim();
  return name || 'Payvexis Member';
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(Number(value) || 0);
}

function formatSignedMoney(value) {
  const amount = Number(value) || 0;
  const formatted = formatMoney(Math.abs(amount));
  return amount >= 0 ? `+${formatted}` : `-${formatted}`;
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replaceAll('"', '""')}"`;
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

function incomeIcon() {
  return '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 19V5m0 0l-6 6m6-6l6 6" /></svg>';
}

function spendIcon() {
  return '<svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14m0 0l6-6m-6 6l-6-6" /></svg>';
}
