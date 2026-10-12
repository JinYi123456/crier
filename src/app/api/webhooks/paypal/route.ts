import { NextResponse } from 'next/server';
import { deliverEvent, webhookGateway } from '../../../../server/floor';
import { jsonError } from '../../../../server/http';

/**
 * The processor's door.
 *
 * PayPal posts here when something happens to an order it holds - the buyer approved, a capture
 * completed, a dispute opened. Nothing in this handler trusts the body: the gateway re-checks the
 * signature against the processor's own certificate before a word of it reaches a settlement, and an
 * event that does not verify is refused with no attempt to make sense of it.
 *
 * A verified event that belongs to no trade on this machine is still acknowledged. The processor
 * retries an unacknowledged delivery, so the polite answer is the one that stops it hammering; what
 * arrived is reported back so the operator can see that something landed with nowhere to go.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIGNATURE_HEADERS = [
  'paypal-transmission-id',
  'paypal-auth-algo',
  'paypal-cert-url',
  'paypal-transmission-time',
  'paypal-transmission-sigma',
] as const;

function headersOf(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of SIGNATURE_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) out[name] = value;
  }
  return out;
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const target = url.searchParams.get('floor');
  try {
    const gateway = webhookGateway(target === null ? undefined : target);
    if (gateway === null) {
      return NextResponse.json({ error: 'no floor is open, so there is no processor whose signature this could be checked against' }, { status: 501 });
    }
    const raw = await request.text();
    const event = await gateway.verifyWebhook(headersOf(request), raw);
    if (event === null) return NextResponse.json({ error: 'the signature on this event did not verify' }, { status: 401 });
    const delivered = deliverEvent(event);
    return NextResponse.json({
      accepted: true,
      processor: gateway.mode,
      event: event.eventType,
      floor: delivered.id.length > 0 ? delivered.id : null,
      matched: delivered.matched,
    });
  } catch (error) {
    return jsonError(error);
  }
}
