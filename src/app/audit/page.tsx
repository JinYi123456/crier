import { FloorError, floorSnapshot, listFloors } from '../../server/floor';
import AuditRoom from '../ui/AuditRoom';

export const dynamic = 'force-dynamic';

/**
 * The audit screen, first painted on the server.
 *
 * `?floor=<id>` picks a room; without it the newest one on this machine is shown. Nothing here asks
 * permission because there is nothing to hide: the tape is the record, and the record is meant to be
 * checked by somebody who was not in the room when it was written.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const raw = (await searchParams).floor;
  const wanted = typeof raw === 'string' ? decodeURIComponent(raw) : '';
  const rooms = listFloors().map((room) => ({
    id: room.id,
    seed: room.seed,
    tick: room.tick,
    maxTicks: room.maxTicks,
    trades: room.trades,
    closed: room.closed,
  }));
  const id = wanted.length > 0 ? wanted : (rooms[0]?.id ?? '');

  if (id.length === 0) {
    return (
      <div className="mx-auto mt-20 max-w-[600px]">
        <h1 className="font-display text-[30px] text-paper">Nothing to audit yet</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-white/60">
          This page reads the tape of a floor that is open on this machine - the chain verdict, the journal as a grid, and a scrubber back to any
          line. Open a floor first, then come back and check it.
        </p>
        <a href="/" className="mt-6 inline-block rounded bg-brass px-4 py-2 font-display text-[15px] text-ink no-underline hover:bg-[#eab94f]">
          Open a floor
        </a>
      </div>
    );
  }

  try {
    const initial = floorSnapshot(id);
    return <AuditRoom id={id} initial={initial} rooms={rooms} />;
  } catch (error) {
    if (!(error instanceof FloorError)) throw error;
    return (
      <div className="mx-auto mt-20 max-w-[600px]">
        <h1 className="font-display text-[30px] text-paper">No floor by that name</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-white/60">{error.message}</p>
        <p className="mt-3 text-[13px] leading-relaxed text-white/45">
          A floor lives in the memory of the machine that opened it. The tape it wrote is portable and can be re-verified anywhere, but this page
          can only read a room that is currently open here.
        </p>
        <a href="/audit" className="mt-6 inline-block rounded bg-brass px-4 py-2 font-display text-[15px] text-ink no-underline hover:bg-[#eab94f]">
          Audit the newest floor
        </a>
      </div>
    );
  }
}
