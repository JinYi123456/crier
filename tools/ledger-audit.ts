import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACCOUNT } from '../src/core/books.ts';
import { Ledger, type LedgerEntry } from '../src/core/ledger.ts';
import { computeSealHash, GENESIS_HASH, keyringFrom, verifyChain } from '../src/core/protocol.ts';
import { identityFromPublicKeyHex } from '../src/core/keys.ts';
import { money, renderMoney } from '../src/core/money.ts';
import { Session, type SessionSnapshot } from '../src/core/world.ts';

/**
 * An audit that does not trust the engine.
 *
 * `npm run pit` prints what happened. This re-derives it from the recording: it adds up every
 * posting from scratch, checks the trial balance and every account floor, walks the message
 * chain with only the public keys visible in the tape itself, and refuses to call a session
 * clean unless all of it holds. Point it at a saved snapshot and a run can be audited long
 * after the floor has closed.
 */

class Report {
  readonly problems: string[] = [];

  note(line: string): void {
    console.log(line);
  }

  fail(problem: string): void {
    this.problems.push(problem);
  }

  get clean(): boolean {
    return this.problems.length === 0;
  }
}

/** Balances re-derived from postings, ignoring whatever the ledger thinks it holds. */
function recompute(entries: readonly LedgerEntry[], report: Report): Map<string, number> {
  const byAccount = new Map<string, number>();
  let debit = 0;
  let credit = 0;
  for (const entry of entries) {
    let entryDebit = 0;
    let entryCredit = 0;
    for (const posting of entry.postings) {
      entryDebit += posting.debit;
      entryCredit += posting.credit;
      byAccount.set(posting.account, (byAccount.get(posting.account) ?? 0) + posting.debit - posting.credit);
    }
    if (entryDebit !== entryCredit) report.fail(`entry ${entry.id} is not balanced: ${entryDebit} debit against ${entryCredit} credit`);
    debit += entryDebit;
    credit += entryCredit;
  }
  report.note(`trial balance    ${debit} debit / ${credit} credit  ${debit === credit ? 'balanced' : 'IMBALANCED'}`);
  if (debit !== credit) report.fail('the trial balance does not sum to zero');
  return byAccount;
}

function audit(snapshot: SessionSnapshot, report: Report): void {
  report.note(`session          ${snapshot.session}  (${snapshot.tick} rounds, closed: ${snapshot.closed ? 'yes' : 'no'})`);
  report.note('-'.repeat(78));

  const byAccount = recompute(snapshot.entries, report);
  report.note(`entries          ${snapshot.entries.length} across ${snapshot.accounts.length} accounts`);

  const ledger = new Ledger(snapshot.accounts);
  for (const finding of ledger.audit()) report.fail(`ledger audit: ${finding.code} ${finding.detail}`);

  for (const account of snapshot.accounts) {
    const raw = byAccount.get(account.id) ?? 0;
    const normal = account.type === 'asset' || account.type === 'expense' ? raw : -raw;
    if (account.floorMinor !== undefined && normal < account.floorMinor) {
      report.fail(`${account.id} is at ${normal}, below its floor of ${account.floorMinor}`);
    }
  }

  const escrow = byAccount.get(ACCOUNT.escrow) ?? 0;
  const openGross = snapshot.trades
    .filter((trade) => trade.phase === 'funded' || trade.phase === 'captured')
    .reduce((sum, trade) => sum + trade.grossMinor, 0);
  report.note(`escrow           ${renderMoney(money(snapshot.currency, escrow))}, which is what ${snapshot.trades.filter((t) => t.phase === 'funded' || t.phase === 'captured').length} unsettled trade(s) are owed (${openGross})`);
  if (escrow !== openGross) report.fail(`escrow holds ${escrow} but open trades are owed ${openGross}`);

  // An auditor has no private keys and no reason to trust the engine's keyring, so the tape is
  // read on its own terms: each actor gets whatever key it first claimed, every later message
  // must keep that key, and the signatures are checked against those keys alone.
  const claimed = new Map<string, string>();
  const seated = new Map(snapshot.participants.map((participant) => [participant.id, participant.key]));
  for (const message of snapshot.messages) {
    const seen = claimed.get(message.actor);
    if (seen === undefined) {
      claimed.set(message.actor, message.key);
      const seat = seated.get(message.actor);
      if (seat !== undefined && seat !== message.key) {
        report.fail(`${message.actor} signed seq ${message.seq} with ${message.key.slice(0, 12)}..., but the session seated it with ${seat.slice(0, 12)}...`);
      }
    } else if (seen !== message.key) {
      report.fail(`${message.actor} changed key at seq ${message.seq}`);
    }
  }
  const identities = [...claimed].map(([actor, key]) => identityFromPublicKeyHex(actor, key));
  for (const participant of snapshot.participants) {
    const signed = claimed.get(participant.id);
    if (signed !== undefined && signed !== participant.key) {
      report.fail(`${participant.id} is seated with ${participant.key.slice(0, 12)}... but signed the tape with ${signed.slice(0, 12)}...`);
    }
  }
  const verification = verifyChain(snapshot.messages, keyringFrom(identities));
  report.note(`messages         ${snapshot.messages.length}, head ${snapshot.headHash.slice(0, 16)}...`);
  report.note(`chain            ${verification.ok ? `verified against ${identities.length} public keys found in the tape` : `BROKEN: ${verification.findings.length} finding(s)`}`);
  if (!verification.ok) {
    for (const finding of verification.findings.slice(0, 10)) report.fail(`chain seq ${finding.seq}: ${finding.code} ${finding.detail}`);
  }
  const last = snapshot.messages[snapshot.messages.length - 1];
  const head = last ? computeSealHash(last) : GENESIS_HASH;
  if (snapshot.headHash !== head) report.fail(`the recording claims head ${snapshot.headHash}, the chain says ${head}`);

  const feeRevenue = -(byAccount.get(ACCOUNT.feeRevenue) ?? 0);
  const feeSum = snapshot.trades.reduce((sum, trade) => sum + trade.feeMinor, 0);
  report.note(`fees             ${renderMoney(money(snapshot.currency, feeRevenue))} earned, trades account for ${feeSum}`);
  if (feeRevenue > feeSum) report.fail(`the revenue book holds ${feeRevenue} but the trades only account for ${feeSum}`);

  const summary = snapshot.summary;
  report.note(`summary          ${summary.trades} trades, gross ${summary.grossMinor}, refunded ${summary.refundedMinor}, held ${summary.heldTrades}, awaiting payout ${summary.pendingPayoutMinor}`);
  report.note('-'.repeat(78));
}

function argument(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const report = new Report();
  const file = argument(argv, '--file');

  let snapshot: SessionSnapshot;
  if (file) {
    const path = resolve(process.cwd(), file);
    snapshot = JSON.parse(readFileSync(path, 'utf8')) as SessionSnapshot;
    report.note(`auditing the recording at ${path}`);
  } else {
    const seed = argument(argv, '--seed') ?? process.env.CRIER_SEED ?? 'crier-default-seed';
    const ticks = Number(argument(argv, '--ticks') ?? '12');
    report.note(`playing a fresh session from seed ${seed}`);
    const session = await Session.open({ seed, maxTicks: Number.isFinite(ticks) ? ticks : 12 });
    await session.run();
    snapshot = session.snapshot();
  }

  audit(snapshot, report);

  if (!report.clean) {
    for (const problem of report.problems) console.error(`  ! ${problem}`);
    console.error(`ledger audit: ${report.problems.length} problem(s)`);
    process.exit(1);
  }
  console.log('ledger audit: clean');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
