// --- Admin Panel Logic ---

// 1. Auth Check
const token = localStorage.getItem('payvexisAdminToken') || localStorage.getItem('payvexisToken');
if (!token) {
  window.location.href = 'login.html';
}

// Global State
const state = {
  users: { page: 1, limit: 20, total: 0, search: '', status: 'all', sort: 'created_at_desc' },
  audit: { page: 1, limit: 20, total: 0 }
};

// Formatting Helper
const formatMoney = (val) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(val || 0);
const formatDate = (str) => new Date(str).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// API Helper
async function apiCall(endpoint, options = {}) {
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    ...options.headers
  };
  
  const res = await fetch(`/api/admin${endpoint}`, { ...options, headers });
  
  if (res.status === 401 || res.status === 403) {
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
  setupTabs();
  setupModals();
  setupUserFilters();
  
  loadStats();
  loadUsers();
  
  document.getElementById('admin-logout').addEventListener('click', () => {
    localStorage.removeItem('payvexisToken');
    localStorage.removeItem('payvexisAdminToken');
    window.location.href = 'index.html';
  });
});

// --- UI Setup ---
function setupTabs() {
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
      
      e.target.classList.add('active');
      document.getElementById(e.target.dataset.target).classList.remove('hidden');
      
      if (e.target.dataset.target === 'audit-panel') loadAuditLog();
    });
  });
}

function setupModals() {
  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.admin-modal').forEach(m => m.classList.add('hidden'));
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
          <div class="font-bold">${u.first_name} ${u.last_name}</div>
          <div class="text-xs text-slate-400">${u.email}</div>
        </td>
        <td class="font-mono text-sm">${u.account_number}</td>
        <td class="font-bold">${formatMoney(u.balance)}</td>
        <td>${statusBadge}</td>
        <td class="text-sm">${formatDate(u.created_at)}</td>
        <td class="text-right">
          <button onclick="viewUser(${u.id})" class="text-xs text-blue-400 hover:text-blue-300 mr-2">View</button>
          <button onclick="openAdjustModal(${u.id})" class="text-xs text-amber-400 hover:text-amber-300 mr-2">Adjust</button>
          <button onclick="toggleSuspend(${u.id})" class="text-xs ${u.suspended ? 'text-emerald-400 hover:text-emerald-300' : 'text-orange-400 hover:text-orange-300'} mr-2">${u.suspended ? 'Unsuspend' : 'Suspend'}</button>
          <button onclick="deleteUser(${u.id}, '${u.email}')" class="text-xs text-red-400 hover:text-red-300">Delete</button>
        </td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-red-400">Error: ${err.message}</td></tr>`;
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
        <td class="text-sm">${log.admin_email}</td>
        <td class="text-sm font-semibold text-amber-400">${log.action}</td>
        <td class="text-sm">${log.details}</td>
        <td class="text-xs text-slate-400 font-mono">${log.ip_address}</td>
      `;
      tbody.appendChild(tr);
    });
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center py-4 text-red-400">Error: ${err.message}</td></tr>`;
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
  modal.classList.remove('hidden');
  content.innerHTML = '<p>Loading...</p>';

  try {
    const data = await apiCall(`/users/${id}`);
    const u = data.user;
    
    let html = `
      <div class="grid grid-cols-2 gap-4 mb-6">
        <div>
          <p class="text-xs text-slate-400">Name</p>
          <p class="font-bold">${u.first_name} ${u.last_name}</p>
        </div>
        <div>
          <p class="text-xs text-slate-400">Email</p>
          <p class="font-bold">${u.email}</p>
        </div>
        <div>
          <p class="text-xs text-slate-400">Account</p>
          <p class="font-mono">${u.account_number}</p>
        </div>
        <div>
          <p class="text-xs text-slate-400">Balance</p>
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
          <span>${c.name} (****${c.mask})</span>
          <button onclick="toggleCardFreeze(${c.id})" class="text-xs px-2 py-1 rounded border ${c.frozen ? 'border-emerald-500 text-emerald-500' : 'border-orange-500 text-orange-500'}">
            ${c.frozen ? 'Unfreeze' : 'Freeze'}
          </button>
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
          <span>${t.merchant} <span class="text-xs text-slate-500 ml-2">${new Date(t.created_at).toLocaleDateString()}</span></span>
          <span class="font-bold ${color}">${sign}${formatMoney(t.amount)}</span>
        </div>
      `;
    });
    html += '</div>';
    
    content.innerHTML = html;
  } catch (err) {
    content.innerHTML = `<p class="text-red-400">Error: ${err.message}</p>`;
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

async function deleteUser(id, email) {
  if (!confirm(`WARNING: Are you sure you want to permanently delete ${email}? This action cannot be undone and will erase all data.`)) return;
  try {
    await apiCall(`/users/${id}`, { method: 'DELETE' });
    loadUsers();
    loadStats();
  } catch (err) {
    alert(err.message);
  }
}

function openAdjustModal(id) {
  document.getElementById('adjust-user-id').value = id;
  document.getElementById('adjust-amount').value = '';
  document.getElementById('adjust-reason').value = '';
  document.getElementById('adjust-modal').classList.remove('hidden');
}

document.getElementById('adjust-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('adjust-user-id').value;
  const payload = {
    type: document.getElementById('adjust-type').value,
    amount: parseFloat(document.getElementById('adjust-amount').value),
    reason: document.getElementById('adjust-reason').value
  };

  try {
    await apiCall(`/users/${id}/adjust`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    document.getElementById('adjust-modal').classList.add('hidden');
    loadUsers();
    loadStats();
  } catch (err) {
    alert(err.message);
  }
});

// Need to attach to window for inline onclick handler from modal
window.toggleCardFreeze = async (cardId) => {
  try {
    await apiCall(`/cards/${cardId}/freeze`, { method: 'PUT' });
    // Re-open/refresh modal data
    const userId = document.getElementById('adjust-user-id').value; // We don't have it easily here without refactor, just close modal for now or instruct refresh
    alert('Card freeze state updated. Reopen user details to see change.');
  } catch(err) {
    alert(err.message);
  }
};
window.viewUser = viewUser;
window.toggleSuspend = toggleSuspend;
window.deleteUser = deleteUser;
window.openAdjustModal = openAdjustModal;
