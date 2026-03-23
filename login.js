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

    submitBtn.disabled = true;
    submitBtn.classList.add('opacity-80', 'cursor-not-allowed');
    submitText.textContent = 'Signing In...';

    setTimeout(() => {
      success.classList.remove('hidden');
      submitText.textContent = 'Continue to Dashboard';
      window.setTimeout(() => {
        window.location.href = 'index.html';
      }, 800);
    }, 1100);
  });
}
