// ============================================================
// BANKLIO — Premium Fintech Interactions
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  initScrollReveal();
  initCounters();
  initRippleButtons();
  initMobileNav();
  initSmoothScroll();
  initCard3DTilt();
  initNavbarScroll();
  initSwipeCarousels();
  initParallaxOrbs();
  initCardHoverGlow();
  initLiveRates();
  initCurrencyConverter();
  initMapTooltips();
});

// ============================================================
// SCROLL REVEAL — IntersectionObserver with stagger
// ============================================================
function initScrollReveal() {
  const elements = document.querySelectorAll('.reveal, .reveal-left, .reveal-right, .reveal-scale');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '0px 0px -60px 0px'
  });

  elements.forEach(el => observer.observe(el));
}

// ============================================================
// COUNTER ANIMATIONS — Spring easing
// ============================================================
function initCounters() {
  const counters = document.querySelectorAll('[data-counter]');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        animateCounter(entry.target);
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.5 });

  counters.forEach(c => observer.observe(c));
}

function animateCounter(el) {
  const target = parseInt(el.getAttribute('data-counter'));
  const suffix = el.getAttribute('data-suffix') || '';
  const duration = 2500;
  const start = performance.now();

  function springEase(t) {
    return 1 - Math.pow(Math.cos(t * Math.PI * 0.5), 3);
  }

  function update(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const eased = springEase(progress);
    const current = Math.floor(eased * target);
    el.textContent = current + suffix;

    if (progress < 1) {
      requestAnimationFrame(update);
    } else {
      el.textContent = target + suffix;
    }
  }

  requestAnimationFrame(update);
}

// ============================================================
// RIPPLE BUTTONS
// ============================================================
function initRippleButtons() {
  document.querySelectorAll('.btn-primary, .btn-secondary').forEach(btn => {
    btn.addEventListener('click', function(e) {
      const ripple = document.createElement('span');
      ripple.classList.add('ripple-span');
      const rect = this.getBoundingClientRect();
      const size = Math.max(rect.width, rect.height) * 1.5;
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
      ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
      this.appendChild(ripple);
      setTimeout(() => ripple.remove(), 700);
    });

    // Touch active state
    btn.addEventListener('touchstart', () => {
      btn.style.transform = 'scale(0.96)';
    }, { passive: true });

    btn.addEventListener('touchend', () => {
      btn.style.transform = '';
    }, { passive: true });
  });
}

// ============================================================
// MOBILE NAV
// ============================================================
function initMobileNav() {
  const toggle = document.getElementById('nav-toggle');
  const mobileNav = document.getElementById('mobile-nav');
  const closeBtn = document.getElementById('nav-close');

  if (!toggle || !mobileNav) return;

  function closeMobileNav() {
    mobileNav.classList.remove('open');
    document.body.style.overflow = '';
  }

  toggle.addEventListener('click', () => {
    mobileNav.classList.add('open');
    document.body.style.overflow = 'hidden';
  });

  if (closeBtn) {
    closeBtn.addEventListener('click', closeMobileNav);
  }

  // Close overlay on link click — don't delay navigation for external links
  mobileNav.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', (e) => {
      const href = link.getAttribute('href') || '';
      const isPageLink = href && !href.startsWith('#');

      if (isPageLink) {
        // For page navigation links: close instantly without animation delay
        mobileNav.style.transition = 'none';
        closeMobileNav();
        // Restore transition after frame so it doesn't affect next open
        requestAnimationFrame(() => {
          mobileNav.style.transition = '';
        });
      } else {
        // For same-page hash links: animate close normally
        closeMobileNav();
      }
    });
  });
}

// ============================================================
// SMOOTH SCROLL — with navbar offset
// ============================================================
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const targetId = this.getAttribute('href');
      if (!targetId || targetId === '#') return;

      // Only handle same-page hash links — skip if target section doesn't exist on this page
      const target = document.querySelector(targetId);
      if (target) {
        e.preventDefault();
        const navHeight = document.getElementById('navbar')?.offsetHeight || 70;
        const targetPos = target.getBoundingClientRect().top + window.pageYOffset - navHeight;
        window.scrollTo({ top: targetPos, behavior: 'smooth' });
      }
    });
  });
}

// ============================================================
// 3D CARD TILT — Mouse + Touch
// ============================================================
function initCard3DTilt() {
  document.querySelectorAll('.card-3d').forEach(card => {
    // Mouse tilt
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = ((y - centerY) / centerY) * -12;
      const rotateY = ((x - centerX) / centerX) * 12;
      card.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.03)`;
    });

    card.addEventListener('mouseleave', () => {
      card.style.transform = 'perspective(800px) rotateX(0deg) rotateY(0deg) scale(1)';
    });

    // Touch tilt
    card.addEventListener('touchmove', (e) => {
      if (e.touches.length !== 1) return;
      const touch = e.touches[0];
      const rect = card.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = ((y - centerY) / centerY) * -8;
      const rotateY = ((x - centerX) / centerX) * 8;
      card.style.transform = `perspective(800px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(1.02)`;
    }, { passive: true });

    card.addEventListener('touchend', () => {
      card.style.transform = 'perspective(800px) rotateX(0deg) rotateY(0deg) scale(1)';
    }, { passive: true });
  });
}

// ============================================================
// NAVBAR SCROLL — Glassmorphic on scroll
// ============================================================
function initNavbarScroll() {
  const nav = document.getElementById('navbar');
  if (!nav) return;

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        if (window.scrollY > 50) {
          nav.classList.add('scrolled');
        } else {
          nav.classList.remove('scrolled');
        }
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });
}

// ============================================================
// SWIPE CAROUSEL — Touch + Mouse drag with snap
// ============================================================
function initSwipeCarousels() {
  document.querySelectorAll('.swipe-carousel').forEach(carousel => {
    let isDown = false;
    let startX;
    let scrollLeft;
    let velX = 0;
    let lastX;
    let animFrame;

    // Mouse drag
    carousel.addEventListener('mousedown', (e) => {
      isDown = true;
      carousel.style.cursor = 'grabbing';
      startX = e.pageX - carousel.offsetLeft;
      scrollLeft = carousel.scrollLeft;
      lastX = e.pageX;
      cancelAnimationFrame(animFrame);
    });

    carousel.addEventListener('mouseleave', () => {
      if (isDown) momentumScroll(carousel, velX);
      isDown = false;
      carousel.style.cursor = 'grab';
    });

    carousel.addEventListener('mouseup', () => {
      if (isDown) momentumScroll(carousel, velX);
      isDown = false;
      carousel.style.cursor = 'grab';
    });

    carousel.addEventListener('mousemove', (e) => {
      if (!isDown) return;
      e.preventDefault();
      const x = e.pageX - carousel.offsetLeft;
      const walk = (x - startX) * 1.5;
      carousel.scrollLeft = scrollLeft - walk;
      velX = e.pageX - lastX;
      lastX = e.pageX;
    });

    // Update carousel dots
    const carouselId = carousel.id;
    const dotsContainer = document.getElementById(carouselId?.replace('carousel', 'dots'));

    if (dotsContainer) {
      const dots = dotsContainer.querySelectorAll('.carousel-dot');
      const cards = carousel.querySelectorAll('.swipe-card');

      carousel.addEventListener('scroll', () => {
        if (!ticking2) {
          requestAnimationFrame(() => {
            const scrollPos = carousel.scrollLeft;
            const cardWidth = cards[0]?.offsetWidth || 300;
            const gap = 16;
            const activeIndex = Math.round(scrollPos / (cardWidth + gap));
            dots.forEach((dot, i) => {
              dot.classList.toggle('active', i === activeIndex);
            });
            ticking2 = false;
          });
          ticking2 = true;
        }
      }, { passive: true });

      let ticking2 = false;

      dots.forEach(dot => {
        dot.addEventListener('click', () => {
          const index = parseInt(dot.dataset.index);
          const cards = carousel.querySelectorAll('.swipe-card');
          if (cards[index]) {
            cards[index].scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
          }
        });
      });
    }
  });
}

function momentumScroll(el, velocity) {
  let vel = velocity * 2;
  function step() {
    if (Math.abs(vel) < 0.5) return;
    el.scrollLeft -= vel;
    vel *= 0.92;
    requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ============================================================
// PARALLAX GLOW ORBS — Subtle movement on scroll
// ============================================================
function initParallaxOrbs() {
  const orbs = document.querySelectorAll('.glow-orb');
  if (orbs.length === 0) return;

  let ticking = false;

  window.addEventListener('scroll', () => {
    if (!ticking) {
      requestAnimationFrame(() => {
        const scrollY = window.scrollY;
        orbs.forEach((orb, i) => {
          const speed = (i % 3 + 1) * 0.03;
          const direction = i % 2 === 0 ? 1 : -1;
          const y = scrollY * speed * direction;
          const x = scrollY * speed * 0.3 * direction * -1;
          orb.style.transform = `translate(${x}px, ${y}px)`;
        });
        ticking = false;
      });
      ticking = true;
    }
  }, { passive: true });
}

// ============================================================
// CARD HOVER GLOW — glass-card subtle glow follow
// ============================================================
function initCardHoverGlow() {
  document.querySelectorAll('.glass-card, .feature-card-premium, .testimonial-card-premium').forEach(card => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      card.style.setProperty('--glow-x', `${x}px`);
      card.style.setProperty('--glow-y', `${y}px`);
      card.style.background = `radial-gradient(300px circle at ${x}px ${y}px, rgba(201,245,115,0.06), transparent 60%), var(--gradient-card)`;
    });

    card.addEventListener('mouseleave', () => {
      card.style.background = '';
    });
  });
}

// ============================================================
// LIVE EXCHANGE RATES — frankfurter.app API
// ============================================================
function initLiveRates() {
  fetchLiveRates();
  // Refresh every 60 seconds
  setInterval(fetchLiveRates, 60000);
}

async function fetchLiveRates() {
  const statusEl = document.getElementById('rates-status');
  try {
    // Fetch USD-based rates
    const [usdRes, gbpRes] = await Promise.all([
      fetch('https://api.frankfurter.app/latest?from=USD&to=EUR,JPY'),
      fetch('https://api.frankfurter.app/latest?from=GBP&to=USD')
    ]);

    if (!usdRes.ok || !gbpRes.ok) throw new Error('API error');

    const usdData = await usdRes.json();
    const gbpData = await gbpRes.json();

    // USD to EUR
    const usdEur = usdData.rates.EUR;
    const usdEurEl = document.getElementById('rate-usd-eur');
    const usdEurChangeEl = document.getElementById('rate-usd-eur-change');
    if (usdEurEl) {
      usdEurEl.textContent = usdEur.toFixed(4);
      animateRateUpdate(usdEurEl);
    }
    if (usdEurChangeEl) usdEurChangeEl.textContent = `1 USD = ${usdEur.toFixed(4)} EUR`;

    // GBP to USD
    const gbpUsd = gbpData.rates.USD;
    const gbpUsdEl = document.getElementById('rate-gbp-usd');
    const gbpUsdChangeEl = document.getElementById('rate-gbp-usd-change');
    if (gbpUsdEl) {
      gbpUsdEl.textContent = gbpUsd.toFixed(4);
      animateRateUpdate(gbpUsdEl);
    }
    if (gbpUsdChangeEl) gbpUsdChangeEl.textContent = `1 GBP = ${gbpUsd.toFixed(4)} USD`;

    // USD to JPY
    const usdJpy = usdData.rates.JPY;
    const usdJpyEl = document.getElementById('rate-usd-jpy');
    const usdJpyChangeEl = document.getElementById('rate-usd-jpy-change');
    if (usdJpyEl) {
      usdJpyEl.textContent = usdJpy.toFixed(2);
      animateRateUpdate(usdJpyEl);
    }
    if (usdJpyChangeEl) usdJpyChangeEl.textContent = `1 USD = ${usdJpy.toFixed(2)} JPY`;

    if (statusEl) {
      statusEl.textContent = 'Live';
      statusEl.classList.remove('text-red-400');
      statusEl.classList.add('text-green-400');
    }
  } catch (err) {
    console.warn('Rate fetch failed:', err);
    if (statusEl) {
      statusEl.textContent = 'Offline';
      statusEl.classList.remove('text-green-400');
      statusEl.classList.add('text-red-400');
    }
  }
}

function animateRateUpdate(el) {
  el.style.transition = 'none';
  el.style.transform = 'scale(1.15)';
  el.style.color = '#c9f573';
  requestAnimationFrame(() => {
    el.style.transition = 'transform 0.5s cubic-bezier(0.34,1.56,0.64,1), color 1s ease';
    el.style.transform = 'scale(1)';
    setTimeout(() => { el.style.color = ''; }, 500);
  });
}

// ============================================================
// CURRENCY CONVERTER - Live conversion via API
// ============================================================
function initCurrencyConverter() {
  const fromSelect = document.getElementById('convert-from');
  const toSelect = document.getElementById('convert-to');
  const amountInput = document.getElementById('convert-amount');
  const resultEl = document.getElementById('convert-result');
  const rateInfoEl = document.getElementById('convert-rate-info');
  const lastUpdateEl = document.getElementById('convert-last-update');
  const swapBtn = document.getElementById('convert-swap');

  if (!fromSelect || !toSelect || !amountInput) return;

  let conversionCache = {};

  async function convert() {
    const from = fromSelect.value;
    const to = toSelect.value;
    const amount = parseFloat(amountInput.value);

    if (!amount || amount <= 0 || from === to) {
      if (resultEl) resultEl.textContent = from === to ? formatNumber(amount || 0) : '--';
      if (rateInfoEl) rateInfoEl.textContent = from === to ? 'Same currency' : 'Enter an amount';
      return;
    }

    const cacheKey = `${from}_${to}`;

    try {
      // Check cache (valid for 60s)
      const cached = conversionCache[cacheKey];
      const now = Date.now();
      let rate;

      if (cached && (now - cached.time) < 60000) {
        rate = cached.rate;
      } else {
        const res = await fetch(`https://api.frankfurter.app/latest?amount=1&from=${from}&to=${to}`);
        if (!res.ok) throw new Error('API error');
        const data = await res.json();
        rate = data.rates[to];
        conversionCache[cacheKey] = { rate, time: now };
      }

      const result = amount * rate;

      if (resultEl) {
        resultEl.textContent = formatNumber(result);
        animateRateUpdate(resultEl);
      }
      if (rateInfoEl) rateInfoEl.textContent = `1 ${from} = ${rate.toFixed(4)} ${to}`;
      if (lastUpdateEl) {
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        lastUpdateEl.textContent = `Updated ${time}`;
      }
    } catch (err) {
      console.warn('Conversion failed:', err);
      if (resultEl) resultEl.textContent = 'Error';
      if (rateInfoEl) rateInfoEl.textContent = 'Could not fetch rate. Try again.';
    }
  }

  function formatNumber(n) {
    if (n >= 1000) {
      return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return n.toFixed(4);
  }

  // Event listeners
  let debounceTimer;
  amountInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(convert, 300);
  });

  fromSelect.addEventListener('change', () => convert());
  toSelect.addEventListener('change', () => convert());

  // Swap button
  if (swapBtn) {
    swapBtn.addEventListener('click', () => {
      const tempVal = fromSelect.value;
      fromSelect.value = toSelect.value;
      toSelect.value = tempVal;
      // Animate the swap icon
      swapBtn.style.transform = 'rotate(180deg) scale(1.1)';
      setTimeout(() => { swapBtn.style.transform = ''; }, 400);
      convert();
    });
  }

  // Initial conversion on load
  convert();
}

// ============================================================
// MAP TOOLTIPS — City dot hover labels
// ============================================================
function initMapTooltips() {
  const tooltip = document.getElementById('map-tooltip');
  const mapContainer = document.getElementById('globe-card');
  if (!tooltip || !mapContainer) return;

  const dots = mapContainer.querySelectorAll('.city-dot');

  dots.forEach(dot => {
    const cityName = dot.getAttribute('data-city') || '';

    dot.addEventListener('mouseenter', (e) => {
      tooltip.textContent = cityName;
      tooltip.classList.add('visible');
      updateTooltipPosition(e, tooltip, mapContainer);
    });

    dot.addEventListener('mousemove', (e) => {
      updateTooltipPosition(e, tooltip, mapContainer);
    });

    dot.addEventListener('mouseleave', () => {
      tooltip.classList.remove('visible');
    });

    // Touch support
    dot.addEventListener('touchstart', (e) => {
      tooltip.textContent = cityName;
      tooltip.classList.add('visible');
      const touch = e.touches[0];
      updateTooltipPosition(touch, tooltip, mapContainer);
      setTimeout(() => tooltip.classList.remove('visible'), 2000);
    }, { passive: true });

    // Hover glow effect on dot
    dot.style.cursor = 'pointer';
    dot.style.transition = 'r 0.3s ease, opacity 0.3s ease';
    dot.addEventListener('mouseenter', () => {
      dot.setAttribute('r', parseFloat(dot.getAttribute('r')) + 2);
    });
    dot.addEventListener('mouseleave', () => {
      dot.setAttribute('r', parseFloat(dot.getAttribute('r')) - 2);
    });
  });
}

function updateTooltipPosition(e, tooltip, container) {
  const rect = container.getBoundingClientRect();
  const x = (e.clientX || e.pageX) - rect.left;
  const y = (e.clientY || e.pageY) - rect.top;
  tooltip.style.left = x + 'px';
  tooltip.style.top = (y - 35) + 'px';
}

