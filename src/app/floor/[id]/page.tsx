import { INSTRUMENTS } from '../../../core/catalog';
import { FloorError, floorSnapshot, pointerOf, readPointer, roomForId, roundOf } from '../../../server/floor';
import { spokenBy } from '../../../server/interpreter';
import Pit from '../../ui/Pit';

export const dynamic = 'force-dynamic';

/**
 * One room, drawn from the server on the first paint.
 *
 * The page reads the floor the same way the API does, so what you see when the URL is opened is the
 * tape as it stands at that moment - and after that the screen keeps itself current by asking only
 * for the lines it has not seen.
 *
 * A URL that carries the room's pointer - `?seed=…&instruments=…&ticks=…&round=…` - can also be
 * painted by a machine that never opened this floor: it rebuilds the room from the seed and runs it to
 * the round the URL names, which is the same room because the same rounds are a deterministic thing.
 */
export default async function FloorPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const { id } = await params;
  const query = await searchParams;
  const room = decodeURIComponent(id);
  const instruments = INSTRUMENTS.map((instrument) => ({
    id: instrument.id,
    name: instrument.name,
    symbol: instrument.symbol,
    currency: instrument.currency,
    lot: instrument.lot,
    tickSizeMinor: instrument.tickSizeMinor,
    category: instrument.category,
  }));

  try {
    const { room: held, rebuilt } = await roomForId(room, readPointer(query), roundOf(query));
    const initial = floorSnapshot(room);
    const voice = await spokenBy();
    return <Pit id={room} initial={initial} instruments={instruments} pointer={pointerOf(held)} rebuilt={rebuilt} crier={voice.spokenBy} crierSource={voice.source} />;
  } catch (error) {
    if (!(error instanceof FloorError)) throw error;
    return (
      <div className="mx-auto mt-20 max-w-[560px]">
        <h1 className="font-display text-[30px] text-paper">That room has closed</h1>
        <p className="mt-3 text-[14px] leading-relaxed text-white/60">{error.message}</p>
        <p className="mt-3 text-[13px] leading-relaxed text-white/45">
          A floor lives in the memory of the machine that opened it - the record of what happened there lives in its tape, which you can keep,
          publish and re-verify anywhere. If you were following a link, the room was probably opened by somebody else, or this process restarted.
        </p>
        <a href="/" className="mt-6 inline-block rounded bg-brass px-4 py-2 font-display text-[15px] text-ink no-underline hover:bg-[#eab94f]">
          Open a floor
        </a>
      </div>
    );
  }
}
