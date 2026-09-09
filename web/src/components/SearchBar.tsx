import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { identify, kindLabel, type AddressSuggestion, type IdentifierKind, type LookupSuggestion } from '@sw/shared';
import { KIND_LABEL, LookupIcon } from './LookupIcon';
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

/**
 * Worked examples, shown only when the fixture set is answering lookups.
 *
 * These are fixture values. On a live deployment the UPRN and the CLI do not
 * exist, so offering them as a starting point produced "No premises found"
 * from the one thing on the page that was supposed to be guaranteed. When
 * live, the hints below describe what can be typed without inventing a
 * premises that is not there.
 */
const EXAMPLES = [
  { label: 'M1 1AE', hint: 'postcode' },
  { label: '4 High Street', hint: 'first line of address' },
  { label: '148575287842', hint: 'UPRN' },
  { label: '01614969790', hint: 'CLI' },
];

/** What the box accepts, for when there are no safe examples to offer. */
const ACCEPTED = ['postcode', 'first line of address', 'UPRN', 'CLI', 'line access ID'];

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
  onPickService,
  busy,
  initialValue = '',
}: {
  onSubmit: (query: string) => void;
  onPickAddress: (suggestion: AddressSuggestion) => void;
  /** A broadband service or a mobile, which open different things. */
  onPickService: (suggestion: LookupSuggestion) => void;
  busy: boolean;
  initialValue?: string;
}): ReactElement {
  const [value, setValue] = useState(initialValue);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  /* Words the search could not account for. See SearchResponse.unmatched. */
  const [unmatched, setUnmatched] = useState<string[]>([]);
  const [postcodes, setPostcodes] = useState<string[]>([]);
  /*
   * Services matching what was typed.
   *
   * Kept apart from the address suggestions rather than merged into one
   * list: they are three different kinds of thing, they open three different
   * pages, and a flat list of them would need the icon to carry meaning it
   * cannot carry on its own.
   */
  const [services, setServices] = useState<{
    clients: LookupSuggestion[];
    broadband: LookupSuggestion[];
    mobile: LookupSuggestion[];
    needsIdentifier: boolean;
  }>({ clients: [], broadband: [], mobile: [], needsIdentifier: false });
  /*
   * The client whose sites are showing.
   *
   * A client with one site opens straight away. With several, the row
   * expands into them rather than guessing: a company with twenty shops has
   * twenty answers, and picking one for the engineer would be picking wrong
   * nineteen times out of twenty.
   */
  const [expanded, setExpanded] = useState<LookupSuggestion | null>(null);
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
      setUnmatched([]);
      setServices({ clients: [], broadband: [], mobile: [], needsIdentifier: false });
      return;
    }
    /*
     * Line identifiers used to stop here, on the reasoning that submitting
     * was the only action available for one. That stopped being true when
     * the box started finding services: a phone number now has both a mobile
     * and a circuit behind it, and suppressing the list meant an engineer
     * typing a number could never see the SIM. So the fetch runs for these
     * too — it simply comes back with services and no premises.
     */

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const result = await api.suggest(trimmed);
        if (cancelled) return;
        setSuggestions(result.suggestions);
        setUnmatched(result.unmatched ?? []);
        setPostcodes(result.postcodes ?? []);
        setServices({
          clients: result.clients ?? [],
          broadband: result.broadband ?? [],
          mobile: result.mobile ?? [],
          needsIdentifier: result.broadbandNeedsIdentifier ?? false,
        });
        setExpanded(null);
        // Only pop the list open if the user has typed something new since
        // the last submission.
        // Anything worth showing opens the list, services included — a
        // number has no premises behind it and its SIM is the whole point.
        const anything =
          result.suggestions.length > 0 ||
          (result.postcodes ?? []).length > 0 ||
          (result.clients ?? []).length > 0 ||
          (result.broadband ?? []).length > 0 ||
          (result.mobile ?? []).length > 0 ||
          Boolean(result.broadbandNeedsIdentifier);
        setOpen(trimmed !== submitted && anything);
        setHighlight(-1);
      } catch {
        if (!cancelled) {
          setSuggestions([]);
          setUnmatched([]);
          setPostcodes([]);
          setServices({ clients: [], broadband: [], mobile: [], needsIdentifier: false });
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

  /**
   * A broadband service or a mobile.
   *
   * The box is left showing what identifies the thing rather than its label,
   * because that is what can be pasted into a ticket and searched again.
   */
  const pickClient = (suggestion: LookupSuggestion) => {
    const sites = suggestion.sites ?? [];
    if (sites.length === 1) {
      // One site: substitute its UPRN or postcode and run the real lookup.
      // That is the whole trick — the name was never searchable upstream,
      // and this is.
      const site = sites[0]!;
      const identifier = site.uprn ?? site.postcode;
      if (identifier) {
        setOpen(false);
        setValue(identifier);
        setSubmitted(identifier);
        onSubmit(identifier);
        setTimeout(loadRecent, 1200);
        return;
      }
    }
    // Several sites, or none we can look up. Expanding is honest; guessing
    // is not.
    setExpanded((current) => (current?.id === suggestion.id ? null : suggestion));
  };

  const pickSite = (site: { name: string; postcode?: string; uprn?: string }) => {
    const identifier = site.uprn ?? site.postcode;
    if (!identifier) return;
    setOpen(false);
    setExpanded(null);
    setValue(identifier);
    setSubmitted(identifier);
    onSubmit(identifier);
    setTimeout(loadRecent, 1200);
  };

  const pickService = (suggestion: LookupSuggestion) => {
    setOpen(false);
    setValue(suggestion.query);
    setSubmitted(suggestion.query.trim());
    onPickService(suggestion);
    setTimeout(loadRecent, 1200);
  };

  /** Re-runs a recent lookup by its most precise identifier. */
  const rerun = (entry: RecentLookup) => {
    const query = entry.uprn ?? entry.query;
    setValue(query);
    submit(query);
  };

  /*
   * Every selectable row, in the order they are drawn.
   *
   * One flat list rather than three offsets into three arrays: the arrow
   * keys have to walk premises, then broadband, then mobiles, then postcode
   * completions, and doing that with index arithmetic across four arrays is
   * how a keyboard path quietly stops matching what is on screen.
   */
  const rows: Array<
    | { row: 'address'; suggestion: AddressSuggestion }
    | { row: 'service'; suggestion: LookupSuggestion }
    | { row: 'postcode'; postcode: string }
  > = [
    ...services.clients.map((suggestion) => ({ row: 'service' as const, suggestion })),
    ...suggestions.map((suggestion) => ({ row: 'address' as const, suggestion })),
    ...services.broadband.map((suggestion) => ({ row: 'service' as const, suggestion })),
    ...services.mobile.map((suggestion) => ({ row: 'service' as const, suggestion })),
    ...postcodes.map((postcode) => ({ row: 'postcode' as const, postcode })),
  ];

  /** Where each group starts, so a row knows its own index. */
  const offset = {
    client: 0,
    address: services.clients.length,
    broadband: services.clients.length + suggestions.length,
    mobile: services.clients.length + suggestions.length + services.broadband.length,
    postcode:
      services.clients.length + suggestions.length + services.broadband.length + services.mobile.length,
  };

  const choose = (index: number): void => {
    const chosen = rows[index];
    if (!chosen) return;
    if (chosen.row === 'address') pick(chosen.suggestion);
    else if (chosen.row === 'service') {
      if (chosen.suggestion.kind === 'client') pickClient(chosen.suggestion);
      else pickService(chosen.suggestion);
    } else submit(chosen.postcode);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const total = rows.length;
    if (event.key === 'Enter') {
      event.preventDefault();
      if (open && highlight >= 0 && highlight < total) choose(highlight);

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
              else if (
                value.trim() !== submitted &&
                (suggestions.length ||
                  postcodes.length ||
                  services.clients.length ||
                  services.broadband.length ||
                  services.mobile.length)
              ) {
                setOpen(true);
              }
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
              <Label>{recent.length > 0 ? 'Recent' : 'You can type'}</Label>
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
                  : ACCEPTED.map((kind) => (
                      // Not buttons: there is no live value to prefill, and a
                      // dead example is worse than none.
                      <span key={kind} className="search__example search__example--muted">
                        {kind}
                      </span>
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

      {open &&
        (suggestions.length > 0 ||
          postcodes.length > 0 ||
          services.clients.length > 0 ||
          services.broadband.length > 0 ||
          services.mobile.length > 0 ||
          services.needsIdentifier ||
          (!value.trim() && recent.length > 0)) && (
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
                  <span className="typeahead__uprn sw-mono">{entry.postcode ?? entry.kind}</span>
                </button>
              ))}
            </>
          )}

          {services.clients.length > 0 && (
            <>
              <div className="typeahead__group">
                <Label>
                  {services.clients.length} {services.clients.length === 1 ? 'client' : 'clients'} — from our own
                  records
                </Label>
              </div>
              {services.clients.map((client, i) => (
                <ClientRow
                  key={client.id}
                  suggestion={client}
                  index={offset.client + i}
                  highlight={highlight}
                  expanded={expanded?.id === client.id}
                  onPick={pickClient}
                  onPickSite={pickSite}
                  onHover={setHighlight}
                />
              ))}
            </>
          )}

          {suggestions.length > 0 && (
            <>
              <div className="typeahead__group">
                <Label>
                  {unmatched.length > 0 ? (
                    <>
                      Nothing matched every word — closest {suggestions.length}
                    </>
                  ) : (
                    <>
                      {suggestions.length} {suggestions.length === 1 ? 'premises' : 'premises'}
                      {resolved.kind === 'postcode' ? ` at ${resolved.normalised}` : ''} — pick the exact address
                    </>
                  )}
                </Label>
              </div>
              {/*
                * The list is only as good as its heading.
                *
                * `megans richmond` returned nine Megan's in nine other towns
                * under "12 premises — pick the exact address", which is the
                * search claiming to have answered a question it had not.
                * Naming the word that came back empty makes the same list
                * useful: AddressBase has no premises at that place under that
                * name, so reach for the postcode instead.
                */}
              {unmatched.length > 0 && (
                <div className="typeahead__note">
                  No premises came back for{' '}
                  <strong>{unmatched.map((w) => `“${w}”`).join(' or ')}</strong>. AddressBase may not carry the
                  trading name at that address yet — try the postcode.
                </div>
              )}
              {suggestions.map((s, i) => (
                <button
                  key={s.id}
                  type="button"
                  className="typeahead__item"
                  role="option"
                  aria-selected={highlight === offset.address + i}
                  onClick={() => pick(s)}
                  onMouseEnter={() => setHighlight(offset.address + i)}
                >
                  <LookupIcon kind="address" />
                  <span className="typeahead__kind">{KIND_LABEL.address}</span>
                  <span className="typeahead__label">{s.label}</span>
                  {/* The postcode, not the UPRN. A UPRN identifies a premises
                      to a database; a postcode identifies it to a person. */}
                  <span className="typeahead__uprn sw-mono">{s.postcode || s.postTown}</span>
                </button>
              ))}
            </>
          )}

          {services.broadband.length > 0 && (
            <>
              <div className="typeahead__group">
                <Label>
                  {services.broadband.length} broadband{' '}
                  {services.broadband.length === 1 ? 'service' : 'services'}
                </Label>
              </div>
              {services.broadband.map((s, i) => (
                <ServiceRow
                  key={s.id}
                  suggestion={s}
                  index={offset.broadband + i}
                  highlight={highlight}
                  onPick={pickService}
                  onHover={setHighlight}
                />
              ))}
            </>
          )}

          {services.mobile.length > 0 && (
            <>
              <div className="typeahead__group">
                <Label>
                  {services.mobile.length} {services.mobile.length === 1 ? 'mobile' : 'mobiles'}
                </Label>
              </div>
              {services.mobile.map((s, i) => (
                <ServiceRow
                  key={s.id}
                  suggestion={s}
                  index={offset.mobile + i}
                  highlight={highlight}
                  onPick={pickService}
                  onHover={setHighlight}
                />
              ))}
            </>
          )}

          {/*
            * Said out loud, because "no circuits" and "circuits cannot be
            * searched by name" are different answers and only one of them is
            * about the customer. The suppliers' service searches match a
            * reference, a postcode or a number — not a name.
            */}
          {services.needsIdentifier && (
            <div className="typeahead__note">
              Broadband cannot be searched by name — suppliers only match a postcode, a service reference or a
              phone number. Mobiles and premises above are searchable by name.
            </div>
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
                  aria-selected={highlight === offset.postcode + i}
                  onClick={() => {
                    setValue(pc);
                    submit(pc);
                  }}
                  onMouseEnter={() => setHighlight(offset.postcode + i)}
                >
                  <LookupIcon kind="address" />
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

/**
 * One broadband or mobile row.
 *
 * The kind is written next to the icon rather than left to it. An icon is a
 * shortcut for somebody who can see it and nothing at all otherwise, and
 * "globe" versus "handset" is not a distinction worth betting a lookup on.
 */
function ServiceRow({
  suggestion,
  index,
  highlight,
  onPick,
  onHover,
}: {
  suggestion: LookupSuggestion;
  index: number;
  highlight: number;
  onPick: (suggestion: LookupSuggestion) => void;
  onHover: (index: number) => void;
}): ReactElement {
  return (
    <button
      type="button"
      className="typeahead__item"
      role="option"
      aria-selected={highlight === index}
      onClick={() => onPick(suggestion)}
      onMouseEnter={() => onHover(index)}
    >
      <LookupIcon kind={suggestion.kind} />
      <span className="typeahead__kind">{KIND_LABEL[suggestion.kind]}</span>
      <span className="typeahead__label">
        {suggestion.label}
        {suggestion.detail && (
          <span className="muted" style={{ display: 'block', fontSize: 11.5 }}>
            {suggestion.detail}
          </span>
        )}
      </span>
      <span className="typeahead__uprn sw-mono">{suggestion.postcode || suggestion.source}</span>
    </button>
  );
}

/**
 * A client from our own index, and its sites.
 *
 * The row that makes a name useful. The suppliers cannot be searched by
 * customer name, so picking a client substitutes the UPRN or postcode behind
 * one of their sites — which they can. One site goes straight through; more
 * than one expands, because a company with twenty shops has twenty answers.
 */
function ClientRow({
  suggestion,
  index,
  highlight,
  expanded,
  onPick,
  onPickSite,
  onHover,
}: {
  suggestion: LookupSuggestion;
  index: number;
  highlight: number;
  expanded: boolean;
  onPick: (suggestion: LookupSuggestion) => void;
  onPickSite: (site: { name: string; postcode?: string; uprn?: string }) => void;
  onHover: (index: number) => void;
}): ReactElement {
  const sites = suggestion.sites ?? [];

  return (
    <>
      <button
        type="button"
        className="typeahead__item"
        role="option"
        aria-selected={highlight === index}
        aria-expanded={sites.length > 1 ? expanded : undefined}
        onClick={() => onPick(suggestion)}
        onMouseEnter={() => onHover(index)}
      >
        <LookupIcon kind="client" />
        <span className="typeahead__kind">{KIND_LABEL.client}</span>
        <span className="typeahead__label">
          {suggestion.label}
          <span className="muted" style={{ display: 'block', fontSize: 11.5 }}>
            {suggestion.detail}
            {suggestion.knownFrom?.length ? ` · known from ${suggestion.knownFrom.join(', ')}` : ''}
          </span>
        </span>
        <span className="typeahead__uprn sw-mono">{sites.length > 1 ? (expanded ? 'hide' : 'pick a site') : ''}</span>
      </button>

      {expanded &&
        sites.map((site) => (
          <button
            key={`${suggestion.id}:${site.uprn ?? site.postcode ?? site.name}`}
            type="button"
            className="typeahead__item typeahead__item--nested"
            onClick={() => onPickSite(site)}
          >
            <LookupIcon kind="address" />
            <span className="typeahead__label">
              {site.name}
              {site.address && (
                <span className="muted" style={{ display: 'block', fontSize: 11.5 }}>
                  {site.address}
                </span>
              )}
            </span>
            <span className="typeahead__uprn sw-mono">{site.postcode ?? (site.uprn ? 'UPRN' : '')}</span>
          </button>
        ))}

      {expanded && sites.length === 0 && (
        <div className="typeahead__note">
          We know this client but not where they are yet. Look up one of their premises by postcode once, and it
          will be here next time.
        </div>
      )}
    </>
  );
}
