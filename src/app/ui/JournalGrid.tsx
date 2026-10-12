'use client';

import { useMemo, useRef } from 'react';
import { AllCommunityModule, ModuleRegistry, themeQuartz, type ColDef } from 'ag-grid-community';
import { AgGridReact } from 'ag-grid-react';
import type { CurrencyCode } from '../../core/money';
import type { LedgerEntry } from '../../core/ledger';
import { cash, clockOf } from './format';

// The Theming API below injects its own stylesheet - importing `ag-grid.css` as well makes the grid
// report that it is being themed twice.
ModuleRegistry.registerModules([AllCommunityModule]);

/**
 * The journal, as a real grid.
 *
 * Every settlement writes postings, and a person auditing the room should be able to sort them,
 * filter them and drag the columns about without asking a server for anything. One row is one
 * posting, which is the level double-entry actually lives at: an account, a side, an amount, and
 * the memo of the trade that caused it.
 */

interface Row {
  readonly seq: number;
  readonly at: string;
  readonly code: string;
  readonly account: string;
  readonly party: string;
  readonly debit: number;
  readonly credit: number;
  readonly memo: string;
  readonly trade: string;
}

const theme = themeQuartz.withParams({
  backgroundColor: '#0b0f13',
  foregroundColor: 'rgba(240,235,225,0.82)',
  accentColor: '#d9a441',
  browserColorScheme: 'dark',
  headerBackgroundColor: '#141a20',
  headerTextColor: '#d9a441',
  headerFontSize: '0.72rem',
  headerFontWeight: '600',
  fontSize: '0.78rem',
  rowHeight: 30,
  headerHeight: 34,
  borderColor: 'rgba(255,255,255,0.07)',
  wrapperBorderRadius: 6,
  oddRowBackgroundColor: 'rgba(255,255,255,0.025)',
  rowHoverColor: 'rgba(217,164,65,0.07)',
  rangeSelectionBorderColor: '#d9a441',
  focusShadow: '0 0 0 1px #d9a441',
});

export default function JournalGrid({
  entries,
  accounts,
  currency,
}: {
  entries: readonly LedgerEntry[];
  accounts: readonly { id: string; name: string; type: string }[];
  currency: CurrencyCode;
}): React.ReactElement {
  const gridRef = useRef<AgGridReact<Row>>(null);

  const rows = useMemo<Row[]>(() => {
    const names = new Map(accounts.map((account) => [account.id, account.name]));
    const list: Row[] = [];
    for (const entry of entries) {
      for (const posting of entry.postings) {
        list.push({
          seq: entry.seq,
          at: clockOf(entry.ts),
          code: entry.code,
          account: posting.account,
          party: names.get(posting.account) ?? '',
          debit: posting.debit,
          credit: posting.credit,
          memo: entry.memo,
          trade: entry.refs['trade'] ?? '',
        });
      }
    }
    return list;
  }, [entries, accounts]);

  const totals = rows.reduce(
    (total, row) => ({ debit: total.debit + row.debit, credit: total.credit + row.credit }),
    { debit: 0, credit: 0 },
  );
  const balanced = totals.debit === totals.credit;

  const columns = useMemo<ColDef<Row>[]>(
    () => [
      { field: 'seq', headerName: 'line', width: 74, cellClass: 'tnum journal-number' },
      { field: 'at', headerName: 'when (utc)', width: 108 },
      { field: 'code', headerName: 'code', width: 150 },
      { field: 'account', headerName: 'account', flex: 2, minWidth: 200, cellClass: 'journal-account' },
      { field: 'party', headerName: 'kept for', flex: 1, minWidth: 130, cellClass: 'journal-party' },
      { field: 'debit', headerName: 'debit', width: 112, cellClass: 'tnum journal-number', valueFormatter: (p) => (p.value === 0 ? '' : cash(p.value, currency)) },
      { field: 'credit', headerName: 'credit', width: 112, cellClass: 'tnum journal-number', valueFormatter: (p) => (p.value === 0 ? '' : cash(p.value, currency)) },
      { field: 'memo', headerName: 'memo', flex: 3, minWidth: 220, cellClass: 'journal-memo' },
      { field: 'trade', headerName: 'trade', width: 116 },
    ],
    [currency],
  );

  return (
    <section className="brass-edge rounded-lg bg-ink/70 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1 pb-2">
        <h3 className="font-mono text-[11px] uppercase tracking-[0.24em] text-brass/85">The journal</h3>
        <p className="font-mono text-[11px] text-white/45">
          {String(rows.length)} postings · debits {cash(totals.debit, currency)} · credits {cash(totals.credit, currency)} ·{' '}
          <span className={balanced ? 'text-good' : 'text-alarm'}>{balanced ? 'the books balance' : 'THE BOOKS DO NOT BALANCE'}</span>
        </p>
      </div>
      <div className="h-[420px] w-full">
        <AgGridReact<Row>
          ref={gridRef}
          theme={theme}
          columnDefs={columns}
          rowData={rows}
          defaultColDef={{ sortable: true, resizable: true, suppressHeaderMenuButton: false }}
          rowSelection={{ mode: 'multiRow' }}
          getRowStyle={(params) => (params.data && params.data.debit === 0 ? { color: 'rgba(240,235,225,0.62)' } : undefined)}
          overlayNoRowsTemplate='<span style="padding:12px;color:rgba(255,255,255,.45)">nothing has settled on this floor yet</span>'
        />
      </div>
    </section>
  );
}
