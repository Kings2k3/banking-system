(async function () {
  const message = document.getElementById('verify-message');
  const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
  window.history.replaceState(null, '', window.location.pathname);
  if (!token) {
    message.textContent = 'This verification link is missing its code.';
    return;
  }
  try {
    const response = await fetch('/api/auth/verify-email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const result = await response.json();
    message.textContent = response.ok ? 'Your email is verified.' :
      (result.error || 'This verification link is invalid or expired.');
  } catch (error) {
    message.textContent = 'Could not verify your email. Please try again.';
  }
})();
