import { useState, type ReactElement } from 'react';
import { BULK_MAX_ENTRIES, parseBulkInput, type BulkResult, type BulkRow } from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Card, Cell, Chip, ExportButtons, Label, Spinner } from './ui';
import type { CsvColumn } from '../lib/csv';

/**
 * Many premises at once.
 *
 * The per-premises report is right for one site and useless for a bid across
 * forty. Paste the column out of the spreadsheet, get a table back, export
 * it, and open individual rows properly where the detail matters.
 *
 * Every row is a real availability check against a wholesale account, so the
 * budget is shown before the run rather than discovered during it.
 */

const COLUMNS: Array<CsvColumn<BulkRow>> = [
  { header: 'Input', value: (r) => r.input },
  { header: 'Read as', value: (r) => r.kind },
  { header: 'Status', value: (r) => r.status },
  { header: 'UPRN', value: (r) => r.uprn },
  { header: 'Address', value: (r) => r.address },
  { header: 'Postcode', value: (r) => r.postcode },
  { header: 'Best technology', value: (r) => r.bestTechnology },
  { header: 'Operator', value: (r) => r.bestOperator },
  { header: 'Down Mb', value: (r) => r.downMbps },
  { header: 'Up Mb', value: (r) => r.upMbps },
  { header: 'Orderable now', value: (r) => r.orderableCount },
  { header: 'Options', value: (r) => r.optionCount },
  { header: 'Lines in place', value: (r) => r.lineCount },
  { header: 'Note', value: (r) => r.note },
];

const STATUS_TONE = {
  ok: 'ok',
  not_found: 'idle',
  skipped: 'warn',
  error: 'crit',
} as const;

const STATUS_LABEL = {
  ok: 'Checked',
  not_found: 'Not found',
  skipped: 'Budget spent',
  error: 'Failed',
} as const;

export function BulkLookup(): ReactElement {
  const [text, setText] = useState('');
  const [result, setResult] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Parsed as they type, so the count and the limit are visible before the
  // run rather than after it.
  const entries = parseBulkInput(text);
  const overLimit = entries.length > BULK_MAX_ENTRIES;

  const run = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.bulkLookup(text));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'The bulk lookup failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack stack--tight">
      <Card title="Bulk lookup" eyebrow="Many premises at once" index="01" accent={1}>
        <div className="stack stack--tight">
          <div>
            <Label>Postcodes, UPRNs, addresses, CLIs — one per line</Label>
            <textarea
              className="input"
              rows={8}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={'M1 1AE\nSE23 1JG\n100023253338\n45 Brockley Rise, London'}
              style={{ width: '100%', marginTop: 5, fontFamily: 'var(--sw-mono, monospace)', fontSize: 12.5 }}
              spellCheck={false}
            />
          </div>

          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void run()}
              disabled={busy || entries.length === 0 || overLimit}
            >
              {busy ? 'Checking…' : `Check ${entries.length || ''}`.trim()}
            </button>
            <span className="muted" style={{ fontSize: 12 }}>
              {entries.length} unique{' '}
              {entries.length === 1 ? 'entry' : 'entries'} — each one spends a unit of the daily budget
            </span>
            {text.trim() && (
              <button type="button" className="btn btn--ghost btn--small" onClick={() => { setText(''); setResult(null); }}>
                Clear
              </button>
            )}
          </div>

          {overLimit && (
            <Alert tone="warn">
              {entries.length} entries — {BULK_MAX_ENTRIES} is the most one run will take. Split the list.
            </Alert>
          )}

          {busy && (
            <Spinner label={`Checking ${entries.length} premises — three at a time, so the supplier is not hammered`} />
          )}

          {error && <Alert tone="error">{error}</Alert>}
        </div>
      </Card>

      {result && <BulkResults result={result} />}
    </div>
  );
}

function BulkResults({ result }: { result: BulkResult }): ReactElement {
  const found = result.rows.filter((r) => r.status === 'ok');
  const sellable = found.filter((r) => (r.orderableCount ?? 0) > 0);

  return (
    <Card
      title="Results"
      eyebrow={`${result.completed} of ${result.requested} checked in ${Math.round(result.durationMs / 1000)}s`}
      index="02"
      accent={2}
      flush
      meta={<ExportButtons rows={result.rows} columns={COLUMNS} filenamePrefix="bulk-lookup" label="these results" />}
    >
      <div style={{ padding: '14px 18px 0' }}>
        <div className="kv">
          <Cell label="Checked" value={result.completed} mono />
          <Cell label="Something orderable" value={sellable.length} mono />
          <Cell label="Not found" value={result.rows.filter((r) => r.status === 'not_found').length} mono />
          <Cell label="Failed" value={result.rows.filter((r) => r.status === 'error').length} mono />
          <Cell
            label="Budget left today"
            value={result.quota.limit === 0 ? 'unlimited' : result.quota.remaining}
            mono
          />
        </div>
      </div>

      {result.skippedForBudget > 0 && (
        <div style={{ padding: '14px 18px 0' }}>
          <Alert tone="warn">
            {result.skippedForBudget} {result.skippedForBudget === 1 ? 'entry was' : 'entries were'} not checked —
            today's fair-use budget ran out partway through. They are listed below as “Budget spent”, so re-running
            tomorrow only needs those.
          </Alert>
        </div>
      )}

      <div className="table-wrap" style={{ marginTop: 14 }}>
        <table className="data">
          <thead>
            <tr>
              <th>Input</th>
              <th>Status</th>
              <th>Premises</th>
              <th>Best available</th>
              <th>Speed</th>
              <th>Orderable</th>
              <th>Lines</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, index) => (
              <tr key={`${row.input}:${index}`}>
                <td className="sw-mono" style={{ fontSize: 12 }}>{row.input}</td>
                <td>
                  <Chip tone={STATUS_TONE[row.status]} dot={row.status === 'ok'}>
                    {STATUS_LABEL[row.status]}
                  </Chip>
                </td>
                <td style={{ fontSize: 12, maxWidth: 260 }}>
                  {row.address ?? '—'}
                  {row.note && (
                    <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{row.note}</div>
                  )}
                </td>
                <td style={{ fontSize: 12.5 }}>
                  {row.bestTechnology ? (
                    <>
                      <strong style={{ color: 'var(--sw-ink)' }}>{row.bestTechnology}</strong>
                      {row.bestOperator && (
                        <div className="muted" style={{ fontSize: 11 }}>{row.bestOperator}</div>
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="sw-mono" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                  {row.downMbps != null ? `${row.downMbps} / ${row.upMbps ?? '?'}` : '—'}
                </td>
                <td className="sw-mono" style={{ fontSize: 12 }}>
                  {row.orderableCount != null ? `${row.orderableCount} of ${row.optionCount ?? 0}` : '—'}
                </td>
                <td className="sw-mono" style={{ fontSize: 12 }}>{row.lineCount ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
