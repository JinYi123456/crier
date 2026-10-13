import { NextResponse } from 'next/server';
import { FloorError, floorSnapshot, readPointer, roomForId, roundOf } from '../../../../../server/floor';
import { factsFor, readChit } from '../../../../../server/interpreter';
import { jsonError } from '../../../../../server/http';

/**
 * One chit, read out loud.
 *
 * The pile hands a person a settlement that the floor would not complete alone. The card already
 * carries the rule that caught it and the amounts, all of it straight from the sealed record - what
 * it cannot carry is a sentence, because the engine speaks in integers and a decision needs prose.
 * This route asks the floor's interpreter for that sentence and says, in the same breath, whether a
 * model wrote it or the desk template did.
 *
 * Nothing here moves money. The answer is commentary about a record that already exists: it is not
 * sealed into the tape, it is not what the ledger was posted from, and a brief that contradicts a
 * figure on the card loses.
 *
 * The pointer in the query is what makes this work on a machine that never saw the floor: the room is
 * rebuilt from its own seed first, so the chit is read wherever the URL is opened.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const room = decodeURIComponent(id);
    const query = Object.fromEntries(new URL(request.url).searchParams);
    const tradeId = typeof query['trade'] === 'string' ? query['trade'].trim() : '';
    if (tradeId.length === 0) throw new FloorError('name the chit to read', 400);
    await roomForId(room, readPointer(query), roundOf(query));
    const { snapshot } = floorSnapshot(room);
    const trade = snapshot.trades.find((entry) => entry.id === tradeId);
    if (trade === undefined) throw new FloorError(`this floor has no trade ${tradeId}`, 404);
    if (!trade.held) throw new FloorError(`trade ${tradeId} is not waiting on a person`, 409);
    const voice = await readChit(factsFor(snapshot, trade));
    return NextResponse.json({ floor: room, trade: tradeId, ...voice }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
