#!/usr/bin/env node
import { chromium } from 'playwright';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const HELP = `
Usage:
  snap --browser [url]   Open a Chrome window that snap can capture from
  snap [url]             Capture the page as it is right now in that window (no reload).
                         Picks the tab matching <url>, or the visible tab if no url is given.
                         If that window isn't open, loads <url> fresh in a hidden browser.

Options:
  -o, --out <file>     Output PNG path (default: screenshots/<host>-<time>.png)
  -w, --width <px>     Page width (default: current window width, or 1440 when loading fresh)
      --mobile         Capture as a phone (390px wide)
  -s, --scale <n>      Pixel density, 2 = retina (default: 3)
      --wait <ms>      Extra wait before capturing (default: 300 for open tabs, 1000 fresh)
      --login          Hidden-browser mode only: log in once; the session is saved
      --open           Open the result in Preview
  -c, --copy           Copy the result to the clipboard
  -h, --help
`;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    width: { type: 'string', short: 'w' },
    mobile: { type: 'boolean' },
    scale: { type: 'string', short: 's' },
    wait: { type: 'string' },
    browser: { type: 'boolean' },
    login: { type: 'boolean' },
    open: { type: 'boolean' },
    copy: { type: 'boolean', short: 'c' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (opts.help) {
  console.log(HELP);
  process.exit(0);
}

let url = positionals[0];
if (url && !/^https?:\/\//.test(url)) {
  url = (/^(localhost|127\.|\d+$|:)/.test(url) ? 'http://' : 'https://') + url.replace(/^:/, 'localhost:');
}

const DEBUG_PORT = Number(process.env.SNAP_PORT ?? 9222);
const MAX_HEIGHT = 32000;
const DEFAULT_SCALE = 3;
const MAX_PIXELS = 120e6; // Chrome leaves unpainted gaps in captures much larger than this

if (opts.browser) {
  execFileSync('open', [
    '-na', 'Google Chrome', '--args',
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${path.join(import.meta.dirname, '.chrome-profile')}`,
    ...(url ? [url] : []),
  ]);
  console.log('Opened Chrome. Use your app in that window, then run `snap` to capture the current page.');
  process.exit(0);
}

const tab = !opts.login && (await findOpenTab(url));
let page, metrics, cleanup;

if (tab) {
  page = tab;
  const win = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }));
  metrics = {
    width: opts.mobile ? 390 : Number(opts.width ?? win.width),
    deviceScaleFactor: Number(opts.scale ?? Math.max(win.dpr, DEFAULT_SCALE)),
    mobile: !!opts.mobile,
  };
  cleanup = () => cdp.send('Emulation.clearDeviceMetricsOverride');
  console.log(`Capturing open tab: ${page.url()}`);
} else {
  if (!url) {
    console.log('No snap browser window is open. Run `snap --browser <url>` first, or pass a url to load fresh.');
    console.log(HELP);
    process.exit(1);
  }
  const context = await chromium.launchPersistentContext(path.join(import.meta.dirname, '.profile'), {
    headless: !opts.login,
    viewport: { width: opts.mobile ? 390 : Number(opts.width ?? 1440), height: opts.mobile ? 844 : 900 },
    deviceScaleFactor: Number(opts.scale ?? DEFAULT_SCALE),
    isMobile: !!opts.mobile,
    hasTouch: !!opts.mobile,
  });
  page = context.pages()[0] ?? (await context.newPage());
  metrics = { width: page.viewportSize().width, deviceScaleFactor: Number(opts.scale ?? DEFAULT_SCALE), mobile: !!opts.mobile };
  cleanup = () => context.close();

  if (opts.login) {
    await page.goto(url);
    console.log('Log in in the browser window, then close it. Your session will be saved.');
    await new Promise((resolve) => context.on('close', resolve));
    process.exit(0);
  }

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  } catch (e) {
    if (!/Timeout/.test(e.message)) {
      console.error(`Could not load ${url}: ${e.message.split('\n')[0]}`);
      await context.close();
      process.exit(1);
    }
  }
}

const cdp = await page.context().newCDPSession(page);
const setHeight = (height) => cdp.send('Emulation.setDeviceMetricsOverride', { ...metrics, height });
let height = await evaluate(() => window.innerHeight);
await setHeight(height);

// Remember scroll positions so an open tab is left as it was found
await evaluate(() => {
  window.__snapScroll = [[document.scrollingElement, window.scrollY]];
  for (const el of document.querySelectorAll('*')) if (el.scrollTop) window.__snapScroll.push([el, el.scrollTop]);
});

// Scroll through the page so lazy-loaded content renders
await evaluate(async () => {
  const step = window.innerHeight * 0.8;
  for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
    window.scrollTo(0, y);
    await new Promise((r) => setTimeout(r, 150));
  }
  window.scrollTo(0, 0);
});

// Many web apps scroll inside a container (100vh layout) rather than the page itself.
// Grow the viewport until no large container has hidden overflow, so it all renders at once.
for (let i = 0; i < 5; i++) {
  const extra = await evaluate(() => {
    let max = 0;
    for (const el of document.querySelectorAll('*')) {
      const { overflowY } = getComputedStyle(el);
      if (!/(auto|scroll)/.test(overflowY)) continue;
      if (el.clientHeight < window.innerHeight * 0.4) continue;
      max = Math.max(max, el.scrollHeight - el.clientHeight);
    }
    return max;
  });
  const next = Math.min(height + extra, MAX_HEIGHT);
  if (extra < 2 || next === height) break;
  height = next;
  await setHeight(height);
  await page.waitForTimeout(300);
}

const size = await evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight }));
const fit = Math.sqrt(MAX_PIXELS / (size.w * size.h));
if (metrics.deviceScaleFactor > fit) {
  metrics.deviceScaleFactor = Math.floor(fit * 10) / 10;
  await setHeight(height);
  console.log(`Note: very long page; using ${metrics.deviceScaleFactor}x resolution so it renders completely.`);
}

await page.waitForTimeout(Number(opts.wait ?? (tab ? 300 : 1000)));

if (!tab && page.url().replace(/\/$/, '') !== url.replace(/\/$/, '')) {
  console.log(`Note: page redirected to ${page.url()}`);
  if (/login|signin|sign-in|auth/i.test(page.url())) console.log('Looks like a login page; run once with --login.');
}

const host = new URL(page.url()).host.replace(/[^a-z0-9.-]/gi, '_');
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const out = path.resolve(opts.out ?? path.join(import.meta.dirname, 'screenshots', `${host}-${stamp}.png`));
mkdirSync(path.dirname(out), { recursive: true });

const { data } = await cdp.send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: true,
  clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 },
});
writeFileSync(out, Buffer.from(data, 'base64'));
await cleanup();
if (tab) {
  await evaluate(() => {
    for (const [el, top] of window.__snapScroll) el.scrollTop = top;
    delete window.__snapScroll;
  });
}
console.log(out);

if (opts.copy) {
  execFileSync('osascript', ['-e', `set the clipboard to (read (POSIX file "${out}") as «class PNGf»)`]);
  console.log('Copied to clipboard');
}
if (opts.open) execFileSync('open', [out]);
process.exit(0);

// Finds a tab in the `snap --browser` Chrome window: the one matching url, else the visible one
async function findOpenTab(url) {
  try {
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(500) });
  } catch {
    return null;
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
  const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => /^https?:/.test(p.url()));
  const matching = url ? pages.filter((p) => p.url().startsWith(url.replace(/\/$/, ''))) : pages;
  const visible = [];
  for (const p of matching) {
    if (await p.evaluate(() => document.visibilityState === 'visible').catch(() => false)) visible.push(p);
  }
  return visible.at(-1) ?? matching.at(-1) ?? null;
}

// Client-side redirects or dev-server reloads can navigate mid-capture; wait and retry.
async function evaluate(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await page.evaluate(fn);
    } catch (e) {
      if (attempt >= 4 || !/context was destroyed|navigat/i.test(e.message)) throw e;
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}
