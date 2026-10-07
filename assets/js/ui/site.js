import { onThemeChange, toggleTheme } from './theme.js';
import { $, $$ } from './dom.js';

/**
 * Shared page chrome: theme toggle, mobile navigation, footer year and
 * service-worker registration (offline support / installable PWA).
 */
export function initSite() {
  for (const btn of $$('[data-action="theme"], #btn-theme')) btn.addEventListener('click', toggleTheme);

  const menu = $('#nav-toggle');
  const nav = $('#site-nav');
  if (menu && nav) {
    menu.addEventListener('click', () => {
      const open = menu.getAttribute('aria-expanded') !== 'true';
      menu.setAttribute('aria-expanded', String(open));
      nav.classList.toggle('is-open', open);
    });
    nav.addEventListener('click', (e) => {
      if (e.target.closest('a')) {
        menu.setAttribute('aria-expanded', 'false');
        nav.classList.remove('is-open');
      }
    });
  }

  for (const el of $$('[data-year]')) el.textContent = String(new Date().getFullYear());

  // Network-first service worker: always fresh online, still works offline.
  if (
    'serviceWorker' in navigator &&
    window.isSecureContext &&
    location.protocol.startsWith('http') &&
    !location.search.includes('nosw')
  ) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch((err) => console.info('[sw] registration failed', err));
    });
  }

  return { onThemeChange };
}
