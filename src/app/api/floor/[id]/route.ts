import { NextResponse } from 'next/server';
import { actOnFloorTrade, closeFloor, floorSnapshot, runFloor, stepFloor, tamperFloor, type TradeAction } from '../../../../server/floor';
import { jsonError, readBody, stringField } from '../../../../server/http';
import { deskIsLocked, operatorRefusal } from '../../../../server/operator';

/**
 * Read one floor.
 *
 * `?since=<seq>` trims the tape to the messages after that sequence, which is how a live screen
 * polls without re-fetching a thousand seals every second. The rest of the snapshot - board, seats,
 * trades, accounts, entries - is always complete, because a screen that shows a slice of the books
 * is a screen that can be quietly wrong.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const since = new URL(request.url).searchParams.get('since');
    const parsed = since === null ? -1 : Number.parseInt(since, 10);
    const { snapshot, sinceSeq } = floorSnapshot(decodeURIComponent(id), Number.isSafeInteger(parsed) ? parsed : -1);
    return NextResponse.json({ snapshot, sinceSeq, locked: deskIsLocked() });
  } catch (error) {
    return jsonError(error);
  }
}

/**
 * Everything a person or a caller can do to a live floor.
 *
 * One round, the floor to the bell, the bell itself, the human actions on a trade, and a
 * demonstration that edits the tape on purpose. There is no action here that moves money without
 * either a match on the board or a signed decision behind it - and once an operator key is set, the
 * actions that speak for the platform refuse a caller that cannot quote it.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await context.params;
  const room = decodeURIComponent(id);
  const body = await readBody(request);
  const action = stringField(body, 'action');
  const refusal = operatorRefusal(request, action);
  if (refusal !== null) return refusal;
  try {
    switch (action) {
      case 'step':
        return NextResponse.json({ result: await stepFloor(room) });
      case 'run':
        return NextResponse.json({ rounds: await runFloor(room) });
      case 'close':
        return NextResponse.json({ floor: await closeFloor(room) });
      case 'trade': {
        const tradeAction: TradeAction = {
          action: tradeActionKind(body),
          tradeId: stringField(body, 'tradeId'),
          ...(typeof body.note === 'string' ? { note: body.note } : {}),
          ...(typeof body.amountMinor === 'number' ? { amountMinor: body.amountMinor } : {}),
        };
        const trade = await actOnFloorTrade(room, tradeAction);
        return NextResponse.json({ trade });
      }
      case 'tamper': {
        const seq = typeof body.seq === 'number' ? body.seq : Number.NaN;
        if (!Number.isSafeInteger(seq)) return NextResponse.json({ error: 'a tamper demonstration needs a message seq' }, { status: 422 });
        return NextResponse.json({ result: tamperFloor(room, seq, stringField(body, 'field') || 'grossMinor') });
      }
      default:
        return NextResponse.json({ error: `nothing on a floor answers to ${action || 'an empty action'}` }, { status: 422 });
    }
  } catch (error) {
    return jsonError(error);
  }
}

function tradeActionKind(body: Record<string, unknown>): TradeAction['action'] {
  const kind = stringField(body, 'tradeAction');
  switch (kind) {
    case 'release':
    case 'veto':
    case 'refund':
    case 'partial_refund':
    case 'payout':
      return kind;
    default:
      return 'release';
  }
}
