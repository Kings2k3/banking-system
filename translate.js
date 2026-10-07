/* ============================================================
   TRANSLATE.JS — Auto-detect browser language & translate site
   Uses Google Translate Element API (free, 100+ languages)
   ============================================================ */

(function () {
  'use strict';

  // ---- Supported Languages (popular global languages) ----
  const LANGUAGES = [
    { code: 'en', name: 'English', flag: '🇬🇧' },
    { code: 'fr', name: 'Français', flag: '🇫🇷' },
    { code: 'es', name: 'Español', flag: '🇪🇸' },
    { code: 'pt', name: 'Português', flag: '🇧🇷' },
    { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
    { code: 'it', name: 'Italiano', flag: '🇮🇹' },
    { code: 'nl', name: 'Nederlands', flag: '🇳🇱' },
    { code: 'ru', name: 'Русский', flag: '🇷🇺' },
    { code: 'zh-CN', name: '中文 (简体)', flag: '🇨🇳' },
    { code: 'zh-TW', name: '中文 (繁體)', flag: '🇹🇼' },
    { code: 'ja', name: '日本語', flag: '🇯🇵' },
    { code: 'ko', name: '한국어', flag: '🇰🇷' },
    { code: 'ar', name: 'العربية', flag: '🇸🇦' },
    { code: 'hi', name: 'हिन्दी', flag: '🇮🇳' },
    { code: 'bn', name: 'বাংলা', flag: '🇧🇩' },
    { code: 'tr', name: 'Türkçe', flag: '🇹🇷' },
    { code: 'vi', name: 'Tiếng Việt', flag: '🇻🇳' },
    { code: 'th', name: 'ไทย', flag: '🇹🇭' },
    { code: 'pl', name: 'Polski', flag: '🇵🇱' },
    { code: 'uk', name: 'Українська', flag: '🇺🇦' },
    { code: 'sv', name: 'Svenska', flag: '🇸🇪' },
    { code: 'da', name: 'Dansk', flag: '🇩🇰' },
    { code: 'fi', name: 'Suomi', flag: '🇫🇮' },
    { code: 'el', name: 'Ελληνικά', flag: '🇬🇷' },
    { code: 'cs', name: 'Čeština', flag: '🇨🇿' },
    { code: 'ro', name: 'Română', flag: '🇷🇴' },
    { code: 'hu', name: 'Magyar', flag: '🇭🇺' },
    { code: 'id', name: 'Bahasa Indonesia', flag: '🇮🇩' },
    { code: 'ms', name: 'Bahasa Melayu', flag: '🇲🇾' },
    { code: 'sw', name: 'Kiswahili', flag: '🇰🇪' },
    { code: 'yo', name: 'Yorùbá', flag: '🇳🇬' },
    { code: 'ha', name: 'Hausa', flag: '🇳🇬' },
    { code: 'ig', name: 'Igbo', flag: '🇳🇬' },
    { code: 'am', name: 'አማርኛ', flag: '🇪🇹' },
    { code: 'zu', name: 'isiZulu', flag: '🇿🇦' },
    { code: 'af', name: 'Afrikaans', flag: '🇿🇦' },
    { code: 'he', name: 'עברית', flag: '🇮🇱' },
    { code: 'fa', name: 'فارسی', flag: '🇮🇷' },
    { code: 'ur', name: 'اردو', flag: '🇵🇰' },
    { code: 'tl', name: 'Filipino', flag: '🇵🇭' },
  ];

  const STORAGE_KEY = 'payvexisLang';
  const RELOAD_FLAG = 'payvexisLangReload';
  const GOOGLE_TRANSLATE_ELEMENT_ID = 'google_translate_element';

  // ---- Detect browser language ----
  function detectBrowserLanguage() {
    const browserLang = navigator.language || navigator.languages?.[0] || 'en';
    const exactMatch = LANGUAGES.find(l => l.code.toLowerCase() === browserLang.toLowerCase());
    if (exactMatch) return exactMatch.code;

    const baseLang = browserLang.split('-')[0].toLowerCase();
    const baseMatch = LANGUAGES.find(l => l.code.toLowerCase() === baseLang || l.code.toLowerCase().startsWith(baseLang + '-'));
    return baseMatch ? baseMatch.code : 'en';
  }

  // ---- Get saved or detected language ----
  function getTargetLanguage() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && LANGUAGES.find(l => l.code === saved)) return saved;
    return detectBrowserLanguage();
  }

  function getLanguageInfo(code) {
    return LANGUAGES.find(l => l.code === code) || LANGUAGES[0];
  }

  // ---- Cookie helpers ----
  function setTranslateCookie(langCode) {
    const value = langCode && langCode !== 'en' ? `/en/${langCode}` : '';
    document.cookie = `googtrans=${value}; path=/; SameSite=Lax`;
    const hostname = window.location.hostname;
    if (hostname && hostname !== 'localhost') {
      document.cookie = `googtrans=${value}; path=/; domain=.${hostname}; SameSite=Lax`;
    }
  }

  function clearTranslateCookie() {
    document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
    document.cookie = 'googtrans=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; domain=.' + window.location.hostname;
  }

  // ---- Create the hidden Google Translate element ----
  function createGoogleTranslateElement() {
    if (document.getElementById(GOOGLE_TRANSLATE_ELEMENT_ID)) return;
    const el = document.createElement('div');
    el.id = GOOGLE_TRANSLATE_ELEMENT_ID;
    el.style.display = 'none';
    document.body.appendChild(el);
  }

  // ---- Load Google Translate script ----
  function loadGoogleTranslateScript() {
    return new Promise((resolve) => {
      if (window.google && window.google.translate) {
        resolve();
        return;
      }

      window.googleTranslateElementInit = function () {
        new window.google.translate.TranslateElement({
          pageLanguage: 'en',
          autoDisplay: false,
          layout: google.translate.TranslateElement.InlineLayout.SIMPLE
        }, GOOGLE_TRANSLATE_ELEMENT_ID);
        setTimeout(resolve, 500);
      };

      const script = document.createElement('script');
      script.src = 'https://translate.google.com/translate_a/element.js?cb=googleTranslateElementInit';
      script.async = true;
      document.head.appendChild(script);
    });
  }

  // ---- Switch language: set cookie + save + reload ----
  // This is the most reliable method — Google Translate reads the
  // googtrans cookie on page load and auto-translates accordingly.
  function switchLanguage(langCode) {
    localStorage.setItem(STORAGE_KEY, langCode);

    if (langCode === 'en') {
      clearTranslateCookie();
    } else {
      setTranslateCookie(langCode);
    }

    // Set flag to prevent infinite reload loop
    sessionStorage.setItem(RELOAD_FLAG, '1');
    window.location.reload();
  }

  // ---- Build the Custom UI ----
  function buildLanguageSelector() {
    const currentLang = getTargetLanguage();
    const currentInfo = getLanguageInfo(currentLang);
    const detectedLang = detectBrowserLanguage();

    const navbarActions = document.querySelector('.navbar-actions');
    if (!navbarActions) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'translate-wrapper';
    wrapper.id = 'translate-selector';

    wrapper.innerHTML = `
      <button class="translate-btn notranslate" aria-label="Change language" aria-expanded="false" aria-haspopup="listbox">
        <svg class="globe-icon" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 21a9 9 0 100-18 9 9 0 000 18z"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M3.6 9h16.8M3.6 15h16.8"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 3a15.3 15.3 0 014 9 15.3 15.3 0 01-4 9 15.3 15.3 0 01-4-9 15.3 15.3 0 014-9z"/>
        </svg>
        <span class="lang-label notranslate">${currentInfo.name}</span>
        <svg class="chevron-icon" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
        </svg>
      </button>
      <div class="translate-dropdown" role="listbox" aria-label="Select language">
        <div class="translate-search-wrap">
          <svg class="search-icon" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
          </svg>
          <input type="text" class="translate-search notranslate" placeholder="Search languages..." aria-label="Search languages"/>
        </div>
        <div class="translate-options-list"></div>
      </div>
    `;

    navbarActions.insertBefore(wrapper, navbarActions.firstChild);

    renderOptions(wrapper, currentLang, detectedLang, '');

    const btn = wrapper.querySelector('.translate-btn');
    const dropdown = wrapper.querySelector('.translate-dropdown');
    const searchInput = wrapper.querySelector('.translate-search');

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = wrapper.classList.toggle('open');
      btn.setAttribute('aria-expanded', isOpen);
      if (isOpen) {
        searchInput.value = '';
        renderOptions(wrapper, getCurrentActiveLang(), detectedLang, '');
        setTimeout(() => searchInput.focus(), 100);
      }
    });

    searchInput.addEventListener('input', () => {
      renderOptions(wrapper, getCurrentActiveLang(), detectedLang, searchInput.value);
    });

    dropdown.addEventListener('click', (e) => e.stopPropagation());

    document.addEventListener('click', () => {
      wrapper.classList.remove('open');
      btn.setAttribute('aria-expanded', 'false');
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        wrapper.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function getCurrentActiveLang() {
    return localStorage.getItem(STORAGE_KEY) || getTargetLanguage();
  }

  function renderOptions(wrapper, activeLang, detectedLang, filter) {
    const list = wrapper.querySelector('.translate-options-list');
    const filterLower = filter.toLowerCase().trim();

    let filteredLangs = LANGUAGES;
    if (filterLower) {
      filteredLangs = LANGUAGES.filter(l =>
        l.name.toLowerCase().includes(filterLower) ||
        l.code.toLowerCase().includes(filterLower)
      );
    }

    const detectedInfo = getLanguageInfo(detectedLang);
    const otherLangs = filteredLangs.filter(l => l.code !== detectedLang);

    let html = '';

    if (!filterLower || detectedInfo.name.toLowerCase().includes(filterLower) || detectedInfo.code.toLowerCase().includes(filterLower)) {
      html += `<div class="translate-section-label">Detected Language</div>`;
      html += buildOptionHTML(detectedInfo, activeLang, true);
      if (otherLangs.length) {
        html += `<div class="translate-divider"></div>`;
        html += `<div class="translate-section-label">All Languages</div>`;
      }
    }

    otherLangs.forEach(lang => {
      html += buildOptionHTML(lang, activeLang, false);
    });

    if (!html) {
      html = `<div style="padding: 1rem; text-align: center; color: rgba(148,163,184,0.5); font-size: 0.8rem;">No languages found</div>`;
    }

    list.innerHTML = html;

    list.querySelectorAll('.translate-option').forEach(opt => {
      opt.addEventListener('click', () => {
        const code = opt.dataset.lang;
        const current = getCurrentActiveLang();
        // Only switch if different language selected
        if (code !== current) {
          selectLanguage(code, wrapper);
        } else {
          // Same language, just close dropdown
          wrapper.classList.remove('open');
          wrapper.querySelector('.translate-btn').setAttribute('aria-expanded', 'false');
        }
      });
    });
  }

  function buildOptionHTML(lang, activeLang, isDetected) {
    const isActive = lang.code === activeLang;
    return `
      <button class="translate-option notranslate ${isActive ? 'active' : ''}" data-lang="${lang.code}" role="option" aria-selected="${isActive}">
        <span class="lang-flag">${lang.flag}</span>
        <span class="lang-name">${lang.name}</span>
        ${isDetected ? '<span class="translate-detected-badge">Auto</span>' : ''}
        <svg class="check-icon" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
        </svg>
      </button>
    `;
  }

  function selectLanguage(langCode, wrapper) {
    const langInfo = getLanguageInfo(langCode);

    // Update button label immediately for visual feedback
    const label = wrapper.querySelector('.lang-label');
    if (label) label.textContent = langInfo.name;

    // Close dropdown
    wrapper.classList.remove('open');
    wrapper.querySelector('.translate-btn').setAttribute('aria-expanded', 'false');

    // Switch language via cookie + reload (most reliable method)
    switchLanguage(langCode);
  }

  // ---- Initialize ----
  function init() {
    createGoogleTranslateElement();
    buildLanguageSelector();

    const targetLang = getTargetLanguage();

    if (targetLang !== 'en') {
      // Ensure cookie is set for this language
      setTranslateCookie(targetLang);
      // Load Google Translate — it will auto-translate from the cookie
      loadGoogleTranslateScript();
    } else {
      // English — make sure cookie is cleared so Google doesn't translate
      clearTranslateCookie();
      // Still load the script so switching works on first click
      loadGoogleTranslateScript();
    }

    // Clear the reload flag after successful init
    sessionStorage.removeItem(RELOAD_FLAG);
  }

  // Run when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
