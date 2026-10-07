(function () {
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  window.history.replaceState(null, '', window.location.pathname);
  const message = document.getElementById('invite-message');
  const button = document.getElementById('accept-invite');
  if (!token) {
    button.disabled = true;
    message.textContent = 'Invitation link is missing its code.';
    return;
  }
  button.addEventListener('click', async () => {
    const session = localStorage.getItem('payvexisToken');
    if (!session) {
      message.textContent = 'Sign in with the invited email, then reopen your invitation link.';
      return;
    }
    button.disabled = true;
    try {
      const response = await fetch('/api/accounts/invitations/accept', {
        method: 'POST', headers: { 'Content-Type': 'application/json',
          Authorization: `Bearer ${session}` },
        body: JSON.stringify({ token })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not accept invitation.');
      message.textContent = 'Invitation accepted. Your account is available in Members & approvals.';
    } catch (error) {
      button.disabled = false;
      message.textContent = error.message;
    }
  });
})();
