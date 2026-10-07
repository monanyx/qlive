/**
 * Static integrity checks for the build-free site: every page is well-formed
 * and locked down, every local reference resolves, every module import
 * resolves, and the service worker precaches exactly the shipped assets.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');
const PAGES = ['index.html', 'terminal.html', 'markets.html', 'docs.html', '404.html'];

const walk = (dir) =>
  readdirSync(join(root, dir)).flatMap((f) => {
    const p = join(dir, f);
    return statSync(join(root, p)).isDirectory() ? walk(p) : [p];
  });

test('every page has the essentials', () => {
  for (const page of PAGES) {
    const html = read(page);
    assert.match(html, /^<!doctype html>/i, `${page}: doctype`);
    assert.match(html, /<html lang="en"/, `${page}: lang`);
    assert.match(html, /<meta name="viewport"/, `${page}: viewport`);
    assert.match(html, /<title>[^<]+<\/title>/, `${page}: title`);
    assert.match(html, /http-equiv="Content-Security-Policy"/, `${page}: CSP`);
    assert.doesNotMatch(html, /'unsafe-eval'/, `${page}: no unsafe-eval`);
    assert.doesNotMatch(html, /script-src[^;"]*'unsafe-inline'/, `${page}: no inline scripts allowed`);
    assert.doesNotMatch(html, /\sstyle="/, `${page}: no inline style attributes`);
    assert.doesNotMatch(html, /\son[a-z]+="/, `${page}: no inline event handlers`);
    assert.doesNotMatch(
      html,
      /(src|href)="https?:\/\/(?!github\.com|www\.tradingview\.com)/,
      `${page}: no third-party resources`,
    );
  }
});

test('every local href/src in the pages resolves to a file', () => {
  for (const page of PAGES) {
    const html = read(page);
    for (const [, url] of html.matchAll(/(?:href|src)="([^"#?]+)[^"]*"/g)) {
      if (/^(https?:|mailto:|data:)/.test(url) || url === './') continue;
      const path = url.split('#')[0];
      assert.ok(existsSync(join(root, path)), `${page} → ${url}`);
    }
  }
});

test('every ES module import resolves', () => {
  const modules = walk('assets/js').filter((f) => f.endsWith('.js'));
  for (const mod of modules) {
    const src = read(mod);
    for (const [, spec] of src.matchAll(/(?:import|export)\s[^'"]*?from\s+'([^']+)'/g)) {
      const target = normalize(join(dirname(mod), spec));
      assert.ok(existsSync(join(root, target)), `${mod} imports missing ${spec}`);
    }
  }
});

test('service worker precaches exactly the shipped assets', () => {
  const sw = read('sw.js');
  const list = [...sw.match(/const PRECACHE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const f of list) assert.ok(f === './' || existsSync(join(root, f)), `precached file missing: ${f}`);

  const shipped = [...walk('assets'), ...walk('vendor')]
    .map((f) => relative(root, join(root, f)).split('\\').join('/'))
    .filter((f) => !/\.txt$|LICENSE$|og-image\.png$/.test(f));
  for (const f of shipped) assert.ok(list.includes(f), `asset not precached: ${f}`);
  for (const page of PAGES) assert.ok(list.includes(page), `page not precached: ${page}`);
});

test('manifest is valid and its icons exist', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.ok(m.start_url && m.scope);
  for (const icon of m.icons) assert.ok(existsSync(join(root, icon.src)), icon.src);
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'));
});

test('connect-src covers every endpoint the feeds use', () => {
  const csp = read('terminal.html').match(/content="(default-src[^"]+)"/)[1];
  const sources = [read('assets/js/feeds/exchanges.js'), read('assets/js/feeds/history.js')].join('\n');
  const hosts = new Set(
    [...sources.matchAll(/(wss|https):\/\/([a-z0-9.-]+(?::\d+)?)/g)].map((m) => `${m[1]}://${m[2]}`),
  );
  for (const host of hosts) assert.ok(csp.includes(host), `terminal CSP missing ${host}`);
});
