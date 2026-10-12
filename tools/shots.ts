/**
 * Look at the room with real eyes.
 *
 * Opens a floor, rings the bell until there is something to see, and photographs the landing and the
 * pit at three widths while collecting every console complaint and any horizontal overflow. Output
 * lands in `shots/`, which is not committed; it is for the person building the screens.
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
      body: JSON.stringify({ seed: `shots-${Date.now() % 100000}`, instruments: ['coffee-green', 'cacao-fine'], agentsPerSide: 4, maxTicks: 10 }),
    });

    for (let round = 0; round < 6; round += 1) {
      await api(`/api/floor/${floor}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'step' }) });
    }

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

    for (const size of sizes.slice(1)) {
      await page.setViewportSize({ width: size.width, height: size.height });
      await page.goto(`${base}/`, { waitUntil: 'networkidle' });
      await shot(page, `landing-${size.name}`);
      await page.goto(`${base}/floor/${floor}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await shot(page, `pit-${size.name}`);
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
