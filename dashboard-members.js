(function () {
  const token = localStorage.getItem('payvexisToken');
  const message = document.getElementById('members-message');
  if (!token) {
    window.location.href = 'login.html';
    return;
  }
  let userId;
  async function api(route, method = 'GET', body) {
    const response = await fetch(route, {
      method, headers: { Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Request failed.');
    return result;
  }
  function element(tag, className, value) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (value !== undefined) item.textContent = value;
    return item;
  }
  async function renderAccounts() {
    const { accounts } = await api('/api/accounts');
    const container = document.getElementById('member-accounts');
    container.replaceChildren();
    for (const account of accounts) {
      const panel = element('article', 'rounded-xl border border-white/10 p-4');
      panel.append(element('h3', 'font-semibold text-lg', `${account.name} · ****${account.mask}`));
      panel.append(element('p', 'text-sm text-slate-400 mt-1',
        `${account.memberRole} · ${account.ownershipKind} · ${account.status}`));
      const { members, signingRule } = await api(`/api/accounts/${account.id}/members`);
      panel.append(element('p', 'text-sm text-slate-400 mt-2',
        `Signing rule: ${signingRule === 'two_signers' ? 'Two distinct members, including an owner' : 'Owner only'}`));
      const list = element('ul', 'text-sm text-slate-300 mt-2 space-y-1');
      members.forEach(member => list.append(element('li', '',
        `${member.firstName} ${member.lastName} · ${member.role} · ${member.email}`)));
      panel.append(list);
      if (account.memberRole === 'owner' && ['joint', 'business'].includes(account.requestedType)) {
        const form = element('form', 'mt-4 flex flex-wrap gap-2');
        const email = element('input', 'dashboard-input flex-1 min-w-48');
        email.type = 'email'; email.required = true; email.placeholder = 'Member email';
        form.append(email);
        let role;
        if (account.requestedType === 'business') {
          role = element('select', 'dashboard-input');
          for (const choice of ['operator', 'viewer', 'owner']) {
            const option = element('option', '', choice); option.value = choice; role.append(option);
          }
          form.append(role);
        }
        const button = element('button', 'btn-secondary', 'Send invitation');
        button.type = 'submit'; form.append(button);
        form.addEventListener('submit', async event => {
          event.preventDefault(); button.disabled = true;
          try {
            await api(`/api/accounts/${account.id}/invitations`, 'POST',
              { email: email.value.trim(), ...(role ? { role: role.value } : {}) });
            message.textContent = `Invitation sent to ${email.value.trim()}.`;
            email.value = '';
          } catch (error) { message.textContent = error.message; }
          finally { button.disabled = false; }
        });
        panel.append(form);
      }
      container.append(panel);
    }
  }
  async function renderRequests() {
    const { requests } = await api('/api/transactions/transfer-requests');
    const container = document.getElementById('transfer-approvals');
    container.replaceChildren();
    if (!requests.length) return container.append(element('p', 'text-slate-400 text-sm', 'No shared transfers yet.'));
    for (const request of requests) {
      const card = element('article', 'rounded-xl border border-white/10 p-4');
      card.append(element('p', 'font-semibold',
        `#${request.id} · $${request.amount.toFixed(2)} to ****${request.recipientMask}`));
      card.append(element('p', 'text-sm text-slate-400 mt-1',
        `${request.status} · ${request.approvals}/${request.requiredApprovals} signatures · funds not reserved`));
      if (request.status === 'pending') {
        const controls = element('div', 'flex gap-2 mt-3');
        if (request.createdBy !== userId) {
          const approve = element('button', 'btn-primary', 'Approve demo transfer');
          approve.type = 'button';
          approve.addEventListener('click', () => decide(request.id, 'approve'));
          controls.append(approve);
        }
        const reject = element('button', 'btn-secondary', 'Reject');
        reject.type = 'button'; reject.addEventListener('click', () => decide(request.id, 'reject'));
        controls.append(reject); card.append(controls);
      }
      container.append(card);
    }
  }
  async function decide(id, action) {
    if (action === 'approve' && !window.confirm('Approve this demo transfer? It will post if this is the required second signature.')) return;
    try {
      const result = await api(`/api/transactions/transfer-requests/${id}/${action}`, 'POST', {});
      message.textContent = result.request.status === 'posted'
        ? `Demo transfer posted: ${result.request.reference}` : `Transfer is ${result.request.status}.`;
      await renderRequests();
    } catch (error) { message.textContent = error.message; }
  }
  document.getElementById('resend-verification').addEventListener('click', async () => {
    try {
      const result = await api('/api/auth/resend-verification', 'POST', {});
      message.textContent = result.message;
    } catch (error) { message.textContent = error.message; }
  });
  (async () => {
    try {
      const me = await api('/api/accounts/me');
      userId = me.user.id;
      if (!me.user.emailVerifiedAt) document.getElementById('email-verification').classList.remove('hidden');
      await renderAccounts();
      await renderRequests();
    } catch (error) { message.textContent = error.message; }
  })();
})();
