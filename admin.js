// --- Dev API Redirect ---
(function() {
  const isLocalDev = window.location.hostname === 'localhost' ||
                      window.location.hostname === '127.0.0.1' ||
                      window.location.protocol === 'file:';
  const isWrongPort = window.location.port !== '3000';
  if (isLocalDev && isWrongPort) {
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
      if (typeof input === 'string' && input.startsWith('/api')) {
        input = 'http://localhost:3000' + input;
      }
      return originalFetch(input, init);
    };
  }
})();

// --- Admin Panel Logic ---

// 1. Auth Check
const token = localStorage.getItem('payvexisAdminToken') || localStorage.getItem('payvexisToken');
if (!token) {
  window.location.href = 'login.html';
}

// Global State
const state = {
  users: { page: 1, limit: 20, total: 0, search: '', status: 'all', sort: 'created_at_desc' },
  audit: { page: 1, limit: 20, total: 0 },
  operations: { page: 1, limit: 20, total: 0, type: 'all', status: 'all' },
  me: null,
  activeCustomerId: null,
  adjustmentRequest: null,
  adjustments: []
};

// Formatting Helper
const formatMoney = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);
const formatDate = (str) => new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

// API Helper
async function apiCall(endpoint, options = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...options.headers
  };

  const res = await fetch(`/api/admin${endpoint}`, { ...options, headers });

  if (res.status === 401) {
    localStorage.removeItem('payvexisToken');
    localStorage.removeItem('payvexisAdminToken');
    window.location.href = 'login.html';
    return null;
  }

  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'API Error');
  return data;
}

// --- Initialization ---
document.addEventListener('DOMContentLoaded', () => {
  setupMobileSidebar();
  setupTabs();
  setupModals();
  setupUserFilters();
  setupUserTableDelegation();
  setupAdjustForm();
  setupUserDetailDelegation();
  setupAdjustmentQueue();
  setupOperationsQueue();
  setupStaffControls();
  loadAdminAccess();
  document.getElementById('refresh-ledger')?.addEventListener('click', loadLedger);

});

async function loadAdminAccess() {
  try {
    state.me = await apiCall('/me');
    if (!state.me) return;
    const allowed = permission => state.me.permissions.includes(permission);
    document.querySelectorAll('.admin-tab').forEach(tab => {
      tab.hidden = !allowed(tab.dataset.permission) ||
        (!state.me.controlsReady && ['adjustments-panel', 'staff-panel'].includes(tab.dataset.target)) ||
        (!state.me.workspaceReady && tab.dataset.target === 'operations-panel');
      tab.style.display = tab.hidden ? 'none' : '';
    });
    document.querySelectorAll('.admin-tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(panel => panel.classList.add('hidden'));
    document.querySelector('.admin-tab:not([hidden])')?.click();
    if (allowed('stats.read')) loadStats();
  } catch (error) {
    console.error('Failed to load staff access:', error);
  }
}

// --- UI Setup ---
function setupMobileSidebar() {
  const sidebar = document.getElementById('admin-sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  const toggle = document.getElementById('sidebar-toggle');
  const closeBtn = document.getElementById('sidebar-close');

  if (toggle) {
    toggle.addEventListener('click', () => {
      sidebar.classList.add('sidebar-open');
      overlay.classList.add('show');
    });
  }

  const closeSidebar = () => {
    sidebar.classList.remove('sidebar-open');
    overlay.classList.remove('show');
  };

  if (closeBtn) {
    closeBtn.addEventListener('click', closeSidebar);
  }

  if (overlay) {
    overlay.addEventListener('click', closeSidebar);
  }

  // Close sidebar when clicking menu links on mobile
  document.querySelectorAll('.admin-sidebar a').forEach(link => {
    link.addEventListener('click', closeSidebar);
  });
}
function setupTabs() {
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));

      const currentTab = e.currentTarget;
      currentTab.classList.add('active');
      const targetPanel = document.getElementById(currentTab.dataset.target);
      if (targetPanel) {
        targetPanel.classList.remove('hidden');
      }

      if (currentTab.dataset.target === 'audit-panel') loadAuditLog();
      if (currentTab.dataset.target === 'ledger-panel') loadLedger();
      if (currentTab.dataset.target === 'adjustments-panel') loadAdjustments();
      if (currentTab.dataset.target === 'operations-panel') loadOperations();
      if (currentTab.dataset.target === 'staff-panel') loadStaff();
      if (currentTab.dataset.target === 'users-panel') loadUsers();
    });
  });
}

function setupModals() {
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-modal').forEach(m => m.classList.remove('show'));
    });
  });
}

function setupUserFilters() {
  const sInput = document.getElementById('user-search');
  const sStatus = document.getElementById('user-status-filter');
  const sSort = document.getElementById('user-sort');

  let debounceTimer;
  sInput.addEventListener('input', (e) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      state.users.search = e.target.value;
      state.users.page = 1;
      loadUsers();
    }, 400);
  });

  sStatus.addEventListener('change', (e) => {
    state.users.status = e.target.value;
    state.users.page = 1;
    loadUsers();
  });

  sSort.addEventListener('change', (e) => {
    state.users.sort = e.target.value;
    state.users.page = 1;
    loadUsers();
  });

  // Pagination
  document.getElementById('user-prev-page').addEventListener('click', () => {
    if (state.users.page > 1) { state.users.page--; loadUsers(); }
  });
  document.getElementById('user-next-page').addEventListener('click', () => {
    const maxPage = Math.ceil(state.users.total / state.users.limit);
    if (state.users.page < maxPage) { state.users.page++; loadUsers(); }
  });
}

// --- Event Delegation for User Table Actions ---
// Instead of inline onclick attributes (blocked by CSP), we use data-* attributes
// and a single delegated click listener on the table body.
function setupUserTableDelegation() {
  const tbody = document.getElementById('user-table-body');
  tbody.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const userId = btn.dataset.id;
    const userEmail = btn.dataset.email;

    switch (action) {
      case 'view':
        viewUser(userId);
        break;
      case 'adjust':
        openAdjustModal(userId, btn.dataset.name);
        break;
      case 'toggle-suspend':
        toggleSuspend(userId);
        break;
    }
  });
}

// --- Event Delegation for User Detail Modal (card freeze buttons) ---
function setupUserDetailDelegation() {
  const content = document.getElementById('user-detail-content');
  content.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'toggle-card-freeze') {
      toggleCardFreeze(btn.dataset.cardId, btn.dataset.userId);
    } else if (btn.dataset.action === 'revoke-customer-sessions') {
      const id = state.activeCustomerId;
      if (!id || !window.confirm('Sign out all sessions for this customer?')) return;
      try {
        const result = await apiCall(`/users/${id}/sessions/revoke`, { method: 'POST' });
        alert(`${result.revoked} sessions revoked.`);
        loadCustomerWorkspace(id);
      } catch (error) { alert(error.message); }
    }
  });
  content.addEventListener('submit', async (e) => {
    const form = e.target;
    const id = state.activeCustomerId;
    if (!id || (!form.matches('[data-workspace-note]') &&
        !form.matches('[data-workspace-restriction]'))) return;
    e.preventDefault();
    try {
      if (form.matches('[data-workspace-note]')) {
        const body = form.querySelector('textarea[name="body"]').value.trim();
        await apiCall(`/users/${id}/notes`, { method: 'POST', body: JSON.stringify({ body }) });
      } else {
        const accountId = form.dataset.accountId;
        const payload = {
          debitBlocked: form.querySelector('[name="debitBlocked"]').checked,
          creditBlocked: form.querySelector('[name="creditBlocked"]').checked,
          reason: form.querySelector('[name="reason"]').value.trim()
        };
        await apiCall(`/accounts/${accountId}/restrictions`, {
          method: 'PATCH', body: JSON.stringify(payload)
        });
      }
      loadCustomerWorkspace(id);
    } catch (error) { alert(error.message); }
  });
}

// --- Adjust Form Submit (via addEventListener, CSP-safe) ---
function setupAdjustForm() {
  document.getElementById('adjust-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('adjust-user-id').value;
    const payload = {
      userId: Number(id),
      type: document.getElementById('adjust-type').value,
      amount: document.getElementById('adjust-amount').value.trim(),
      reason: document.getElementById('adjust-reason').value,
      senderName: document.getElementById('adjust-sender').value
    };
    const body = JSON.stringify(payload);
    if (!state.adjustmentRequest || state.adjustmentRequest.body !== body) {
      state.adjustmentRequest = { body, key: crypto.randomUUID() };
    }

    try {
      const result = await apiCall('/adjustments', {
        method: 'POST',
        headers: { 'Idempotency-Key': state.adjustmentRequest.key },
        body
      });
      state.adjustmentRequest = null;
      document.getElementById('adjust-modal').classList.remove('show');
      alert(`Proposal #${result.adjustment.id} is waiting for a different staff member to review it. No balance changed yet.`);
      loadAdjustments();
    } catch (err) {
      alert(err.message);
    }
  });
}

// --- Data Loading ---
async function loadStats() {
  try {
    const stats = await apiCall('/stats');
    document.getElementById('stat-users').textContent = stats.totalUsers;
    document.getElementById('stat-balance').textContent = formatMoney(stats.totalBalance);
    document.getElementById('stat-txs').textContent = stats.transactionCount;
    document.getElementById('stat-suspended').textContent = stats.suspendedCount;
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

async function loadUsers() {
  const tbody = document.getElementById('user-table-body');
  try {
    const { search, status, sort, page, limit } = state.users;
    const qs = new URLSearchParams({ search, status, sort, page, limit }).toString();
    const data = await apiCall(`/users?${qs}`);

    state.users.total = data.total;
    updatePagination('user', data.page, data.limit, data.total);

    tbody.innerHTML = '';
    if (data.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center py-4 text-slate-400">No users found.</td></tr>';
      return;
    }

    data.users.forEach(u => {
      const statusBadge = u.suspended
        ? '<span class="status-badge suspended">Suspended</span>'
        : '<span class="status-badge active">Active</span>';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>
          <div class="font-bold">${escapeHtml(u.first_name)} ${escapeHtml(u.last_name)}</div>
          <div class="text-xs text-slate-400">${escapeHtml(u.email)}</div>
        </td>
        <td class="font-mono text-sm">${escapeHtml(u.account_number)}</td>
        <td class="font-bold">${formatMoney(u.balance)}</td>
        <td>${statusBadge}</td>
        <td class="text-sm">${formatDate(u.created_at)}</td>
        <td class="text-right">
          <button data-action="view" data-id="${u.id}" class="action-btn view mr-2">View</button>
          ${data.adjustmentsEnabled ? `<button data-action="adjust" data-id="${u.id}" data-name="${escapeHtml(`${u.first_name} ${u.last_name}`)}" class="action-btn adjust mr-2">Propose adjustment</button>` : ''}
          ${state.me?.permissions.includes('users.suspend') ? `<button data-action="toggle-suspend" data-id="${u.id}" class="action-btn ${u.suspended ? 'unsuspend' : 'suspend'} mr-2">${u.suspended ? 'Unsuspend' : 'Suspend'}</button>` : ''}
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-red-400">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadAuditLog() {
  const tbody = document.getElementById('audit-table-body');
  try {
    const { page, limit } = state.audit;
    const data = await apiCall(`/audit?page=${page}&limit=${limit}`);

    state.audit.total = data.total;
    updatePagination('audit', data.page, data.limit, data.total);

    tbody.innerHTML = '';
    if (data.logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-slate-400">No logs found.</td></tr>';
      return;
    }

    data.logs.forEach(log => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="text-sm">${new Date(log.created_at).toLocaleString()}</td>
        <td class="text-sm">${escapeHtml(log.admin_email)}</td>
        <td class="text-sm font-semibold text-amber-400">${escapeHtml(log.action)}</td>
        <td class="text-sm">${escapeHtml(log.details)}</td>
        <td class="text-xs text-slate-400 font-mono">${escapeHtml(log.ip_address)}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-red-400">Error: ${escapeHtml(err.message)}</td></tr>`;
  }
}

async function loadLedger() {
  const tbody = document.getElementById('ledger-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" class="text-slate-400">Loading journals...</td></tr>';
  try {
    const data = await apiCall('/ledger/journals?limit=50');
    tbody.innerHTML = '';
    if (data.journals.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-slate-400">No posted journals.</td></tr>';
      return;
    }
    for (const journal of data.journals) {
      const rows = journal.postings.map(posting => {
        const signed = `${posting.amountMinor < 0 ? '-' : '+'}${formatMoney(Math.abs(posting.amountMinor) / 100)}`;
        const account = posting.kind === 'customer'
          ? `User ${posting.userId}, account ****${posting.accountMask}` : 'Opening clearing';
        return `<div>${escapeHtml(account)}: ${escapeHtml(signed)}</div>`;
      }).join('');
      const row = document.createElement('tr');
      row.innerHTML = `
        <td class="font-mono text-xs">${escapeHtml(journal.reference)}</td>
        <td>${escapeHtml(journal.kind.replaceAll('_', ' '))}</td>
        <td class="text-xs">${rows}</td>
        <td class="text-sm">${escapeHtml(journal.createdAt)}</td>
      `;
      tbody.appendChild(row);
    }
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-red-400">${escapeHtml(error.message)}</td></tr>`;
  }
}

function setupAdjustmentQueue() {
  document.getElementById('adjustment-status-filter')?.addEventListener('change', loadAdjustments);
  document.getElementById('adjustments-table-body')?.addEventListener('click', async event => {
    const button = event.target.closest('button[data-adjustment-decision]');
    if (!button) return;
    const proposal = state.adjustments.find(item => item.id === Number(button.dataset.id));
    if (!proposal) return;
    const decision = button.dataset.adjustmentDecision;
    let note;
    if (decision === 'approve') {
      if (!window.confirm(`Approve ${proposal.direction} of ${formatMoney(proposal.amountMinor / 100)} for ${proposal.customerEmail}?`)) return;
      note = window.prompt('Approval note (optional)', 'Evidence reviewed');
    } else {
      note = window.prompt('Reason for rejection (at least 5 characters)');
    }
    if (note === null) return;
    button.disabled = true;
    try {
      await apiCall(`/adjustments/${proposal.id}/${decision}`, {
        method: 'POST', body: JSON.stringify({ note })
      });
      await loadAdjustments();
      loadUsers();
      loadStats();
      loadLedger();
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  });
}

async function loadAdjustments() {
  const tbody = document.getElementById('adjustments-table-body');
  if (!tbody || !state.me?.permissions.includes('adjustments.read')) return;
  const filter = document.getElementById('adjustment-status-filter').value;
  tbody.innerHTML = '<tr><td colspan="6" class="text-slate-400">Loading proposals...</td></tr>';
  try {
    const data = await apiCall(`/adjustments?status=${encodeURIComponent(filter)}&limit=50`);
    state.adjustments = data.adjustments;
    tbody.innerHTML = '';
    if (!data.adjustments.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-slate-400">No proposals in this view.</td></tr>';
      return;
    }
    for (const item of data.adjustments) {
      const mayDecide = state.me.demoAdjustmentsEnabled && item.status === 'pending' && item.proposedBy !== state.me.userId &&
        state.me.permissions.includes('adjustments.approve');
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${escapeHtml(item.customerEmail)}<div class="text-xs text-slate-500">#${item.userId}</div></td>
        <td class="font-bold">${escapeHtml(item.direction)} ${formatMoney(item.amountMinor / 100)}</td>
        <td class="text-sm max-w-xs">${escapeHtml(item.reason)}</td>
        <td class="text-sm">${escapeHtml(item.proposerEmail)}</td>
        <td>${escapeHtml(item.status)}${item.journalReference ? `<div class="text-xs font-mono">${escapeHtml(item.journalReference)}</div>` : ''}</td>
        <td>${mayDecide ? `<button class="action-btn adjust mr-2" data-adjustment-decision="approve" data-id="${item.id}">Approve</button><button class="action-btn delete" data-adjustment-decision="reject" data-id="${item.id}">Reject</button>` : '<span class="text-xs text-slate-500">—</span>'}</td>
      `;
      tbody.appendChild(row);
    }
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-red-400">${escapeHtml(error.message)}</td></tr>`;
  }
}

function setupStaffControls() {
  document.getElementById('staff-invite-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const message = document.getElementById('staff-invite-message');
    const output = document.getElementById('staff-invite-code-wrap');
    output.classList.add('hidden');
    try {
      const result = await apiCall('/staff/invitations', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('staff-invite-email').value,
          role: document.getElementById('staff-invite-role').value
        })
      });
      document.getElementById('staff-invite-code').value = result.invitationCode;
      output.classList.remove('hidden');
      message.textContent = 'Invitation created. Copy the code now; it is shown only once.';
      loadStaff();
    } catch (error) {
      message.textContent = error.message;
    }
  });

  document.getElementById('staff-table-body')?.addEventListener('click', async event => {
    const button = event.target.closest('button[data-staff-action]');
    if (!button) return;
    const id = Number(button.dataset.id);
    const action = button.dataset.staffAction;
    const row = button.closest('tr');
    button.disabled = true;
    try {
      if (action === 'role') {
        const role = row.querySelector('select[data-staff-role]').value;
        await apiCall(`/staff/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
      } else {
        const active = action === 'activate';
        if (!active && !window.confirm('Deactivate this staff member and revoke their sessions?')) return;
        await apiCall(`/staff/${id}/active`, { method: 'POST', body: JSON.stringify({ active }) });
      }
      await loadStaff();
    } catch (error) {
      alert(error.message);
    } finally {
      button.disabled = false;
    }
  });
}

async function loadStaff() {
  const tbody = document.getElementById('staff-table-body');
  if (!tbody || !state.me?.permissions.includes('staff.manage')) return;
  tbody.innerHTML = '<tr><td colspan="4" class="text-slate-400">Loading staff...</td></tr>';
  try {
    const data = await apiCall('/staff');
    const roles = ['finance_operator', 'finance_approver', 'support', 'auditor'];
    tbody.innerHTML = '';
    for (const person of data.staff) {
      const protectedOwner = person.role === 'owner';
      const roleControl = protectedOwner ? 'Owner' :
        `<select data-staff-role class="admin-input px-2 py-1 rounded text-sm">${roles.map(role =>
          `<option value="${role}" ${role === person.role ? 'selected' : ''}>${role.replaceAll('_', ' ')}</option>`).join('')}</select>`;
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${escapeHtml(`${person.firstName} ${person.lastName}`)}<div class="text-xs text-slate-400">${escapeHtml(person.email)}</div></td>
        <td>${roleControl}</td>
        <td>${person.active ? 'Active' : 'Inactive'}</td>
        <td>${protectedOwner ? '—' : `<button class="action-btn adjust mr-2" data-staff-action="role" data-id="${person.id}">Save role</button><button class="action-btn ${person.active ? 'delete' : 'view'}" data-staff-action="${person.active ? 'deactivate' : 'activate'}" data-id="${person.id}">${person.active ? 'Deactivate' : 'Activate'}</button>`}</td>
      `;
      tbody.appendChild(row);
    }
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-red-400">${escapeHtml(error.message)}</td></tr>`;
  }
}

function updatePagination(prefix, page, limit, total) {
  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);

  const infoEl = document.getElementById(`${prefix}-page-info`);
  if (infoEl) infoEl.textContent = total === 0 ? 'Showing 0-0 of 0' : `Showing ${start}-${end} of ${total}`;

  const prevBtn = document.getElementById(`${prefix}-prev-page`);
  if (prevBtn) prevBtn.disabled = page === 1;

  const nextBtn = document.getElementById(`${prefix}-next-page`);
  if (nextBtn) nextBtn.disabled = end >= total;
}

// --- Admin Actions ---
async function viewUser(id) {
  const modal = document.getElementById('user-detail-modal');
  const content = document.getElementById('user-detail-content');
  modal.classList.add('show');
  state.activeCustomerId = String(id);
  content.innerHTML = '<p>Loading...</p>';

  try {
    const data = await apiCall(`/users/${id}`);
    const u = data.user;

    let html = `
      <div class="grid grid-cols-2 gap-4 mb-6">
        <div>
          <p class="text-xs text-slate-400">Name</p>
          <p class="font-bold">${escapeHtml(u.first_name)} ${escapeHtml(u.last_name)}</p>
        </div>
        <div>
          <p class="text-xs text-slate-400">Email</p>
          <p class="font-bold">${escapeHtml(u.email)}</p>
        </div>
        <div>
          <p class="text-xs text-slate-400">Primary account</p>
          <p class="font-mono">${escapeHtml(u.account_number)}</p>
        </div>
        <div>
          <p class="text-xs text-slate-400">Primary account balance</p>
          <p class="font-bold text-emerald-400">${formatMoney(u.balance)}</p>
        </div>
      </div>

      <h3 class="font-bold border-b border-white/10 pb-2 mb-3">Cards</h3>
      <div class="space-y-2 mb-6">
    `;

    if (data.cards.length === 0) html += '<p class="text-sm text-slate-400">No cards</p>';
    data.cards.forEach(c => {
      html += `
        <div class="flex justify-between items-center p-2 bg-white/5 rounded">
          <span>${escapeHtml(c.name)} (****${escapeHtml(c.mask)})</span>
          ${state.me?.permissions.includes('cards.freeze') ? `<button data-action="toggle-card-freeze" data-card-id="${c.id}" data-user-id="${u.id}" class="text-xs px-2 py-1 rounded border ${c.frozen ? 'border-emerald-500 text-emerald-500' : 'border-orange-500 text-orange-500'}">${c.frozen ? 'Unfreeze' : 'Freeze'}</button>` : ''}
        </div>
      `;
    });

    html += `</div><h3 class="font-bold border-b border-white/10 pb-2 mb-3">Recent Transactions</h3><div class="space-y-2 max-h-40 overflow-y-auto">`;
    if (data.transactions.length === 0) html += '<p class="text-sm text-slate-400">No transactions</p>';
    data.transactions.forEach(t => {
      const color = t.type === 'income' ? 'text-emerald-400' : 'text-slate-200';
      const sign = t.type === 'income' ? '+' : '-';
      html += `
        <div class="flex justify-between text-sm p-2 bg-white/5 rounded">
          <span>${escapeHtml(t.merchant)} <span class="text-xs text-slate-500 ml-2">${new Date(t.created_at).toLocaleDateString()}</span></span>
          <span class="font-bold ${color}">${sign}${formatMoney(t.amount)}</span>
        </div>
      `;
    });
    html += '</div>';

    content.innerHTML = html + (state.me?.workspaceReady
      ? '<div id="customer-workspace" class="mt-8 border-t border-white/10 pt-6">Loading account workspace...</div>'
      : '');
    if (state.me?.workspaceReady) loadCustomerWorkspace(id);
  } catch (err) {
    content.innerHTML = `<p class="text-red-400">Error: ${escapeHtml(err.message)}</p>`;
  }
}

async function loadCustomerWorkspace(id) {
  const container = document.getElementById('customer-workspace');
  if (!container) return;
  try {
    const data = await apiCall(`/users/${id}/workspace`);
    if (!data || state.activeCustomerId !== String(id)) return;
    const canRestrict = state.me?.permissions.includes('users.restrict');
    const canWriteNotes = state.me?.permissions.includes('users.notes.write');
    const canReadNotes = state.me?.permissions.includes('users.notes.read');
    const canRevokeSessions = state.me?.permissions.includes('users.sessions.revoke');
    const accounts = data.accounts.map(account => `
      <div class="p-3 rounded-lg bg-white/5 mb-3">
        <div class="flex flex-wrap justify-between gap-2">
          <div><strong>${escapeHtml(account.name)}</strong> · ****${escapeHtml(account.mask)}
            <div class="text-xs text-slate-400">${escapeHtml(account.ownershipKind)} · ${escapeHtml(account.memberRole)} · ${escapeHtml(account.status)}</div></div>
          <strong>${formatMoney(account.balanceMinor / 100)}</strong>
        </div>
        <div class="text-xs text-slate-300 mt-2">Members: ${account.members.map(member =>
          `${escapeHtml(member.firstName)} ${escapeHtml(member.lastName)} (${escapeHtml(member.role)}${member.emailVerifiedAt ? ', verified' : ', unverified'})`).join('; ') || 'None'}</div>
        <div class="text-xs text-slate-400 mt-2">Debits: ${account.debitBlocked ? 'blocked' : 'allowed'} · Credits: ${account.creditBlocked ? 'blocked' : 'allowed'}${account.restrictionReason ? ` · ${escapeHtml(account.restrictionReason)}` : ''}</div>
        ${canRestrict ? `<form data-workspace-restriction data-account-id="${account.id}" class="mt-3 space-y-2">
          <div class="flex gap-4 text-sm">
            <label><input type="checkbox" name="debitBlocked" ${account.debitBlocked ? 'checked' : ''}> Block debits</label>
            <label><input type="checkbox" name="creditBlocked" ${account.creditBlocked ? 'checked' : ''}> Block credits</label>
          </div>
          <input class="admin-input w-full px-3 py-2 rounded" name="reason" required minlength="10" maxlength="300" placeholder="Reason for changing restrictions">
          <button class="btn-secondary text-sm px-3 py-2" type="submit">Save restrictions</button>
        </form>` : ''}
      </div>`).join('') || '<p class="text-sm text-slate-400">No active account memberships.</p>';
    const activity = data.recentActivity.map(item => `
      <div class="flex justify-between gap-3 text-sm py-2 border-b border-white/5">
        <span>${escapeHtml(item.merchant)} <span class="text-xs text-slate-500">${escapeHtml(item.reference || '')}</span></span>
        <span>${item.type === 'income' ? '+' : '-'}${formatMoney(item.amount)}</span>
      </div>`).join('') || '<p class="text-sm text-slate-400">No account activity.</p>';
    const events = data.recentAccountEvents.slice(0, 10).map(item => `
      <div class="text-xs text-slate-400 py-1">${escapeHtml(item.type)} · ${escapeHtml(item.details || '')}</div>`).join('') ||
      '<p class="text-sm text-slate-400">No membership or account events.</p>';
    const notes = canReadNotes ? `<section class="mt-6">
      <h3 class="font-bold border-b border-white/10 pb-2 mb-3">Internal notes</h3>
      ${canWriteNotes ? `<form data-workspace-note class="space-y-2 mb-3">
        <textarea class="admin-input w-full px-3 py-2 rounded" name="body" rows="3" required minlength="3" maxlength="2000" placeholder="Internal note"></textarea>
        <button class="btn-secondary text-sm px-3 py-2" type="submit">Add note</button>
      </form>` : ''}
      ${data.notes.map(note => `<div class="p-2 rounded bg-white/5 mb-2 text-sm">
        <p>${escapeHtml(note.body)}</p><p class="text-xs text-slate-400 mt-1">${escapeHtml(note.authorEmail)} · ${escapeHtml(note.createdAt)}</p>
      </div>`).join('') || '<p class="text-sm text-slate-400">No notes yet.</p>'}
    </section>` : '';
    container.innerHTML = `<h3 class="font-bold text-lg mb-3">Customer workspace</h3>
      <section><h4 class="font-semibold mb-2">Accounts and members</h4>${accounts}</section>
      <section class="mt-6"><h4 class="font-semibold mb-2">Sessions</h4>
        <p class="text-sm text-slate-300">${data.sessions.activeCount} active sessions</p>
        ${canRevokeSessions ? '<button class="btn-secondary text-sm px-3 py-2 mt-2" type="button" data-action="revoke-customer-sessions">Sign out all sessions</button>' : ''}
      </section>
      <section class="mt-6"><h4 class="font-semibold mb-2">Account activity</h4>${activity}</section>
      <section class="mt-6"><h4 class="font-semibold mb-2">Account events</h4>${events}</section>
      ${notes}`;
  } catch (error) {
    container.innerHTML = `<p class="text-red-400">Workspace error: ${escapeHtml(error.message)}</p>`;
  }
}

async function toggleSuspend(id) {
  try {
    await apiCall(`/users/${id}/suspend`, { method: 'PUT' });
    loadUsers();
    loadStats();
  } catch (err) {
    alert(err.message);
  }
}

function openAdjustModal(id, name) {
  document.getElementById('adjust-user-id').value = id;
  document.getElementById('adjust-amount').value = '';
  document.getElementById('adjust-sender').value = name || '';
  document.getElementById('adjust-reason').value = '';
  document.getElementById('adjust-modal').classList.add('show');
}

async function toggleCardFreeze(cardId, userId) {
  try {
    await apiCall(`/cards/${cardId}/freeze`, { method: 'PUT' });
    // Refresh the user detail modal to reflect the change
    if (userId) {
      viewUser(userId);
    } else {
      alert('Card freeze state updated. Reopen user details to see change.');
    }
  } catch(err) {
    alert(err.message);
  }
}

function setupOperationsQueue() {
  for (const [id, key] of [['operation-type-filter', 'type'],
    ['operation-status-filter', 'status']]) {
    document.getElementById(id)?.addEventListener('change', event => {
      state.operations[key] = event.target.value;
      state.operations.page = 1;
      loadOperations();
    });
  }
  document.getElementById('operation-prev-page')?.addEventListener('click', () => {
    if (state.operations.page > 1) { state.operations.page--; loadOperations(); }
  });
  document.getElementById('operation-next-page')?.addEventListener('click', () => {
    if (state.operations.page * state.operations.limit < state.operations.total) {
      state.operations.page++; loadOperations();
    }
  });
  document.getElementById('operations-table-body')?.addEventListener('click', event => {
    const button = event.target.closest('button[data-operation-action]');
    if (!button) return;
    if (button.dataset.operationAction === 'customer') viewUser(button.dataset.customerId);
    else loadOperationDetail(button.dataset.type, button.dataset.id);
  });
  document.getElementById('operation-detail-content')?.addEventListener('submit', async event => {
    const form = event.target;
    if (!form.matches('[data-operation-review]')) return;
    event.preventDefault();
    const type = form.dataset.type;
    const id = form.dataset.id;
    const payload = {
      state: form.querySelector('[name="state"]').value,
      note: form.querySelector('[name="note"]').value.trim()
    };
    try {
      await apiCall(`/operations/${type}/${id}/review`, {
        method: 'POST', body: JSON.stringify(payload)
      });
      await loadOperationDetail(type, id);
      loadOperations();
    } catch (error) { alert(error.message); }
  });
}

async function loadOperations() {
  const tbody = document.getElementById('operations-table-body');
  if (!tbody || !state.me?.permissions.includes('operations.read')) return;
  tbody.innerHTML = '<tr><td colspan="6" class="text-slate-400">Loading operations...</td></tr>';
  try {
    const query = new URLSearchParams({ page: state.operations.page,
      limit: state.operations.limit });
    if (state.operations.type !== 'all') query.set('type', state.operations.type);
    if (state.operations.status !== 'all') query.set('status', state.operations.status);
    const data = await apiCall(`/operations?${query}`);
    state.operations.total = data.total;
    updatePagination('operation', data.page, data.limit, data.total);
    tbody.innerHTML = data.operations.map(item => `<tr>
      <td>${escapeHtml(item.customerEmail)}<div class="text-xs text-slate-400">Customer #${item.customerId}</div></td>
      <td>${item.type === 'shared_transfer' ? 'Shared transfer' : 'Adjustment'} #${item.id}</td>
      <td>${item.direction === 'debit' ? '-' : '+'}${formatMoney(item.amountMinor / 100)}</td>
      <td>${escapeHtml(item.financialStatus)}</td>
      <td>${escapeHtml(item.reviewState)}</td>
      <td><button type="button" class="action-btn view mr-2" data-operation-action="detail" data-type="${item.type}" data-id="${item.id}">Review</button>
        <button type="button" class="action-btn view" data-operation-action="customer" data-customer-id="${item.customerId}">Customer</button></td>
    </tr>`).join('') || '<tr><td colspan="6" class="text-slate-400">No matching operations.</td></tr>';
  } catch (error) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-red-400">${escapeHtml(error.message)}</td></tr>`;
  }
}

async function loadOperationDetail(type, id) {
  const modal = document.getElementById('operation-detail-modal');
  const content = document.getElementById('operation-detail-content');
  modal.classList.add('show');
  content.innerHTML = '<p>Loading...</p>';
  try {
    const data = await apiCall(`/operations/${type}/${id}`);
    const item = data.operation;
    const approvals = data.approvals.map(approval => `<li>${escapeHtml(approval.email)} · ${escapeHtml(approval.role)}</li>`).join('') ||
      '<li>No signatures recorded.</li>';
    const events = data.reviewEvents.map(event => `<div class="p-2 bg-white/5 rounded mb-2 text-sm">
      <strong>${escapeHtml(event.state)}</strong> · ${escapeHtml(event.staffEmail)}
      <p>${escapeHtml(event.note)}</p><p class="text-xs text-slate-400">${escapeHtml(event.createdAt)}</p>
    </div>`).join('') || '<p class="text-sm text-slate-400">No investigation notes.</p>';
    const mayReview = state.me?.permissions.includes('operations.review');
    content.innerHTML = `<div class="space-y-2 text-sm mb-5">
      <p><strong>Customer:</strong> ${escapeHtml(item.customerEmail)}</p>
      <p><strong>Type:</strong> ${item.type === 'shared_transfer' ? 'Shared transfer' : 'Adjustment'} #${item.id}</p>
      <p><strong>Amount:</strong> ${formatMoney(item.amountMinor / 100)} · ${escapeHtml(item.direction)}</p>
      <p><strong>Financial status:</strong> ${escapeHtml(item.financialStatus)}</p>
      ${item.expiresAt ? `<p><strong>Signing deadline:</strong> ${escapeHtml(item.expiresAt)}</p>` : ''}
      <p><strong>Review state:</strong> ${escapeHtml(item.reviewState)}</p>
      <p><strong>Ledger reference:</strong> ${escapeHtml(item.reference || 'Pending')}</p>
    </div>
    ${item.type === 'shared_transfer' ? `<h3 class="font-semibold mb-2">Customer signatures</h3><ul class="text-sm mb-5">${approvals}</ul>` : ''}
    <h3 class="font-semibold mb-2">Investigation history</h3>${events}
    ${mayReview ? `<form data-operation-review data-type="${item.type}" data-id="${item.id}" class="space-y-2 mt-5">
      <label class="text-sm block">Review state
        <select name="state" class="admin-input block w-full px-3 py-2 rounded">
          <option value="investigating">Investigating</option><option value="resolved">Resolved</option>
        </select></label>
      <label class="text-sm block">Investigation note
        <textarea name="note" class="admin-input block w-full px-3 py-2 rounded" rows="3" minlength="10" maxlength="1000" required></textarea></label>
      <button class="btn-primary px-4 py-2" type="submit">Save review</button>
      <p class="text-xs text-slate-400">This note does not approve, reject or post the financial operation.</p>
    </form>` : ''}`;
  } catch (error) {
    content.innerHTML = `<p class="text-red-400">${escapeHtml(error.message)}</p>`;
  }
}
