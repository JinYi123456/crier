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
// The far arc's houses stand at the bottom of the ring with their name and their shout written under
// them, so the frame has to be taller than the felt or the last row gets cut off at the edge.
const HEIGHT = 470;
const CX = WIDTH / 2;
const CY = HEIGHT / 2 - 1;
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
  // Every house holds its place on its side's arc whether it is still trading or not, so a seat going
  // empty leaves a gap in the ring rather than sliding the whole room round to close it - and a walked
  // house never lands on top of a house still shouting.
  const buySide = seats.filter((seat) => seat.role === 'buy');
  const sellSide = seats.filter((seat) => seat.role === 'sell');
  const placed = [
    ...buySide.map((seat, index) => ({ seat, ...seatAt('buy', index, buySide.length) })),
    ...sellSide.map((seat, index) => ({ seat, ...seatAt('sell', index, sellSide.length) })),
  ];
  const boardLeft = CX - 118;
  const boardRight = CX + 118;
  const bestBid = board.best.bidMinor;
  const bestAsk = board.best.askMinor;
  const bestBidQty = board.bids.filter((order) => order.priceMinor === bestBid).reduce((total, order) => total + order.remaining, 0);
  const bestAskQty = board.asks.filter((order) => order.priceMinor === bestAsk).reduce((total, order) => total + order.remaining, 0);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full select-none" role="img" aria-label="The trading pit, with houses seated around the clerk's board">
      <defs>
        <radialGradient id="ring-felt" cx="50%" cy="44%" r="64%">
          <stop offset="0%" stopColor="#1e2934" />
          <stop offset="58%" stopColor="#111820" />
          <stop offset="100%" stopColor="#080b0e" />
        </radialGradient>
        <linearGradient id="ring-slate" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f6efe0" />
          <stop offset="100%" stopColor="#ddd0b5" />
        </linearGradient>
        <linearGradient id="ring-wood" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#3a2718" />
          <stop offset="55%" stopColor="#2a1d12" />
          <stop offset="100%" stopColor="#1b120a" />
        </linearGradient>
        <linearGradient id="ring-brass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f0cd7c" />
          <stop offset="46%" stopColor="#d9a441" />
          <stop offset="100%" stopColor="#7d5a14" />
        </linearGradient>
      </defs>
      <ellipse cx={CX} cy={CY} rx={RX + 44} ry={RY + 34} fill="url(#ring-felt)" />
      <ellipse cx={CX} cy={CY} rx={RX - 78} ry={RY - 62} fill="none" stroke="rgba(241,231,212,0.07)" strokeDasharray="2 7" />
      <ellipse cx={CX} cy={CY} rx={RX} ry={RY} fill="none" stroke="url(#ring-brass)" strokeWidth="1.6" opacity="0.42" />
      <ellipse cx={CX} cy={CY} rx={RX + 5} ry={RY + 5} fill="none" stroke="rgba(217,164,65,0.14)" strokeWidth="3" strokeDasharray="7 9" />

      {/* The hands that are up on the board right now. */}
      {placed.filter(({ seat }) => !seat.withdrawn).map(({ seat, x, y }) =>
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

      {/* The clerk's board, in the middle of the ring: a board on a frame, with the two sides of the
          market written on it in the same columns a clerk would jot them in. */}
      <g className={lastPrintFlash > 0 ? 'knock' : ''}>
        <rect x={boardLeft - 6} y={CY - 58} width={248} height={116} rx={10} fill="url(#ring-wood)" />
        <rect x={boardLeft} y={CY - 52} width={236} height={104} rx={7} fill="url(#ring-slate)" />
        <rect x={boardLeft} y={CY - 52} width={236} height={22} rx={7} fill="#2a1d12" />
        <rect x={boardLeft} y={CY - 44} width={236} height={14} fill="#2a1d12" />
        <text x={CX} y={CY - 36} textAnchor="middle" className="board-head" fontSize="10">
          {board.instrumentId.toUpperCase()} · CLERK BOARD
        </text>

        <line x1={CX} y1={CY - 22} x2={CX} y2={CY + 30} stroke="#26201a" strokeOpacity="0.14" />
        <text x={boardLeft + 16} y={CY - 8} className="board-side-buy" fontSize="10">
          BID
        </text>
        <text x={boardLeft + 16} y={CY + 14} className="board-figure" fontSize="24">
          {bestBid === null ? '—' : cash(bestBid, currency)}
        </text>
        <text x={boardLeft + 16} y={CY + 30} className="board-foot" fontSize="9">
          {bestBid === null ? 'no bids resting' : `${bestBidQty} for the best`}
        </text>
        <text x={boardRight - 16} y={CY - 8} textAnchor="end" className="board-side-sell" fontSize="10">
          OFFER
        </text>
        <text x={boardRight - 16} y={CY + 14} textAnchor="end" className="board-figure" fontSize="24">
          {bestAsk === null ? '—' : cash(bestAsk, currency)}
        </text>
        <text x={boardRight - 16} y={CY + 30} textAnchor="end" className="board-foot" fontSize="9">
          {bestAsk === null ? 'no offers resting' : `${bestAskQty} for the best`}
        </text>
        <text x={CX} y={CY + 46} textAnchor="middle" className="board-foot" fontSize="9">
          {board.lastPrintMinor === null ? 'no print yet' : `last ${cash(board.lastPrintMinor, currency)}`} · open {cash(board.openingMinor, currency)}
        </text>
      </g>

      {placed.map(({ seat, x, y }) => {
        const color = seat.role === 'buy' ? '#3fbf9a' : '#e2683f';
        if (seat.withdrawn) {
          // An empty seat stays a seat: the ring keeps the shape it was opened with, and the gap is
          // part of the record of the session rather than something to tidy away.
          return (
            <g key={seat.id} transform={`translate(${x} ${y})`} opacity="0.45">
              <circle r={13} fill="none" stroke="#6b7280" strokeDasharray="3 3" />
              <text y={4} textAnchor="middle" className="seat-number" fontSize="11" fill="#6b7280">
                {initials(seat.name)}
              </text>
              <text y={30} textAnchor="middle" className="ring-name" fontSize="11" fill="#6b7280">
                {seat.name} walked
              </text>
            </g>
          );
        }
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
            <text y={4} textAnchor="middle" className="seat-number" fontSize="12" fill={color}>
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
            <text y={34} textAnchor="middle" className="ring-name">
              {seat.name}
            </text>
            {seat.resting.length > 0 && (
              <text y={46} textAnchor="middle" className="ring-quote" fill={color}>
                {seat.role === 'buy' ? 'bidding' : 'offering'} {cash(seat.resting[0]!.priceMinor, currency)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
