/**
 * Find the element that will not fit.
 *
 * Loads a floor at a given width and prints the chain of nodes wider than the viewport, deepest
 * first, so the culprit is the first line rather than its twenty ancestors.
 *
 *   npx tsx tools/overflow.ts [base-url] [width]
 */
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://127.0.0.1:3111';
const width = Number(process.argv[3] ?? 430);

async function main(): Promise<number> {
  const opened = await fetch(`${base}/api/floor`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ seed: `overflow-${Date.now() % 10000}`, instruments: ['coffee-green'], agentsPerSide: 3, maxTicks: 8 }),
  });
  const { floor } = (await opened.json()) as { floor: string };
  for (let round = 0; round < 4; round += 1) {
    await fetch(`${base}/api/floor/${floor}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'step' }) });
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.goto(`${base}/floor/${floor}`, { waitUntil: 'networkidle' });
  const report = await page.evaluate(() => {
    const limit = window.innerWidth;
    const wide: string[] = [];
    for (const node of [...document.querySelectorAll('body *')]) {
      const box = node.getBoundingClientRect();
      if (box.width > limit + 1) {
        const label = `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}.${String(node.className ?? '').split(' ').slice(0, 4).join('.')}`;
        wide.push(`${Math.round(box.width)}px  ${label}  "${(node.textContent ?? '').trim().slice(0, 40)}"`);
      }
    }
    return wide;
  });
  await browser.close();
  console.log(report.length === 0 ? 'nothing is wider than the viewport.' : report.slice(0, 25).join('\n'));
  return report.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.log(String(error));
    process.exit(1);
  },
);
