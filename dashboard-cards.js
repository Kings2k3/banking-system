const cardPageState = {
  currentUser: null,
  cards: [],
  activeCard: null,
  selectedTheme: 'graphite',
};

document.addEventListener('DOMContentLoaded', () => {
  initMobileNav();
  initNavbarScroll();
  initSignOut();
  initCardPage();
});

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

  if (closeBtn) closeBtn.addEventListener('click', closeMobileNav);
  mobileNav.querySelectorAll('a, button:not(#nav-close)').forEach(item => {
    item.addEventListener('click', closeMobileNav);
  });
}

function initNavbarScroll() {
  const nav = document.getElementById('navbar');
  if (!nav) return;

  let ticking = false;
  window.addEventListener('scroll', () => {
    if (ticking) return;
    requestAnimationFrame(() => {
      nav.classList.toggle('scrolled', window.scrollY > 50);
      ticking = false;
    });
    ticking = true;
  }, { passive: true });
}

function initSignOut() {
  document.querySelectorAll('[data-sign-out]').forEach(link => {
    link.addEventListener('click', () => {
      localStorage.removeItem('payvexisCurrentUser');
    });
  });
}

async function initCardPage() {
  const token = localStorage.getItem('payvexisToken');
  if (!token) {
    showSignedOutState();
    return;
  }

  try {
    const res = await fetch('/api/accounts/me', { headers: { 'Authorization': `Bearer ${token}` } });
    if (!res.ok) throw new Error();
    const data = await res.json();
    
    cardPageState.currentUser = data.user;
    cardPageState.cards = data.cards;

    if (cardPageState.cards.length > 0) {
      cardPageState.activeCard = cardPageState.cards[0];
      cardPageState.selectedTheme = cardPageState.activeCard.theme || 'graphite';
    } else {
      // Create a default card shape if missing (shouldn't happen with our backend)
      cardPageState.activeCard = { theme: 'graphite', limit: 400, frozen: false, mask: '0000', network: 'PAYVEXIS' };
      cardPageState.selectedTheme = 'graphite';
    }

    initCardFormEvents();
    renderCardPage();
  } catch(err) {
    showSignedOutState();
  }
}

function showSignedOutState() {
  const empty = document.getElementById('signed-out-state');
  const workspace = document.getElementById('card-workspace');
  if (empty) empty.classList.add('open');
  if (workspace) workspace.classList.add('workspace-hidden');
}

// Stubs for functions no longer needed but may be called
function getCurrentUser() { return cardPageState.currentUser; }
function loadPrimaryCard() { return cardPageState.activeCard; }

function buildDefaultCard(user) {
  const holder = formatHolderName(user);
  return {
    id: `card-${user.id || user.email}`,
    name: 'Payvexis Debit',
    nickname: 'Everyday spend',
    holder,
    mask: getAccountMask(user),
    network: 'PAYVEXIS',
    status: 'Active',
    frozen: false,
    spend: 0,
    limit: 400,
    theme: 'graphite',
    contactless: true,
    online: true,
    international: false,
    atm: true,
  };
}

function normalizeCard(card, defaults) {
  return {
    ...defaults,
    ...card,
    id: card.id || defaults.id,
    name: cleanText(card.name || defaults.name, 28),
    nickname: cleanText(card.nickname || defaults.nickname, 24),
    holder: cleanText(card.holder || defaults.holder, 30),
    mask: getCardMask(card.mask, defaults.mask),
    network: normalizeNetwork(card.network || defaults.network),
    status: card.frozen ? 'Active' : cleanText(card.status || defaults.status, 16),
    frozen: Boolean(card.frozen),
    spend: toMoneyNumber(card.spend, defaults.spend),
    limit: clampLimit(card.limit || defaults.limit),
    theme: getValidTheme(card.theme || defaults.theme),
    contactless: card.contactless !== false,
    online: card.online !== false,
    international: Boolean(card.international),
    atm: card.atm !== false,
  };
}

function initCardFormEvents() {
  const form = document.getElementById('card-settings-form');
  if (form) form.addEventListener('submit', handleCardSave);

  const freezeButton = document.getElementById('freeze-card');
  if (freezeButton) freezeButton.addEventListener('click', toggleCardFrozen);

  const resetButton = document.getElementById('reset-card');
  if (resetButton) resetButton.addEventListener('click', resetCardDesign);

  document.querySelectorAll('[data-theme]').forEach(button => {
    button.addEventListener('click', () => {
      cardPageState.activeCard.theme = getValidTheme(button.dataset.theme);
      cardPageState.selectedTheme = cardPageState.activeCard.theme;
      renderCardPreview();
      renderThemeButtons();
      showSaveFeedback('Theme preview updated. Save to keep this design.');
    });
  });

  ['card-name', 'card-holder', 'card-statement-name'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.addEventListener('input', updateCardFromForm);
  });

  const limitRange = document.getElementById('card-limit-range');
  const limitInput = document.getElementById('card-limit');
  if (limitRange && limitInput) {
    limitRange.addEventListener('input', () => {
      limitInput.value = limitRange.value;
      updateCardFromForm();
    });
    limitInput.addEventListener('input', () => {
      limitRange.value = clampLimit(limitInput.value);
      updateCardFromForm();
    });
  }

  ['toggle-contactless', 'toggle-online', 'toggle-international', 'toggle-atm'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.addEventListener('change', updateCardFromForm);
  });
}

function renderCardPage() {
  renderOwnerDetails();
  renderCardForm();
  renderCardPreview();
  renderThemeButtons();
  renderCardMetrics();
  renderFrozenState();
}

function renderOwnerDetails() {
  const user = cardPageState.currentUser;
  const initials = `${user.firstName?.[0] || 'P'}${user.lastName?.[0] || ''}`.toUpperCase();
  setText('owner-avatar', initials);
  setText('owner-name', formatHolderName(user));
  setText('owner-account', `${user.accountLabel || 'Account'} ending ${getAccountMask(user)}`);
}

function renderCardForm() {
  const card = cardPageState.activeCard;
  setValue('card-name', card.name);
  setValue('card-holder', card.holder);
  setValue('card-statement-name', card.nickname);
  setValue('card-limit', card.limit);
  setValue('card-limit-range', card.limit);
  setChecked('toggle-contactless', card.contactless);
  setChecked('toggle-online', card.online);
  setChecked('toggle-international', card.international);
  setChecked('toggle-atm', card.atm);
}

function renderCardPreview() {
  const card = cardPageState.activeCard;
  const preview = document.getElementById('card-preview');
  if (preview) {
    preview.className = `payment-card card-theme-${getValidTheme(card.theme)}`;
    preview.classList.toggle('is-frozen', card.frozen);
  }

  setText('preview-card-number', `**** **** **** ${getCardMask(card.mask, getAccountMask(cardPageState.currentUser))}`);
  setText('preview-holder', card.holder || formatHolderName(cardPageState.currentUser));
  setText('preview-card-name', card.nickname || card.name || 'Everyday card');
  setText('preview-network', normalizeNetwork(card.network));
}

function renderThemeButtons() {
  document.querySelectorAll('[data-theme]').forEach(button => {
    const active = button.dataset.theme === cardPageState.activeCard.theme;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function renderCardMetrics() {
  const card = cardPageState.activeCard;
  setText('metric-limit', formatMoney(card.limit));
  setText('metric-spend', formatMoney(card.spend));
  setText('metric-controls', `${getEnabledControlCount(card)} on`);
}

function renderFrozenState() {
  const card = cardPageState.activeCard;
  const status = document.getElementById('card-status');
  const button = document.getElementById('freeze-card');
  if (status) {
    status.textContent = card.frozen ? 'Frozen' : 'Active';
    status.classList.toggle('is-frozen', card.frozen);
    status.classList.toggle('is-active', !card.frozen);
  }
  if (button) button.textContent = card.frozen ? 'Unfreeze Card' : 'Freeze Card';
}

function updateCardFromForm() {
  const card = cardPageState.activeCard;
  card.name = cleanText(getValue('card-name') || 'Payvexis Debit', 28);
  card.holder = cleanText(getValue('card-holder') || formatHolderName(cardPageState.currentUser), 30);
  card.nickname = cleanText(getValue('card-statement-name') || 'Everyday spend', 24);
  card.limit = clampLimit(getValue('card-limit'));
  card.contactless = getChecked('toggle-contactless');
  card.online = getChecked('toggle-online');
  card.international = getChecked('toggle-international');
  card.atm = getChecked('toggle-atm');

  renderCardPreview();
  renderCardMetrics();
}

async function handleCardSave(event) {
  event.preventDefault();
  updateCardFromForm();
  await saveActiveCard();
  renderCardPage();
  showSaveFeedback('Card settings saved.');
}

async function toggleCardFrozen() {
  const card = cardPageState.activeCard;
  const token = localStorage.getItem('payvexisToken');
  try {
    const res = await fetch(`/api/accounts/cards/${card.id}/freeze`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    cardPageState.activeCard = data.card;
    renderCardPreview();
    renderFrozenState();
    showSaveFeedback(cardPageState.activeCard.frozen ? 'Card frozen. New purchases are paused.' : 'Card unfrozen. New purchases are available.');
  } catch (err) {
    alert('Failed to update card status');
  }
}

async function resetCardDesign() {
  const card = cardPageState.activeCard;
  card.theme = 'graphite';
  card.nickname = 'Everyday spend';
  await saveActiveCard();
  renderCardPage();
  showSaveFeedback('Card design reset.');
}

async function saveActiveCard() {
  const card = cardPageState.activeCard;
  const token = localStorage.getItem('payvexisToken');
  try {
    const res = await fetch(`/api/accounts/cards/${card.id}`, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: card.theme, nickname: card.nickname, cardLimit: card.limit })
    });
    if (!res.ok) throw new Error();
    const data = await res.json();
    cardPageState.activeCard = data.card;
  } catch (err) {
    console.error('Failed to save card settings');
  }
}

function showSaveFeedback(message) {
  const feedback = document.getElementById('save-feedback');
  if (!feedback) return;

  feedback.textContent = message;
  window.clearTimeout(showSaveFeedback.timer);
  showSaveFeedback.timer = window.setTimeout(() => {
    feedback.textContent = '';
  }, 2600);
}

function readUserDashboardList(key) {
  const storageKey = `payvexis:${cardPageState.currentUser.email}:${key}`;
  try {
    return JSON.parse(localStorage.getItem(storageKey)) || [];
  } catch (error) {
    return [];
  }
}

function saveUserDashboardList(key, value) {
  localStorage.setItem(`payvexis:${cardPageState.currentUser.email}:${key}`, JSON.stringify(value));
}

function isTenDigitAccountNumber(accountNumber) {
  return /^\d{10}$/.test(String(accountNumber || ''));
}

function makeAccountNumber(users) {
  const usedNumbers = new Set(users.map(user => String(user.accountNumber || '')));
  let accountNumber;

  do {
    accountNumber = String(Math.floor(1000000000 + Math.random() * 9000000000));
  } while (usedNumbers.has(accountNumber));

  return accountNumber;
}

function getAccountMask(user) {
  const accountNumber = String(user?.accountNumber || '');
  if (isTenDigitAccountNumber(accountNumber)) return accountNumber.slice(-4);
  return String(user?.accountMask || '0000').slice(-4);
}

function getCardMask(mask, fallback) {
  const cleaned = String(mask || fallback || '0000').replace(/\D/g, '');
  return (cleaned || '0000').slice(-4).padStart(4, '0');
}

function getValidTheme(theme) {
  const themes = new Set(['graphite', 'emerald', 'ocean', 'sunrise']);
  return themes.has(theme) ? theme : 'graphite';
}

function normalizeNetwork(network) {
  const label = cleanText(network || 'PAYVEXIS', 8).toUpperCase();
  const legacyNetwork = ['v', 'i', 's', 'a'].join('').toUpperCase();
  return label === legacyNetwork ? 'PAYVEXIS' : label;
}

function formatHolderName(user) {
  const name = `${user?.firstName || ''} ${user?.lastName || ''}`.trim();
  return name || 'Payvexis Member';
}

function getEnabledControlCount(card) {
  return [card.contactless, card.online, card.international, card.atm].filter(Boolean).length;
}

function clampLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 400;
  return Math.min(Math.max(Math.round(number / 50) * 50, 50), 5000);
}

function toMoneyNumber(value, fallback = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Number(number.toFixed(2));
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(Number(value) || 0);
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function setValue(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

function getValue(id) {
  const el = document.getElementById(id);
  return el ? el.value : '';
}

function setChecked(id, value) {
  const el = document.getElementById(id);
  if (el) el.checked = Boolean(value);
}

function getChecked(id) {
  const el = document.getElementById(id);
  return el ? el.checked : false;
}
