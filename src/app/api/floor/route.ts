import { NextResponse } from 'next/server';
import { CATALOG_AS_OF, INSTRUMENTS, instrumentById } from '../../../core/catalog';
import { FloorError, listFloors, openFloor, suggestedSeed, type OpenFloorRequest } from '../../../server/floor';

/**
 * Opening and listing floors.
 *
 * A floor is defined entirely by its seed and its instrument list, so the request body is small and
 * the answer is a room anybody holding the id can inspect and audit for themselves. The seed is the
 * only required field; leave it out and the floor opens on a fresh one, so a first-time visitor sees
 * a market rather than a form.
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
  let body: Partial<OpenFloorRequest> = {};
  try {
    body = (await request.json()) as Partial<OpenFloorRequest>;
  } catch {
    body = {};
  }
  const instruments = Array.isArray(body.instruments) ? body.instruments.map((id) => String(id).trim()).filter(Boolean) : [];
  const unknown = instruments.filter((id) => {
    try {
      instrumentById(id);
      return false;
    } catch {
      return true;
    }
  });
  if (unknown.length > 0) {
    return NextResponse.json({ error: `the catalogue has no instrument called ${unknown.join(', ')}` }, { status: 422 });
  }

  const seed = typeof body.seed === 'string' ? body.seed.trim() : '';
  const openRequest: OpenFloorRequest = {
    seed: seed.length > 0 ? seed : suggestedSeed(),
    instruments,
    gateway: body.gateway === 'sandbox' ? 'sandbox' : 'sim',
    payoutMode: body.payoutMode === 'batched' ? 'batched' : 'immediate',
    ...(Number.isSafeInteger(body.agentsPerSide) ? { agentsPerSide: body.agentsPerSide } : {}),
    ...(Number.isSafeInteger(body.maxTicks) ? { maxTicks: body.maxTicks } : {}),
  };

  try {
    const room = await openFloor(openRequest);
    return NextResponse.json({ floor: room.session.session, snapshot: room.session.snapshot() });
  } catch (error) {
    if (error instanceof FloorError) return NextResponse.json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
