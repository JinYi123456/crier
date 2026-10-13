import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channel, factsFor, forgetChannel, forgetChits, polish, readChit, spokenBy, templateBrief } from '../src/server/interpreter';
import type { HoldFacts } from '../src/server/interpreter';
import { floorSnapshot, forgetFloors, openFloor, pointerOf, runFloor } from '../src/server/floor';
import { pointerParams } from '../src/app/ui/pointer';
import { GET as readChitRoute } from '../src/app/api/floor/[id]/chit/route';

/**
 * The floor's interpreter.
 *
 * A chit is a decision somebody has to make about other people's money, and the sentence in front of
 * them may be written by a model. These tests hold the two halves of that: the model is reachable and
 * gets used when it is, and it is never trusted with a number - the brief is a reading of the record,
 * and the record does not change because something talked about it.
 */

/** A base URL whose port refuses a socket, so no test can reach a model on the machine running them. */
const DEAD = 'http://127.0.0.1:9';
const NO_MODEL: Record<string, string> = { AI_BASE_URL: '', AI_API_KEY: '', AI_MODEL: '', OLLAMA_BASE_URL: DEAD, OLLAMA_MODEL: '' };

function facts(over: Partial<HoldFacts> = {}): HoldFacts {
  return {
    session: 'crier_testsession',
    trade: 't-1',
    instrument: 'saffron',
    buyer: 'buy-halden-1-grn',
    seller: 'sell-larkspur-1-grn',
    price: '412.00 USD',
    qty: 10,
    gross: '4120.00 USD',
    fee: '41.20 USD',
    net: '4078.80 USD',
    currency: 'USD',
    phase: 'matched',
    lastPrint: '398.00 USD',
    caughtBy: [{ rule: 'size', label: 'Size above the auto-settle limit', reason: 'saffron settles more here than the floor lets through on its own', hint: 'Large settlements are the ones nobody wants to explain later.' }],
    lines: ['buy-halden-1-grn agreed to pay sell-larkspur-1-grn 4120.00 USD for 10 unit(s) of saffron at 412.00 USD each.'],
    ...over,
  };
}

beforeEach(() => {
  forgetChannel();
  forgetChits();
  vi.stubEnv('OLLAMA_BASE_URL', DEAD);
  vi.stubEnv('OLLAMA_MODEL', '');
  vi.stubEnv('AI_BASE_URL', '');
  vi.stubEnv('AI_API_KEY', '');
  vi.stubEnv('AI_MODEL', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('which voice a floor has', () => {
  it('takes an endpoint when all three of its fields are given', async () => {
    const found = await channel({ ...NO_MODEL, AI_BASE_URL: 'https://infer.example/v1/', AI_API_KEY: 'a-key', AI_MODEL: 'model-x' });
    expect(found?.source).toBe('endpoint');
    expect(found?.model).toBe('model-x');
    // The trailing slash is dropped, or the route would be built onto `/v1//chat/completions`.
    const post = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) });
    vi.stubGlobal('fetch', post);
    await found?.post('system', 'user', 5_000);
    expect(post.mock.calls[0]?.[0]).toBe('https://infer.example/v1/chat/completions');
  });

  it('will not call an endpoint it cannot name a model for', async () => {
    // A half-configured channel is worse than none: the provider would answer with some default model
    // and the screen would print a name it did not choose.
    expect(await channel({ ...NO_MODEL, AI_BASE_URL: 'https://infer.example/v1', AI_API_KEY: 'a-key' })).toBeNull();
    expect(await spokenBy({ ...NO_MODEL })).toEqual({ source: 'template', spokenBy: 'the desk template' });
  });

  it('prefers a named local model and otherwise takes the quickest one installed', async () => {
    const named = await channel({ ...NO_MODEL, OLLAMA_BASE_URL: 'http://ollama.test:11434', OLLAMA_MODEL: 'qwen2.5:1.5b' });
    expect(named).toMatchObject({ source: 'ollama', model: 'qwen2.5:1.5b' });

    const listed = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'nomic-embed-text:latest', details: {}, capabilities: ['embedding'] },
          { name: 'llama3.2:3b', details: {} },
          { name: 'gemma3:4b', details: {}, capabilities: ['completion', 'vision'] },
        ],
      }),
    });
    vi.stubGlobal('fetch', listed);
    forgetChannel();
    const picked = await channel({ ...NO_MODEL, OLLAMA_BASE_URL: 'http://ollama.test:11434' });
    expect(listed.mock.calls[0]?.[0]).toBe('http://ollama.test:11434/api/tags');
    // An embedding-only model cannot hold a turn, a list that says nothing is no reason to skip the
    // model, and the shorter name is the smaller download.
    expect(picked).toMatchObject({ source: 'ollama', model: 'gemma3:4b' });
  });

  it('is a template on a machine where nothing answers', async () => {
    const refused = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', refused);
    expect(await channel({ ...NO_MODEL, OLLAMA_BASE_URL: 'http://ollama.test:11434' })).toBeNull();
    expect(await spokenBy({ ...NO_MODEL, OLLAMA_BASE_URL: 'http://ollama.test:11434' })).toEqual({ source: 'template', spokenBy: 'the desk template' });
  });
});

describe('reading a chit', () => {
  it('hands a model the record and asks for a sentence about it, nothing else', async () => {
    const post = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [
          {
            message: {
              content: 'buy-halden-1-grn is paying sell-larkspur-1-grn 4120.00 USD for 10 unit(s) of saffron at 412.00 USD each.\n- the size rule caught it\nLet it through, or refuse it.',
            },
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', post);
    const voice = await readChit(facts(), { ...NO_MODEL, AI_BASE_URL: 'https://infer.example/v1', AI_API_KEY: 'a-key', AI_MODEL: 'model-x' });

    expect(voice.source).toBe('endpoint');
    expect(voice.spokenBy).toBe('model-x');
    expect(voice.text).toBe('buy-halden-1-grn is paying sell-larkspur-1-grn 4120.00 USD for 10 unit(s) of saffron at 412.00 USD each. the size rule caught it Let it through, or refuse it.');

    const init = post.mock.calls[0]?.[1] as { body: string };
    const body = JSON.parse(init.body) as { messages: { role: string; content: string }[]; max_tokens: number };
    const system = body.messages[0]?.content ?? '';
    const user = body.messages[1]?.content ?? '';
    // The prompt is the discipline: the model is told to copy the figures it is given, to stay out of
    // the decision, and it is handed sentences rather than a table it could recompose. The worked
    // example is part of the discipline, so it is asserted here too - a small model follows an example
    // it would not follow a rule.
    expect(system).toContain('Do not decide anything');
    expect(system).toContain('word for word');
    expect(system).toContain('Never spell a number out');
    expect(system).toContain('buy-marigold-7-grn pays sell-tillery-2-grn');
    expect(user).toContain('4120.00 USD');
    expect(user).toContain('buy-halden-1-grn');
    expect(body.max_tokens).toBeGreaterThan(0);
  });

  it('throws away a reading that lost the money', async () => {
    // A paragraph that does not carry the figure on the card has not read the chit. The template takes
    // over, and the miss is not remembered, so the next ask gives the model another try at the card.
    const post = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'You are being asked to choose between letting this settlement through, or refusing it.' } }] }),
    });
    vi.stubGlobal('fetch', post);
    const env = { ...NO_MODEL, AI_BASE_URL: 'https://infer.example/v1', AI_API_KEY: 'a-key', AI_MODEL: 'model-x' };
    const voice = await readChit(facts(), env);
    expect(voice).toMatchObject({ source: 'template', spokenBy: 'the desk template' });
    expect(voice.text).toBe(templateBrief(facts()));
    await readChit(facts(), env);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('forgives a house name written with the wrong capitals', async () => {
    // A model will title-case an identifier it was handed in lower case. The figures still have to be
    // exact, but the name of a house is not a figure, and refusing a true reading over a capital would
    // only make the desk look mute.
    const post = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Buy-Halden-1-Grn is paying Sell-Larkspur-1-Grn 4120.00 USD for saffron at 412.00 USD each, and the size rule is what caught it.' } }] }),
    });
    vi.stubGlobal('fetch', post);
    const voice = await readChit(facts(), { ...NO_MODEL, AI_BASE_URL: 'https://infer.example/v1', AI_API_KEY: 'a-key', AI_MODEL: 'model-x' });
    expect(voice.source).toBe('endpoint');
  });

  it('throws away a reading that made the seller pay the buyer', async () => {
    // The houses are in the right sentence for the wrong reason: a small model will swap who pays whom.
    // A card that tells a person the opposite of the tape is worse than a card that says nothing, so the
    // order of the two names is checked and a reversed paragraph is dropped.
    const post = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'Sell-Larkspur-1-Grn is paying Buy-Halden-1-Grn 4120.00 USD for saffron at 412.00 USD each, and the size rule is what caught it.' } }] }),
    });
    vi.stubGlobal('fetch', post);
    const env = { ...NO_MODEL, AI_BASE_URL: 'https://infer.example/v1', AI_API_KEY: 'a-key', AI_MODEL: 'model-x' };
    const voice = await readChit(facts(), env);
    expect(voice).toMatchObject({ source: 'template', spokenBy: 'the desk template' });
    expect(voice.text).toContain('buy-halden-1-grn agreed to pay sell-larkspur-1-grn');
  });

  it('throws away a reading that put the fee in the seller\'s pocket', async () => {
    // The one figure a brief must not restate on its own terms is the split between the floor's fee and
    // the seller's take: the card prints both, and a model that says them aloud gets them the wrong way
    // round often enough that the sentence is not worth the risk.
    const post = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'buy-halden-1-grn pays sell-larkspur-1-grn 4120.00 USD for saffron at 412.00 USD each, and this floor books 4120.00 USD and leaves the seller 41.20 USD of it. You may let it through, or refuse it.' } }] }),
    });
    vi.stubGlobal('fetch', post);
    const voice = await readChit(facts(), { ...NO_MODEL, AI_BASE_URL: 'https://infer.example/v1', AI_API_KEY: 'a-key', AI_MODEL: 'model-x' });
    expect(voice.source).toBe('template');
  });

  it('forgives an amount written with the currency in lower case', async () => {
    // The same style problem as a capitalised house name, in the other direction: a model will write
    // `4120.00 usd`. The digits are what the card is made of, and they are the same digits.
    const post = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'buy-halden-1-grn pays sell-larkspur-1-grn 4120.00 usd for 10 unit(s) of saffron at 412.00 usd each, and it is on the pile because of its size.' } }] }),
    });
    vi.stubGlobal('fetch', post);
    const voice = await readChit(facts(), { ...NO_MODEL, AI_BASE_URL: 'https://infer.example/v1', AI_API_KEY: 'a-key', AI_MODEL: 'model-x' });
    expect(voice.source).toBe('endpoint');
  });

  it('answers the same card with the same sentence', async () => {
    const post = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message: { content: 'buy-halden-1-grn pays sell-larkspur-1-grn 4120.00 USD for saffron, and the size rule is what caught it here.' } }),
    });
    vi.stubGlobal('fetch', post);
    const env = { ...NO_MODEL, OLLAMA_BASE_URL: 'http://ollama.test:11434', OLLAMA_MODEL: 'gemma3:4b' };
    const first = await readChit(facts(), env);
    const again = await readChit(facts(), env);
    expect(first.source).toBe('ollama');
    expect(again.text).toBe(first.text);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('falls back to the template when the channel goes quiet, and re-probes after it', async () => {
    const chat = vi.fn().mockRejectedValue(new Error('socket hang up'));
    vi.stubGlobal('fetch', chat);
    const voice = await readChit(facts(), { ...NO_MODEL, OLLAMA_BASE_URL: 'http://ollama.test:11434', OLLAMA_MODEL: 'gemma3:4b' });
    expect(voice).toMatchObject({ source: 'template', spokenBy: 'the desk template' });
    expect(voice.text).toBe(templateBrief(facts()));
    chat.mockClear();
    // A channel that failed is not remembered as one: the next card asks the machine again.
    expect(await channel({ ...NO_MODEL, OLLAMA_BASE_URL: 'http://ollama.test:11434' })).toBeNull();
    expect(chat.mock.calls[0]?.[0]).toBe('http://ollama.test:11434/api/tags');
  });

  it('sends an empty answer to the template rather than printing a blank card', async () => {
    const post = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: '   ' } }] }) });
    vi.stubGlobal('fetch', post);
    const voice = await readChit(facts(), { ...NO_MODEL, AI_BASE_URL: 'https://infer.example/v1', AI_API_KEY: 'a-key', AI_MODEL: 'model-x' });
    expect(voice.source).toBe('template');
  });
});

describe('the words themselves', () => {
  it('folds a rambling answer into one paragraph and cuts it on a sentence', () => {
    expect(polish('\n  Hello!\n\n * one\n * two  \n')).toBe('Hello! one two');
    expect(polish('short and fine')).toBe('short and fine');

    const long = `${'A calm sentence about the trade. '.repeat(20)}Nothing after this is wanted.`;
    const cut = polish(long);
    expect(cut.length).toBeLessThanOrEqual(560);
    expect(cut).toMatch(/The chit below holds the rest\.$/);
  });

  it('reads the same figures off the same card, twice, identically', () => {
    const once = templateBrief(facts());
    expect(once).toBe(templateBrief(facts()));
    for (const wanted of [facts().buyer, facts().seller, facts().gross, facts().fee, facts().net, 'saffron settles more here']) {
      expect(once).toContain(wanted);
    }
    // A template that does not name both doors is not a brief, it is a nudge.
    expect(once).toContain('Letting it through');
    expect(once).toContain('refusing it');
  });

  it('quotes a rule the floor does not know without inventing a reason for it', () => {
    const unknown = templateBrief(facts({ caughtBy: [{ rule: 'brand_new', label: 'brand_new', reason: 'held by a rule of this floor', hint: 'a rule of this floor' }] }));
    expect(unknown).toContain('brand_new');
    expect(unknown).not.toContain('auto-settle');
  });
});

describe('a brief that is made from a real floor', () => {
  it('takes its figures from the record and leaves the record alone', async () => {
    const room = await openFloor({ seed: 'human-actions', instruments: ['saffron'], maxTicks: 8 });
    const id = room.session.session;
    await runFloor(id);
    const before = floorSnapshot(id);
    const held = before.snapshot.trades.find((trade) => trade.held);
    expect(held).toBeDefined();
    if (held === undefined) return;

    const read = factsFor(before.snapshot, held);
    expect(read.session).toBe(id);
    expect(read.gross).toMatch(/^\d+\.\d{2} USD$/);
    expect(read.caughtBy.length).toBeGreaterThan(0);
    // The rule's own words come from the rule table, not from the reason string, so the model is handed
    // what the floor was holding itself to as well as what it caught.
    expect(read.caughtBy[0]?.label.length).toBeGreaterThan(0);
    expect(read.lines.join(' ')).toContain(held.buyer);

    const asked = new URLSearchParams({ ...pointerParams(pointerOf(room)), trade: held.id });
    const response = await readChitRoute(new Request(`http://localhost/api/floor/${id}/chit?${asked}`, { method: 'GET' }), {
      params: Promise.resolve({ id }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { text: string; source: string; trade: string };
    expect(body.trade).toBe(held.id);
    // The room this test runs in has no model, so this is the template - and either way, the tape is
    // the same tape it was before anything was said about it.
    expect(body.source).toBe('template');
    expect(body.text.length).toBeGreaterThan(40);
    const after = floorSnapshot(id);
    expect(after.snapshot.messages.length).toBe(before.snapshot.messages.length);
    expect(after.snapshot.headHash).toBe(before.snapshot.headHash);
    forgetFloors();
  });

  it('refuses to read a card that is not on the pile', async () => {
    const room = await openFloor({ seed: 'chit-refusals', instruments: ['coffee-green'], maxTicks: 6 });
    const id = room.session.session;
    await runFloor(id);
    const { snapshot } = floorSnapshot(id);
    const settled = snapshot.trades.find((trade) => !trade.held);
    expect(settled).toBeDefined();
    if (settled === undefined) return;

    const asked = new URLSearchParams({ ...pointerParams(pointerOf(room)), trade: settled.id });
    const wrong = await readChitRoute(new Request(`http://localhost/api/floor/${id}/chit?${asked}`), { params: Promise.resolve({ id }) });
    expect(wrong.status).toBe(409);
    const missing = await readChitRoute(new Request(`http://localhost/api/floor/${id}/chit?${new URLSearchParams(pointerParams(pointerOf(room)))}`), {
      params: Promise.resolve({ id }),
    });
    expect(missing.status).toBe(400);
    const unknown = await readChitRoute(new Request(`http://localhost/api/floor/${id}/chit?${new URLSearchParams({ ...pointerParams(pointerOf(room)), trade: 'no-such-trade' })}`), {
      params: Promise.resolve({ id }),
    });
    expect(unknown.status).toBe(404);
    forgetFloors();
  });
});
