import { useEffect, useState, type ReactElement } from 'react';
import type { WatchRecord } from '@sw/shared';
import { ApiClientError, api } from '../lib/api';
import { Alert, Card, Chip, Empty, Label, Spinner, formatDateTime, relativeTime } from './ui';

/**
 * The watch list.
 *
 * A watch exists because the interesting broadband changes are slow — a
 * planned FTTP build going live, an RFS date moving — and nobody remembers to
 * look again six months later. The list is deliberately plain: what is being
 * watched, when it was last checked, and what moved.
 */

export function WatchPanel({ onOpenSite }: { onOpenSite?: (uprn: string) => void }): ReactElement {
  const [watches, setWatches] = useState<WatchRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    try {
      setWatches((await api.watches()).watches);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load your watched premises.');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const remove = async (id: string): Promise<void> => {
    setRemoving(id);
    try {
      await api.removeWatch(id);
      setWatches((current) => (current ?? []).filter((w) => w.id !== id));
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not stop watching that premises.');
    } finally {
      setRemoving(null);
    }
  };

  return (
    <Card
      title="Watched premises"
      eyebrow={watches?.length ? `${watches.length} being re-checked` : 'Tell me when it changes'}
      index="04"
      accent={3}
    >
      {watches === null && !error && <Spinner label="Loading your watched premises" />}

      {error && <Alert tone="error">{error}</Alert>}

      {watches?.length === 0 && (
        <Empty title="Nothing watched yet">
          Open a premises under Lookup and use “Watch this premises”. It gets re-checked about once a day and you
          tell you only when something actually moves — a build going live, an RFS date changing, a technology
          arriving.
        </Empty>
      )}

      {watches && watches.length > 0 && (
        <div className="stack stack--tight">
          {watches.map((watch) => (
            <WatchRow
              key={watch.id}
              watch={watch}
              busy={removing === watch.id}
              onRemove={() => void remove(watch.id)}
              {...(onOpenSite ? { onOpen: () => onOpenSite(watch.uprn) } : {})}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function WatchRow({
  watch,
  busy,
  onRemove,
  onOpen,
}: {
  watch: WatchRecord;
  busy: boolean;
  onRemove: () => void;
  onOpen?: () => void;
}): ReactElement {
  const latest = watch.history[0];

  return (
    <div className="watch-row">
      <div className="watch-row__main">
        <div className="watch-row__address">{watch.address}</div>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
          <Chip tone="idle">{watch.postcode}</Chip>
          <Chip tone="idle" title="UPRN">
            <span className="sw-mono">{watch.uprn}</span>
          </Chip>
          {watch.snapshot.bestTechnology && <Chip tone="ok">{watch.snapshot.bestTechnology}</Chip>}
          {watch.snapshot.fttpBuildStatus && (
            <Chip tone="warn">FTTP {watch.snapshot.fttpBuildStatus.toLowerCase()}</Chip>
          )}
        </div>

        <div style={{ marginTop: 6 }}>
          <Label>
            {watch.lastCheckedAt
              ? `Last checked ${relativeTime(watch.lastCheckedAt)}`
              : 'Not re-checked yet — the first sweep will pick it up'}
            {watch.lastChangedAt ? ` · last changed ${formatDateTime(watch.lastChangedAt)}` : ''}
          </Label>
        </div>

        {watch.lastError && (
          <div style={{ marginTop: 6 }}>
            <Alert tone="warn">Last check failed: {watch.lastError}</Alert>
          </div>
        )}

        {latest && (
          <ul className="watch-row__changes">
            {latest.changes.map((change) => (
              <li key={change}>{change}</li>
            ))}
          </ul>
        )}
      </div>

      <div className="row" style={{ gap: 6 }}>
        {onOpen && (
          <button type="button" className="btn btn--ghost btn--small" onClick={onOpen}>
            Open
          </button>
        )}
        <button type="button" className="btn btn--ghost btn--small" onClick={onRemove} disabled={busy}>
          {busy ? 'Stopping…' : 'Stop watching'}
        </button>
      </div>
    </div>
  );
}

/**
 * The button on a site report.
 *
 * Adding a watch costs no upstream call — the server seeds the first snapshot
 * from the report it just built — so this is a single POST and a label change
 * rather than anything that needs a dialog.
 */
export function WatchButton({ uprn }: { uprn: string }): ReactElement {
  const [state, setState] = useState<'idle' | 'busy' | 'watching'>('idle');
  const [error, setError] = useState<string | null>(null);

  // A different premises is a different question, so the label resets.
  useEffect(() => {
    setState('idle');
    setError(null);
  }, [uprn]);

  const add = async (): Promise<void> => {
    setState('busy');
    setError(null);
    try {
      await api.addWatch(uprn);
      setState('watching');
    } catch (err) {
      // "Already watching this premises" is the answer, not a failure, so it
      // lands on the button rather than in an error banner.
      const message = err instanceof ApiClientError ? err.message : 'Could not start watching this premises.';
      if (/already watching/i.test(message)) {
        setState('watching');
        return;
      }
      setState('idle');
      setError(message);
    }
  };

  if (state === 'watching') {
    return (
      <span className="row" style={{ gap: 6, alignItems: 'center' }}>
        <Chip tone="ok" dot>
          Watching
        </Chip>
      </span>
    );
  }

  return (
    <>
      <button
        type="button"
        className="btn btn--ghost btn--small"
        onClick={() => void add()}
        disabled={state === 'busy'}
        title="Re-checked about once a day. You only hear about it when something changes."
      >
        {state === 'busy' ? 'Adding…' : 'Watch this premises'}
      </button>
      {error && (
        <span className="muted" style={{ fontSize: 11.5, maxWidth: 260 }}>
          {error}
        </span>
      )}
    </>
  );
}
