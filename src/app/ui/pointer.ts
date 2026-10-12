import type { FloorPointer } from '../../server/floor';

/**
 * A pointer as an address, not as an object.
 *
 * A URL is where a floor travels - pasted into a message, bookmarked, opened by somebody who was not
 * in the room when it was written - so the field names it uses are the short ones, and the instrument
 * list is a run of ids rather than a JSON array. The server reads either spelling, which is what lets
 * the same pointer survive the trip from a JSON answer into an address bar and back.
 */
export function pointerParams(pointer: FloorPointer): Record<string, string> {
  return {
    seed: pointer.seed,
    instruments: pointer.instruments.join(','),
    agents: String(pointer.agentsPerSide),
    ticks: String(pointer.maxTicks),
    gateway: pointer.gateway,
    payout: pointer.payoutMode,
  };
}

/** The query a request or a link needs to name this room to a machine that has never seen it. */
export function pointerSearch(pointer: FloorPointer, round: number): string {
  return new URLSearchParams({ ...pointerParams(pointer), round: String(round) }).toString();
}

/** The address of a room, with its pointer carried along. */
export function floorHref(id: string, pointer: FloorPointer, round: number): string {
  return `/floor/${encodeURIComponent(id)}?${pointerSearch(pointer, round)}`;
}
