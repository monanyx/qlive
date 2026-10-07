/** Small DOM helpers. All text goes through textContent — never innerHTML. */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * Hyperscript-style element builder.
 *   h('div', { class: 'row', dataset: { id: 1 }, onclick: fn }, 'text', child)
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** SVG icon from the sprite. */
export function icon(name, cls = 'icon') {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', cls);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', `assets/img/icons.svg#${name}`);
  svg.append(use);
  return svg;
}

/** Update textContent only when it changed (avoids needless layout work). */
export function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

/** Toggle up/down colour classes based on the sign of `n`. */
export function setTrend(el, n) {
  if (!el) return;
  el.classList.toggle('up', n > 0);
  el.classList.toggle('down', n < 0);
}

export const prefersReducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Brief background flash, e.g. when a value changes. */
export function flash(el, color) {
  if (!el || prefersReducedMotion() || !el.animate) return;
  el.animate([{ backgroundColor: color }, { backgroundColor: 'transparent' }], { duration: 600, easing: 'ease-out' });
}

/** Read a CSS custom property from :root. */
export function cssVar(name, el = document.documentElement) {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Device-pixel-ratio aware canvas sizing. Returns the 2D context or null if hidden. */
export function fitCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.round(rect.width * dpr);
  const hgt = Math.round(rect.height * dpr);
  if (canvas.width !== w || canvas.height !== hgt) {
    canvas.width = w;
    canvas.height = hgt;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: rect.width, h: rect.height, dpr };
}

/** Wire an ARIA tablist: arrow-key navigation + panel switching. */
export function tablist(root, { onChange, attr = 'aria-selected' } = {}) {
  const tabs = $$('[role="tab"]', root);
  const select = (tab, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute(attr, String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = t.getAttribute('aria-controls');
      if (panel) document.getElementById(panel)?.toggleAttribute('hidden', !on);
    }
    if (focus) tab.focus();
    onChange?.(tab.dataset.value ?? tab.id, tab);
  };
  root.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab && root.contains(tab)) select(tab);
  });
  root.addEventListener('keydown', (e) => {
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = tabs.length - 1;
    if (j != null) {
      e.preventDefault();
      select(tabs[j], true);
    }
  });
  return {
    select: (value) => {
      const t = tabs.find((x) => (x.dataset.value ?? x.id) === value);
      if (t) select(t);
    },
  };
}

/** Wire a group of toggle buttons (single choice) using aria-pressed/aria-checked. */
export function choiceGroup(root, { attr = 'aria-pressed', onChange } = {}) {
  const buttons = $$('button[data-value]', root);
  const set = (value, emit = true) => {
    for (const b of buttons) b.setAttribute(attr, String(b.dataset.value === String(value)));
    if (emit) onChange?.(value);
  };
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (b && root.contains(b)) set(b.dataset.value);
  });
  return { set, get: () => buttons.find((b) => b.getAttribute(attr) === 'true')?.dataset.value };
}

/** '#rrggbb' (or 'rgb(r,g,b)') → 'rgba(r,g,b,a)'. */
export function alpha(color, a) {
  const c = color.trim();
  let r;
  let g;
  let b;
  if (c.startsWith('#')) {
    const hex = c.length === 4 ? [...c.slice(1)].map((x) => x + x).join('') : c.slice(1, 7);
    r = parseInt(hex.slice(0, 2), 16);
    g = parseInt(hex.slice(2, 4), 16);
    b = parseInt(hex.slice(4, 6), 16);
  } else {
    [r, g, b] = (c.match(/[\d.]+/g) ?? [0, 0, 0]).map(Number);
  }
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export const getThemeName = () => document.documentElement.dataset.theme || 'dark';
