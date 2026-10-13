/**
 * Look at the room with real eyes.
 *
 * Opens a floor, rings the bell until there is something to see, and photographs the landing, the pit,
 * the pile with a card read out, and the audit room at three widths while collecting every console
 * complaint and any horizontal overflow. Output lands in `shots/`, which is not committed; it is for
 * the person building the screens - and for the gallery a listing needs.
 *
 *   npx tsx tools/shots.ts [base-url]
 */
import { mkdirSync } from 'node:fs';
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:3111';
const outDir = 'shots';
mkdirSync(outDir, { recursive: true });

const sizes = [
  { name: 'wide', width: 1440, height: 900 },
  { name: 'laptop', width: 1180, height: 820 },
  { name: 'phone', width: 430, height: 932 },
];

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${base}${path}`, init);
  if (!response.ok) throw new Error(`${path} -> ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

interface Opened {
  floor: string;
}

interface TradeRow {
  id: string;
  held: boolean;
  phase: string;
}

const problems: string[] = [];

function watch(page: import('@playwright/test').Page, label: string): void {
  page.on('console', (message) => {
    // The dev server's hot-reload socket cannot upgrade inside a scripted browser; that is not the page's fault.
    if (/_next\/hmr/.test(message.text())) return;
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`${label} console ${message.type()}: ${message.text().slice(0, 200)}`);
  });
  page.on('pageerror', (error) => problems.push(`${label} pageerror: ${error.message.slice(0, 200)}`));
}

async function shot(page: import('@playwright/test').Page, name: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const wide = [...document.querySelectorAll('body *')].filter((node) => node.scrollWidth > node.clientWidth + 2 && node.clientWidth > 0);
    return {
      pageScroll: doc.scrollWidth,
      viewport: window.innerWidth,
      culprits: wide.slice(0, 5).map((node) => `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 40)} ${node.scrollWidth}>${node.clientWidth}`),
    };
  });
  if (overflow.pageScroll > overflow.viewport + 1) problems.push(`${name}: page scrolls sideways (${overflow.pageScroll}px in ${overflow.viewport}px) ${overflow.culprits.join(', ')}`);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: false });
  await page.screenshot({ path: `${outDir}/${name}-full.png`, fullPage: true });
  console.log(`shot ${name} ${overflow.pageScroll}px`);
}

async function main(): Promise<number> {
  const browser = await chromium.launch();
  try {
    const { floor } = await api<Opened>('/api/floor', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seed: 'gallery', instruments: ['coffee-green', 'cacao-fine'], agentsPerSide: 4, maxTicks: 12 }),
    });

    // Ring until the pile has something on it. A gallery shot of an empty pile photographs a product
    // that is not working, and how many rounds it takes before a settlement stops depends on the seed.
    let booked: TradeRow[] = [];
    for (let round = 0; round < 10; round += 1) {
      await api(`/api/floor/${floor}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'step' }) });
      const room = await api<{ snapshot: { trades: TradeRow[] } }>(`/api/floor/${floor}`);
      booked = room.snapshot.trades;
      if (booked.some((row) => row.held)) break;
    }

    const trade = booked.find((row) => row.held) ?? booked[0];
    console.log(`${booked.length} trade(s) booked, ${booked.filter((row) => row.held).length} held; photographing ${trade?.id ?? 'none'}`);

    const context = await browser.newContext({ viewport: { width: sizes[0]!.width, height: sizes[0]!.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    watch(page, 'page');

    await page.goto(`${base}/`, { waitUntil: 'networkidle' });
    await shot(page, 'landing-wide');

    await page.goto(`${base}/floor/${floor}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await shot(page, 'pit-wide');

    // open a dossier and the inspector so the side panels are photographed with content in them
    await page.locator('svg g.cursor-pointer').first().click({ force: true }).catch(() => undefined);
    await page.locator('button.tape-in').nth(6).click().catch(() => undefined);
    await page.waitForTimeout(300);
    await shot(page, 'pit-inspector');

    // The pile with one card read out loud. This is the screen where a model is doing a job on the
    // floor, so it is photographed with the attribution line in frame, and it is allowed to be slow:
    // a small model on a CPU takes half a minute over a paragraph.
    await page.goto(`${base}/floor/${floor}`, { waitUntil: 'networkidle' });
    const crier = page.getByRole('button', { name: 'have the crier read this chit' }).first();
    if ((await crier.count()) === 1) {
      await crier.click();
      const read = await page.getByText(/^written by/).first().waitFor({ timeout: 150_000 }).catch(() => null);
      if (read === null) problems.push('crier: no reading came back inside 150 seconds');
      else {
        await page.waitForTimeout(400);
        await shot(page, 'pit-crier');
      }
    } else {
      problems.push('crier: nothing was waiting on the pile to read');
    }

    // The audit room: the grid has to actually paint rows, not just mount.
    await page.goto(`${base}/audit?floor=${floor}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[role="row"]', { timeout: 15_000 }).catch(() => problems.push('audit: the journal grid never painted a row'));
    await page.waitForTimeout(600);
    const cells = await page.locator('[role="gridcell"]').count();
    if (cells === 0) problems.push('audit: no grid cells after the row selector resolved');
    console.log(`audit room: ${cells} grid cells`);
    await shot(page, 'audit-wide');

    const scrubber = page.locator('input.scrubber');
    if ((await scrubber.count()) === 1) {
      await scrubber.first().evaluate((node) => {
        const input = node as HTMLInputElement;
        const half = Math.floor((Number(input.min) + Number(input.max)) / 2);
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(input, String(half));
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForTimeout(400);
      await shot(page, 'audit-halfway');
    } else {
      problems.push('audit: no scrubber on the page');
    }

    await page.goto(`${base}/docs`, { waitUntil: 'networkidle' });
    await shot(page, 'docs-wide');

    // The two URLs the processor sends a buyer back to, plus one that names nothing.
    if (trade !== undefined) {
      await page.goto(`${base}/checkout/return?trade=${encodeURIComponent(trade.id)}`, { waitUntil: 'networkidle' });
      await shot(page, `checkout-return-${trade.phase}`);
      await page.goto(`${base}/checkout/cancel?trade=${encodeURIComponent(trade.id)}`, { waitUntil: 'networkidle' });
      await shot(page, 'checkout-cancel');
    }
    await page.goto(`${base}/checkout/return`, { waitUntil: 'networkidle' });
    await shot(page, 'checkout-no-trade');

    for (const size of sizes.slice(1)) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(`${base}/`, { waitUntil: 'networkidle' });
      await shot(page, `landing-${size.name}`);
      await page.goto(`${base}/floor/${floor}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await shot(page, `pit-${size.name}`);
      await page.goto(`${base}/docs`, { waitUntil: 'networkidle' });
      await shot(page, `docs-${size.name}`);
      await page.goto(`${base}/audit?floor=${floor}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      await shot(page, `audit-${size.name}`);
      if (trade !== undefined) {
        await page.goto(`${base}/checkout/return?trade=${encodeURIComponent(trade.id)}`, { waitUntil: 'networkidle' });
        await shot(page, `checkout-return-${size.name}`);
      }
    }

    await context.close();
  } finally {
    await browser.close();
  }

  if (problems.length > 0) {
    console.log(`\n${problems.length} problem(s):`);
    for (const problem of [...new Set(problems)]) console.log(`- ${problem}`);
    return 1;
  }
  console.log('\nno console errors, no sideways scroll.');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.log(`the walk crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  },
);
