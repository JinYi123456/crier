'use client';

/**
 * The room you are about to walk into, drawn from what the form actually says.
 *
 * This used to be a picture of a pit in general: ten dots that no floor had, a board that named
 * nothing, and a shape that stayed the same however the dials were moved. It is now the shape of
 * *this* floor - one seat per house the seed will seat, the pits that will be open, the processor it
 * will settle on. A plan that contradicts the thing it is a plan of is the exact habit this whole
 * project is built to break, and besides, a preview that answers you is a more interesting first
 * screen than one that poses.
 */

const WIDTH = 460;
const HEIGHT = 400;
const CX = WIDTH / 2;
const CY = 212;
/** Where the seats stand, and how far the rope is strung outside them. */
const RX = 172;
const RY = 128;
const ROPE = 26;

export interface PitPlanProps {
  readonly agents: number;
  readonly ticks: number;
  readonly pits: readonly { name: string; symbol: string }[];
  readonly seed: string;
  readonly sandbox: boolean;
}

interface Placed {
  readonly x: number;
  readonly y: number;
  readonly deg: number;
  readonly index: number;
}

/**
 * Seats sweep an arc centred on the apex of their side, and the arc widens with the number of houses,
 * so two of them sit shoulder to shoulder at the top rather than a part-open fan. Both sides count
 * from the visitor's left, because a ring whose far half numbers backwards reads as a mistake.
 */
function seatsOn(side: 'buy' | 'sell', count: number): Placed[] {
  const apex = side === 'buy' ? 0 : 180;
  const spread = Math.min(146, 29 * (count - 1));
  const direction = side === 'buy' ? 1 : -1;
  return Array.from({ length: count }, (_, index) => {
    const deg = apex + direction * (-spread / 2 + (count > 1 ? (spread / (count - 1)) * index : 0));
    const rad = (deg * Math.PI) / 180;
    return { x: CX + Math.sin(rad) * RX, y: CY - Math.cos(rad) * RY, deg, index };
  });
}

export default function PitPlan({ agents, ticks, pits, seed, sandbox }: PitPlanProps): React.ReactElement {
  const buyers = seatsOn('buy', agents);
  const sellers = seatsOn('sell', agents);
  const board = { left: CX - 95, top: CY - 46, width: 190, height: 92, right: CX + 95 };
  const heading = pits.length === 1 ? `${pits[0]?.symbol ?? ''} · clerk board` : `${String(pits.length)} pits · clerk board`;

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" className="w-full select-none" aria-label={`The plan of the floor: ${String(agents)} houses on each side of the clerk's board`}>
        <defs>
          <radialGradient id="plan-felt" cx="50%" cy="44%" r="64%">
            <stop offset="0%" stopColor="#1e2934" />
            <stop offset="58%" stopColor="#111820" />
            <stop offset="100%" stopColor="#080b0e" />
          </radialGradient>
          <linearGradient id="plan-slate" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f6efe0" />
            <stop offset="100%" stopColor="#ddd0b5" />
          </linearGradient>
          <linearGradient id="plan-wood" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#3a2718" />
            <stop offset="55%" stopColor="#2a1d12" />
            <stop offset="100%" stopColor="#1b120a" />
          </linearGradient>
          <linearGradient id="plan-brass" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#f0cd7c" />
            <stop offset="46%" stopColor="#d9a441" />
            <stop offset="100%" stopColor="#7d5a14" />
          </linearGradient>
        </defs>

        {/* The floor, the chalk circle inside the rope, and the rope itself. */}
        <ellipse cx={CX} cy={CY} rx={RX + ROPE + 12} ry={RY + ROPE + 12} fill="url(#plan-felt)" />
        <ellipse cx={CX} cy={CY} rx={RX - 44} ry={RY - 34} fill="none" stroke="rgba(241,231,212,0.07)" strokeDasharray="2 7" />
        <ellipse cx={CX} cy={CY} rx={RX + ROPE} ry={RY + ROPE} fill="none" stroke="url(#plan-brass)" strokeWidth="1.6" opacity="0.5" />
        <ellipse cx={CX} cy={CY} rx={RX + ROPE + 4} ry={RY + ROPE + 4} fill="none" stroke="rgba(217,164,65,0.16)" strokeWidth="3" strokeDasharray="7 9" />

        {/* Which half of the room is which, written on the felt where the seats are looking. */}
        <text x={CX} y={CY - RY + 34} textAnchor="middle" className="pit-arc">
          buyers stand here
        </text>
        <text x={CX} y={CY + RY - 26} textAnchor="middle" className="pit-arc">
          sellers stand here
        </text>

        <g className="bell-live" style={{ transformOrigin: `${String(CX)}px 8px` }}>
          <path d={`M ${CX} 8 v 16`} stroke="#8a6519" strokeWidth="1.6" />
          <path d={`M ${CX - 15} 40 q 0 -18 15 -18 q 15 0 15 18 z`} fill="url(#plan-brass)" />
          <path d={`M ${CX - 18} 40 h 36`} stroke="#d9a441" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx={CX} cy={45} r={2.6} fill="#8a6519" />
        </g>

        {/* The clerk's board: a board, not a label. It says what it is holding, which right now is nothing. */}
        <g key={`${String(pits.length)}-${String(ticks)}`} className="plan-board">
          <rect x={board.left - 4} y={board.top - 3} width={board.width + 8} height={board.height + 8} rx={9} fill="url(#plan-wood)" />
          <rect x={board.left} y={board.top} width={board.width} height={board.height} rx={6} fill="url(#plan-slate)" />
          <rect x={board.left} y={board.top} width={board.width} height={17} rx={6} fill="#2a1d12" />
          <rect x={board.left} y={board.top + 11} width={board.width} height={6} fill="#2a1d12" />
          <text x={CX} y={board.top + 12} textAnchor="middle" className="board-head">
            {heading.toUpperCase()}
          </text>

          <line x1={CX} y1={board.top + 26} x2={CX} y2={board.top + 62} stroke="#26201a" strokeOpacity="0.14" />
          <text x={board.left + 14} y={board.top + 38} className="board-side-buy">
            BID
          </text>
          <text x={board.left + 14} y={board.top + 58} className="board-figure">
            —
          </text>
          <text x={board.right - 14} y={board.top + 38} textAnchor="end" className="board-side-sell">
            OFFER
          </text>
          <text x={board.right - 14} y={board.top + 58} textAnchor="end" className="board-figure">
            —
          </text>

          <text x={CX} y={board.top + 78} textAnchor="middle" className="board-foot">
            {`${String(ticks)} rounds before the bell`}
          </text>
        </g>

        {[...buyers.map((seat) => ({ seat, color: '#3fbf9a' as const })), ...sellers.map((seat) => ({ seat, color: '#e2683f' as const }))].map(
          ({ seat, color }) => (
            <g
              key={`${color}-${String(seat.index)}-${String(agents)}`}
              transform={`translate(${seat.x.toFixed(1)} ${seat.y.toFixed(1)}) rotate(${seat.deg.toFixed(1)})`}
            >
              <g className="plan-seat" style={{ animationDelay: `${String(seat.index * 55)}ms` }}>
                <line y1={-13} y2={-21} stroke={color} strokeWidth="1.4" strokeOpacity="0.45" strokeLinecap="round" />
                <circle r={11} fill="#0d1216" stroke={color} strokeWidth="1.2" />
                <circle r={15} fill="none" stroke={color} strokeOpacity="0.16" />
                {/* The seat turns to face the board; the number on it does not, or the far side reads upside down. */}
                <g transform={`rotate(${String(-seat.deg)})`}>
                  <text y={4} textAnchor="middle" className="seat-number" fill={color}>
                    {String(seat.index + 1)}
                  </text>
                </g>
              </g>
            </g>
          ),
        )}
      </svg>

      <figcaption className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-white/40">
        <span className="text-buy">{`${String(agents)} houses`} a side</span>
        <span>·</span>
        <span>{`${String(agents * 2)} seats around one board`}</span>
        <span>·</span>
        <span className="text-paper/70">{pits.length === 1 ? pits[0]?.name : `${String(pits.length)} pits open`}</span>
        <span>·</span>
        <span>
          settles on <span className={sandbox ? 'text-brass' : 'text-white/60'}>{sandbox ? 'the real processor' : 'the local processor'}</span>
        </span>
        <span>·</span>
        <span className="text-white/55">{seed.trim().length > 0 ? `seed "${seed.trim()}"` : 'a seed nobody has typed yet'}</span>
      </figcaption>
    </figure>
  );
}
