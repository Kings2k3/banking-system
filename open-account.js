document.addEventListener('DOMContentLoaded', () => {
  initMobileNav();
  initReveal();
  initNavbarScroll();
  initPasswordToggle();
  initStepForm();
  initPasswordStrength();
});

/* ── Mobile Navigation ── */
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

/* ── Scroll Reveal ── */
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

/* ── Navbar Scroll ── */
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

/* ── Password Toggle ── */
function initPasswordToggle() {
  const passwordInput = document.getElementById('signup-password');
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

/* ── Password Strength Meter ── */
function initPasswordStrength() {
  const input = document.getElementById('signup-password');
  const fill = document.getElementById('strength-fill');
  const text = document.getElementById('strength-text');
  if (!input || !fill || !text) return;

  input.addEventListener('input', () => {
    const val = input.value;
    let score = 0;
    if (val.length >= 8) score++;
    if (/[A-Z]/.test(val)) score++;
    if (/[0-9]/.test(val)) score++;
    if (/[^A-Za-z0-9]/.test(val)) score++;

    fill.className = 'strength-fill';
    if (score <= 1) {
      fill.classList.add('strength-weak');
      text.textContent = 'Weak — add uppercase, numbers & symbols';
    } else if (score <= 2) {
      fill.classList.add('strength-medium');
      text.textContent = 'Medium — getting stronger';
    } else {
      fill.classList.add('strength-strong');
      text.textContent = 'Strong password';
    }

    if (val.length === 0) {
      fill.className = 'strength-fill';
      text.textContent = 'Use 8+ characters with letters, numbers & symbols';
    }
  });
}

/* ── Multi-step Form ── */
function initStepForm() {
  let current = 1;
  const totalSteps = 3;

  const panels = {
    1: document.getElementById('panel-1'),
    2: document.getElementById('panel-2'),
    3: document.getElementById('panel-3'),
    success: document.getElementById('panel-success'),
  };

  const stepItems = document.querySelectorAll('.step-item');
  const connectors = [document.getElementById('conn-1'), document.getElementById('conn-2')];

  // Navigation buttons
  const next1 = document.getElementById('next-1');
  const next2 = document.getElementById('next-2');
  const back2 = document.getElementById('back-2');
  const back3 = document.getElementById('back-3');
  const form = document.getElementById('signup-form');

  function goTo(step) {
    // Hide all panels
    Object.values(panels).forEach(p => { if (p) p.classList.remove('active'); });

    if (step === 'success') {
      panels.success.classList.add('active');
      // Mark all steps done
      stepItems.forEach(item => {
        item.classList.remove('active');
        item.classList.add('done');
        item.querySelector('.step-circle').innerHTML = checkSVG();
      });
      connectors.forEach(c => c.classList.add('filled'));
      return;
    }

    panels[step].classList.add('active');
    current = step;

    // Update step bar
    stepItems.forEach((item, idx) => {
      const s = idx + 1;
      item.classList.remove('active', 'done');
      if (s < step) {
        item.classList.add('done');
        item.querySelector('.step-circle').innerHTML = checkSVG();
      } else if (s === step) {
        item.classList.add('active');
        item.querySelector('.step-circle').textContent = s;
      } else {
        item.querySelector('.step-circle').textContent = s;
      }
    });

    // Connectors
    connectors.forEach((c, idx) => {
      c.classList.toggle('filled', idx + 1 < step);
    });
  }

  function checkSVG() {
    return '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>';
  }

  // Validation per step
  function validateStep(step) {
    let valid = true;
    const panel = panels[step];
    const inputs = panel.querySelectorAll('input[required], select[required]');

    inputs.forEach(inp => {
      inp.classList.remove('error');
      if (!inp.value.trim()) {
        inp.classList.add('error');
        valid = false;
      }
      if (inp.type === 'email' && inp.value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inp.value)) {
        inp.classList.add('error');
        valid = false;
      }
    });

    // Step 2: password match
    if (step === 2) {
      const pass = document.getElementById('signup-password').value;
      const confirm = document.getElementById('confirm-password').value;
      if (pass !== confirm) {
        document.getElementById('confirm-password').classList.add('error');
        valid = false;
      }
      if (pass.length < 8) {
        document.getElementById('signup-password').classList.add('error');
        valid = false;
      }
    }

    return valid;
  }

  // Populate summary
  function populateSummary() {
    const firstName = document.getElementById('first-name').value;
    const lastName = document.getElementById('last-name').value;
    document.getElementById('summary-name').textContent = `${firstName} ${lastName}`;
    document.getElementById('summary-email').textContent = document.getElementById('signup-email').value;
    document.getElementById('summary-phone').textContent = document.getElementById('phone').value;
    const accountSelect = document.getElementById('account-type');
    const accountText = accountSelect.options[accountSelect.selectedIndex]?.text || '—';
    document.getElementById('summary-account').textContent = accountText;
  }

  // Events
  if (next1) {
    next1.addEventListener('click', () => {
      if (validateStep(1)) goTo(2);
    });
  }

  if (next2) {
    next2.addEventListener('click', () => {
      if (validateStep(2)) {
        populateSummary();
        goTo(3);
      }
    });
  }

  if (back2) back2.addEventListener('click', () => goTo(1));
  if (back3) back3.addEventListener('click', () => goTo(2));

  // Form submit
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();

      const terms = document.getElementById('terms');
      if (!terms.checked) {
        terms.classList.add('error');
        return;
      }

      const submitBtn = document.getElementById('signup-submit');
      const submitText = document.getElementById('signup-submit-text');
      submitBtn.disabled = true;
      submitBtn.classList.add('opacity-80', 'cursor-not-allowed');
      submitText.textContent = 'Creating Account...';

      setTimeout(() => {
        goTo('success');
      }, 1400);
    });
  }

  // Remove error on focus
  document.querySelectorAll('.auth-input, .custom-check').forEach(inp => {
    inp.addEventListener('focus', () => inp.classList.remove('error'));
    inp.addEventListener('change', () => inp.classList.remove('error'));
  });
}
