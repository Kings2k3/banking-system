document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('staff-setup-form');
  const message = document.getElementById('staff-setup-message');
  const button = document.getElementById('staff-setup-submit');

  form.addEventListener('submit', async event => {
    event.preventDefault();
    button.disabled = true;
    message.textContent = '';
    try {
      const response = await fetch('/api/auth/accept-staff-invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          invitationCode: document.getElementById('invitation-code').value.trim(),
          firstName: document.getElementById('first-name').value.trim(),
          lastName: document.getElementById('last-name').value.trim(),
          password: document.getElementById('password').value
        })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not accept invitation.');
      message.textContent = 'Staff account created. You can now sign in.';
      form.reset();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
});
