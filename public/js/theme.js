/* talktalk appearance: light / dark / match-device, plus an accent colour.
   Loaded in <head> before the stylesheets apply, so the page never flashes
   the wrong theme. The choice is remembered per device (localStorage). */
(() => {
  'use strict';

  const KEY = 'tt:appearance';
  const MODES = ['system', 'light', 'dark'];
  const ACCENTS = ['lavender', 'sky', 'mint', 'rose', 'neutral'];
  const DEFAULTS = { mode: 'system', accent: 'lavender' };
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const listeners = new Set();

  function load() {
    try {
      const saved = JSON.parse(localStorage.getItem(KEY)) || {};
      return {
        mode: MODES.includes(saved.mode) ? saved.mode : DEFAULTS.mode,
        accent: ACCENTS.includes(saved.accent) ? saved.accent : DEFAULTS.accent,
      };
    } catch {
      return { ...DEFAULTS };
    }
  }

  let current = load();

  function apply() {
    const dark = current.mode === 'dark' || (current.mode === 'system' && darkQuery.matches);
    const root = document.documentElement;
    root.dataset.theme = dark ? 'dark' : 'light';
    root.dataset.accent = current.accent;
    listeners.forEach((fn) => fn({ ...current, dark }));
  }

  // Follow the device live while "Auto" is chosen.
  darkQuery.addEventListener('change', () => current.mode === 'system' && apply());

  window.ttAppearance = {
    MODES,
    ACCENTS,
    get: () => ({ ...current }),
    set(changes) {
      current = { ...current, ...changes };
      if (!MODES.includes(current.mode)) current.mode = DEFAULTS.mode;
      if (!ACCENTS.includes(current.accent)) current.accent = DEFAULTS.accent;
      try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode */ }
      apply();
    },
    onChange: (fn) => listeners.add(fn),
  };

  apply();
})();
