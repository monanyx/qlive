/**
 * Theme handling. The initial theme is applied before first paint by the
 * classic script assets/js/boot.js; this module handles toggling and lets
 * canvas-based views react to changes.
 */
const KEY = 'qlive.theme';
const listeners = new Set();

export const getTheme = () => document.documentElement.dataset.theme || 'dark';

export function setTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* storage unavailable */
    }
  }
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#f3f5fa' : '#05060b');
  for (const fn of listeners) fn(theme);
}

export const toggleTheme = () => setTheme(getTheme() === 'dark' ? 'light' : 'dark');

export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Follow OS changes until the user picks a theme explicitly.
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', (e) => {
  let stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    /* ignore */
  }
  if (!stored) setTheme(e.matches ? 'light' : 'dark', false);
});
