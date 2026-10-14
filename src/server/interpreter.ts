import { money, renderMoney, type CurrencyCode } from '../core/money';
import { DEFAULT_VETO_RULES } from '../core/settlement';
import type { SessionSnapshot, SerializedTrade } from '../core/world';

/**
 * Amounts the way the brief quotes them: `4120.00 USD`, not a locale's `$` and not a float.
 *
 * The screen keeps its own tabular rendering; a sentence that a model reads back has to carry the
 * currency in the words, because the model may otherwise invent one.
 */
function spoken(minor: number, currency: CurrencyCode): string {
  return renderMoney(money(currency, Math.round(minor)));
}

/**
 * The voice that speaks to the person on the pile.
 *
 * The pit runs on arithmetic: every price, concession and hold in this building comes out of the
 * engine, and the sealed tape keeps them as integers so a stranger can re-verify them without
 * trusting a single word we wrote. A human being does not read integers. When a settlement stops on
 * the pile, the person behind the desk gets a handful of rule codes and has to decide whether other
 * people's money moves - so something has to turn the record into a sentence, and that something is
 * a language model.
 *
 * The discipline is the interesting part, and it is one-directional: the model is handed the numbers
 * and asked to talk about them. It sets no price, approves nothing, and its prose is never sealed
 * into the tape - the tape is the record, a brief is a reading of it. If the model contradicts a
 * figure the screen is already showing, the figure stands.
 *
 * Three channels, in this order, and the caller is always told which one spoke:
 * 1. an OpenAI-compatible endpoint, when `AI_BASE_URL`, `AI_API_KEY` and `AI_MODEL` are all set;
 * 2. a model on a local Ollama server, when one answers and `OLLAMA_MODEL` is set or a chat-capable
 *    model is installed - this is what makes the floor a real AI product on a laptop with no key;
 * 3. a fixed template in this file, deterministic and offline, which is what a machine with neither
 *    answers with, and what the test suite pins.
 */

export type InterpreterSource = 'endpoint' | 'ollama' | 'template';

export interface Voice {
  readonly text: string;
  readonly source: InterpreterSource;
  /** Who said it, in the words a screen prints next to the sentence. */
  readonly spokenBy: string;
}

interface ChatChannel {
  readonly source: InterpreterSource;
  readonly model: string;
  readonly post: (system: string, user: string, timeoutMs: number) => Promise<string>;
}

/** One model per room, resolved once, and remembered until it stops answering. */
let cached: ChatChannel | null | undefined;

const DEFAULT_OLLAMA_BASE = 'http://127.0.0.1:11434';
/**
 * A chit is a few sentences, and a small model on a laptop without a GPU writes them at roughly the
 * speed of a person reading them out - a full brief on a 4B model kept in CPU RAM measured 68s on this
 * machine, and a cold load is inside that number rather than outside it. The wait is bounded twice
 * over: a completion budget, and a timeout with room for the slowest honest reading, after which the
 * template speaks rather than the card sitting blank. A timeout below the measured latency would not
 * be a bound at all; it would just be a switch that turns the model off.
 */
const CHAT_TIMEOUT_MS = 150_000;
const MAX_COMPLETION_TOKENS = 260;
const PROBE_TIMEOUT_MS = 1_200;
/** Families worth loading ahead of the rest when nobody named a model. */
const PREFERRED = ['gemma', 'llama', 'qwen', 'mistral', 'phi', 'granite', 'command'];

function envValue(env: Readonly<Record<string, string | undefined>>, key: string): string {
  return (env[key] ?? '').trim();
}

async function withTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/**
 * An OpenAI-compatible chat endpoint, if the room was given one.
 *
 * All three fields are required: a base URL without a model would silently talk to whatever the
 * provider defaults to, which is not a thing to print next to a settlement decision.
 */
function endpointChannel(env: Readonly<Record<string, string | undefined>>): ChatChannel | null {
  const base = envValue(env, 'AI_BASE_URL').replace(/\/+$/, '');
  const key = envValue(env, 'AI_API_KEY');
  const model = envValue(env, 'AI_MODEL');
  if (base.length === 0 || key.length === 0 || model.length === 0) return null;
  return {
    source: 'endpoint',
    model,
    post: async (system, user, timeoutMs) => {
      const response = await withTimeout(
        `${base}/chat/completions`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: 0.1,
            max_tokens: MAX_COMPLETION_TOKENS,
          }),
        },
        timeoutMs,
      );
      if (!response.ok) throw new Error(`endpoint answered ${response.status}`);
      const body = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = body.choices?.[0]?.message?.content;
      return typeof content === 'string' ? content : '';
    },
  };
}

function ollamaBase(env: Readonly<Record<string, string | undefined>>): string {
  return envValue(env, 'OLLAMA_BASE_URL').replace(/\/+$/, '') || DEFAULT_OLLAMA_BASE;
}

/** The smallest model name, so a laptop that has three installed gets the quickest one. */
function shorter(a: string, b: string): number {
  return a.length === b.length ? a.localeCompare(b) : a.length - b.length;
}

/**
 * A local Ollama server, if one answers.
 *
 * `OLLAMA_MODEL` wins when it is set. Otherwise the server is asked what it holds and the first
 * completion-capable model from a preferred family is taken, smallest name first - so `npm run dev`
 * on a machine with Ollama running is an AI product without anybody pasting a key.
 */
async function ollamaChannel(env: Readonly<Record<string, string | undefined>>): Promise<ChatChannel | null> {
  const base = ollamaBase(env);
  const named = envValue(env, 'OLLAMA_MODEL');
  let model = named;
  if (model.length === 0) {
    let listed: unknown;
    try {
      listed = await (await withTimeout(`${base}/api/tags`, { method: 'GET' }, PROBE_TIMEOUT_MS)).json();
    } catch {
      return null;
    }
    const models = (listed as { models?: { name?: unknown; capabilities?: unknown; details?: { capabilities?: unknown } }[] }).models ?? [];
    const usable = models
      .filter((entry) => {
        // `capabilities` sits beside `details` on a server that answers today; a list without it says
        // nothing about whether a model can hold a turn, so an unknown shape is not a reason to skip it.
        const listed = entry.capabilities ?? entry.details?.capabilities;
        return typeof entry.name === 'string' && (!Array.isArray(listed) || listed.includes('completion'));
      })
      .map((entry) => String(entry.name))
      .filter((name) => PREFERRED.some((family) => name.toLowerCase().includes(family)))
      .sort(shorter);
    const first = usable[0];
    if (first === undefined) return null;
    model = first;
  }
  return {
    source: 'ollama',
    model,
    post: async (system, user, timeoutMs) => {
      const response = await withTimeout(
        `${base}/api/chat`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            stream: false,
            keep_alive: '5m',
            options: { temperature: 0.1, num_predict: MAX_COMPLETION_TOKENS },
          }),
        },
        timeoutMs,
      );
      if (!response.ok) throw new Error(`ollama answered ${response.status}`);
      const body = (await response.json()) as { message?: { content?: unknown } };
      const content = body.message?.content;
      return typeof content === 'string' ? content : '';
    },
  };
}

/**
 * Which channel this machine would use right now.
 *
 * A successful resolution is remembered, a failure is not - so a laptop that falls asleep with
 * Ollama closed can be woken by the next request without a restart of the floor.
 */
export async function channel(env: Readonly<Record<string, string | undefined>> = process.env): Promise<ChatChannel | null> {
  if (cached !== undefined) return cached;
  const endpoint = endpointChannel(env);
  if (endpoint !== null) {
    cached = endpoint;
    return cached;
  }
  const local = await ollamaChannel(env);
  cached = local;
  return cached;
}

/** Only for tests and for a floor that wants to re-probe after its environment changed. */
export function forgetChannel(): void {
  cached = undefined;
}

/** Where a model's name has to be printed, it is printed with the machine it lives on. */
function nameOf(found: ChatChannel): string {
  return found.source === 'ollama' ? `${found.model}, on this machine` : found.model;
}

/** What a screen prints before anybody presses a button, so the mode is never a surprise. */
export async function spokenBy(env: Readonly<Record<string, string | undefined>> = process.env): Promise<{ source: InterpreterSource; spokenBy: string }> {
  const found = await channel(env);
  if (found === null) return { source: 'template', spokenBy: 'the desk template' };
  return { source: found.source, spokenBy: nameOf(found) };
}

/**
 * Everything the brief may be built from, already turned into the room's own words.
 *
 * Deliberately a flat list of strings: the model is handed sentences the engine wrote, so it cannot
 * be tempted to compute, and a template cannot get out of step with the screen.
 */
export interface HoldFacts {
  readonly session: string;
  readonly trade: string;
  readonly instrument: string;
  readonly buyer: string;
  readonly seller: string;
  readonly price: string;
  readonly qty: number;
  readonly gross: string;
  readonly fee: string;
  readonly net: string;
  /** Whether the split between the fee and the seller's take has actually been struck yet. */
  readonly struck: boolean;
  readonly currency: CurrencyCode;
  readonly phase: string;
  readonly lastPrint: string | null;
  readonly caughtBy: { readonly rule: string; readonly label: string; readonly reason: string; readonly hint: string }[];
  readonly lines: readonly string[];
}

function labelOf(ruleId: string): { label: string; hint: string } {
  const found = DEFAULT_VETO_RULES.find((rule) => rule.id === ruleId);
  return found === undefined ? { label: ruleId, hint: 'a rule of this floor' } : { label: found.label, hint: found.hint };
}

export function factsFor(snapshot: SessionSnapshot, trade: SerializedTrade): HoldFacts {
  const currency = trade.currency;
  const market = snapshot.markets.find((entry) => entry.instrumentId === trade.instrument);
  const last = market?.lastPrintMinor ?? null;
  const caughtBy = trade.vetoRules.map((ruleId, position) => ({
    rule: ruleId,
    ...labelOf(ruleId),
    reason: trade.vetoReasons[position] ?? 'held without a stated reason',
  }));
  const price = spoken(trade.priceMinor, currency);
  const gross = spoken(trade.grossMinor, currency);
  const fee = spoken(trade.feeMinor, currency);
  const net = spoken(trade.netMinor, currency);
  // Capture is what strikes the split, so on a chit that has not been captured the engine's fee and net
  // are both legitimately zero. Saying "0.00 USD" on a card that is asking for a capture would read like
  // the floor takes nothing, so the brief says plainly that the split has not been struck instead.
  const struck = trade.netMinor > 0;
  const lastPrint = last === null ? null : spoken(last, currency);
  const lines = [
    `${trade.buyer} agreed to pay ${trade.seller} ${gross} for ${trade.qty} unit(s) of ${trade.instrument} at ${price} each.`,
    struck
      ? `This floor books ${fee} as its fee and ${net} as the seller's take.`
      : `The floor's fee and the seller's take are struck when the money is captured, and this money has not been captured yet.`,
    lastPrint === null ? '' : `The last print on ${trade.instrument} was ${lastPrint}.`,
    ...caughtBy.map((entry) => `Caught by ${entry.rule}: ${entry.reason}. ${entry.hint}`),
    `The settlement is currently ${trade.phase}.`,
  ].filter((line) => line.length > 0);
  return {
    session: snapshot.session,
    trade: trade.id,
    instrument: trade.instrument,
    buyer: trade.buyer,
    seller: trade.seller,
    price,
    qty: trade.qty,
    gross,
    fee,
    net,
    struck,
    currency,
    phase: trade.phase,
    lastPrint,
    caughtBy,
    lines,
  };
}

/**
 * What the model is told.
 *
 * The brief is written for a small model running on a laptop CPU, because that is the machine the
 * floor runs on when nobody has configured a key. Such a model does not hold an abstract rule set -
 * given only instructions it spells the money out in words ("four hundred sixty-four dollars") and
 * swaps who pays whom - but it imitates an example almost perfectly. So the instruction is short and
 * there is a worked example in it, drawn from a card that is not this card, with figures the gate
 * would reject if the model echoed them instead of the facts.
 */
const SYSTEM = [
  'You are the crier of an open-outcry trading floor. A settlement stopped on the human pile because a rule caught it, so the floor will not complete it without a person.',
  'The person in front of the chit needs it said in plain English. Say it in two or three sentences, one paragraph: who pays whom and how much, for how many units of what, at what price; which rule caught it and why; and that they may let it through or refuse it.',
  'Copy the amount at stake, the price and every house name out of the facts word for word - digits, currency letters, lower case and hyphens. Never spell a number out. Never put a house name in capitals. Do not say what the floor keeps as its fee or what the seller takes: that split is printed on the card, and a short sentence puts it the wrong way round. The house that pays is the one the facts name first. Say the rule as the facts give it, and do not point it at a house the facts do not point it at. Do not decide anything, do not add a fact, and do not greet or sign off.',
  'Example of the way to do it, with figures that are not on this chit:',
  'buy-marigold-7-grn pays sell-tillery-2-grn 1875.50 USD for 5 unit(s) of wool-top at 375.10 USD each. It is on the pile because it is larger than the floor lets through on its own. You may let it through, or refuse it.',
].join('\n');

function userPrompt(facts: HoldFacts): string {
  return ['Facts, from the sealed record:', ...facts.lines.map((line) => `- ${line}`)].join('\n');
}

/**
 * A model's answer, made safe to print.
 *
 * Whitespace is folded into one paragraph, a stray bullet is dropped, and an over-long answer is cut
 * at a sentence boundary - a chit is a small card, and a card that needs scrolling is not a card.
 */
export function polish(raw: string): string {
  const paragraph = raw
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
    .filter((line) => line.length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (paragraph.length <= 520) return paragraph;
  const room = paragraph.slice(0, 520);
  const stop = room.lastIndexOf('. ');
  // Cut on a sentence, not mid-word, and say where the rest of it lives.
  return stop > 200 ? `${room.slice(0, stop + 1)} The chit below holds the rest.` : `${room.trimEnd()}...`;
}

/** The deterministic reading of the same facts - what a machine with no model speaks. */
export function templateBrief(facts: HoldFacts): string {
  const caught = facts.caughtBy;
  const why =
    caught.length === 0
      ? 'the floor held it without naming a rule'
      : caught.length === 1
        ? `${caught[0]?.reason ?? 'a rule caught it'} (${caught[0]?.rule ?? 'rule'})`
        : `${caught.map((entry) => entry.reason).join(', and ')}`;
  return polish(
    `${facts.buyer} agreed to pay ${facts.seller} ${facts.gross} for ${facts.qty} unit(s) of ${facts.instrument} at ${facts.price} each, ` +
      (facts.struck
        ? `of which this floor keeps ${facts.fee} and ${facts.seller} takes ${facts.net}. `
        : `which this floor has not yet split - capturing it is what strikes its fee and the seller's take. `) +
      `It is on the pile because ${why}. ` +
      `The money sits at ${facts.phase}. ` +
      `Letting it through captures it and pays ${facts.seller}; refusing it sends ${facts.buyer} their money back and writes your reason on the tape.`,
  );
}

/**
 * Did the reading keep faith with the record?
 *
 * A brief is only worth printing if the figures on the card are the figures in the sentence. Three
 * things are checked, and a model that fails any of them is thrown away so the template speaks:
 *
 * - the gross has to be in the paragraph, because a reading that lost the money is not a reading;
 * - the buyer has to come before the seller, because a small model on CPU will happily say the seller
 *   is paying the buyer, and a card that states the opposite of the tape is worse than a blank card;
 * - no amount may appear in the paragraph that is not on the card, which is how a garbled figure - the
 *   model writing the fee where the seller's take belongs - is caught rather than believed.
 *
 * House names are matched without regard to capitalisation, because a model writes `Buy-Halden-1-Grn`
 * for `buy-halden-1-grn` and that is a style problem, not a false statement. Amounts are matched
 * exactly, because those are digits and there is nothing to forgive. This is the whole discipline of
 * the channel in one predicate: the words may be generated, the numbers may not.
 */
/**
 * An amount as this floor writes one: digits, a decimal point, two places, and a currency. A rule that
 * quotes `2177 bps` is not an amount and must not be mistaken for one, so the two decimals are required
 * rather than guessed at.
 */
const AMOUNT = /\d+\.\d{2}\s*[A-Za-z]{3}\b/g;

function keepsFaith(text: string, facts: HoldFacts): boolean {
  const said = text.toLowerCase();
  const buyer = said.indexOf(facts.buyer.toLowerCase());
  const seller = said.indexOf(facts.seller.toLowerCase());
  if (!(said.includes(facts.gross.toLowerCase()) && buyer >= 0 && seller > buyer && text.length > 60)) return false;
  // The figures a brief is allowed to say out loud: what is at stake, what it was struck at, and where
  // the market last printed. The split between the floor's fee and the seller's take is not on the list,
  // because the split is the one place a small model puts a number in the wrong pocket - and the card
  // underneath the sentence prints both of them either way. Currency letters are matched without regard
  // to case, since a model will write `usd` as often as `USD`; the digits are not negotiable.
  const speakable = new Set([facts.price, facts.gross, facts.lastPrint ?? ''].filter((held) => held.length > 0));
  for (const amount of text.match(AMOUNT) ?? []) {
    if (!speakable.has(amount.replace(/\s+/g, ' ').toUpperCase())) return false;
  }
  return true;
}

/**
 * Read one chit to the person standing in front of it.
 *
 * A channel that is configured but does not answer - a laptop asleep, a key with no credit, a model
 * that rambles - falls back to the template rather than leaving a card blank, and says so: the
 * returned voice always carries which of the three spoke.
 *
 * A reading that stands up is kept for the rest of the room's life: a person who reads a chit, walks
 * away and comes back should not find a different sentence, and a model should not be asked twice for
 * one card. A reading that failed the test above is not kept, so the next ask gets another try.
 */
const readChits = new Map<string, Voice>();
const MAX_READ_CHITS = 400;

export function forgetChits(): void {
  readChits.clear();
}

function template(facts: HoldFacts): Voice {
  return { text: templateBrief(facts), source: 'template', spokenBy: 'the desk template' };
}

function remember(key: string, voice: Voice): Voice {
  if (readChits.size >= MAX_READ_CHITS) {
    const oldest = readChits.keys().next();
    if (!oldest.done) readChits.delete(oldest.value);
  }
  readChits.set(key, voice);
  return voice;
}

export async function readChit(facts: HoldFacts, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Voice> {
  const key = `${facts.session}|${facts.trade}`;
  const remembered = readChits.get(key);
  if (remembered !== undefined) return remembered;
  const found = await channel(env);
  if (found === null) return remember(key, template(facts));
  try {
    const text = polish(await found.post(SYSTEM, userPrompt(facts), CHAT_TIMEOUT_MS));
    if (keepsFaith(text, facts)) return remember(key, { text, source: found.source, spokenBy: nameOf(found) });
  } catch {
    // The channel is gone rather than merely slow for this one card - re-probe next time.
    forgetChannel();
  }
  return template(facts);
}
