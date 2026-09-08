import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { identify, kindLabel, type AddressSuggestion, type IdentifierKind } from '@sw/shared';
import { api, type RecentLookup } from '../lib/api';
import { Chip, Label, relativeTime, type ChipTone } from './ui';

/**
 * The one search box.
 *
 * Classification happens locally as the user types (the same `identify`
 * used by the server), so the chip updates with no round trip. Address
 * suggestions are fetched with a debounce, and a postcode always shows the
 * full premises list so the exact address can be picked.
 */

const EXAMPLES = [
  { label: 'M1 1AE', hint: 'postcode' },
  { label: '4 High Street', hint: 'first line of address' },
  { label: '148575287842', hint: 'UPRN' },
  { label: '01614969790', hint: 'CLI' },
];

const TONE_BY_KIND: Record<IdentifierKind, ChipTone> = {
  postcode: 'info',
  uprn: 'ok',
  address: 'info',
  cli: 'slate',
  lineAccessId: 'slate',
  serviceId: 'slate',
  ontSerial: 'slate',
  unknown: 'idle',
};

export function SearchBar({
  onSubmit,
  onPickAddress,
  busy,
  initialValue = '',
}: {
  onSubmit: (query: string) => void;
  onPickAddress: (suggestion: AddressSuggestion) => void;
  busy: boolean;
  initialValue?: string;
}): ReactElement {
  const [value, setValue] = useState(initialValue);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [postcodes, setPostcodes] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  /**
   * The value most recently submitted. Without this the debounced typeahead
   * re-opens over the results the moment a search returns, because the input
   * still holds the text that was searched for.
   */
  const [submitted, setSubmitted] = useState<string | null>(null);
  /**
   * What this user looked up recently. Loaded once on mount and refreshed
   * after each submission, so the list is current without polling.
   */
  const [recent, setRecent] = useState<RecentLookup[]>([]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const resolved = useMemo(() => identify(value), [value]);

  const loadRecent = useCallback(() => {
    void api
      .recent()
      .then((r) => setRecent(r.recent))
      // A missing recents list is not worth a message — the box still works.
      .catch(() => setRecent([]));
  }, []);

  useEffect(() => loadRecent(), [loadRecent]);

  // Debounced typeahead. A stale response must never overwrite a newer one,
  // so each request is tagged and late arrivals are dropped.
  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setPostcodes([]);
      return;
    }
    // Line identifiers have no address list — submitting is the only action.
    if (['cli', 'lineAccessId', 'serviceId', 'ontSerial'].includes(resolved.kind)) {
      setSuggestions([]);
      setPostcodes([]);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await api.suggest(trimmed);
        if (cancelled) return;
        setSuggestions(result.suggestions);
        setPostcodes(result.postcodes ?? []);
        // Only pop the list open if the user has typed something new since
        // the last submission.
        setOpen(
          trimmed !== submitted && (result.suggestions.length > 0 || (result.postcodes ?? []).length > 0),
        );
        setHighlight(-1);
      } catch {
        if (!cancelled) {
          setSuggestions([]);
          setPostcodes([]);
        }
      }
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value, resolved.kind, submitted]);

  // Close the dropdown on an outside click.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  // `/` focuses the search from anywhere, as long as you aren't already typing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      if (event.key === '/' && !typing) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const submit = (query = value) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    setOpen(false);
    setSubmitted(trimmed);
    onSubmit(trimmed);
    // The server files the lookup once it resolves; give it a moment, then
    // re-read rather than guessing what it recorded.
    setTimeout(loadRecent, 1200);
  };

  const pick = (suggestion: AddressSuggestion) => {
    setOpen(false);
    setValue(suggestion.label);
    setSubmitted(suggestion.label.trim());
    onPickAddress(suggestion);
    setTimeout(loadRecent, 1200);
  };

  /** Re-runs a recent lookup by its most precise identifier. */
  const rerun = (entry: RecentLookup) => {
    const query = entry.uprn ?? entry.query;
    setValue(query);
    submit(query);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const total = suggestions.length + postcodes.length;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (open && highlight >= 0 && highlight < suggestions.length) pick(suggestions[highlight]!);
      else if (open && highlight >= suggestions.length) submit(postcodes[highlight - suggestions.length]);
      else submit();
      return;
    }
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown' && total) {
      event.preventDefault();
      setOpen(true);
      setHighlight((h) => (h + 1) % total);
    }
    if (event.key === 'ArrowUp' && total) {
      event.preventDefault();
      setHighlight((h) => (h <= 0 ? total - 1 : h - 1));
    }
  };

  const showChip = value.trim().length >= 2;

  return (
    <div className="search" ref={boxRef}>
      <div className="search__card">
        <div className="search__strip" aria-hidden="true" />
        <div className="search__row">
          <span className="search__icon" aria-hidden="true">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.6-3.6" />
            </svg>
          </span>
          <input
            ref={inputRef}
            className="search__input"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={onKeyDown}
            onFocus={() => {
              // An empty box offers the history; a part-typed one offers
              // suggestions, unless they are for what was just submitted.
              if (!value.trim()) setOpen(recent.length > 0);
              else if (value.trim() !== submitted && (suggestions.length || postcodes.length)) setOpen(true);
            }}
            placeholder="Postcode, address, UPRN, CLI or line ID…"
            spellCheck={false}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            aria-label="Search by postcode, address, UPRN, CLI or line ID"
            aria-expanded={open}
            aria-autocomplete="list"
            role="combobox"
          />
          <button type="button" className="search__submit" onClick={() => submit()} disabled={busy || !value.trim()}>
            {busy ? 'Looking…' : 'Look up'}
          </button>
        </div>

        <div className="search__hint">
          {showChip ? (
            <>
              <Chip tone={TONE_BY_KIND[resolved.kind]} dot>
                {kindLabel(resolved.kind)}
              </Chip>
              <span className="muted" style={{ fontSize: 12 }}>
                {resolved.reason}
                {resolved.kind !== 'unknown' && resolved.normalised !== value.trim() && (
                  <> — reading as <strong className="sw-mono">{resolved.normalised}</strong></>
                )}
              </span>
            </>
          ) : (
            <div>
              <Label>{recent.length > 0 ? 'Recent' : 'Try'}</Label>
              <div className="search__examples">
                {recent.length > 0
                  ? recent.slice(0, 5).map((entry) => (
                      <button
                        key={`${entry.kind}:${entry.uprn ?? entry.query}`}
                        type="button"
                        className="search__example"
                        onClick={() => rerun(entry)}
                        title={`${entry.label ?? entry.query} — looked up ${relativeTime(entry.at)}`}
                      >
                        {entry.label ?? entry.query}
                      </button>
                    ))
                  : EXAMPLES.map((ex) => (
                      <button
                        key={ex.label}
                        type="button"
                        className="search__example"
                        onClick={() => {
                          setValue(ex.label);
                          submit(ex.label);
                        }}
                        title={`Example ${ex.hint}`}
                      >
                        {ex.label}
                      </button>
                    ))}
                {recent.length > 0 && (
                  <button
                    type="button"
                    className="search__example search__example--muted"
                    onClick={() => {
                      void api.clearRecent().then(() => setRecent([]));
                    }}
                    title="Forget this list"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {open && (suggestions.length > 0 || postcodes.length > 0 || (!value.trim() && recent.length > 0)) && (
        <div className="typeahead" role="listbox">
          {!value.trim() && recent.length > 0 && (
            <>
              <div className="typeahead__group">
                <Label>Where you have been</Label>
              </div>
              {recent.map((entry) => (
                <button
                  key={`recent:${entry.kind}:${entry.uprn ?? entry.query}`}
                  type="button"
                  className="typeahead__item"
                  role="option"
                  aria-selected={false}
                  onClick={() => rerun(entry)}
                >
                  <span className="typeahead__label">
                    {entry.label ?? entry.query}
                    <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>{relativeTime(entry.at)}</span>
                  </span>
                  <span className="typeahead__uprn sw-mono">{entry.uprn ?? entry.postcode ?? entry.kind}</span>
                </button>
              ))}
            </>
          )}

          {suggestions.length > 0 && (
            <>
              <div className="typeahead__group">
                <Label>
                  {suggestions.length} {suggestions.length === 1 ? 'premises' : 'premises'}
                  {resolved.kind === 'postcode' ? ` at ${resolved.normalised}` : ''} — pick the exact address
                </Label>
              </div>
              {suggestions.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  className="typeahead__item"
                  role="option"
                  aria-selected={highlight === i}
                  onClick={() => pick(s)}
                  onMouseEnter={() => setHighlight(i)}
                >
                  <span className="typeahead__label">{s.label}</span>
                  <span className="typeahead__uprn sw-mono">{s.uprn ?? s.postcode}</span>
                </button>
              ))}
            </>
          )}

          {postcodes.length > 0 && (
            <>
              <div className="typeahead__group">
                <Label>Did you mean one of these postcodes</Label>
              </div>
              {postcodes.map((pc, i) => (
                <button
                  key={pc}
                  type="button"
                  className="typeahead__item"
                  role="option"
                  aria-selected={highlight === suggestions.length + i}
                  onClick={() => {
                    setValue(pc);
                    submit(pc);
                  }}
                  onMouseEnter={() => setHighlight(suggestions.length + i)}
                >
                  <span className="typeahead__label sw-mono">{pc}</span>
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
