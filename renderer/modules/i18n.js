// ── Porkfolio i18n engine ─────────────────────────────────────────────────────
// Loaded first so window.t() is available to all modules.
// Call window.i18n.load(code) to fetch a lang file and re-apply all translations.

window.i18n = {
  current: 'en',
  strings: {},

  /** Translate a key. Falls back to `fallback` if provided, then the key itself. */
  t(key, fallback) {
    const v = this.strings[key];
    if (v !== undefined) return v;
    return fallback !== undefined ? fallback : key;
  },

  /** Walk every [data-i18n] element and set its textContent to the translated string.
   *  If no translation exists for a key the original text is left unchanged. */
  apply() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const val = this.strings[el.dataset.i18n];
      if (val !== undefined) el.textContent = val;
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
      const val = this.strings[el.dataset.i18nPlaceholder];
      if (val !== undefined) el.placeholder = val;
    });
    document.querySelectorAll('[data-i18n-title]').forEach(el => {
      const val = this.strings[el.dataset.i18nTitle];
      if (val !== undefined) el.title = val;
    });
  },

  /** Load a language file by code (e.g. "en", "fr", "de") via IPC, then apply. */
  async load(code) {
    if (!code) code = 'en';
    try {
      const data = await window.pork.langLoad(code);
      if (data && typeof data.strings === 'object') {
        this.strings = data.strings;
        this.current = code;
      }
    } catch (e) {
      console.warn('[i18n] Could not load language "' + code + '":', e.message || e);
      // Fall back to empty (original HTML text remains visible)
      this.strings = {};
      this.current = 'en';
    }
    this.apply();
  },
};

/** Shorthand global translate function */
window.t = (key, fallback) => window.i18n.t(key, fallback);
