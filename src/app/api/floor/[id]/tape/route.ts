import { NextResponse } from 'next/server';
import { floorSnapshot, readPointer, roomForId, roundOf } from '../../../../../server/floor';
import { jsonError } from '../../../../../server/http';

/**
 * The recording, as a file.
 *
 * Every claim this floor makes is checkable from the tape alone, but only by somebody holding it -
 * so the audit room hands it over. The body is the same snapshot `GET /api/floor/{id}` returns with
 * no `since`, which is the format `npm run audit:ledger -- --file` reads.
 *
 * A pointer in the query rebuilds the room first, so a tape can still be taken from a machine that
 * never opened this floor - the rounds come back exactly, which is the whole point of a session whose
 * clock belongs to its seed.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const room = decodeURIComponent(id);
    const query = Object.fromEntries(new URL(request.url).searchParams);
    await roomForId(room, readPointer(query), roundOf(query));
    const { snapshot } = floorSnapshot(room);
    return new NextResponse(JSON.stringify(snapshot, null, 2), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="${room}.tape.json"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
