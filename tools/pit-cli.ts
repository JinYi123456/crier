import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { formatMoney, renderMoney, type CurrencyCode, type Money } from '../src/core/money.ts';
import { fingerprint } from '../src/core/canonical.ts';
import { DEFAULT_INSTRUMENTS, Session } from '../src/core/world.ts';
import { INSTRUMENTS } from '../src/core/catalog.ts';
import type { SealedMessage } from '../src/core/protocol.ts';
import type { TradeRecord } from '../src/core/settlement.ts';

/**
 * The floor without a screen.
 *
 * `npm run pit` plays a whole session in a terminal: the shouts, the prints, the settlements and
 * the closing balances. It is the same code path the web app drives, so anything the screen can
 * show can also be read here - and it is how a tape gets captured for a replay.
 */

interface Options {
  seed: string;
  ticks: number;
  agentsPerSide: number;
  instruments: string[] | null;
  currency: CurrencyCode;
  payoutMode: 'immediate' | 'batched';
  json: string | null;
  quiet: boolean;
}

const USAGE = `crier - the floor without a screen

  npm run pit -- [flags]

  --seed <text>          The market is a pure function of this. Default $CRIER_SEED.
  --ticks <n>            Rounds before the bell. Default 12.
  --agents <n>           Seats per side in each pit. Default 4.
  --instruments <a,b>    Comma-separated catalogue ids. Default: ${DEFAULT_INSTRUMENTS.join(', ')}.
  --currency <CODE>      Three-letter code the floor settles in. Default USD.
  --payout <mode>        immediate, or batched to hold the net in escrow. Default immediate.
  --json <file>          Write the session recording out for npm run audit:ledger.
  --quiet                Skip the round-by-round shouting; keep the prints and the closing volume.

  Ids: ${INSTRUMENTS.map((instrument) => instrument.id).join(', ')}.`;

function parseArgs(argv: readonly string[]): Options {
  const options: Options = {
    seed: process.env.CRIER_SEED ?? 'crier-default-seed',
    ticks: 12,
    agentsPerSide: 4,
    instruments: null,
    currency: 'USD',
    payoutMode: 'immediate',
    json: null,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    switch (argument) {
      case '--seed':
        if (value) options.seed = value;
        index += 1;
        break;
      case '--ticks':
        if (value) options.ticks = Number(value);
        index += 1;
        break;
      case '--agents':
        if (value) options.agentsPerSide = Number(value);
        index += 1;
        break;
      case '--instruments':
        if (value) options.instruments = value.split(',').map((part) => part.trim()).filter(Boolean);
        index += 1;
        break;
      case '--currency':
        if (value) options.currency = value.toUpperCase() as CurrencyCode;
        index += 1;
        break;
      case '--payout':
        if (value === 'batched' || value === 'immediate') options.payoutMode = value;
        index += 1;
        break;
      case '--json':
        if (value) options.json = value;
        index += 1;
        break;
      case '--quiet':
        options.quiet = true;
        break;
      case '-h':
      case '--help':
        console.log(USAGE);
        process.exit(0);
        break;
      default:
        throw new Error(`nothing answers to ${argument} - try --help`);
    }
  }
  if (!Number.isInteger(options.ticks) || options.ticks < 1) throw new Error('--ticks wants a whole number of rounds');
  if (!Number.isInteger(options.agentsPerSide) || options.agentsPerSide < 1) throw new Error('--agents wants a whole number per side');
  return options;
}

const RULE = '-'.repeat(96);

function money(minor: number, currency: CurrencyCode): Money {
  return { currency, minor };
}

function say(options: Options, line: string): void {
  if (!options.quiet) console.log(line);
}

function describeMessage(message: SealedMessage, currency: CurrencyCode): string | null {
  const { payload, type } = message;
  const at = new Date(message.ts).toISOString().slice(11, 19);
  switch (type) {
    case 'floor.quote':
      return `${at}  ${String(payload.voice ?? `${payload.side} ${payload.priceMinor} x${payload.qty}`)}  [${payload.reason}]`;
    case 'floor.accept':
      return `${at}      ${String(payload.voice ?? 'done')} - ${String(payload.party)}`;
    case 'floor.walk_away':
      return `${at}      ${String(payload.party)} leaves the floor: ${String(payload.reason)}`;
    case 'book.match':
      return `${at}      PRINT ${String(payload.buyer)} buys ${String(payload.qty)} at ${renderMoney(money(Number(payload.priceMinor), currency))} from ${String(payload.seller)}`;
    case 'book.cancel':
      return `${at}      ${String(payload.party)} withdraws ${String(payload.orders)} order(s)`;
    case 'human.veto':
      return payload.pending === true
        ? `${at}      HELD for a person: ${Array.isArray(payload.rules) ? payload.rules.join(', ') : String(payload.rules ?? '')}`
        : `${at}      human ${payload.action === 'veto' ? 'vetoed' : 'released'} ${String(payload.trade ?? '')}`;
    case 'human.release':
      return `${at}      human released ${String(payload.trade ?? '')}: ${String(payload.note ?? '')}`;
    case 'order.failed':
      return `${at}      settlement failed at ${String(payload.stage ?? '?')}: ${String(payload.detail ?? '')}`;
    default:
      return null;
  }
}

function describeTrade(trade: TradeRecord, currency: CurrencyCode): string {
  const flags = trade.held ? ` HELD(${trade.vetoRules.join('+') || 'rule'})` : '';
  const fee = trade.feeMinor > 0 ? ` fee ${renderMoney(money(trade.feeMinor, currency))}` : '';
  const refunded = trade.refundedMinor > 0 ? ` refunded ${renderMoney(money(trade.refundedMinor, currency))}` : '';
  return `${trade.id.slice(0, 22).padEnd(24)} ${trade.phase.padEnd(9)} ${String(trade.buyer).padEnd(22)} ${String(trade.seller).padEnd(22)} ${renderMoney(money(trade.grossMinor, currency))}${fee}${refunded}${flags}`;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const session = await Session.open({
    seed: options.seed,
    maxTicks: options.ticks,
    agentsPerSide: options.agentsPerSide,
    instrumentIds: options.instruments ?? undefined,
    currency: options.currency,
    payoutMode: options.payoutMode,
  });

  console.log(RULE);
  console.log(`Crier  session ${session.session}`);
  console.log(`seed ${options.seed}   ${options.currency}   ${options.agentsPerSide} a side   ${session.config.payoutMode} payouts`);
  for (const market of session.marketsView) {
    console.log(
      `  ${market.instrument.id.padEnd(14)} opens ${renderMoney(money(market.openingMinor, market.instrument.currency))}  tick ${market.instrument.tickSizeMinor}  lot: ${market.instrument.lot}`,
    );
  }
  console.log(RULE);

  let index = 0;
  const started = session.chain.messages.length;
  while (!session.closed && session.tick < options.ticks && session.activeParticipants().length > 0) {
    const report = await session.step();
    for (const message of session.chain.messages.slice(started + index)) {
      const line = describeMessage(message, options.currency);
      if (line) say(options, line);
    }
    index = session.chain.messages.length - started;
    say(options, `     round ${report.tick}: ${report.shouts} calls, ${report.fills.length} prints, ${report.walked.length} left${report.held.length > 0 ? `, ${report.held.length} held` : ''}`);
    if (report.silent) {
      say(options, 'the floor went quiet');
      break;
    }
  }
  await session.close();

  const report = session.report();
  console.log(RULE);
  console.log('SETTLEMENTS');
  for (const trade of session.trades) console.log(`  ${describeTrade(trade, options.currency)}`);

  console.log(RULE);
  const summary = report.summary;
  console.log(
    `${report.ticks} rounds   ${report.messages} messages   ${report.trades} trades   volume ${renderMoney(money(summary.grossMinor, options.currency))}` +
      `   fees ${renderMoney(money(summary.feeMinor, options.currency))}   refunded ${renderMoney(money(summary.refundedMinor, options.currency))}`,
  );
  console.log(`by phase: ${Object.entries(summary.byPhase).map(([phase, count]) => `${phase} ${count}`).join(', ')}`);
  console.log(`held for a person: ${summary.heldTrades}   awaiting payout: ${renderMoney(money(summary.pendingPayoutMinor, options.currency))}`);
  console.log(`books balanced: ${report.balanced ? 'yes' : 'NO'}   chain verified: ${report.verification.ok ? 'yes' : 'NO'}   head ${fingerprint(report.headHash, 8)}`);
  if (!report.verification.ok) {
    for (const finding of report.verification.findings.slice(0, 10)) console.log(`  ! ${finding.code} at seq ${finding.seq ?? '-'}: ${finding.detail}`);
  }
  console.log(RULE);

  if (options.json) {
    const target = resolve(process.cwd(), options.json);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(session.snapshot(), null, 2), 'utf8');
    console.log(`wrote ${target}`);
  }
  if (options.quiet) console.log(formatMoney(money(summary.grossMinor, options.currency)));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
