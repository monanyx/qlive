#!/usr/bin/env node
/**
 * Regenerates binary assets with headless Chromium:
 *   • PWA icons (192, 512, maskable 512) from favicon.svg
 *   • Open Graph preview image (1200×630) from the landing page hero
 *   • README screenshots of the terminal (simulator mode)
 *
 *   npm run assets
 *
 * Requires the `playwright` dev dependency and a Chromium build
 * (`npx playwright install chromium` if one is not already available).
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8765;
const BASE = `http://localhost:${PORT}`;

const server = spawn(process.execPath, ['scripts/serve.mjs', String(PORT)], { cwd: root, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 600));

const browser = await chromium.launch();
try {
  await mkdir(`${root}assets/icons`, { recursive: true });
  await mkdir(`${root}docs/screenshots`, { recursive: true });

  // ---------------------------------------------------------------- icons
  const svg = await readFile(`${root}favicon.svg`, 'utf8');
  const icon = async (size, file, { maskable = false } = {}) => {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    const pad = maskable ? Math.round(size * 0.18) : 0;
    await page.setContent(
      `<html><body style="margin:0;background:#070a12;display:grid;place-items:center;width:${size}px;height:${size}px">
        <div style="width:${size - pad * 2}px;height:${size - pad * 2}px">${svg.replace('<svg ', '<svg width="100%" height="100%" ')}</div>
      </body></html>`,
    );
    await page.screenshot({ path: `${root}assets/icons/${file}`, omitBackground: !maskable });
    await page.close();
  };
  await icon(192, 'icon-192.png');
  await icon(512, 'icon-512.png');
  await icon(512, 'icon-maskable-512.png', { maskable: true });
  console.log('✓ icons');

  // ------------------------------------------------------------- OG image
  {
    const ctx = await browser.newContext({
      viewport: { width: 1200, height: 630 },
      colorScheme: 'dark',
      bypassCSP: true,
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/index.html?nosw`);
    await page.addStyleTag({
      content: '.site-header{display:none}.hero{padding-top:56px}.ticker-strip,.ticker-source{display:none}',
    });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${root}assets/img/og-image.png` });
    await ctx.close();
    console.log('✓ og-image');
  }

  // ---------------------------------------------------------- screenshots
  const shoot = async (name, { width = 1440, height = 900, theme = 'dark', url, setup, mobile = false }) => {
    const ctx = await browser.newContext({
      viewport: { width, height },
      colorScheme: theme,
      deviceScaleFactor: mobile ? 2 : 1,
      isMobile: mobile,
      hasTouch: mobile,
    });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${url}`);
    await page.waitForTimeout(3500);
    if (setup) await setup(page);
    await page.screenshot({ path: `${root}docs/screenshots/${name}.png` });
    await ctx.close();
    console.log(`✓ ${name}`);
  };

  const trade = async (page) => {
    await page.click('#f-type button[data-value="market"]');
    await page.fill('#f-amount', '0.4');
    await page.click('#f-submit');
    await page.click('#f-type button[data-value="limit"]');
    const mid = await page.evaluate(() => window.qlive.market.book.mid);
    await page.fill('#f-price', String(Math.round(mid * 0.997)));
    await page.fill('#f-amount', '0.25');
    await page.click('#f-submit');
    await page.waitForTimeout(4500);
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  };

  await shoot('terminal-dark', { url: 'terminal.html?exchange=sim&symbol=BTC&tf=60&nosw', setup: trade });
  await shoot('terminal-light', {
    theme: 'light',
    url: 'terminal.html?exchange=sim&symbol=ETH&tf=60&nosw',
    setup: async (page) => {
      await page.keyboard.press('d');
      await page.waitForTimeout(800);
    },
  });
  await shoot('heatmap', {
    url: 'terminal.html?exchange=sim&symbol=SOL&nosw',
    setup: async (page) => {
      await page.keyboard.press('h');
      await page.waitForTimeout(12_000);
    },
  });
  await shoot('landing', { url: 'index.html?nosw', height: 900 });
  await shoot('mobile', { width: 390, height: 844, mobile: true, url: 'terminal.html?exchange=sim&symbol=BTC&nosw' });
} finally {
  await browser.close();
  server.kill();
}
