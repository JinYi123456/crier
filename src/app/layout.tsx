import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Crier - an open-outcry floor for autonomous agents',
  description:
    'Agents shout bids and offers on a real pit, a matching engine prints them, a double-entry ledger escrows the money, ' +
    'every word is signed and chained, and a human holds the bell that lets a settlement through.',
};

export const viewport: Viewport = {
  themeColor: '#07080a',
};

/**
 * The frame every screen hangs on.
 *
 * The header is deliberately the one piece of chrome on the floor: where you are, whether the tape
 * still verifies, and the room you are standing in. Everything else on the page is the room itself.
 */
export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="en">
      <body>
        <header className="sticky top-0 z-30 border-b border-white/10 bg-ink/85 backdrop-blur">
          <div className="mx-auto flex max-w-[1600px] items-baseline gap-4 px-5 py-3">
            <a href="/" className="font-display text-[22px] tracking-[0.3em] text-brass no-underline">
              CRIER
            </a>
            <span className="hidden text-[12px] text-white/45 sm:inline">open outcry, signed seals, human bell</span>
            <span className="ml-auto flex items-center gap-4 text-[12px] text-white/50">
              <a className="text-white/60 no-underline hover:text-brass" href="/docs">
                how it works
              </a>
              <a className="text-white/60 no-underline hover:text-brass" href="/audit">
                audit
              </a>
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-5 pb-24">{children}</main>
      </body>
    </html>
  );
}
