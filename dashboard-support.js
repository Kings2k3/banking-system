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

// Token Check
const token = localStorage.getItem('payvexisToken');
if (!token) {
  window.location.href = 'login.html';
}

document.addEventListener('DOMContentLoaded', () => {
  initMobileNav();
  loadTickets();
  setupFormSubmit();
});

// Setup Mobile Navigation Toggle
function initMobileNav() {
  const navToggle = document.getElementById('nav-toggle');
  const navClose = document.getElementById('nav-close');
  const mobileNav = document.getElementById('mobile-nav');

  if (navToggle && mobileNav) {
    navToggle.addEventListener('click', () => {
      mobileNav.classList.add('active');
    });
  }

  if (navClose && mobileNav) {
    navClose.addEventListener('click', () => {
      mobileNav.classList.remove('active');
    });
  }
}

// Load tickets filed by this user
async function loadTickets() {
  const listEl = document.getElementById('ticket-list');
  const countEl = document.getElementById('ticket-count');

  try {
    const response = await fetch('/api/support/tickets', {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        localStorage.removeItem('payvexisToken');
        window.location.href = 'login.html';
        return;
      }
      throw new Error('Failed to load tickets.');
    }

    const { tickets } = await response.json();
    countEl.textContent = `${tickets.length} ticket${tickets.length === 1 ? '' : 's'}`;

    if (tickets.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-8 text-slate-400">
          <p>No complaints filed yet.</p>
          <p class="text-xs text-slate-500 mt-1">If you have any issues, use the form above to let us know.</p>
        </div>
      `;
      return;
    }

    listEl.innerHTML = '';
    tickets.forEach(ticket => {
      const date = new Date(ticket.created_at).toLocaleString();
      const statusClass = ticket.status === 'open' ? 'open' : 'resolved';
      const statusText = ticket.status === 'open' ? 'Open' : 'Resolved';

      const div = document.createElement('div');
      div.className = 'ticket-row';
      div.innerHTML = `
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-2">
          <div class="flex items-center gap-3">
            <span class="ticket-status ${statusClass}">${statusText}</span>
            <h3 class="font-bold text-slate-200">${escapeHTML(ticket.subject)}</h3>
          </div>
          <span class="text-xs text-slate-500 font-medium">${date}</span>
        </div>
        <p class="text-sm text-slate-400 leading-relaxed">${escapeHTML(ticket.message)}</p>
      `;
      listEl.appendChild(div);
    });
  } catch (err) {
    listEl.innerHTML = `<div class="text-center py-8 text-red-400">Error: ${err.message}</div>`;
  }
}

// Handle Form Submission
function setupFormSubmit() {
  const form = document.getElementById('support-form');
  const msgEl = document.getElementById('support-submit-msg');
  const btn = document.getElementById('support-submit-btn');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const subject = document.getElementById('ticket-subject').value;
    const message = document.getElementById('ticket-message').value;

    btn.disabled = true;
    btn.textContent = 'Submitting...';
    msgEl.className = 'hidden';

    try {
      const response = await fetch('/api/support/tickets', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ subject, message })
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to submit complaint.');

      msgEl.textContent = 'Complaint submitted successfully. Our team will review it.';
      msgEl.className = 'text-sm text-emerald-400 mt-2 font-medium';

      form.reset();
      loadTickets(); // Refresh list
    } catch (err) {
      msgEl.textContent = err.message;
      msgEl.className = 'text-sm text-red-400 mt-2 font-medium';
    } finally {
      btn.disabled = false;
      btn.innerHTML = `
        Submit Complaint
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M14 5l7 7m0 0l-7 7m7-7H3" />
        </svg>
      `;
    }
  });
}

function escapeHTML(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
