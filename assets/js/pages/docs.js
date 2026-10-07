import { $$, h } from '../ui/dom.js';
import { initSite } from '../ui/site.js';

initSite();

/* Scroll-spy: highlight the section currently in view in the table of contents. */
const links = new Map($$('.toc a').map((a) => [a.getAttribute('href').slice(1), a]));
const visible = new Set();
const io = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target.id);
      else visible.delete(e.target.id);
    }
    const current = [...links.keys()].find((id) => visible.has(id));
    if (!current) return;
    for (const [id, a] of links) {
      a.classList.toggle('is-active', id === current);
      if (id === current) a.setAttribute('aria-current', 'location');
      else a.removeAttribute('aria-current');
    }
  },
  { rootMargin: '-80px 0px -60% 0px' },
);
for (const id of links.keys()) {
  const el = document.getElementById(id);
  if (el) io.observe(el);
}

/* Copy buttons on code blocks. */
for (const pre of $$('.prose pre')) {
  const btn = h('button', { type: 'button', class: 'btn btn--xs btn--outline copy-btn' }, 'Copy');
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText((pre.querySelector('code') ?? pre).textContent.trim());
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Press Ctrl+C';
    }
    setTimeout(() => (btn.textContent = 'Copy'), 1600);
  });
  pre.classList.add('has-copy');
  pre.append(btn);
}
