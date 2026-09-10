import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  VAULT_KEYS,
  credentialServices,
  type SecretStatus,
} from '@sw/shared';
import { ApiClientError, api, type ClientIndexStatus } from '../lib/api';
import { Alert, Card, Chip, Label, Spinner, formatDateTime } from './ui';

/**
 * Credentials, settable here instead of in Plesk.
 *
 * Adding an integration used to mean editing environment variables on the
 * server and restarting, which is a deploy-shaped task for what is really a
 * settings change — and it means the person with the keys and the person with
 * the server have to be the same person.
 *
 * Two rules the layout is built around. Nothing ever shows a stored value,
 * not even four characters of it, because four characters of an API key is
 * four characters an attacker does not have to guess. And Test comes before
 * Save: an operator who pastes a key, tests it green and then saves has
 * proved the thing works, where one who saves first has changed the running
 * system to find out.
 */

export function CredentialVault(): ReactElement {
  const [keys, setKeys] = useState<SecretStatus[]>([]);
  const [vault, setVault] = useState<{ ok: boolean; reason?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.credentials();
      setKeys(result.keys);
      setVault(result.vault);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not load the credential list.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const services = useMemo(() => credentialServices(), []);
  const byService = useMemo(() => {
    const map = new Map<string, SecretStatus[]>();
    for (const key of keys) {
      map.set(key.service, [...(map.get(key.service) ?? []), key]);
    }
    return map;
  }, [keys]);

  if (loading && !keys.length) return <Spinner label="Loading credentials" />;

  const unreadable = keys.filter((k) => k.unreadable);

  return (
    <div className="stack">
      {error && <Alert tone="error">{error}</Alert>}

      {vault && !vault.ok && <Alert tone="error">{vault.reason}</Alert>}

      {unreadable.length > 0 && (
        <Alert tone="error">
          {unreadable.length} stored credential{unreadable.length === 1 ? '' : 's'} cannot be decrypted:{' '}
          <strong>{unreadable.map((k) => k.label).join(', ')}</strong>. SESSION_SECRET has changed since they were
          saved, so they need entering again. Nothing was lost at the provider's end — only our copy.
        </Alert>
      )}

      <Card title="Credentials" eyebrow="stored here, not in Plesk" index="01" accent={1}>
        <p className="muted" style={{ fontSize: 13, margin: '0 0 6px', maxWidth: 700 }}>
          A key saved here takes effect immediately — no restart. It is encrypted at rest with a key derived from{' '}
          <strong>SESSION_SECRET</strong>, which is why that one has to stay in the environment: it is the key the
          rest are locked with, so it cannot be kept in here with them.
        </p>
        <p className="muted" style={{ fontSize: 13, margin: 0, maxWidth: 700 }}>
          Anything still set in Plesk keeps working and is marked as such. Saving the same key here takes over from
          it; clearing it here hands it back at the next restart.
        </p>
      </Card>

      <ClientIndexCard />

      {services.map((service, index) => {
        const group = byService.get(service) ?? VAULT_KEYS.filter((k) => k.service === service).map((k) => ({
          ...k,
          source: 'unset' as const,
        }));
        return (
          <ServiceCredentials
            key={service}
            service={service}
            keys={group}
            index={index + 4}
            disabled={vault ? !vault.ok : false}
            onSaved={load}
          />
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Can the .env file go?
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * One integration's keys
 * ------------------------------------------------------------------ */

const SERVICE_LABEL: Record<string, string> = {
  zen: 'Zen Internet',
  'os-places': 'OS Places',
  'companies-house': 'Companies House',
  giacom: 'Giacom',
  jola: 'Jola',
  zendesk: 'Zendesk',
  opencellid: 'OpenCelliD',
  thinkbroadband: 'thinkbroadband',
  'ofcom-broadband': 'Ofcom broadband',
  resend: 'Resend',
  'bt-home-network': 'BT Home Network',
  'bt-imei': 'BT IMEI lookup',
  'bt-location': 'BT Location Insights',
  microsoft: 'Microsoft sign-in',
  portal: 'This portal',
};

function ServiceCredentials({
  service,
  keys,
  index,
  disabled,
  onSaved,
}: {
  service: string;
  keys: SecretStatus[];
  index: number;
  disabled: boolean;
  onSaved: () => Promise<void> | void;
}): ReactElement {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'test' | 'save' | string | null>(null);
  const [tested, setTested] = useState<{ state: string; detail: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const entered = Object.entries(draft).filter(([, v]) => v.trim().length > 0);
  const hasDraft = entered.length > 0;
  const live = keys.filter((k) => k.source !== 'unset').length;

  const set = (name: string, value: string): void => {
    setDraft((d) => ({ ...d, [name]: value }));
    // A new value invalidates the last result: a green light from the
    // previous paste would be worse than no light at all.
    setTested(null);
    setSaved(null);
  };

  const values = (): Record<string, string> => Object.fromEntries(entered.map(([k, v]) => [k, v.trim()]));

  const test = async (): Promise<void> => {
    setBusy('test');
    setError(null);
    try {
      const result = await api.testCredentials(values());
      setTested({ state: result.state, detail: result.detail });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'The test could not be run.');
    } finally {
      setBusy(null);
    }
  };

  const save = async (): Promise<void> => {
    setBusy('save');
    setError(null);
    try {
      const result = await api.saveCredentials(values());
      setDraft({});
      setTested(null);
      setSaved(
        result.failed.length
          ? `${result.saved.length} saved, ${result.failed.length} refused: ${result.failed[0]?.error ?? ''}`
          : `${result.saved.length} credential${result.saved.length === 1 ? '' : 's'} saved and live.`,
      );
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Those credentials were not saved.');
    } finally {
      setBusy(null);
    }
  };

  const clear = async (name: string): Promise<void> => {
    setBusy(name);
    setError(null);
    try {
      await api.clearCredential(name);
      setSaved('Removed.');
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'That credential was not removed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card
      title={SERVICE_LABEL[service] ?? service}
      eyebrow={live === keys.length ? 'all set' : live ? `${live} of ${keys.length} set` : 'not configured'}
      index={String(index).padStart(2, '0')}
      accent={((index % 4) + 1) as 1 | 2 | 3 | 4}
    >
      <div className="stack stack--tight">
        {keys.map((key) => (
          <div key={key.name} className="cred">
            <div className="cred__meta">
              <strong>{key.label}</strong>
              <span className="muted sw-mono" style={{ fontSize: 11 }}>
                {key.name}
              </span>
              {key.hint && <span className="muted">{key.hint}</span>}
            </div>

            <div className="cred__field">
              <input
                className="field__input"
                type={key.secret ? 'password' : 'text'}
                autoComplete="off"
                spellCheck={false}
                value={draft[key.name] ?? ''}
                onChange={(e) => set(key.name, e.target.value)}
                placeholder={
                  key.source === 'unset'
                    ? 'Paste it here'
                    : `Set — ${key.length} characters. Paste a new one to replace it.`
                }
                disabled={disabled}
              />
            </div>

            <div className="cred__state">
              {key.unreadable ? (
                <Chip tone="crit">cannot decrypt</Chip>
              ) : key.source === 'vault' ? (
                <Chip tone="ok" title={`Set ${formatDateTime(key.setAt) ?? ''}${key.setBy ? ` by ${key.setBy}` : ''}`}>
                  stored here
                </Chip>
              ) : key.source === 'environment' ? (
                <Chip tone="info" title="Set in Plesk. Saving a value here takes over from it.">
                  from Plesk
                </Chip>
              ) : (
                <Chip tone="idle">not set</Chip>
              )}
              {key.source === 'vault' && (
                <button
                  type="button"
                  className="btn btn--ghost btn--small"
                  disabled={busy !== null}
                  onClick={() => void clear(key.name)}
                >
                  {busy === key.name ? 'Removing…' : 'Remove'}
                </button>
              )}
            </div>
          </div>
        ))}

        {tested && (
          <Alert tone={tested.state === 'ok' ? 'ok' : tested.state === 'degraded' ? 'warn' : 'error'}>
            {tested.detail}
          </Alert>
        )}
        {saved && <Alert tone="ok">{saved}</Alert>}
        {error && <Alert tone="error">{error}</Alert>}

        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button
            type="button"
            className="btn btn--ghost btn--small"
            disabled={!hasDraft || busy !== null || disabled}
            onClick={() => void test()}
          >
            {busy === 'test' ? 'Testing…' : 'Test without saving'}
          </button>
          <button
            type="button"
            className="btn btn--primary btn--small"
            disabled={!hasDraft || busy !== null || disabled}
            onClick={() => void save()}
          >
            {busy === 'save' ? 'Saving…' : 'Save and make live'}
          </button>
          {hasDraft && !tested && (
            <span className="muted" style={{ fontSize: 12 }}>
              Worth testing first — it costs one call and tells you now rather than at the next lookup.
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * The local client list
 * ------------------------------------------------------------------ */

/**
 * How big the local client list is, and which sources filled it.
 *
 * Here rather than on its own page because it is what these keys switch on:
 * with none of them set the lookup box cannot find a customer by name, and
 * this says so in numbers rather than leaving somebody to notice.
 */
function ClientIndexCard(): ReactElement {
  const [status, setStatus] = useState<ClientIndexStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.clientIndex());
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not read the client list.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const rebuild = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.rebuildClientIndex());
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'The rebuild failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="Client list"
      eyebrow={status ? `${status.entries} clients · ${status.sites} sites` : 'reading…'}
      index="02"
      accent={2}
      meta={
        <button type="button" className="btn btn--ghost btn--small" disabled={busy} onClick={() => void rebuild()}>
          {busy ? 'Rebuilding…' : 'Rebuild now'}
        </button>
      }
    >
      <p className="muted" style={{ fontSize: 13, margin: '0 0 10px', maxWidth: 700 }}>
        Pulled once a day and searched locally, so typing a customer name in the lookup box costs no API calls at
        all. Picking a client substitutes the postcode or UPRN behind one of their sites — which is what the
        suppliers can actually search for.
      </p>

      {error && <Alert tone="error">{error}</Alert>}

      {status && status.entries === 0 && (
        <Alert tone="warn">
          Empty, so the lookup box cannot find a customer by name yet. IT Glue is the source worth adding first —
          it has the postcodes. Failing that, it fills in on its own as people look premises up.
        </Alert>
      )}

      {status && (
        <>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>Clients</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(status.sources).map(([key, source]) => (
                  <tr key={key}>
                    <td>{key}</td>
                    <td>{source.count || '—'}</td>
                    <td>
                      {source.ok ? (
                        <Chip tone={source.count ? 'ok' : 'idle'}>{source.detail ?? 'listed'}</Chip>
                      ) : (
                        <Chip tone={source.detail === 'not configured' ? 'idle' : 'crit'}>
                          {source.detail ?? 'failed'}
                        </Chip>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="muted" style={{ fontSize: 12.5, margin: '10px 0 0' }}>
            {status.builtAt ? `Last built ${formatDateTime(status.builtAt)}.` : 'Never built.'}
            {status.stale ? ' Due a refresh — it happens on its own within the hour.' : ''}
          </p>

          {status.lastChange && (status.lastChange.added.length > 0 || status.lastChange.removed.length > 0) && (
            <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0', maxWidth: 700 }}>
              Last change: {status.lastChange.added.length} added
              {status.lastChange.added.length ? ` (${status.lastChange.added.slice(0, 4).join(', ')})` : ''},{' '}
              {status.lastChange.removed.length} gone
              {status.lastChange.removed.length ? ` (${status.lastChange.removed.slice(0, 4).join(', ')})` : ''}. A
              client appearing is usually a new customer; one disappearing is usually a cancellation nobody
              mentioned.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
