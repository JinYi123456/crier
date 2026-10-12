import { NextResponse } from 'next/server';
import { floorSnapshot } from '../../../../../server/floor';
import { jsonError } from '../../../../../server/http';

/**
 * The recording, as a file.
 *
 * Every claim this floor makes is checkable from the tape alone, but only by somebody holding it -
 * so the audit room hands it over. The body is the same snapshot `GET /api/floor/{id}` returns with
 * no `since`, which is the format `npm run audit:ledger -- --file` reads.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params;
    const room = decodeURIComponent(id);
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
