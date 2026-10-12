import type { CurrencyCode } from '../../core/money';

/**
 * The instrument card, as a screen sees it.
 *
 * The catalogue lives in the engine next to the hashing code, which is Node-only, so a browser
 * bundle cannot import it. The page hands over exactly the fields a picture needs instead.
 */
export interface InstrumentCard {
  readonly id: string;
  readonly name: string;
  readonly symbol: string;
  readonly currency: CurrencyCode;
  readonly lot: string;
  readonly tickSizeMinor: number;
  readonly category: string;
}
