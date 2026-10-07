import { h, icon } from './dom.js';

let container;

function root() {
  if (!container) {
    container = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
    document.body.append(container);
  }
  return container;
}

/**
 * Show a toast notification.
 * @param {{title: string, message?: string, kind?: 'info'|'success'|'error'|'warn', timeout?: number}} o
 */
export function toast({ title, message = '', kind = 'info', timeout = 4500 }) {
  const close = h(
    'button',
    { class: 'toast__close', 'aria-label': 'Dismiss notification' },
    icon('close', 'icon icon--sm'),
  );
  const el = h(
    'div',
    { class: `toast toast--${kind}` },
    h('span', { class: 'toast__icon', 'aria-hidden': 'true' }),
    h(
      'div',
      {},
      h('div', { class: 'toast__title' }, title),
      message ? h('div', { class: 'toast__msg' }, message) : null,
    ),
    close,
  );
  const remove = () => {
    if (!el.isConnected) return;
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 200);
  };
  close.addEventListener('click', remove);
  const r = root();
  r.append(el);
  while (r.children.length > 5) r.firstElementChild.remove();
  if (timeout) setTimeout(remove, timeout);
  return remove;
}
