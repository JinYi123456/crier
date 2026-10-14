import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * One shift at one desk, in a browser.
 *
 * Open a floor, ring until something stops on the pile, have the crier read that card, refuse it with
 * a reason, and then ask the audit room whether the books still agree. The assertions are the words on
 * the screen rather than a JSON shape - the API has its own tests, and what is being proved here is
 * that a person following a link can do the whole thing with a mouse.
 *
 * Every navigation carries the floor's pointer in the query on purpose: that is the address a visitor
 * gets from the front door, and it is the only spelling that works when the machine painting the page
 * never saw the floor opened. It also means this file can run against a hosted URL, not only against
 * the process that answered the first request.
 *
 * The reading is the slow step. On a machine with a model available the interpreter is a small one
 * running on a CPU and a paragraph takes half a minute; with none, the desk template answers at once
 * and says it was the template. Both are held to the same thing - the amount printed on the card has
 * to appear in the sentence about that card.
 */

const RUN = process.env.E2E_SEED ?? `e2e-${Date.now().toString(36)}`;

interface Pointer {
  readonly seed: string;
  readonly instruments: string;
  readonly agents: string;
  readonly ticks: string;
  readonly gateway: string;
  readonly payout: string;
}

/**
 * A floor of its own per test. A room lives in the memory of the process that opened it and a replay
 * only moves forward, so two tests sharing a seed would share a round too - the second would find the
 * desk standing wherever the first one left it.
 */
function pointerFor(name: string): Pointer {
  return {
    seed: `${RUN}-${name}`,
    instruments: 'coffee-green,saffron',
    agents: '3',
    ticks: '10',
    gateway: 'sim',
    payout: 'immediate',
  };
}

interface Snapshot {
  headHash: string;
  trades: { id: string; held: boolean; phase: string; grossMinor: number }[];
}

/** The pointer as a query string, standing at a given round. */
function at(pointer: Pointer, round: number): string {
  return new URLSearchParams({ ...pointer, round: String(round) }).toString();
}

async function openFloor(request: APIRequestContext, pointer: Pointer, round: number): Promise<{ floor: string; snapshot: Snapshot }> {
  const response = await request.post('/api/floor', { data: { ...pointer, round: String(round) } });
  expect(response.ok()).toBeTruthy();
  const body = (await response.json()) as { floor: string; snapshot: Snapshot };
  console.log(`floor ${body.floor} (seed ${pointer.seed}) at round ${String(round)}`);
  return body;
}

/** Ring the bell from the browser until a card lands on the human pile. */
async function ringUntilPile(page: Page): Promise<void> {
  const ring = page.getByRole('button', { name: 'Ring the bell' });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await page.locator('li.paper').count()) > 0) return;
    await expect(ring).toBeEnabled({ timeout: 30_000 });
    await ring.click();
    await page.waitForTimeout(1_500);
  }
}

test('a settlement a rule caught is read aloud, refused by a person, and the tape still verifies', async ({ page, request }) => {
  test.setTimeout(300_000);
  const pointer = pointerFor('desk');
  const { floor } = await openFloor(request, pointer, 0);

  await page.goto(`/floor/${floor}?${at(pointer, 0)}`);
  await expect(page.getByRole('button', { name: 'Ring the bell' })).toBeVisible();
  await ringUntilPile(page);

  const onThePile = await page.locator('li.paper').count();
  expect(onThePile).toBeGreaterThan(0);

  const card = page.locator('li.paper').first();
  const stamped = (await card.locator('span.tnum').first().textContent()) ?? '';
  expect(stamped).toMatch(/\d+\.\d{2}/);

  await card.getByRole('button', { name: 'have the crier read this chit' }).click();
  await expect(card.getByText(/^written by/)).toBeVisible({ timeout: 150_000 });
  // Whoever wrote the paragraph, it has to be about this card: the figure stamped on the chit is in it.
  await expect(card.locator('p').first()).toContainText(stamped.replace(/[^0-9.]/g, ''));

  // The pile names its channel before anybody presses anything and the card names the one that wrote
  // the reading, in the same breath, in front of a person about to sign. They may not disagree: a
  // machine that has a model on it cannot say no model answers here because one card fell back.
  const header = (((await page.getByText(/^the crier here is/i).first().textContent()) ?? '')).toLowerCase();
  const attribution = (((await card.getByText(/^written by/).first().textContent()) ?? '')).toLowerCase();
  if (attribution.includes('no model answers on this machine')) {
    expect(header).toContain('the desk template');
  }

  await card.getByPlaceholder('say why, if you refuse it').fill('not between these two, not at this price');
  await card.getByRole('button', { name: 'refuse it' }).click();
  await expect(page.locator('li.paper')).toHaveCount(onThePile - 1, { timeout: 30_000 });

  // The room is standing wherever the bell last rang, so the audit is asked for that round: a machine
  // that has to rebuild the floor rebuilds it to here - past the refusal, not before it.
  const ticker = page.getByText(/^\d+\/\d+$/).first();
  const standingAt = (((await ticker.textContent()) ?? '0/10').split('/')[0]) ?? '0';
  await page.goto(`/audit?${new URLSearchParams({ floor, ...pointer, round: standingAt })}`);
  await expect(page.getByText('tape verifies').first()).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(/the books balance/i).first()).toBeVisible();
  await expect(page.getByText(/0 finding\(s\)/).first()).toBeVisible();
});

test('the address alone brings up the room: the screen names the same seals as the machine that rang', async ({ page, request }) => {
  const pointer = pointerFor('replay');
  const { floor, snapshot } = await openFloor(request, pointer, 4);

  await page.goto(`/floor/${floor}?${at(pointer, 4)}`);
  await expect(page.getByText('4/10', { exact: true })).toBeVisible({ timeout: 30_000 });

  // The head hash is the whole claim: a screen that reached this room through an address bar reports
  // the same seal as the machine that rang the bell - first six hex digits and the last four.
  await expect(page.getByText(`${snapshot.headHash.slice(0, 6)}…${snapshot.headHash.slice(-4)}`).first()).toBeVisible();

  const lines = page.getByText(/\d+ lines read/).first();
  await expect(lines).toBeVisible();
  const first = await lines.textContent();

  await page.goto(`/floor/${floor}?${at(pointer, 4)}`);
  await expect(page.getByText('4/10', { exact: true })).toBeVisible({ timeout: 30_000 });
  expect(await lines.textContent()).toBe(first);
});

test('asked for the real processor, the front door either has permission or says it has none', async ({ page }) => {
  // Which of the two happens is a property of the machine, not of the app: a laptop that was handed
  // PayPal credentials settles on the real one, a deployment that was not refuses in as many words.
  // What neither may do is go quiet, or open a floor that pretends.
  await page.goto('/');
  await page.getByText('settle on the real processor').click();
  await page.getByRole('button', { name: /Take the floor/ }).click();

  const refusal = page.getByText(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
  const settled = page.getByText('sandbox', { exact: true });
  const outcome = await Promise.race([
    refusal.waitFor({ timeout: 60_000 }).then(() => 'refused' as const),
    page.waitForURL(/\/floor\//, { timeout: 60_000 }).then(() => 'opened' as const),
  ]);
  console.log(`the front door answered a request for the real processor by ${outcome}`);

  if (outcome === 'refused') {
    await expect(refusal).toBeVisible();
    expect(page.url()).not.toMatch(/\/floor\//);
    return;
  }
  await expect(settled.first()).toBeVisible({ timeout: 30_000 });
});
