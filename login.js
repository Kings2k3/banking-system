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
  const submitBtn = document.getElementById('login-submit');
  const submitText = document.getElementById('login-submit-text');
  const success = document.getElementById('login-success');
  if (!form || !submitBtn || !submitText || !success) return;

  form.addEventListener('submit', (event) => {
    event.preventDefault();

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const email = document.getElementById('login-email').value.trim().toLowerCase();
    const password = document.getElementById('login-password').value;
    const user = findRegisteredUser(email);
    if (!user || user.password !== password) {
      showLoginError('No matching account found. Use the email and password you registered with.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-80', 'cursor-not-allowed');
    submitText.textContent = 'Signing In...';

    setTimeout(() => {
      localStorage.setItem('payvexisCurrentUser', user.email);
      success.classList.remove('hidden');
      submitText.textContent = 'Continue to Dashboard';
      window.setTimeout(() => {
        window.location.href = 'dashboard.html';
      }, 800);
    }, 1100);
  });
}

function findRegisteredUser(email) {
  try {
    const users = JSON.parse(localStorage.getItem('payvexisUsers')) || [];
    return users.find(user => user.email === email);
  } catch (error) {
    return null;
  }
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
