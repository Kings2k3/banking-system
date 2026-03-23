document.addEventListener('DOMContentLoaded', () => {
  initMobileNav();
  initReveal();
  initCardFlip();
  initCardTilt();
  initNavbarScroll();
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
  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -60px 0px' });
  elements.forEach(el => observer.observe(el));
}

function initCardFlip() {
  const shell = document.getElementById('card-shell');
  const card = document.getElementById('virtual-card');
  if (!shell || !card) return;

  shell.addEventListener('click', () => {
    card.classList.toggle('is-flipped');
  });
}

function initCardTilt() {
  const shell = document.getElementById('card-shell');
  if (!shell) return;

  function applyTilt(cx, cy) {
    const r = shell.getBoundingClientRect();
    const x = cx - r.left;
    const y = cy - r.top;
    const rx = ((y - r.height / 2) / (r.height / 2)) * -8;
    const ry = ((x - r.width / 2) / (r.width / 2)) * 10;
    shell.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg) scale(1.02)`;
  }

  shell.addEventListener('mousemove', e => applyTilt(e.clientX, e.clientY));
  shell.addEventListener('mouseleave', () => { shell.style.transform = ''; });
  shell.addEventListener('touchmove', e => {
    const t = e.touches[0];
    if (t) applyTilt(t.clientX, t.clientY);
  }, { passive: true });
  shell.addEventListener('touchend', () => { shell.style.transform = ''; }, { passive: true });
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
