import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  LATENCY_BAD_MS,
  ispIdentity,
  ispMonogram,
  ispFor,
  ispContactKey,
  hasUsableContact,
  latencyVerdict,
  lossVerdict,
  matchLineToWan,
  reconcileWans,
  wanLabel,
  wanLinesFrom,
  wanVerdict,
  type WanLine,
  type WanHealth,
} from './index';

/* ---- Recognising a provider ------------------------------------------ */

test('a provider we know is named and coloured; one we do not is passed through', () => {
  // "Elevate" is not in any list worth shipping. The honest answer is the
  // name the console reported.
  const known = ispIdentity('Virgin Media Business');
  assert.equal(known.name, 'Virgin Media');
  assert.equal(known.known, true);

  const unknown = ispIdentity('Elevate');
  assert.equal(unknown.name, 'Elevate');
  assert.equal(unknown.known, false);
  assert.equal(unknown.monogram, 'EL');
});

test('short provider names are matched as whole words, not substrings', () => {
  // The trap this codebase has fallen into before: '3' inside 'EE 3G',
  // 'o2' inside 'moto2', 'bt' inside 'debt', 'sky' inside 'Skyline'.
  assert.equal(ispFor('Skyline Networks')?.key, undefined);
  assert.equal(ispFor('Debt Recovery Ltd')?.key, undefined);
  assert.equal(ispFor('Moto2 Systems')?.key, undefined);
  assert.equal(ispFor('Sky')?.key, 'sky');
  assert.equal(ispFor('BT')?.key, 'bt');
});

test('the longest matching alias wins', () => {
  // Otherwise "BT Wholesale" reads as BT and the engineer rings the wrong desk.
  assert.equal(ispFor('BT Wholesale')?.key, 'openreach');
  assert.equal(ispFor('Virgin Media Business')?.key, 'virgin-media');
});

test('a monogram skips the words that carry no meaning', () => {
  assert.equal(ispMonogram('Community Fibre'), 'CF');
  assert.equal(ispMonogram('G.Network'), 'GN');
  assert.equal(ispMonogram('Gamma Telecom'), 'GA');
  assert.equal(ispMonogram('Elevate'), 'EL');
});

test('no provider reported is said rather than left blank', () => {
  assert.equal(ispIdentity(undefined).name, 'Provider not reported');
  assert.equal(ispIdentity('   ').known, false);
});

/* ---- Contacts are entered, never guessed ----------------------------- */

test('a contact with nothing in it is not a contact', () => {
  // A row that looks fillable and is empty wastes the ten minutes when it
  // matters. A wrong support number wastes more.
  assert.equal(hasUsableContact(undefined), false);
  assert.equal(hasUsableContact({ key: 'elevate' }), false);
  assert.equal(hasUsableContact({ key: 'elevate', notes: 'ask Sam' }), false);
  assert.equal(hasUsableContact({ key: 'elevate', supportPhone: '0800 000 0000' }), true);
});

test('an unknown provider gets a stable key so its details survive a rename', () => {
  assert.equal(ispContactKey('Elevate'), 'elevate');
  assert.equal(ispContactKey('G.Network'), 'g-network');
  assert.equal(ispContactKey('Virgin Media Business'), 'virgin-media');
  assert.equal(ispContactKey(''), 'unknown');
});

/* ---- Labels ---------------------------------------------------------- */

test('a numbered uplink is numbered and an unnumbered one is not', () => {
  assert.equal(wanLabel('wan1'), 'WAN 1');
  assert.equal(wanLabel('wan_2'), 'WAN 2');
  assert.equal(wanLabel('wan'), 'WAN');
});

/* ---- Building the rows ----------------------------------------------- */

const health = (over: Partial<WanHealth> = {}): WanHealth => ({
  siteId: 's1',
  interval: '5m',
  samples: [],
  downtimeSeconds: 0,
  ...over,
});

test('a site with two reported uplinks gets two rows, each with its own numbers', () => {
  const rows = wanLinesFrom({
    uplinks: [
      { id: 'wan1', ispName: 'Elevate', uptimePercent: 100, averageLatencyMs: 12 },
      { id: 'wan2', ispName: 'Virgin Media', uptimePercent: 0, averageLatencyMs: 0 },
    ],
  });
  assert.deepEqual(rows.map((r) => r.label), ['WAN 1', 'WAN 2']);
  assert.equal(rows[0]?.providerName, 'Elevate');
  assert.equal(rows[1]?.providerName, 'Virgin Media');
  assert.equal(wanVerdict(rows[1]!.stats), 'bad');
});

test('one set of aggregate numbers is one row called WAN, not WAN 1', () => {
  // A site with two uplinks and one set of numbers must not read as though
  // the numbers belong to the first one. That is a fabricated split.
  const rows = wanLinesFrom({
    site: { isp: { name: 'Elevate' }, counts: { wanConfigurations: 2 } },
    health: health({ latest: { uptimePercent: 100, averageLatencyMs: 11 } }),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.label, 'WAN');
  assert.equal(rows[0]?.providerName, 'Elevate');
});

test('a WAN row is always marked unmanaged and never carries a service reference', () => {
  // There is nothing behind a fault button on a line we do not supply, and
  // offering one wastes the ten minutes when it matters most.
  const rows = wanLinesFrom({ uplinks: [{ id: 'wan1', ispName: 'Elevate' }] });
  assert.equal(rows[0]?.management, 'unmanaged');
  assert.equal(rows[0]?.serviceReference, undefined);
});

test('nothing to report produces no rows rather than an empty one', () => {
  assert.deepEqual(wanLinesFrom({}), []);
  assert.deepEqual(wanLinesFrom({ site: {} }), []);
});

test('the stability count comes from the samples, not from the latest one', () => {
  const rows = wanLinesFrom({
    site: { isp: { name: 'Elevate' } },
    health: health({
      latest: { uptimePercent: 100 },
      samples: [{ uptimePercent: 100 }, { uptimePercent: 40 }, { uptimePercent: 100 }, { uptimePercent: 0 }],
    }),
  });
  assert.equal(rows[0]?.stats.sampleCount, 4);
  assert.equal(rows[0]?.stats.unstableSamples, 2, 'a line at 100% right now can still have had a bad day');
});

/* ---- Grading --------------------------------------------------------- */

test('latency and loss are graded so nobody has to remember what good looks like', () => {
  assert.equal(latencyVerdict(12), 'good');
  assert.equal(latencyVerdict(55), 'warn');
  assert.equal(latencyVerdict(LATENCY_BAD_MS), 'bad');
  assert.equal(latencyVerdict(undefined), 'unknown');
  assert.equal(lossVerdict(0), 'good');
  assert.equal(lossVerdict(2), 'warn');
  assert.equal(lossVerdict(7), 'bad');
});

test('a row takes the worst of its measures, and unmeasured is not good', () => {
  assert.equal(wanVerdict({ uptimePercent: 100, averageLatencyMs: 120 }), 'bad');
  assert.equal(wanVerdict({ uptimePercent: 100, packetLossPercent: 2 }), 'warn');
  assert.equal(wanVerdict({}), 'unknown');
});

/* ---- Matching our own lines to a WAN slot ---------------------------- */

const wan = (id: string, providerName: string, publicIp?: string): WanLine => ({
  id,
  label: wanLabel(id),
  management: 'unmanaged',
  providerName,
  providerColour: '#000',
  providerMonogram: 'XX',
  providerKnown: true,
  ...(publicIp ? { publicIp } : {}),
  stats: {},
});

test('a matching public address is conclusive', () => {
  const result = matchLineToWan({ provider: 'Elevate', publicIp: '81.2.3.4' }, [
    wan('wan1', 'Zen Internet', '81.2.3.4'),
    wan('wan2', 'Elevate', '90.1.2.3'),
  ]);
  assert.equal(result?.wan.id, 'wan1');
  assert.equal(result?.matchedBy, 'ip', 'the address beats the provider name');
});

test('a single WAN on our provider is that WAN', () => {
  const result = matchLineToWan({ provider: 'Zen' }, [wan('wan1', 'Zen Internet'), wan('wan2', 'Elevate')]);
  assert.equal(result?.wan.id, 'wan1');
  assert.equal(result?.matchedBy, 'provider');
});

test('two WANs on the same provider is honestly unmatchable', () => {
  // "It is one of these two" printed as though it were an answer sends
  // somebody to unplug the working line.
  assert.equal(matchLineToWan({ provider: 'Zen' }, [wan('wan1', 'Zen Internet'), wan('wan2', 'Zen Internet')]), undefined);
});

test('a single WAN is the line even when the provider names disagree', () => {
  // Console ISP names are whatever the upstream ASN is called, which is
  // often a wholesaler rather than who we buy from.
  const result = matchLineToWan({ provider: 'Zen' }, [wan('wan', 'Openreach')]);
  assert.equal(result?.matchedBy, 'only-wan');
});

test('no WANs means no match rather than a guess', () => {
  assert.equal(matchLineToWan({ provider: 'Zen' }, []), undefined);
});

/* ---- Reconciling the two lists --------------------------------------- */

test('a WAN matched to one of our lines is not also listed as unmanaged', () => {
  // Two rows for one connection is how somebody raises a fault on a circuit
  // they have already raised a fault on.
  const { unmanaged, matched } = reconcileWans(
    [{ id: 'line-1', provider: 'Zen', serviceId: 'ZEN123456' }],
    [wan('wan1', 'Zen Internet'), wan('wan2', 'Elevate')],
  );
  assert.deepEqual(unmanaged.map((w) => w.id), ['wan2']);
  assert.equal(matched.get('line-1')?.wan.id, 'wan1');
  assert.equal(matched.get('line-1')?.matchedBy, 'provider');
});

test('a conclusive match claims its WAN before a weaker one can', () => {
  // Without the ordering, whichever line happens to be first would take the
  // only WAN by `only-wan` and the address match would find nothing left.
  const { matched } = reconcileWans(
    [
      { id: 'guess', provider: 'Elevate' },
      { id: 'certain', provider: 'Zen', publicIp: '81.2.3.4' },
    ],
    [wan('wan1', 'Zen Internet', '81.2.3.4'), wan('wan2', 'Elevate')],
  );
  assert.equal(matched.get('certain')?.wan.id, 'wan1');
  assert.equal(matched.get('certain')?.matchedBy, 'ip');
  assert.equal(matched.get('guess')?.wan.id, 'wan2');
});

test('every WAN is unmanaged when we supply nothing here', () => {
  const { unmanaged, matched } = reconcileWans([], [wan('wan1', 'Elevate'), wan('wan2', 'Sky')]);
  assert.equal(unmanaged.length, 2);
  assert.equal(matched.size, 0);
});

test('filtering never leaves a one-letter mark when the name has more to give', () => {
  // `G.Network` filtered down to `G`, which reads as a rendering bug rather
  // than as a brand. `Gamma Telecom` filtering to `Gamma` is right.
  assert.equal(ispMonogram('G.Network'), 'GN');
  assert.equal(ispMonogram('Gamma Telecom'), 'GA');
  assert.equal(ispMonogram('The Networks Group'), 'TN');
  assert.equal(ispMonogram('X'), 'X');
});
