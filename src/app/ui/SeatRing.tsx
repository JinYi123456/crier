import type { SessionSnapshot } from '../../core/world';
import { cash } from './format';

/**
 * The pit, seen from above.
 *
 * Buyers stand on the left arc, sellers on the right, and the clerk's board sits in the middle of
 * the ring. A seat's halo is how far that house has travelled down its own concession curve - cool
 * and small when it is still holding the line, hot and wide as it nears the price it will actually
 * take. When a house shouts, a ring leaves its seat; when its order is resting on the board, a thin
 * hand runs from the seat to the price.
 */

export interface Seat {
  readonly id: string;
  readonly name: string;
  readonly role: 'buy' | 'sell';
  readonly pressure: number;
  readonly withdrawn: boolean;
  readonly remaining: number;
  readonly filled: number;
  readonly resting: readonly { priceMinor: number; qty: number }[];
}

const WIDTH = 620;
const HEIGHT = 440;
const CX = WIDTH / 2;
const CY = HEIGHT / 2 + 8;
const RX = 262;
const RY = 176;

function initials(name: string): string {
  const parts = name.split(' ');
  const first = (parts[0] ?? '?').slice(0, 1);
  const second = (parts[1] ?? '').slice(0, 1);
  return `${first}${second || ''}`.toUpperCase();
}

function seatAt(side: 'buy' | 'sell', index: number, count: number, radius = 1): { x: number; y: number; angle: number } {
  // Theta is measured from the top: negative swings down the buyers' left arc, positive down the sellers' right.
  const spread = Math.PI * 0.78;
  const step = count > 1 ? spread / (count - 1) : 0;
  const start = (side === 'buy' ? -1 : 1) * (Math.PI / 2 - spread / 2);
  const theta = start + (side === 'buy' ? -1 : 1) * step * index;
  return { x: CX + Math.sin(theta) * RX * radius, y: CY - Math.cos(theta) * RY * radius, angle: theta };
}

export default function SeatRing({
  seats,
  board,
  currency,
  pulses,
  selectedId,
  onSelect,
  lastPrintFlash,
}: {
  seats: readonly Seat[];
  board: SessionSnapshot['markets'][number];
  currency: SessionSnapshot['currency'];
  pulses: Readonly<Record<string, number>>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  lastPrintFlash: number;
}): React.ReactElement {
  const buyers = seats.filter((seat) => seat.role === 'buy' && !seat.withdrawn);
  const sellers = seats.filter((seat) => seat.role === 'sell' && !seat.withdrawn);
  const walked = seats.filter((seat) => seat.withdrawn);
  const placed = [
    ...buyers.map((seat, index) => ({ seat, ...seatAt('buy', index, buyers.length) })),
    ...sellers.map((seat, index) => ({ seat, ...seatAt('sell', index, sellers.length) })),
  ];
  const boardLeft = CX - 118;
  const boardRight = CX + 118;
  const bestBid = board.best.bidMinor;
  const bestAsk = board.best.askMinor;
  const bestBidQty = board.bids.filter((order) => order.priceMinor === bestBid).reduce((total, order) => total + order.remaining, 0);
  const bestAskQty = board.asks.filter((order) => order.priceMinor === bestAsk).reduce((total, order) => total + order.remaining, 0);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full select-none" role="img" aria-label="The trading pit, with houses seated around the clerk's board">
      <ellipse cx={CX} cy={CY} rx={RX + 44} ry={RY + 34} fill="#0a0e12" stroke="rgba(217,164,65,0.16)" />
      <ellipse cx={CX} cy={CY} rx={RX} ry={RY} fill="#111820" stroke="rgba(255,255,255,0.06)" className="pit-floor" />

      {/* The hands that are up on the board right now. */}
      {placed.map(({ seat, x, y }) =>
        seat.resting.slice(0, 2).map((order, index) => {
          const edge = seat.role === 'buy' ? boardLeft : boardRight;
          const ty = CY - 26 + index * 34 + (seat.role === 'buy' ? 0 : 6);
          return (
            <g key={`${seat.id}-${order.priceMinor}-${index}`} opacity="0.5">
              <path
                d={`M${x} ${y} Q ${(x + edge) / 2} ${(y + ty) / 2 - 26} ${edge} ${ty}`}
                fill="none"
                stroke={seat.role === 'buy' ? '#3fbf9a' : '#e2683f'}
                strokeWidth="1.1"
                strokeDasharray="3 4"
              />
            </g>
          );
        }),
      )}

      {/* The clerk's board, in the middle of the ring. */}
      <g>
        <rect x={boardLeft} y={CY - 52} width={236} height={104} rx={6} className={lastPrintFlash > 0 ? 'knock' : ''} fill="#f1e7d4" opacity="0.95" />
        <rect x={boardLeft} y={CY - 52} width={236} height={20} rx={6} fill="#2a1d12" opacity="0.85" />
        <text x={CX} y={CY - 38} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fill="#d9a441" letterSpacing="2">
          {board.instrumentId.toUpperCase()} · CLERK BOARD
        </text>
        <text x={boardLeft + 14} y={CY - 6} fontFamily="ui-monospace, monospace" fontSize="12" fill="#2f6f57">
          BID
        </text>
        <text x={boardLeft + 14} y={CY + 12} fontFamily="ui-monospace, monospace" fontSize="19" fill="#1d6a51" className="tnum">
          {bestBid === null ? '—' : cash(bestBid, currency)}
        </text>
        <text x={boardLeft + 14} y={CY + 28} fontFamily="ui-monospace, monospace" fontSize="10" fill="#6b6152">
          {bestBid === null ? 'no bids resting' : `${bestBidQty} for the best`}
        </text>
        <text x={boardRight - 14} y={CY - 6} textAnchor="end" fontFamily="ui-monospace, monospace" fontSize="12" fill="#9a4a28">
          OFFER
        </text>
        <text x={boardRight - 14} y={CY + 12} textAnchor="end" fontFamily="ui-monospace, monospace" fontSize="19" fill="#a84d24" className="tnum">
          {bestAsk === null ? '—' : cash(bestAsk, currency)}
        </text>
        <text x={boardRight - 14} y={CY + 28} textAnchor="end" fontFamily="ui-monospace, monospace" fontSize="10" fill="#6b6152">
          {bestAsk === null ? 'no offers resting' : `${bestAskQty} for the best`}
        </text>
        <text x={CX} y={CY + 44} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fill="#4a4238">
          {board.lastPrintMinor === null ? 'no print yet' : `last ${cash(board.lastPrintMinor, currency)}`} · open {cash(board.openingMinor, currency)}
        </text>
      </g>

      {placed.map(({ seat, x, y }) => {
        const color = seat.role === 'buy' ? '#3fbf9a' : '#e2683f';
        const heat = Math.min(1, seat.pressure);
        const halo = 20 + heat * 15;
        const selected = selectedId === seat.id;
        const pulse = pulses[seat.id] ?? 0;
        const remainingFraction = Math.max(0, Math.min(1, seat.remaining));
        return (
          <g key={seat.id} transform={`translate(${x} ${y})`} onClick={() => onSelect(seat.id)} className="cursor-pointer">
            {pulse > 0 && (
              <circle key={`pulse-${pulse}`} r={22} fill="none" stroke={color} strokeWidth="2" className="ripple" />
            )}
            <circle
              r={halo}
              fill="none"
              stroke={`rgb(${Math.round(63 + heat * 174)} ${Math.round(191 - heat * 60)} ${Math.round(154 - heat * 110)})`}
              strokeWidth={1 + heat * 2.4}
              opacity={0.25 + heat * 0.6}
              className={heat > 0.55 ? 'halo-breathe' : ''}
            />
            <circle r={17} fill="#0d1216" stroke={selected ? '#d9a441' : color} strokeWidth={selected ? 2.4 : 1.3} />
            <text y={4} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="11" fill={color}>
              {initials(seat.name)}
            </text>
            {/* The hand's remaining capacity: cash for a buyer, stock for a seller. */}
            <circle
              r={21}
              fill="none"
              stroke={color}
              strokeWidth="2.5"
              opacity="0.7"
              strokeDasharray={`${remainingFraction * 2 * Math.PI * 21} ${2 * Math.PI * 21}`}
              transform="rotate(-90)"
            />
            <text y={34} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9.5" fill="rgba(255,255,255,0.5)">
              {seat.name}
            </text>
            {seat.resting.length > 0 && (
              <text y={46} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill={color} opacity="0.8">
                {seat.role === 'buy' ? 'bidding' : 'offering'} {cash(seat.resting[0]!.priceMinor, currency)}
              </text>
            )}
          </g>
        );
      })}

      {walked.map((seat, index) => {
        const { x, y } = seatAt(seat.role, index, Math.max(1, walked.length), 1.18);
        return (
          <g key={seat.id} transform={`translate(${x} ${y})`} opacity="0.4">
            <circle r={13} fill="none" stroke="#6b7280" strokeDasharray="3 3" />
            <text y={4} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="10" fill="#6b7280">
              {initials(seat.name)}
            </text>
            <text y={28} textAnchor="middle" fontFamily="ui-monospace, monospace" fontSize="9" fill="#6b7280">
              walked
            </text>
          </g>
        );
      })}
    </svg>
  );
}
