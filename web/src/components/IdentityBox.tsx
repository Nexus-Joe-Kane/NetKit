import type { ReactElement } from 'react';
import type { AddressRecord } from '@sw/shared';
import { CopyButton, Label } from './ui';

/**
 * The identity box.
 *
 * Every screen that shows anything about a site shows this first: the full
 * address and the UPRN, both copyable. It is the fixed point the whole
 * portal is organised around.
 */
export function IdentityBox({
  address,
  uprn,
  extra,
}: {
  address: AddressRecord;
  uprn?: string;
  extra?: React.ReactNode;
}): ReactElement {
  const resolvedUprn = uprn ?? address.uprn;

  return (
    <div className="identity">
      <div className="identity__strip">
        <Label>Site identity</Label>
        <span className="muted" style={{ fontSize: 11 }}>
          {address.source === 'mock' ? 'Demo data' : `Source: ${sourceLabel(address.source)}`}
        </span>
        <span className="grow" />
        {extra}
      </div>

      <div className="identity__grid">
        <div className="identity__field">
          <Label>Full address</Label>
          <div className="identity__value identity__value--address">
            {address.singleLine}
            <CopyButton value={address.singleLine} />
          </div>
        </div>

        <div className="identity__field">
          <Label>UPRN</Label>
          <div className={`identity__value identity__value--uprn${resolvedUprn ? '' : ' kv__value--absent'}`}>
            {resolvedUprn ?? 'Not available'}
            {resolvedUprn && <CopyButton value={resolvedUprn} />}
          </div>
        </div>

        <div className="identity__field">
          <Label>Postcode</Label>
          <div className="identity__value sw-mono">
            {address.postcode}
            <CopyButton value={address.postcode} />
          </div>
        </div>

        <div className="identity__field">
          <Label>Premises type</Label>
          <div className="identity__value">
            {address.classificationLabel ?? titleCase(address.premisesType ?? 'unknown')}
            {address.classificationCode && (
              <span className="muted sw-mono" style={{ fontSize: 12 }}> · {address.classificationCode}</span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function sourceLabel(source: AddressRecord['source']): string {
  switch (source) {
    case 'os-places':
      return 'OS Places';
    case 'zen':
      return 'Zen';
    case 'openreach':
      return 'Openreach';
    case 'postcodes.io':
      return 'postcodes.io';
    case 'cache':
      return 'cache';
    default:
      return source;
  }
}

const titleCase = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);
