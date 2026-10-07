(function () {
  const message = document.getElementById('recovery-message');
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  window.history.replaceState(null, '', window.location.pathname);
  const requestForm = document.getElementById('recovery-request');
  const completeForm = document.getElementById('recovery-complete');
  if (token) {
    requestForm.classList.add('hidden');
    completeForm.classList.remove('hidden');
  }
  async function submit(route, payload) {
    const response = await fetch(route, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Request failed.');
    return result;
  }
  requestForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = requestForm.querySelector('button');
    button.disabled = true;
    try {
      const result = await submit('/api/auth/password-reset/request', {
        email: document.getElementById('recovery-email').value.trim()
      });
      message.textContent = result.message;
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  completeForm.addEventListener('submit', async event => {
    event.preventDefault();
    const button = completeForm.querySelector('button');
    button.disabled = true;
    try {
      await submit('/api/auth/password-reset/complete', {
        token, password: document.getElementById('recovery-password').value
      });
      completeForm.classList.add('hidden');
      message.textContent = 'Password updated. Please sign in again.';
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
})();
