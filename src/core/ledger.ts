import { derivedId } from './canonical';
import { MoneyError, assertMinor, type CurrencyCode } from './money';

/**
 * The double-entry book.
 *
 * Money is never moved, only re-expressed as a set of debit and credit lines that have to
 * balance to the unit. That is the whole reason the ledger can be trusted: "the escrow account
 * holds what the buyers paid minus what has been released" is not a rule we remember to obey,
 * it is the only shape an entry can take before it is accepted.
 */

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';

/** Normal balance: the side on which an account grows. */
export const NORMAL_BALANCE: Record<AccountType, 'debit' | 'credit'> = {
  asset: 'debit',
  expense: 'debit',
  liability: 'credit',
  equity: 'credit',
  revenue: 'credit',
};

export interface Account {
  readonly id: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: CurrencyCode;
  /** Which party on the floor owns this pocket of money, when there is one. */
  readonly party?: string;
  /** Lowest balance the account is ever allowed to reach, in minor units of its own currency. */
  readonly floorMinor?: number;
}

export interface Posting {
  readonly account: string;
  readonly debit: number;
  readonly credit: number;
}

export type EntryCode =
  | 'ESCROW_HOLD'
  | 'TRADE_CAPTURE'
  | 'PLATFORM_FEE'
  | 'SELLER_PAYOUT'
  | 'REFUND_ISSUED'
  | 'ORDER_VOIDED'
  | 'OPENING_BALANCE'
  | 'SETTLEMENT';

export interface LedgerEntry {
  readonly id: string;
  readonly seq: number;
  readonly ts: number;
  readonly memo: string;
  readonly code: EntryCode;
  readonly currency: CurrencyCode;
  readonly postings: readonly Posting[];
  readonly idempotencyKey: string;
  readonly refs: Readonly<Record<string, string>>;
}

export class LedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LedgerError';
  }
}

export interface LedgerAuditFinding {
  readonly code: 'trial_balance_imbalanced' | 'unknown_account' | 'floor_breached' | 'duplicate_id' | 'non_atomic_posting' | 'currency_mismatch';
  readonly detail: string;
  readonly entryId?: string;
  readonly account?: string;
}

export interface NewEntry {
  readonly ts: number;
  readonly memo: string;
  readonly code: EntryCode;
  readonly currency: CurrencyCode;
  readonly postings: readonly Posting[];
  readonly idempotencyKey: string;
  readonly refs?: Record<string, string>;
}

export class Ledger {
  private readonly accounts = new Map<string, Account>();
  private readonly entries: LedgerEntry[] = [];
  private readonly balances = new Map<string, number>();
  private readonly byIdempotencyKey = new Map<string, LedgerEntry>();

  constructor(initialAccounts: readonly Account[] = []) {
    for (const account of initialAccounts) this.declare(account);
  }

  declare(account: Account): Account {
    const existing = this.accounts.get(account.id);
    if (existing) {
      if (existing.currency !== account.currency || existing.type !== account.type) {
        throw new LedgerError(`account ${account.id} is already declared as ${existing.type} ${existing.currency}`);
      }
      return existing;
    }
    this.accounts.set(account.id, account);
    this.balances.set(account.id, 0);
    return account;
  }

  hasAccount(id: string): boolean {
    return this.accounts.has(id);
  }

  account(id: string): Account {
    const found = this.accounts.get(id);
    if (!found) throw new LedgerError(`unknown account ${id}`);
    return found;
  }

  listAccounts(): Account[] {
    return [...this.accounts.values()];
  }

  listEntries(): LedgerEntry[] {
    return [...this.entries];
  }

  get size(): number {
    return this.entries.length;
  }

  /** Signed balance in the account's normal direction: positive means the account holds that much. */
  balanceOf(id: string): number {
    const account = this.account(id);
    const signed = this.balances.get(id) ?? 0;
    if (account.type === 'asset' || account.type === 'expense') return signed;
    return signed === 0 ? 0 : -signed;
  }

  /** Raw debit-minus-credit, which is how the trial balance is actually computed. */
  signed(id: string): number {
    return this.balances.get(id) ?? 0;
  }

  totalDebit(): number {
    return this.entries.reduce((sum, entry) => sum + entry.postings.reduce((s, p) => s + p.debit, 0), 0);
  }

  totalCredit(): number {
    return this.entries.reduce((sum, entry) => sum + entry.postings.reduce((s, p) => s + p.credit, 0), 0);
  }

  isBalanced(): boolean {
    return this.totalDebit() === this.totalCredit();
  }

  /**
   * Post an entry, or return the entry that an earlier call with the same idempotency key
   * already posted. Retrying a settlement is therefore safe: the second call is a no-op
   * that reports the first result instead of moving the money twice.
   */
  post(input: NewEntry): { entry: LedgerEntry; created: boolean } {
    const prior = this.byIdempotencyKey.get(input.idempotencyKey);
    if (prior) {
      if (hashShape(prior) !== hashShape(input)) {
        throw new LedgerError(`idempotency key ${input.idempotencyKey} was already used for a different entry`);
      }
      return { entry: prior, created: false };
    }

    const entry = this.validate(input);

    // Check every resulting balance before touching anything: an entry either lands whole
    // or leaves the books exactly as they were.
    for (const posting of entry.postings) {
      const projected = (this.balances.get(posting.account) ?? 0) + posting.debit - posting.credit;
      const account = this.account(posting.account);
      const signed = account.type === 'liability' || account.type === 'equity' || account.type === 'revenue' ? -projected : projected;
      if (account.floorMinor !== undefined && signed < account.floorMinor) {
        throw new LedgerError(
          `entry ${entry.id} would take ${account.id} to ${signed}, below its floor of ${account.floorMinor}`,
        );
      }
    }

    for (const posting of entry.postings) {
      this.balances.set(posting.account, (this.balances.get(posting.account) ?? 0) + posting.debit - posting.credit);
    }
    this.entries.push(entry);
    this.byIdempotencyKey.set(entry.idempotencyKey, entry);
    return { entry, created: true };
  }

  /**
   * Run a group of postings as one unit. A multi-entry movement (a refund is two: the claim
   * and the cash) must not be left half-applied when the second entry is refused.
   */
  transaction<T>(work: () => T): T {
    const entryCount = this.entries.length;
    const balances = new Map(this.balances);
    const idempotency = [...this.byIdempotencyKey.entries()];
    const accountCount = this.accounts.size;
    try {
      return work();
    } catch (error) {
      this.entries.length = entryCount;
      this.balances.clear();
      for (const [id, value] of balances) this.balances.set(id, value);
      this.byIdempotencyKey.clear();
      for (const [key, value] of idempotency) this.byIdempotencyKey.set(key, value);
      for (const id of [...this.accounts.keys()].slice(accountCount)) {
        this.accounts.delete(id);
        this.balances.delete(id);
      }
      throw error;
    }
  }

  private validate(input: NewEntry): LedgerEntry {
    if (input.postings.length < 2) throw new LedgerError('an entry needs at least two postings');
    let debits = 0;
    let credits = 0;
    const seen = new Set<string>();

    for (const posting of input.postings) {
      const account = this.account(posting.account);
      if (account.currency !== input.currency) {
        throw new LedgerError(`posting to ${account.id} is ${account.currency} but the entry is ${input.currency}`);
      }
      if (seen.has(posting.account)) throw new LedgerError(`duplicate posting line for ${posting.account} in one entry`);
      seen.add(posting.account);
      assertMinorSafe(posting.debit, `debit on ${posting.account}`);
      assertMinorSafe(posting.credit, `credit on ${posting.account}`);
      if (posting.debit > 0 && posting.credit > 0) {
        throw new LedgerError(`posting on ${posting.account} carries both a debit and a credit - gross it up instead`);
      }
      if (posting.debit === 0 && posting.credit === 0) {
        throw new LedgerError(`posting on ${posting.account} moves nothing`);
      }
      debits += posting.debit;
      credits += posting.credit;
    }

    if (debits !== credits) {
      throw new MoneyError(`entry "${input.memo}" is unbalanced: debits ${debits} vs credits ${credits}`);
    }
    if (!Number.isSafeInteger(debits)) throw new LedgerError('entry totals exceeded the safe integer range');

    const seq = this.entries.length;
    return {
      id: derivedId('entry', input.idempotencyKey, seq),
      seq,
      ts: input.ts,
      memo: input.memo,
      code: input.code,
      currency: input.currency,
      postings: input.postings.map((p) => ({ account: p.account, debit: p.debit, credit: p.credit })),
      idempotencyKey: input.idempotencyKey,
      refs: { ...(input.refs ?? {}) },
    };
  }

  /** Re-derive every balance from the entries. Used by the audit and after loading a snapshot. */
  recompute(): void {
    for (const key of this.balances.keys()) this.balances.set(key, 0);
    for (const entry of this.entries) {
      for (const posting of entry.postings) {
        this.balances.set(posting.account, (this.balances.get(posting.account) ?? 0) + posting.debit - posting.credit);
      }
    }
  }

  audit(): LedgerAuditFinding[] {
    const findings: LedgerAuditFinding[] = [];
    const debits = this.totalDebit();
    const credits = this.totalCredit();
    if (debits !== credits) {
      findings.push({
        code: 'trial_balance_imbalanced',
        detail: `total debits ${debits} do not equal total credits ${credits} (off by ${debits - credits})`,
      });
    }
    for (const entry of this.entries) {
      for (const posting of entry.postings) {
        if (!this.accounts.has(posting.account)) {
          findings.push({ code: 'unknown_account', detail: `${posting.account} is not in the chart of accounts`, entryId: entry.id, account: posting.account });
        }
        if (posting.debit > 0 && posting.credit > 0) {
          findings.push({ code: 'non_atomic_posting', detail: `${posting.account} carries both sides in one line`, entryId: entry.id, account: posting.account });
        }
      }
      const currencies = new Set(entry.postings.map((p) => this.accounts.get(p.account)?.currency));
      if (currencies.size > 1 || currencies.has(undefined)) {
        findings.push({ code: 'currency_mismatch', detail: `${entry.id} mixes accounts of different currencies`, entryId: entry.id });
      }
    }
    for (const account of this.accounts.values()) {
      if (account.floorMinor === undefined) continue;
      const balance = this.balanceOf(account.id);
      if (balance < account.floorMinor) {
        findings.push({ code: 'floor_breached', detail: `${account.id} holds ${balance}, below its floor of ${account.floorMinor}`, account: account.id });
      }
    }
    return findings;
  }

  toJSON(): SerializedLedger {
    return {
      accounts: [...this.accounts.values()],
      entries: this.entries,
    };
  }

  static fromJSON(data: SerializedLedger): Ledger {
    const ledger = new Ledger(data.accounts);
    for (const entry of data.entries) {
      const posted = ledger.post({
        ts: entry.ts,
        memo: entry.memo,
        code: entry.code,
        currency: entry.currency,
        postings: entry.postings,
        idempotencyKey: entry.idempotencyKey,
        refs: entry.refs,
      });
      if (posted.entry.seq !== entry.seq) {
        throw new LedgerError(`snapshot replay drifted at ${entry.id}: expected seq ${entry.seq}, got ${posted.entry.seq}`);
      }
    }
    return ledger;
  }
}

export interface SerializedLedger {
  readonly accounts: readonly Account[];
  readonly entries: readonly LedgerEntry[];
}

function assertMinorSafe(value: number, context: string): number {
  if (!Number.isInteger(value) || value < 0) throw new LedgerError(`${context} must be a non-negative integer, got ${value}`);
  return assertMinor(value, context);
}

function hashShape(entry: NewEntry | LedgerEntry): string {
  return JSON.stringify({
    memo: entry.memo,
    code: entry.code,
    currency: entry.currency,
    postings: entry.postings.map((p) => [p.account, p.debit, p.credit]),
  });
}
