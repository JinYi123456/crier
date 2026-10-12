import { existsSync, readFileSync } from 'node:fs';
import { AwaitingApprovalError, GatewayError } from '../src/gateway/types';
import { PayPalGateway } from '../src/gateway/paypal';

/**
 * Prove the adapter against the real processor, without moving anybody's money.
 *
 * A recorded fake can only show that the code matches what we believe the API does. This runs the
 * parts of a settlement that need no buyer present - authenticate, open an order, read it back,
 * find it in the waiting queue, then refuse to capture it - and prints the approval link so a
 * person can walk the rest of the way by hand. Nothing here takes funds: an order nobody approves
 * is simply never captured.
 *
 *   npm run smoke                          # the whole read-only walk
 *   npm run smoke -- --amount 2500         # a different ticket, in minor units
 *   npm run smoke -- --capture ORD-XXXX    # an order a buyer has already approved
 */

interface Flags {
  amountMinor: number;
  capture: string | null;
  keep: boolean;
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { amountMinor: 12_00, capture: null, keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === '--amount' && next !== undefined) {
      flags.amountMinor = Number.parseInt(next, 10);
      index += 1;
    } else if (arg === '--capture' && next !== undefined) {
      flags.capture = next;
      index += 1;
    } else if (arg === '--keep') {
      flags.keep = true;
    }
  }
  if (!Number.isSafeInteger(flags.amountMinor) || flags.amountMinor <= 0) {
    throw new Error('--amount must be a positive number of minor units');
  }
  return flags;
}

function loadEnvironment(): Readonly<Record<string, string | undefined>> {
  if (existsSync('.env')) {
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const pair = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!pair || line.trim().startsWith('#')) continue;
      const key = pair[1] as string;
      const value = (pair[2] as string).replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
  return process.env;
}

function show(line: string): void {
  console.log(line);
}

function money(minor: number, currency: string): string {
  return `${(minor / 100).toFixed(2)} ${currency}`;
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const env = loadEnvironment();
  const clientId = env.PAYPAL_CLIENT_ID ?? '';
  const secret = env.PAYPAL_CLIENT_SECRET ?? '';
  if (clientId.length === 0 || secret.length === 0) {
    show('no credentials in the environment - fill in PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env');
    return 2;
  }

  const gateway = new PayPalGateway({
    clientId,
    clientSecret: secret,
    apiBase: env.PAYPAL_API_BASE,
    webhookId: env.PAYPAL_WEBHOOK_ID,
    publicUrl: env.PAYPAL_WEBHOOK_URL ?? 'http://localhost:3000',
    payoutBatchNote: env.PAYPAL_PAYOUT_BATCH_NOTE,
  });

  const failures: string[] = [];
  const step = async (label: string, run: () => Promise<string>): Promise<string | null> => {
    try {
      const detail = await run();
      show(`ok    ${label}${detail.length > 0 ? ` - ${detail}` : ''}`);
      return detail;
    } catch (error) {
      const message = error instanceof GatewayError ? `${error.message} [${error.status}]` : String(error);
      failures.push(`${label}: ${message}`);
      show(`FAIL  ${label} - ${message}`);
      return null;
    }
  };

  show('------------------------------------------------------------------------------');
  show(`crier sandbox walk  ${gateway.mode} at ${env.PAYPAL_API_BASE ?? 'the sandbox host'}`);
  show('------------------------------------------------------------------------------');

  if (flags.capture !== null) {
    const reference = flags.capture;
    await step('read the order back', async () => {
      const order = await gateway.approveOrder(reference);
      return `${order.status}, ${money(order.gross.amountMinor, order.gross.currency)}`;
    });
    await step('capture it', async () => {
      const captured = await gateway.captureOrder(reference);
      return `capture ${captured.captureReference ?? 'not reported'}`;
    });
    return finish(failures);
  }

  const tradeId = `smoke-${Date.now().toString(36)}`;
  let reference = '';
  await step('open an order', async () => {
    const created = await gateway.createOrder({
      tradeId,
      amountMinor: flags.amountMinor,
      currency: 'USD',
      buyer: 'crier smoke - buyer',
      seller: 'crier smoke - seller',
      description: `a ${money(flags.amountMinor, 'USD')} smoke order from the crier floor`,
      invoiceNumber: `SMOKE-${tradeId}`,
    });
    reference = created.reference;
    return `${created.reference}, ${money(created.gross.amountMinor, created.gross.currency)}, status ${created.status}`;
  });

  if (reference.length === 0) {
    failures.push('no order was opened, so there is nothing further to walk');
    show('stop  the walk needs an order to look at');
    return finish(failures);
  }

  await step('the buyer has not approved yet', async () => {
    try {
      await gateway.approveOrder(reference);
      throw new Error('the processor reported the order as approved with no buyer involved');
    } catch (error) {
      if (!(error instanceof AwaitingApprovalError)) throw error;
      show('      open this to approve it by hand:');
      show(`      ${error.approvalUrl ?? 'the processor gave no approval link'}`);
      return 'refused, as it should';
    }
  });

  await step('the order shows up in the waiting queue', async () => {
    const queue = await gateway.listWaiting();
    if (!queue.some((order) => order.reference === reference)) {
      throw new Error(`${reference} is not in a queue of ${queue.length}`);
    }
    return `${queue.length} order(s) still waiting on a buyer`;
  });

  await step('a capture cannot be forced', async () => {
    try {
      await gateway.captureOrder(reference);
      throw new Error('the processor captured an order nobody approved');
    } catch (error) {
      if (!(error instanceof GatewayError)) throw error;
      return 'refused';
    }
  });

  if (!flags.keep) {
    await step('the floor walks away from it', async () => {
      const voided = await gateway.voidOrder(reference, 'smoke walk - nothing to settle');
      return `${voided.reference} is now uncapturable from here`;
    });
    await step('and cannot come back to it', async () => {
      try {
        await gateway.captureOrder(reference);
        throw new Error('a voided order was captured');
      } catch (error) {
        if (!(error instanceof GatewayError)) throw error;
        return 'refused, as it should';
      }
    });
  } else {
    show(`keep  ${reference} left open - approve it by hand, then run: npm run smoke -- --capture ${reference}`);
  }

  return finish(failures);
}

function finish(failures: readonly string[]): number {
  show('------------------------------------------------------------------------------');
  if (failures.length === 0) {
    show('sandbox walk: clean');
    return 0;
  }
  for (const failure of failures) show(`  ${failure}`);
  show(`sandbox walk: ${failures.length} failure(s)`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    show(`the walk crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  },
);
