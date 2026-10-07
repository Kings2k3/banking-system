(function () {
  async function signOut() {
    const tokens = new Set([
      localStorage.getItem('payvexisAdminToken'),
      localStorage.getItem('payvexisToken')
    ].filter(Boolean));
    for (const token of tokens) {
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok && response.status !== 401) {
        throw new Error('Could not sign out. Please try again.');
      }
    }
    localStorage.removeItem('payvexisToken');
    localStorage.removeItem('payvexisAdminToken');
    localStorage.removeItem('payvexisCurrentUser');
    window.location.href = 'index.html';
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-sign-out], #admin-logout').forEach(link => {
      link.addEventListener('click', async event => {
        event.preventDefault();
        if (link.dataset.signingOut === 'true') return;
        link.dataset.signingOut = 'true';
        try {
          await signOut();
        } catch (error) {
          link.dataset.signingOut = 'false';
          window.alert(error.message);
        }
      });
    });
  });
})();
