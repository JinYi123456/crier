import type { SessionSnapshot } from '../../core/world';

/** What the floor answers a reader with: the whole room, and how far its tape had been shown. */
export interface Envelope {
  readonly snapshot: SessionSnapshot;
  readonly sinceSeq: number;
  /** True when the server has an operator key set, so the desk will not move without it. */
  readonly locked?: boolean;
}
