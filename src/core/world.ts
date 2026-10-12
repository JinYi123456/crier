import { bundledFeed, instrumentById, catalogFingerprint, type Instrument, type PriceFeed } from './catalog';
import { Rng, runId } from './rng';
import { derivedId } from './canonical';
import { identityFromSeed, type Identity } from './keys';
import { keyringFrom, newChain, verifyChain, GENESIS_HASH, type ChainState, type SealedMessage, type VerificationResult } from './protocol';
import { Book, type Best, type Fill, type RestingOrder } from './book';
import { DEFAULT_FEE_SCHEDULE, openBooks, type FeeSchedule } from './books';
import { Ledger, type Account, type LedgerEntry } from './ledger';
import { assertMinor, type CurrencyCode } from './money';
import {
  concessionProgress,
  describeStrategy,
  newAgentState,
  quoteFor,
  walkAwayReason,
  type AgentSpec,
  type AgentState,
  type StrategyKind,
} from './policy';
import { SimGateway } from '../gateway/sim';
import type { GatewayEvent, GatewayMode, PaymentGateway } from '../gateway/types';
import {
  Settler,
  AUTO_SETTLE_LIMIT_MINOR,
  FIRST_PAIRING_REVIEW_MINOR,
  MIN_REPUTATION_BPS,
  SESSION_EXPOSURE_CAP_MINOR,
  STRAY_PRICE_BPS,
  type SettlerSummary,
  type TradeRecord,
} from './settlement';

/**
 * One session on the floor.
 *
 * The order is fixed: an agent decides what to shout, the shout goes on the book, the book
 * matches or it does not, a match becomes a trade, a trade becomes a settlement, and every one
 * of those moments is written to the chain by the party that caused it. Nothing skips a step,
 * which is what makes the recording worth auditing.
 *
 * A session is a pure function of its seed. Run it twice and you get the same shouts, the same
 * fills, the same trades and the same hashes - that is what lets a test assert on behaviour and
 * a replay be more than a saved animation.
 */

const HOUSES = [
  'Kestrel',
  'Onyx',
  'Wren',
  'Meridian',
  'Halcyon',
  'Bramble',
  'Cormorant',
  'Sable',
  'Larkspur',
  'Verdant',
  'Anvil',
  'Pewter',
  'Quarry',
  'Tern',
  'Hollow',
  'Rook',
  'Bindlestiff',
  'Causeway',
] as const;

const STRATEGIES: readonly StrategyKind[] = ['patient', 'urgent', 'anchor', 'volume', 'holdout'];

export const DEFAULT_INSTRUMENTS = ['coffee-green', 'ceramic-mug', 'saffron'] as const;

/**
 * The bell. A session is a recording, so its clock starts at a fixed, published time rather than
 * at `Date.now()` - that is what lets two people compare tapes.
 */
export const DEFAULT_START_AT = Date.UTC(2026, 9, 13, 14, 0, 0);

export interface SessionConfig {
  readonly seed: string;
  readonly instrumentIds?: readonly string[];
  readonly agentsPerSide?: number;
  readonly maxTicks?: number;
  readonly currency?: CurrencyCode;
  readonly feeSchedule?: FeeSchedule;
  readonly gateway?: PaymentGateway;
  readonly feed?: PriceFeed;
  readonly payoutMode?: 'immediate' | 'batched';
  /** Cash the platform floats so a post-payout refund has somewhere to come from. */
  readonly openingFloatMinor?: number;
  readonly startAt?: number;
}

export interface Participant {
  readonly identity: Identity;
  readonly spec: AgentSpec;
  readonly state: AgentState;
}

export interface MarketView {
  readonly instrument: Instrument;
  readonly openingMinor: number;
  readonly lastPrintMinor: number | null;
  readonly best: Best;
  readonly depth: { bids: readonly { priceMinor: number; qty: number; orders: number }[]; asks: readonly { priceMinor: number; qty: number; orders: number }[] };
  readonly resting: readonly RestingOrder[];
  readonly participants: readonly Participant[];
}

export interface TickReport {
  readonly tick: number;
  readonly at: number;
  readonly shouts: number;
  readonly fills: Fill[];
  readonly trades: TradeRecord[];
  readonly held: TradeRecord[];
  readonly walked: string[];
  readonly silent: boolean;
}

export interface SessionReport {
  readonly session: string;
  readonly ticks: number;
  readonly messages: number;
  readonly trades: number;
  readonly fills: number;
  readonly volumeMinor: number;
  readonly feeMinor: number;
  readonly heldAtClose: number;
  readonly summary: SettlerSummary;
  readonly verification: VerificationResult;
  readonly balanced: boolean;
  readonly headHash: string;
}

export interface SerializedTrade {
  readonly id: string;
  readonly instrument: string;
  readonly buyer: string;
  readonly seller: string;
  readonly priceMinor: number;
  readonly qty: number;
  readonly grossMinor: number;
  readonly currency: CurrencyCode;
  readonly phase: string;
  readonly feeMinor: number;
  readonly netMinor: number;
  readonly refundedMinor: number;
  readonly orderId: string | null;
  readonly captureReference: string | null;
  readonly payoutReference: string | null;
  readonly refundReferences: string[];
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly held: boolean;
  readonly vetoRules: string[];
  readonly vetoReasons: string[];
  /** Where the buyer approves a live order. Only present while the processor is still waiting. */
  readonly approvalUrl: string | null;
  readonly vetoNote: string | null;
  readonly failure: string | null;
  readonly steps: { phase: string; at: number; note: string }[];
  readonly entries: string[];
  readonly messages: number[];
}

export interface SessionSnapshot {
  readonly session: string;
  readonly seed: string;
  readonly currency: CurrencyCode;
  /** Which processor this room is talking to, because a screen has to say whether the money is real. */
  readonly gateway: GatewayMode;
  readonly catalog: string;
  readonly startAt: number;
  readonly now: number;
  readonly tick: number;
  /** The bell: how many rounds this floor was opened for. */
  readonly maxTicks: number;
  readonly closed: boolean;
  readonly markets: {
    readonly instrumentId: string;
    readonly openingMinor: number;
    readonly lastPrintMinor: number | null;
    readonly best: Best;
    readonly bids: readonly RestingOrder[];
    readonly asks: readonly RestingOrder[];
  }[];
  readonly participants: {
    readonly id: string;
    readonly name: string;
    readonly role: 'buy' | 'sell';
    readonly instrument: string;
    readonly strategy: StrategyKind;
    readonly description: string;
    readonly reservationMinor: number;
    readonly targetMinor: number;
    readonly horizonTicks: number;
    /** Cash a buyer was seated with; zero for a seller, which has no cash limit. */
    readonly budgetMinor: number;
    /** Units a seller was seated with; zero for a buyer, which holds no stock. */
    readonly inventory: number;
    readonly spentMinor: number;
    readonly soldQty: number;
    readonly withdrawn: boolean;
    readonly quotesShouted: number;
    readonly fillsAsMaker: number;
    readonly fillsAsTaker: number;
    /** How far along its concession curve this house is, 0-1. */
    readonly pressure: number;
    readonly key: string;
  }[];
  readonly trades: SerializedTrade[];
  readonly accounts: readonly Account[];
  readonly entries: readonly LedgerEntry[];
  readonly messages: readonly SealedMessage[];
  readonly summary: SettlerSummary;
  readonly verification: VerificationResult;
  readonly headHash: string;
  /**
   * The lines this floor holds itself to, as numbers rather than prose.
   *
   * A screen says them out loud in the room's own currency; the sealed record keeps amounts as
   * integers so a re-verification never depends on whose locale formatted it.
   */
  readonly policy: {
    readonly autoSettleLimitMinor: number;
    readonly strayPriceBps: number;
    readonly minReputationBps: number;
    readonly sessionExposureCapMinor: number;
    readonly firstPairingReviewMinor: number;
    readonly feeBps: number;
    readonly feeFixedMinor: number;
  };
}

interface Market {
  readonly instrument: Instrument;
  readonly book: Book;
  readonly participants: Participant[];
  openingMinor: number;
  lastPrintMinor: number | null;
}

export class Session {
  readonly session: string;
  readonly config: Required<Pick<SessionConfig, 'seed' | 'currency' | 'agentsPerSide' | 'maxTicks' | 'startAt'>> & SessionConfig;
  readonly ledger = new Ledger();
  readonly chain: ChainState = newChain();
  readonly settler: Settler;
  readonly gateway: PaymentGateway;
  private readonly markets: Market[] = [];
  private readonly participants: Participant[] = [];
  private readonly identities = new Map<string, Identity>();
  private readonly pairCounts = new Map<string, number>();
  private readonly exposure = new Map<string, number>();
  private readonly rng: Rng;
  private clock: number;
  private fillCount = 0;
  tick = 0;
  closed = false;

  private constructor(config: SessionConfig) {
    const seed = config.seed;
    this.config = {
      ...config,
      seed,
      currency: config.currency ?? 'USD',
      agentsPerSide: config.agentsPerSide ?? 4,
      maxTicks: config.maxTicks ?? 12,
      startAt: config.startAt ?? DEFAULT_START_AT,
    };
    this.clock = this.config.startAt;
    this.rng = new Rng('crier/session', seed);
    this.session = `crier_${runId(seed, this.config.instrumentIds?.join(',') ?? DEFAULT_INSTRUMENTS.join(','), this.config.agentsPerSide ?? 4, this.config.maxTicks ?? 12)}`;
    this.gateway = config.gateway ?? new SimGateway({ declineBps: 60, reviewAboveMinor: 2_500_00, now: () => this.clock });

    this.identities.set('exchange', identityFromSeed(seed, 'exchange'));
    this.identities.set('human', identityFromSeed(seed, 'human'));

    openBooks(this.ledger, {
      currency: this.config.currency,
      feeSchedule: config.feeSchedule ?? DEFAULT_FEE_SCHEDULE,
      openingFloatMinor: config.openingFloatMinor ?? 25_000_00,
    }, this.at());

    this.settler = new Settler({
      ledger: this.ledger,
      gateway: this.gateway,
      chain: this.chain,
      session: this.session,
      exchange: this.identities.get('exchange') as Identity,
      human: this.identities.get('human') as Identity,
      feeSchedule: config.feeSchedule ?? DEFAULT_FEE_SCHEDULE,
      payoutMode: config.payoutMode ?? 'immediate',
      now: () => this.at(),
    });
  }

  /**
   * Open a session: pick the instruments, seat the houses, publish the opening prices.
   *
   * Async only because a live price feed may be the thing supplying the opening print.
   */
  static async open(config: SessionConfig): Promise<Session> {
    if (!config.seed || config.seed.length < 4) throw new Error('a session seed is required');
    const session = new Session(config);
    const feed = config.feed ?? bundledFeed();
    const ids = config.instrumentIds ?? DEFAULT_INSTRUMENTS;
    const roster = session.rng.shuffle(HOUSES);
    let seat = 0;

    for (const id of ids) {
      const instrument = instrumentById(id);
      if (instrument.currency !== session.config.currency) {
        throw new Error(`instrument ${id} is ${instrument.currency} but this session settles in ${session.config.currency}`);
      }
      const book = new Book(instrument.id, { tickSizeMinor: instrument.tickSizeMinor });
      const market: Market = { instrument, book, participants: [], openingMinor: 0, lastPrintMinor: null };
      const opening = await feed.open(instrument, session.session);
      market.openingMinor = opening.priceMinor;

      const rng = new Rng('crier/agents', config.seed, instrument.id);
      for (const role of ['sell', 'buy'] as const) {
        for (let index = 0; index < (session.config.agentsPerSide ?? 4); index += 1) {
          const house = roster[seat % roster.length] as string;
          seat += 1;
          const name = `${house} ${index + 1}`;
          const party = `${role}-${house.toLowerCase()}-${index + 1}-${instrument.symbol.toLowerCase()}`;
          const strategy = rng.pick(STRATEGIES);
          const spec = session.specFor(party, name, role, instrument, market.openingMinor, strategy, rng);
          const identity = identityFromSeed(config.seed, party);
          session.identities.set(party, identity);
          const participant: Participant = { identity, spec, state: newAgentState(spec) };
          market.participants.push(participant);
          session.participants.push(participant);
        }
      }
      session.markets.push(market);
    }

    session.announce('market.open', {
      session: session.session,
      seed: config.seed,
      currency: session.config.currency,
      catalog: catalogFingerprint(),
      feed: feed.mode,
      instruments: session.markets
        .map((market) => `${market.instrument.id}@${market.openingMinor}`)
        .join(','),
      houses: session.participants.length,
      maxTicks: session.config.maxTicks,
    });
    for (const market of session.markets) {
      session.announce('book.order', {
        instrument: market.instrument.id,
        openingMinor: market.openingMinor,
        tickSizeMinor: market.instrument.tickSizeMinor,
        lot: market.instrument.lot,
        reference: true,
      }, market.participants[0]?.identity ?? (session.identities.get('exchange') as Identity));
    }
    return session;
  }

  private specFor(
    party: string,
    name: string,
    role: 'buy' | 'sell',
    instrument: Instrument,
    openingMinor: number,
    strategy: StrategyKind,
    rng: Rng,
  ): AgentSpec {
    const tick = instrument.tickSizeMinor;
    /** A price `bps` basis points away from the open, snapped to a whole tick. */
    const priceAt = (bps: number): number => {
      const steps = Math.round((openingMinor * (10_000 + bps)) / 10_000 / tick);
      return Math.max(1, steps) * tick;
    };
    const lots = rng.range(2, 5);
    const horizonTicks = rng.range(6, Math.max(6, (this.config.maxTicks ?? 12) - 1));
    // Standing in the pit is mostly earned: a handful of the seats belong to houses that have
    // not settled much yet, and those are the pairings a human should look at first.
    const reputationBps = rng.next() < 0.12 ? rng.range(1_500, 2_900) : rng.range(3_200, 9_500);
    const common = { id: party, instrument: instrument.id, horizonTicks, strategy, maxQtyPerTick: rng.range(1, 3), reputationBps };

    // Each agent is placed by two numbers in basis points off the open: where it hopes to get
    // and the line it will not cross. A buyer aims under the open with a ceiling above it, a
    // seller aims over the open with a floor under it - which is what leaves a deal to be had
    // without either side ever saying so.
    if (role === 'buy') {
      const aimBps = -rng.range(150, 500);
      const ceilingBps = aimBps + rng.range(300, 900);
      const targetMinor = priceAt(aimBps);
      const reservationMinor = Math.max(targetMinor + tick, priceAt(ceilingBps));
      return {
        ...common,
        name,
        role,
        targetMinor,
        reservationMinor,
        budgetMinor: assertMinor(reservationMinor * lots, 'agent budget'),
      };
    }
    const aimBps = rng.range(150, 500);
    const floorBps = aimBps - rng.range(300, 900);
    const targetMinor = priceAt(aimBps);
    const reservationMinor = Math.max(tick, Math.min(targetMinor - tick, priceAt(floorBps)));
    return {
      ...common,
      name,
      role,
      targetMinor,
      reservationMinor,
      inventory: lots,
    };
  }

  private at(): number {
    return this.clock;
  }

  /** Every message moves the clock on a little, so the tape has an honest ordering. */
  private advance(ms = 120): void {
    this.clock += ms;
  }

  private announce(
    type: Parameters<Settler['announce']>[0],
    payload: Record<string, unknown>,
    actor: Identity = this.identities.get('exchange') as Identity,
  ): SealedMessage {
    this.advance();
    return this.settler.announce(type, payload, actor);
  }

  get marketsView(): MarketView[] {
    return this.markets.map((market) => ({
      instrument: market.instrument,
      openingMinor: market.openingMinor,
      lastPrintMinor: market.lastPrintMinor,
      best: market.book.best(),
      depth: market.book.depth(),
      resting: market.book.getOrders(),
      participants: market.participants,
    }));
  }

  get trades(): TradeRecord[] {
    return this.settler.all;
  }

  get heldTrades(): TradeRecord[] {
    return this.settler.held;
  }

  activeParticipants(): Participant[] {
    return this.participants.filter((participant) => !participant.state.withdrawn);
  }

  /** Every seat on the floor, taken or not. */
  get roster(): Participant[] {
    return this.participants;
  }

  /**
   * One round of the floor. Every seated house gets one shout, the book does the matching, and
   * whatever crosses is settled straight away.
   */
  async step(): Promise<TickReport> {
    if (this.closed) throw new Error('the session is closed');
    this.tick += 1;
    const at = this.at();
    const trades: TradeRecord[] = [];
    const fills: Fill[] = [];
    const walked: string[] = [];
    let shouts = 0;

    for (let index = 0; index < this.markets.length; index += 1) {
      const market = this.markets[index] as Market;
      const rotation = (this.tick + index) % market.participants.length;
      for (let offset = 0; offset < market.participants.length; offset += 1) {
        const participant = market.participants[(rotation + offset) % market.participants.length] as Participant;
        if (participant.state.withdrawn) continue;

        const committed = market.book.committedFor(participant.spec.id);
        const quote = quoteFor({
          state: participant.state,
          tick: this.tick,
          tickSizeMinor: market.instrument.tickSizeMinor,
          best: market.book.best(),
          rng: this.rng,
          minMarginMinor: market.instrument.tickSizeMinor,
          committedMinor: committed.minor,
          committedQty: committed.qty,
        });
        if (quote === null) {
          const reason = walkAwayReason({ state: participant.state, tick: this.tick, best: market.book.best() });
          if (reason !== null) {
            participant.state.withdrawn = true;
            const cancelled = market.book.cancelFor(participant.spec.id);
            if (cancelled.length > 0) {
              this.announce('book.cancel', { instrument: market.instrument.id, party: participant.spec.id, orders: cancelled.join(',') }, participant.identity);
            }
            this.announce('floor.walk_away', { instrument: market.instrument.id, party: participant.spec.id, reason }, participant.identity);
            walked.push(participant.spec.id);
          }
          continue;
        }

        shouts += 1;
        participant.state.roundsHeld += 1;
        this.announce(
          'floor.quote',
          {
            instrument: market.instrument.id,
            party: participant.spec.id,
            side: quote.side,
            priceMinor: quote.priceMinor,
            qty: quote.qty,
            kind: quote.kind,
            reason: quote.reason,
            voice: quote.voice,
            urgencyBps: Math.round(quote.urgency * 10_000),
          },
          participant.identity,
        );

        const result = market.book.place({
          party: participant.spec.id,
          side: quote.side,
          priceMinor: quote.priceMinor,
          qty: quote.qty,
          ts: this.at(),
          kind: quote.kind,
          reason: quote.reason,
        });
        this.announce(
          'book.order',
          {
            instrument: market.instrument.id,
            order: result.order.id,
            party: participant.spec.id,
            side: quote.side,
            priceMinor: quote.priceMinor,
            qty: quote.qty,
            kind: quote.kind,
            resting: result.order.remaining,
            rejected: result.rejected ?? '',
            expiredQty: result.expiredQty,
          },
          participant.identity,
        );

        for (const fill of result.fills) {
          fills.push(fill);
          this.fillCount += 1;
          const maker = this.partyOf(fill.maker);
          participant.state.fillsAsTaker += 1;
          if (maker) maker.state.fillsAsMaker += 1;
          this.announce(
            'book.match',
            {
              instrument: market.instrument.id,
              fill: fill.id,
              priceMinor: fill.priceMinor,
              qty: fill.qty,
              buyer: fill.buyer,
              seller: fill.seller,
              aggressor: quote.side,
              maker: fill.maker,
              buyOrder: fill.buyOrder,
              sellOrder: fill.sellOrder,
            },
            participant.identity,
          );
          // The resting side is the one that said yes to the shouted price.
          this.announce(
            'floor.accept',
            { instrument: market.instrument.id, fill: fill.id, priceMinor: fill.priceMinor, party: fill.maker, voice: 'done' },
            maker?.identity ?? participant.identity,
          );
          trades.push(await this.onFill(market, fill));
        }
      }
    }

    this.ingestEvents();
    return {
      tick: this.tick,
      at,
      shouts,
      fills,
      trades,
      held: trades.filter((trade) => trade.held),
      walked,
      silent: shouts === 0 && walked.length === 0,
    };
  }

  private async onFill(market: Market, fill: Fill): Promise<TradeRecord> {
    const buyer = this.partyOf(fill.buyer);
    const seller = this.partyOf(fill.seller);
    const cost = assertMinor(fill.priceMinor * fill.qty, 'fill cost');
    if (buyer) {
      buyer.state.spentMinor += cost;
    }
    if (seller) {
      seller.state.soldQty += fill.qty;
    }

    const pairKey = `${fill.buyer}|${fill.seller}`;
    const priorPairing = this.pairCounts.get(pairKey) ?? 0;
    const sellerExposureMinor = this.exposure.get(fill.seller) ?? 0;
    market.lastPrintMinor = fill.priceMinor;

    const trade = await this.settler.settle({
      tradeId: derivedId('trade', this.session, fill.id),
      instrument: market.instrument.id,
      buyer: fill.buyer,
      seller: fill.seller,
      priceMinor: fill.priceMinor,
      qty: fill.qty,
      currency: market.instrument.currency,
      referencePriceMinor: market.openingMinor,
      buyerReputationBps: buyer?.spec.reputationBps ?? 10_000,
      sellerReputationBps: seller?.spec.reputationBps ?? 10_000,
      priorPairing,
      sellerExposureMinor,
      description: market.instrument.lot,
    });
    if (trade.phase !== 'failed' && trade.phase !== 'declined' && trade.phase !== 'voided') {
      this.pairCounts.set(pairKey, priorPairing + 1);
      this.exposure.set(fill.seller, sellerExposureMinor + trade.grossMinor);
    }
    return trade;
  }

  private partyOf(id: string): Participant | undefined {
    return this.participants.find((participant) => participant.spec.id === id);
  }

  /** Pull whatever the processor sent asynchronously and put it on the chain as verified hooks. */
  ingestEvents(): void {
    const drain = (this.gateway as { drainEvents?: () => GatewayEvent[] }).drainEvents;
    if (typeof drain !== 'function') return;
    const events = drain.call(this.gateway);
    if (events.length > 0) {
      this.settler.ingest(events);
      this.advance();
    }
  }

  /**
   * The four things a human on the floor can do, each signed by the human's own key rather
   * than attributed to the platform.
   */
  async releaseTrade(tradeId: string, note: string): Promise<TradeRecord> {
    const trade = await this.settler.release(tradeId, note);
    this.ingestEvents();
    return trade;
  }

  async vetoTrade(tradeId: string, note: string): Promise<TradeRecord> {
    const trade = await this.settler.veto(tradeId, note);
    this.ingestEvents();
    return trade;
  }

  async refundTrade(tradeId: string, amountMinor: number, reason: string): Promise<TradeRecord> {
    const trade = await this.settler.refund(tradeId, amountMinor, reason);
    this.ingestEvents();
    return trade;
  }

  async payOutstanding(): Promise<TradeRecord[]> {
    const moved = await this.settler.settlePayouts();
    this.ingestEvents();
    return moved;
  }

  /** Run the floor until every house has left or the bell goes. */
  async run(): Promise<SessionReport> {
    while (!this.closed && this.tick < (this.config.maxTicks ?? 12) && this.activeParticipants().length > 0) {
      const report = await this.step();
      if (report.silent) break;
    }
    await this.close();
    return this.report();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.config.payoutMode === 'batched') await this.settler.settlePayouts();
    const summary = this.settler.summary();
    this.announce('market.close', {
      session: this.session,
      ticks: this.tick,
      trades: summary.trades,
      grossMinor: summary.grossMinor,
      feeMinor: summary.feeMinor,
      refundedMinor: summary.refundedMinor,
      heldTrades: summary.heldTrades,
      headHash: this.chain.headHash === GENESIS_HASH ? '' : this.chain.headHash,
    });
  }

  report(): SessionReport {
    const summary = this.settler.summary();
    return {
      session: this.session,
      ticks: this.tick,
      messages: this.chain.messages.length,
      trades: summary.trades,
      fills: this.fillCount,
      volumeMinor: summary.grossMinor,
      feeMinor: summary.feeMinor,
      heldAtClose: summary.heldTrades,
      summary,
      verification: verifyChain(this.chain.messages, this.keyring),
      balanced: this.ledger.isBalanced(),
      headHash: this.chain.headHash,
    };
  }

  get keyring(): ReturnType<typeof keyringFrom> {
    return keyringFrom([...this.identities.values()]);
  }

  get identitiesList(): Identity[] {
    return [...this.identities.values()];
  }

  /** Everything a screen needs, in one JSON-safe object. */
  snapshot(): SessionSnapshot {
    return {
      session: this.session,
      seed: this.config.seed,
      currency: this.config.currency,
      catalog: catalogFingerprint(),
      startAt: this.config.startAt,
      now: this.at(),
      tick: this.tick,
      maxTicks: this.config.maxTicks,
      closed: this.closed,
      gateway: this.gateway.mode,
      markets: this.markets.map((market) => ({
        instrumentId: market.instrument.id,
        openingMinor: market.openingMinor,
        lastPrintMinor: market.lastPrintMinor,
        best: market.book.best(),
        bids: market.book.toJSON().bids,
        asks: market.book.toJSON().asks,
      })),
      participants: this.participants.map((participant) => ({
        id: participant.spec.id,
        name: participant.spec.name,
        role: participant.spec.role,
        instrument: participant.spec.instrument,
        strategy: participant.spec.strategy,
        description: describeStrategy(participant.spec.strategy),
        reservationMinor: participant.spec.reservationMinor,
        targetMinor: participant.spec.targetMinor,
        horizonTicks: participant.spec.horizonTicks,
        budgetMinor: participant.spec.budgetMinor ?? 0,
        inventory: participant.spec.inventory ?? 0,
        spentMinor: participant.state.spentMinor,
        soldQty: participant.state.soldQty,
        withdrawn: participant.state.withdrawn,
        quotesShouted: participant.state.quotesShouted,
        fillsAsMaker: participant.state.fillsAsMaker,
        fillsAsTaker: participant.state.fillsAsTaker,
        /** How far along its concession curve this house is, so the pit can draw it as a halo. */
        pressure: concessionProgress(participant.state, this.tick),
        key: participant.identity.publicKey,
      })),
      trades: this.trades.map(serializeTrade),
      accounts: this.ledger.listAccounts(),
      entries: this.ledger.listEntries(),
      messages: this.chain.messages,
      summary: this.settler.summary(),
      verification: verifyChain(this.chain.messages, this.keyring),
      headHash: this.chain.headHash,
      policy: {
        autoSettleLimitMinor: AUTO_SETTLE_LIMIT_MINOR,
        strayPriceBps: STRAY_PRICE_BPS,
        minReputationBps: MIN_REPUTATION_BPS,
        sessionExposureCapMinor: SESSION_EXPOSURE_CAP_MINOR,
        firstPairingReviewMinor: FIRST_PAIRING_REVIEW_MINOR,
        feeBps: (this.config.feeSchedule ?? DEFAULT_FEE_SCHEDULE).bps,
        feeFixedMinor: (this.config.feeSchedule ?? DEFAULT_FEE_SCHEDULE).fixedMinor,
      },
    };
  }

  /** The number of the concession curve at the current tick - the pit draws this as a halo. */
  pressureFor(partyId: string): number {
    const participant = this.partyOf(partyId);
    if (!participant) return 0;
    return concessionProgress(participant.state, this.tick);
  }
}

function serializeTrade(trade: TradeRecord): SerializedTrade {
  return {
    id: trade.id,
    instrument: trade.instrument,
    buyer: trade.buyer,
    seller: trade.seller,
    priceMinor: trade.priceMinor,
    qty: trade.qty,
    grossMinor: trade.grossMinor,
    currency: trade.currency,
    phase: trade.phase,
    feeMinor: trade.feeMinor,
    netMinor: trade.netMinor,
    refundedMinor: trade.refundedMinor,
    orderId: trade.orderId,
    captureReference: trade.captureReference,
    payoutReference: trade.payoutReference,
    refundReferences: [...trade.refundReferences],
    createdAt: trade.createdAt,
    updatedAt: trade.updatedAt,
    held: trade.held,
    vetoRules: [...trade.vetoRules],
    vetoReasons: [...trade.vetoReasons],
    approvalUrl: trade.approvalUrl,
    vetoNote: trade.vetoNote,
    failure: trade.failure,
    steps: trade.steps.map((step) => ({ phase: step.phase, at: step.at, note: step.note })),
    entries: trade.entries.map((entry) => entry.id),
    messages: trade.messages.map((message) => message.seq),
  };
}

