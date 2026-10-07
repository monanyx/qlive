/**
 * Browser smoke test: serves the site, drives every page in headless
 * Chromium and checks the critical paths of the terminal using the
 * (deterministic, offline) simulator feed.
 *
 *   npm run test:e2e        (requires `npx playwright install chromium`)
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../..', import.meta.url));
const PORT = 8790;
const BASE = `http://localhost:${PORT}`;
let server;
let browser;

// Exchange connectivity depends on the network the test runs on; failures
// to reach a venue are expected and handled by the app (simulator fallback).
const IGNORED =
  /coinbase\.com|binance\.(com|vision)|kraken\.com|ERR_TUNNEL|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|WebSocket connection|status of 404/;

async function open(path, { width = 1440, height = 900, theme = 'dark' } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && !IGNORED.test(m.text()) && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(() =>
    document.addEventListener('securitypolicyviolation', (e) =>
      console.error(`CSP violation: ${e.violatedDirective} ${e.blockedURI}`),
    ),
  );
  await page.goto(`${BASE}/${path}`);
  return { page, ctx, errors };
}

before(async () => {
  server = spawn(process.execPath, ['scripts/serve.mjs', String(PORT)], { cwd: root, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 500));
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.kill();
});

describe('pages', () => {
  for (const path of ['index.html', 'markets.html', 'docs.html', 'terminal.html?exchange=sim']) {
    test(`${path} loads cleanly on desktop and mobile`, async () => {
      for (const width of [1440, 390]) {
        const { page, ctx, errors } = await open(`${path}${path.includes('?') ? '&' : '?'}nosw`, {
          width,
          height: 860,
        });
        await page.waitForTimeout(1500);
        const [scroll, client] = await page.evaluate(() => [
          document.documentElement.scrollWidth,
          document.documentElement.clientWidth,
        ]);
        assert.ok(scroll <= client, `${path} @${width}px overflows horizontally (${scroll} > ${client})`);
        assert.deepEqual(errors, [], `${path} @${width}px console errors`);
        await ctx.close();
      }
    });
  }

  test('404 page is styled at a nested path', async () => {
    const { page, ctx } = await open('a/b/c/missing');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(bg, 'rgba(0, 0, 0, 0)', 'stylesheet did not load');
    assert.match(await page.textContent('h1'), /never filled/);
    await ctx.close();
  });
});

describe('terminal (simulator)', () => {
  let page;
  let ctx;
  let errors;

  before(async () => {
    ({ page, ctx, errors } = await open('terminal.html?exchange=sim&symbol=BTC&nosw'));
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.waitForFunction(() => document.querySelectorAll('.book-row:not(.is-empty)').length > 10, null, {
      timeout: 10_000,
    });
  });

  after(() => ctx.close());

  test('streams book, trades and stats', async () => {
    await page.waitForFunction(() => document.querySelectorAll('#tp-trades .tape-row').length > 5);
    assert.match(await page.textContent('#conn-text'), /Simulator/);
    assert.match(await page.textContent('#s-last'), /\d/);
    const crossed = await page.evaluate(() => window.qlive.market.book.isCrossed);
    assert.equal(crossed, false);
    // Row count follows the panel height and must not feed back into it.
    const rows = await page.$$eval('.book-row:not([hidden])', (els) => els.length);
    assert.ok(rows > 10 && rows <= 120, `book rows: ${rows}`);
  });

  test('market order fills against the book', async () => {
    await page.click('#f-type button[data-value="market"]');
    await page.fill('#f-amount', '0.5');
    await page.waitForFunction(() => /\d/.test(document.querySelector('#e-price').textContent));
    await page.click('#f-submit');
    const state = await page.evaluate(() => window.qlive.engine.state);
    assert.equal(state.history[0].status, 'filled');
    assert.ok(Math.abs(state.balances.BTC - 0.5) < 1e-9);
    assert.ok(state.balances.USD < 100_000);
  });

  test('limit order rests, shows up and can be cancelled', async () => {
    await page.click('#f-type button[data-value="limit"]');
    const mid = await page.evaluate(() => window.qlive.market.book.mid);
    await page.fill('#f-price', String(Math.round(mid * 0.98)));
    await page.fill('#f-amount', '0.1');
    await page.click('#f-submit');
    await page.click('#t-orders');
    await page.waitForSelector('#ap-orders button[data-act="cancel"]');
    await page.click('#ap-orders button[data-act="cancel"]');
    await page.waitForFunction(() => window.qlive.engine.state.orders.length === 0);
  });

  test('invalid orders are rejected with a message', async () => {
    await page.click('#f-type button[data-value="market"]');
    await page.fill('#f-amount', '100000');
    await page.click('#f-submit');
    assert.match(await page.textContent('#f-error'), /liquidity|balance/i);
  });

  test('chart views, timeframes and theme switch', async () => {
    await page.click('#main');
    for (const key of ['d', 'h', 'c']) {
      await page.keyboard.press(key);
      await page.waitForTimeout(200);
    }
    assert.equal(await page.isVisible('#candles'), true);
    await page.click('#tf button[data-value="1"]');
    assert.match(page.url(), /tf=1/);
    const before = await page.getAttribute('html', 'data-theme');
    await page.click('#btn-theme');
    assert.notEqual(await page.getAttribute('html', 'data-theme'), before);
  });

  test('switching market resets the book and updates the URL', async () => {
    await page.selectOption('#symbol', 'ETH');
    await page.waitForFunction(
      () =>
        window.qlive.symbol === 'ETH' && window.qlive.market.book.mid > 100 && window.qlive.market.book.mid < 100_000,
    );
    assert.match(page.url(), /symbol=ETH/);
  });

  test('no console errors during the session', () => {
    assert.deepEqual(errors, []);
  });
});
