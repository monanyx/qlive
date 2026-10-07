import { SYMBOLS } from '../core/config.js';
import { fmtDateTime, fmtPrice, fmtSize, fmtTime, fmtUsd, fmtUsdSigned } from '../core/format.js';
import { QUOTE } from '../trading/paper-engine.js';
import { h, icon, setText } from './dom.js';

const pDec = (sym) => SYMBOLS[sym]?.priceDecimals ?? 2;
const sDec = (sym) => SYMBOLS[sym]?.sizeDecimals ?? 4;
const signed = (n) => h('span', { class: n > 0 ? 'up' : n < 0 ? 'down' : '' }, fmtUsdSigned(n));
const sideTag = (side) => h('span', { class: side === 'buy' ? 'up' : 'down' }, side.toUpperCase());
const TYPE = { limit: 'Limit', market: 'Market', stop: 'Stop' };

function table(cols, rows, empty) {
  if (!rows.length) return h('div', { class: 'empty' }, ...empty);
  return h(
    'table',
    { class: 'table mono' },
    h('thead', {}, h('tr', {}, ...cols.map(([label, r]) => h('th', { class: r ? 'r' : '', scope: 'col' }, label)))),
    h(
      'tbody',
      {},
      rows.map((cells) => h('tr', {}, ...cells.map((c, i) => h('td', { class: cols[i][1] ? 'r' : '' }, c)))),
    ),
  );
}

/** Tables for the paper account: positions, open orders, history, fills, alerts. */
export class AccountView {
  constructor({ panels, engine, alerts, counts, actions }) {
    this.p = panels;
    this.engine = engine;
    this.alerts = alerts;
    this.counts = counts;
    this.actions = actions;
    this.keys = {};

    // Event delegation for row buttons.
    for (const el of Object.values(panels)) {
      el.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-act]');
        if (!b) return;
        const { act, id } = b.dataset;
        this.actions[act]?.(id);
      });
    }
  }

  /** Re-render a panel only when its data changed. */
  #swap(name, key, build) {
    if (this.keys[name] === key) return;
    this.keys[name] = key;
    this.p[name].replaceChildren(build());
  }

  render() {
    const s = this.engine.state;
    const open = s.orders;
    setText(this.counts.orders, String(open.length));
    this.counts.orders.hidden = !open.length;
    setText(this.counts.alerts, String(this.alerts.list.length));
    this.counts.alerts.hidden = !this.alerts.list.length;

    // Positions (marks move constantly — key on rounded values).
    const pos = this.engine.positions();
    const sum = this.engine.summary();
    const pkey = JSON.stringify([
      pos.map((p) => [p.asset, p.qty, Math.round(p.value * 100)]),
      Math.round(sum.cash * 100),
      Math.round(sum.availableCash * 100),
    ]);
    this.#swap('positions', pkey, () =>
      h(
        'div',
        {},
        table(
          [
            ['Asset'],
            ['Amount', 1],
            ['Avg cost', 1],
            ['Mark', 1],
            ['Value', 1],
            ['Unrealised', 1],
            ['Realised', 1],
            ['', 1],
          ],
          [
            [
              h('strong', {}, QUOTE),
              fmtUsd(sum.cash),
              '—',
              '—',
              fmtUsd(sum.cash),
              h('span', { class: 'faint' }, `avail ${fmtUsd(sum.availableCash)}`),
              '—',
              '',
            ],
            ...pos.map((p) => [
              h('strong', {}, p.asset),
              fmtSize(p.qty, sDec(p.asset)),
              fmtPrice(p.avgCost, pDec(p.asset)),
              fmtPrice(p.mark, pDec(p.asset)),
              fmtUsd(p.value),
              p.qty > 0 ? signed(p.unrealized) : '—',
              signed(p.realized),
              p.available > 0
                ? h(
                    'button',
                    {
                      class: 'btn btn--xs btn--outline',
                      dataset: { act: 'close', id: p.asset },
                      title: `Market-sell all ${p.asset}`,
                    },
                    'Close',
                  )
                : '',
            ]),
          ],
          [],
        ),
      ),
    );

    // Open orders
    this.#swap('orders', JSON.stringify(open.map((o) => [o.id, o.filled])), () =>
      table(
        [['Time'], ['Pair'], ['Type'], ['Side'], ['Price', 1], ['Amount', 1], ['Filled', 1], ['', 1]],
        open.map((o) => [
          fmtTime(o.createdAt),
          `${o.symbol}-USD`,
          TYPE[o.type] + (o.postOnly ? ' · PO' : ''),
          sideTag(o.side),
          o.type === 'stop'
            ? `${o.side === 'buy' ? '≥' : '≤'} ${fmtPrice(o.stopPrice, pDec(o.symbol))}`
            : fmtPrice(o.price, pDec(o.symbol)),
          fmtSize(o.qty, sDec(o.symbol)),
          `${((o.filled / o.qty) * 100).toFixed(0)}%`,
          h(
            'button',
            {
              class: 'btn btn--xs btn--ghost btn--danger',
              dataset: { act: 'cancel', id: o.id },
              'aria-label': 'Cancel order',
            },
            'Cancel',
          ),
        ]),
        [h('strong', {}, 'No open orders'), 'Limit and stop orders rest here until they fill.'],
      ),
    );

    // Order history
    this.#swap('history', `${s.history.length}:${s.history[0]?.id}:${s.history[0]?.status}`, () =>
      table(
        [['Time'], ['Pair'], ['Type'], ['Side'], ['Avg price', 1], ['Filled', 1], ['Fees', 1], ['Status']],
        s.history.slice(0, 120).map((o) => [
          fmtDateTime(o.updatedAt),
          `${o.symbol}-USD`,
          TYPE[o.type],
          sideTag(o.side),
          fmtPrice(o.avgPrice, pDec(o.symbol)),
          `${fmtSize(o.filled, sDec(o.symbol))} / ${fmtSize(o.qty, sDec(o.symbol))}`,
          fmtUsd(o.fees),
          h(
            'span',
            {
              class: o.status === 'filled' ? 'up' : o.status === 'rejected' ? 'down' : 'faint',
              title: o.reason ?? '',
            },
            o.status + (o.reason ? ` — ${o.reason}` : ''),
          ),
        ]),
        [h('strong', {}, 'No orders yet'), 'Use the ticket on the right to place a paper trade.'],
      ),
    );

    // Fills
    this.#swap('fills', `${s.fills.length}:${s.fills[0]?.id}`, () =>
      table(
        [['Time'], ['Pair'], ['Side'], ['Price', 1], ['Amount', 1], ['Fee', 1], ['Liquidity']],
        s.fills
          .slice(0, 150)
          .map((f) => [
            fmtDateTime(f.ts),
            `${f.symbol}-USD`,
            sideTag(f.side),
            fmtPrice(f.price, pDec(f.symbol)),
            fmtSize(f.qty, sDec(f.symbol)),
            fmtUsd(f.fee, 4),
            f.liquidity,
          ]),
        [h('strong', {}, 'No fills yet'), 'Executions appear here and as markers on the chart.'],
      ),
    );

    // Alerts
    const al = this.alerts.list;
    this.#swap('alerts', JSON.stringify(al.map((a) => a.id)), () =>
      table(
        [['Pair'], ['Condition'], ['Price', 1], ['Created'], ['', 1]],
        al.map((a) => [
          `${a.symbol}-USD`,
          a.direction === 'above' ? 'Price rises to' : 'Price falls to',
          fmtPrice(a.price, pDec(a.symbol)),
          fmtDateTime(a.createdAt),
          h(
            'button',
            {
              class: 'btn btn--xs btn--ghost',
              dataset: { act: 'removeAlert', id: a.id },
              'aria-label': 'Remove alert',
            },
            icon('trash', 'icon icon--sm'),
          ),
        ]),
        [h('strong', {}, 'No price alerts'), 'Alt+click the chart or press A to add one at the current price.'],
      ),
    );
  }
}
