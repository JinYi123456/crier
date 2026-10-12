import { NextResponse } from 'next/server';
import { CATALOG_AS_OF, INSTRUMENTS } from '../../../core/catalog';
import {
  FloorError,
  listFloors,
  openFloor,
  openRequestOf,
  pointerFrom,
  pointerOf,
  roundOf,
  runToTick,
} from '../../../server/floor';

/**
 * Opening and listing floors.
 *
 * A floor is defined entirely by its seed and its instrument list, so the request body is small and
 * the answer is a room anybody holding the id can inspect and audit for themselves. The seed is the
 * only required field; leave it out and the floor opens on a fresh one, so a first-time visitor sees
 * a market rather than a form.
 *
 * The answer carries the pointer back - the seed and the shape the id was hashed from - because that
 * is what lets a screen hand the same room to a different machine later, or put it in a URL for
 * somebody else to open.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return NextResponse.json({
    floors: listFloors(),
    instruments: INSTRUMENTS.map((instrument) => ({
      id: instrument.id,
      name: instrument.name,
      symbol: instrument.symbol,
      currency: instrument.currency,
      tickSizeMinor: instrument.tickSizeMinor,
      lot: instrument.lot,
      category: instrument.category,
    })),
    catalog: CATALOG_AS_OF,
  });
}

export async function POST(request: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  try {
    const pointer = pointerFrom(body);
    const room = await openFloor(openRequestOf(pointer));
    const id = room.session.session;
    // A round the caller names is how a screen on a fresh machine catches up to a floor that was
    // opened on another one: the replay is exact, so the room it lands in is the room it left.
    await runToTick(id, roundOf(body));
    return NextResponse.json({ floor: id, pointer: pointerOf(room), snapshot: room.session.snapshot() });
  } catch (error) {
    if (error instanceof FloorError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
