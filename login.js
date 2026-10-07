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

document.addEventListener('DOMContentLoaded', () => {
  initMobileNav();
  initReveal();
  initNavbarScroll();
  initPasswordToggle();
  initLoginForm();
});

function initMobileNav() {
  const toggle = document.getElementById('nav-toggle');
  const mobileNav = document.getElementById('mobile-nav');
  const closeBtn = document.getElementById('nav-close');
  if (!toggle || !mobileNav) return;

  toggle.addEventListener('click', () => {
    mobileNav.classList.add('open');
    document.body.style.overflow = 'hidden';
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      mobileNav.classList.remove('open');
      document.body.style.overflow = '';
    });
  }

  mobileNav.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      mobileNav.classList.remove('open');
      document.body.style.overflow = '';
    });
  });
}

function initReveal() {
  const elements = document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -60px 0px' });

  elements.forEach(el => observer.observe(el));
}

function initNavbarScroll() {
  const nav = document.getElementById('navbar');
  if (!nav) return;
  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        nav.classList.toggle('scrolled', window.scrollY > 50);
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });
}

function initPasswordToggle() {
  const passwordInput = document.getElementById('login-password');
  const toggleBtn = document.getElementById('toggle-password');
  const eyeOpen = document.getElementById('eye-open');
  const eyeClosed = document.getElementById('eye-closed');
  if (!passwordInput || !toggleBtn || !eyeOpen || !eyeClosed) return;

  toggleBtn.addEventListener('click', () => {
    const visible = passwordInput.type === 'text';
    passwordInput.type = visible ? 'password' : 'text';
    eyeOpen.classList.toggle('hidden', !visible);
    eyeClosed.classList.toggle('hidden', visible);
  });
}

function initLoginForm() {
  const form = document.getElementById('login-form');
  const mfaForm = document.getElementById('staff-mfa-form');
  const submitBtn = document.getElementById('login-submit');
  const submitText = document.getElementById('login-submit-text');
  const success = document.getElementById('login-success');
  if (!form || !mfaForm || !submitBtn || !submitText || !success) return;
  let challengeToken = null;
  let mfaPurpose = null;

  function finishLogin(data) {
    if (data.user.role === 'admin') {
      localStorage.removeItem('payvexisToken');
      localStorage.setItem('payvexisAdminToken', data.token);
    } else {
      localStorage.removeItem('payvexisAdminToken');
      localStorage.setItem('payvexisToken', data.token);
    }
    if (data.recoveryCodes?.length) {
      mfaForm.classList.add('hidden');
      document.getElementById('staff-recovery-list').textContent = data.recoveryCodes.join('\n');
      document.getElementById('staff-recovery-codes').classList.remove('hidden');
      return;
    }
    success.classList.remove('hidden');
    setTimeout(() => {
      window.location.href = data.user.role === 'admin' ? 'admin.html' : 'dashboard.html';
    }, 500);
  }

  document.getElementById('staff-recovery-continue').addEventListener('click', () => {
    document.getElementById('staff-recovery-list').textContent = '';
    window.location.href = 'admin.html';
  });
  document.getElementById('staff-mfa-back').addEventListener('click', () => window.location.reload());

  mfaForm.addEventListener('submit', async event => {
    event.preventDefault();
    const code = document.getElementById('staff-mfa-code').value.trim();
    const recoveryCode = document.getElementById('staff-mfa-recovery-code').value.trim();
    if (!/^\d{6}$/.test(code) && !(mfaPurpose === 'login' && recoveryCode)) {
      showLoginError('Enter a 6-digit authenticator code or a recovery code.');
      return;
    }
    const button = document.getElementById('staff-mfa-submit');
    button.disabled = true;
    try {
      const response = await fetch('/api/auth/staff-mfa/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken, purpose: mfaPurpose, code,
          recoveryCode: /^\d{6}$/.test(code) ? '' : recoveryCode })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Authenticator verification failed.');
      finishLogin(data);
    } catch (error) {
      showLoginError(error.message);
    } finally {
      button.disabled = false;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const email = document.getElementById('login-email').value.trim().toLowerCase();
    const password = document.getElementById('login-password').value;

    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-80', 'cursor-not-allowed');
    submitText.textContent = 'Signing In...';
    
    // Clear previous error
    const errorEl = document.getElementById('login-error');
    if (errorEl) errorEl.remove();

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to login');
      }

      if (data.mfaRequired) {
        challengeToken = data.challengeToken;
        mfaPurpose = data.setupRequired ? 'enroll' : 'login';
        if (data.setupRequired) {
          const setupResponse = await fetch('/api/auth/staff-mfa/setup', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ challengeToken })
          });
          const setup = await setupResponse.json();
          if (!setupResponse.ok) throw new Error(setup.error || 'Could not start authenticator setup.');
          document.getElementById('staff-mfa-secret').textContent = setup.secret;
          document.getElementById('staff-mfa-setup').classList.remove('hidden');
        } else {
          document.getElementById('staff-mfa-recovery-entry').classList.remove('hidden');
        }
        document.getElementById('staff-mfa-title').textContent = data.setupRequired
          ? 'Set up your staff authenticator' : 'Verify your authenticator';
        document.getElementById('staff-mfa-instructions').textContent = data.setupRequired
          ? 'Enter the current code from your authenticator app to activate staff access.'
          : 'Enter the current code from your authenticator app, or a saved recovery code.';
        document.getElementById('login-password').value = '';
        form.classList.add('hidden');
        mfaForm.classList.remove('hidden');
        document.getElementById('staff-mfa-code').focus();
        return;
      }

      finishLogin(data);
      submitText.textContent = 'Success!';

    } catch (err) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('opacity-80', 'cursor-not-allowed');
      submitText.textContent = 'Sign In';
      showLoginError(err.message);
    }
  });
}

function showLoginError(message) {
  let error = document.getElementById('login-error');
  if (!error) {
    error = document.createElement('div');
    error.id = 'login-error';
    error.className = 'rounded-xl border border-red-300/30 bg-red-400/10 text-red-200 text-sm px-3.5 py-3 mb-4';
    document.getElementById('login-form').before(error);
  }
  error.textContent = message;
}
