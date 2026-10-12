import { randomUUID } from 'node:crypto';
import { DEFAULT_INSTRUMENTS, Session, type SessionConfig } from '../core/world';
import type { CurrencyCode } from '../core/money';
import { verifyChain, type Finding } from '../core/protocol';
import { PayPalGateway } from '../gateway/paypal';
import type { GatewayEvent, PaymentGateway } from '../gateway/types';
import type { TradeRecord } from '../core/settlement';
import type { SessionSnapshot } from '../core/world';

/**
 * The floor as a running service.
 *
 * A room is one session, held in memory, addressed by the id the engine derives from its seed - so
 * two people who open the same seed land in the same room, and a URL is a reproducible recording.
 * Nothing here persists to disk: the tape *is* the record, and it can be exported and audited by a
 * stranger with no access to this process.
 *
 * The clock belongs to the session, not to the wall. That means the floor only moves when somebody
 * rings the bell, which is what makes it watchable: a round on demand, a step at a time, no
 * background timer running a settlement while nobody is looking.
 */

export interface OpenFloorRequest {
  readonly seed: string;
  readonly instruments?: readonly string[];
  /** `sim` is the local processor and needs nothing; `sandbox` talks to the real one. */
  readonly gateway?: 'sim' | 'sandbox';
  readonly payoutMode?: 'immediate' | 'batched';
  readonly agentsPerSide?: number;
  readonly maxTicks?: number;
  readonly currency?: CurrencyCode;
}

export interface Room {
  readonly session: Session;
  readonly openedAt: number;
  /** The operator's own view of why this room exists, so a list of rooms says something. */
  readonly label: string;
  lastSeen: number;
}

/** A modest instance should not be brought down by an eager visitor opening forty floors. */
const MAX_ROOMS = 8;

export class FloorError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FloorError';
    this.status = status;
  }
}

interface Store {
  rooms: Map<string, Room>;
}

const GLOBAL_KEY = '__crier_floor__';

function store(): Store {
  const holder = globalThis as unknown as Partial<Record<string, Store>>;
  if (!holder[GLOBAL_KEY]) holder[GLOBAL_KEY] = { rooms: new Map<string, Room>() };
  return holder[GLOBAL_KEY] as Store;
}

function gatewayFor(mode: 'sim' | 'sandbox', env: Readonly<Record<string, string | undefined>>): PaymentGateway | undefined {
  if (mode === 'sim') return undefined;
  return new PayPalGateway({
    clientId: env.PAYPAL_CLIENT_ID ?? '',
    clientSecret: env.PAYPAL_CLIENT_SECRET ?? '',
    apiBase: env.PAYPAL_API_BASE,
    webhookId: env.PAYPAL_WEBHOOK_ID,
    publicUrl: env.PUBLIC_APP_URL ?? env.PAYPAL_WEBHOOK_URL,
    payoutBatchNote: env.PAYPAL_PAYOUT_BATCH_NOTE,
  });
}

function mustFind(id: string): Room {
  const room = store().rooms.get(id);
  if (!room) throw new FloorError(`no floor is running under ${id}`, 404);
  room.lastSeen = Date.now();
  return room;
}

function evict(): void {
  const rooms = store().rooms;
  while (rooms.size > MAX_ROOMS) {
    let oldestId: string | null = null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [id, room] of rooms) {
      if (room.session.closed && room.lastSeen < oldest) {
        oldest = room.lastSeen;
        oldestId = id;
      }
    }
    if (oldestId === null) {
      // Every room is live and somebody is watching; drop the one nobody has looked at longest.
      for (const [id, room] of rooms) {
        if (room.lastSeen < oldest) {
          oldest = room.lastSeen;
          oldestId = id;
        }
      }
    }
    if (oldestId === null) break;
    rooms.delete(oldestId);
  }
}

/**
 * Open a floor, or return the one this seed already opened.
 */
export async function openFloor(request: OpenFloorRequest, env: Readonly<Record<string, string | undefined>> = process.env): Promise<Room> {
  const seed = request.seed.trim();
  if (seed.length < 4) throw new FloorError('a floor needs a seed of at least four characters');
  const mode = request.gateway === 'sandbox' ? 'sandbox' : 'sim';
  const instruments = request.instruments && request.instruments.length > 0 ? request.instruments : DEFAULT_INSTRUMENTS;
  const config: SessionConfig = {
    seed,
    instrumentIds: instruments,
    payoutMode: request.payoutMode ?? 'immediate',
    agentsPerSide: request.agentsPerSide ?? 4,
    maxTicks: request.maxTicks ?? 12,
    currency: request.currency ?? 'USD',
    ...(mode === 'sandbox' ? { gateway: gatewayFor(mode, env) } : {}),
  };
  const session = await Session.open(config);
  const existing = store().rooms.get(session.session);
  if (existing) return existing;
  const room: Room = { session, openedAt: Date.now(), label: `${seed} on ${instruments.join(', ')}`, lastSeen: Date.now() };
  store().rooms.set(session.session, room);
  evict();
  return room;
}

export interface RoomSummary {
  readonly id: string;
  readonly seed: string;
  readonly label: string;
  readonly openedAt: number;
  readonly tick: number;
  readonly maxTicks: number;
  readonly closed: boolean;
  readonly gateway: 'sim' | 'sandbox';
  readonly trades: number;
  readonly held: number;
  readonly messages: number;
  readonly headHash: string;
}

function summaryOf(room: Room): RoomSummary {
  const session = room.session;
  return {
    id: session.session,
    seed: session.config.seed,
    label: room.label,
    openedAt: room.openedAt,
    tick: session.tick,
    maxTicks: session.config.maxTicks,
    closed: session.closed,
    gateway: session.gateway.mode,
    trades: session.settler.summary().trades,
    held: session.heldTrades.length,
    messages: session.chain.messages.length,
    headHash: session.chain.headHash,
  };
}

export function listFloors(): RoomSummary[] {
  return [...store().rooms.values()].map(summaryOf).sort((a, b) => b.openedAt - a.openedAt);
}

/**
 * The whole room in one JSON-safe object, with the tape trimmed to what the caller has not seen.
 *
 * A live screen polls this with the last sequence it rendered, so the payload stays small even after
 * a hundred rounds, and the tape it gets back is the real sealed messages rather than a summary of
 * them - a screen that shows less than the log is a screen that can be lied to.
 */
export function floorSnapshot(id: string, sinceSeq = -1): { snapshot: SessionSnapshot; sinceSeq: number } {
  const room = mustFind(id);
  const full = room.session.snapshot();
  const since = sinceSeq >= 0 ? sinceSeq : -1;
  return {
    snapshot: { ...full, messages: full.messages.filter((message) => message.seq > since) },
    sinceSeq: full.messages.length > 0 ? (full.messages[full.messages.length - 1] as { seq: number }).seq : since,
  };
}

export interface TickResult {
  readonly tick: number;
  readonly shouts: number;
  readonly prints: number;
  readonly walked: number;
  readonly held: number;
  readonly silent: boolean;
  readonly closed: boolean;
}

/** Ring the bell once. */
export async function stepFloor(id: string): Promise<TickResult> {
  const room = mustFind(id);
  if (room.session.closed) throw new FloorError('this floor has closed - open another', 409);
  const report = await room.session.step();
  return {
    tick: report.tick,
    shouts: report.shouts,
    prints: report.fills.length,
    walked: report.walked.length,
    held: report.held.length,
    silent: report.silent,
    closed: room.session.closed,
  };
}

/** Run the floor to the bell, one round at a time, so a caller can watch it happen. */
export async function runFloor(id: string, maxRounds = 24): Promise<TickResult[]> {
  const room = mustFind(id);
  const rounds: TickResult[] = [];
  for (let index = 0; index < maxRounds; index += 1) {
    if (room.session.closed || room.session.activeParticipants().length === 0) break;
    const result = await stepFloor(id);
    rounds.push(result);
    if (result.silent) break;
  }
  return rounds;
}

export async function closeFloor(id: string): Promise<RoomSummary> {
  const room = mustFind(id);
  await room.session.close();
  return summaryOf(room);
}

export interface TradeAction {
  readonly action: 'release' | 'veto' | 'refund' | 'partial_refund' | 'payout';
  readonly tradeId: string;
  readonly note?: string;
  readonly amountMinor?: number;
}

/**
 * What a person on the floor can do to a settlement, each of it signed by the human's own key.
 */
export async function actOnFloorTrade(id: string, action: TradeAction): Promise<TradeRecord> {
  const room = mustFind(id);
  const note = (action.note ?? '').trim();
  switch (action.action) {
    case 'release':
      return room.session.releaseTrade(action.tradeId, note.length > 0 ? note : 'released by the floor operator');
    case 'veto':
      if (note.length === 0) throw new FloorError('a veto has to say why');
      return room.session.vetoTrade(action.tradeId, note);
    case 'refund': {
      const found = room.session.trades.find((candidate) => candidate.id === action.tradeId);
      if (!found) throw new FloorError(`no trade ${action.tradeId} on this floor`, 404);
      return room.session.refundTrade(action.tradeId, found.grossMinor - found.refundedMinor, note.length > 0 ? note : 'full refund');
    }
    case 'partial_refund': {
      const amount = action.amountMinor ?? 0;
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new FloorError('a partial refund needs a positive amount in minor units');
      return room.session.refundTrade(action.tradeId, amount, note.length > 0 ? note : 'partial refund');
    }
    case 'payout': {
      await room.session.payOutstanding();
      const settled = room.session.trades.find((candidate) => candidate.id === action.tradeId);
      if (!settled) throw new FloorError(`no trade ${action.tradeId} on this floor`, 404);
      return settled;
    }
  }
}

/**
 * Edit the tape on purpose and show what the audit does about it.
 *
 * The copy is made from the room's own messages and the original chain is never touched, so this is
 * a demonstration rather than damage: the point is that a one-character edit is reported at the
 * message it happened and then at every seal that followed it.
 */
export function tamperFloor(id: string, seq: number, field = 'grossMinor'): { total: number; findings: Finding[]; first: readonly string[] } {
  const room = mustFind(id);
  const messages = room.session.chain.messages;
  const index = messages.findIndex((message) => message.seq === seq);
  if (index < 0) throw new FloorError(`no message at seq ${seq} on this floor`, 404);
  const clean = verifyChain(messages, room.session.keyring);
  if (!clean.ok) throw new FloorError('this tape does not verify before the edit, so the demonstration would prove nothing', 409);
  const target = messages[index]!;
  const payload = { ...target.payload };
  const keys = Object.keys(payload);
  const key = keys.includes(field) ? field : keys[0] ?? 'tampered';
  const value = payload[key];
  payload[key] = typeof value === 'number' ? value + 1 : `${String(value ?? '')} edited`;
  const forged = messages.map((message, position) => (position === index ? { ...message, payload } : message));
  const after = verifyChain(forged, room.session.keyring);
  return {
    total: messages.length,
    findings: after.findings,
    first: after.findings.slice(0, 4).map((finding) => `seq ${finding.seq} - ${finding.code}: ${finding.detail}`),
  };
}

/**
 * Hand a verified webhook to whichever floor is holding that order.
 *
 * The gateway decides whether the signature is real; this only decides who it belongs to. A message
 * nobody can attribute is still put on the tape, because "the processor told us this and we did not
 * know what to do with it" is a thing the record should say out loud rather than swallow.
 */
export function deliverEvent(event: GatewayEvent): { id: string; matched: boolean } {
  for (const [id, room] of store().rooms) {
    const trade = room.session.trades.find(
      (candidate) => candidate.orderId === event.resourceId || candidate.captureReference === event.resourceId,
    );
    if (trade) {
      room.session.settler.ingest([event]);
      room.lastSeen = Date.now();
      return { id, matched: true };
    }
  }
  return { id: '', matched: false };
}

/**
 * Whose processor should decide whether this webhook is real.
 *
 * A room that talks to the live processor wins, because its signature check is the strict one; a
 * floor on the local sim is the fallback, so the same endpoint can be exercised with no credentials
 * at all. Pass an id to hold the delivery to one floor rather than letting the queue decide.
 */
export function webhookGateway(id?: string): PaymentGateway | null {
  if (id !== undefined && id.length > 0) return floorOf(id).gateway;
  const rooms = [...store().rooms.values()];
  const live = rooms.find((room) => room.session.gateway.mode === 'sandbox');
  const room = live ?? rooms[0];
  if (!room) return null;
  room.lastSeen = Date.now();
  return room.session.gateway;
}

export function floorOf(id: string): Session {
  return mustFind(id).session;
}

export interface TradeLocation {
  readonly floorId: string;
  readonly trade: TradeRecord;
}

/**
 * Find a settlement from its own id, without being told which room it happened in.
 *
 * A buyer comes back from the processor with a URL that carries the trade and nothing else - they
 * never saw the room id. When no floor answers, the honest report is that this machine has no such
 * settlement, rather than a page that guesses at what happened to the money.
 */
export function findTrade(tradeId: string): TradeLocation | null {
  for (const [floorId, room] of store().rooms) {
    const trade = room.session.settler.get(tradeId);
    if (trade) {
      room.lastSeen = Date.now();
      return { floorId, trade };
    }
  }
  return null;
}

/**
 * Whether the processor still holds an order open for its buyer, asked without moving anything.
 *
 * `approveOrder` is how the floor drives a capture, so a page a buyer's browser loads cannot use it:
 * the local processor approves on request, and a GET would settle money nobody signed for. The
 * processor's queue is the read-only half of the same truth - once an order has left it, the buyer
 * has approved, and the decision to capture goes back on the pile where a person makes it.
 */
export async function orderAwaitingBuyer(floorId: string, reference: string): Promise<boolean | null> {
  const room = mustFind(floorId);
  try {
    const waiting = await room.session.gateway.listWaiting();
    return waiting.some((order) => order.reference === reference);
  } catch {
    return null;
  }
}

/** A fresh, unguessable seed for somebody who just wants to see a floor run. */
export function suggestedSeed(): string {
  return randomUUID().slice(0, 8);
}