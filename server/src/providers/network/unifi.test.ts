import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { __unifiTesting } from './unifi';

const { toSite, toDevice } = __unifiTesting;

test('a site with no meta or statistics maps rather than throwing', () => {
  // Ubiquiti document both as varying by UniFi OS version, so their absence
  // is a normal case and not an error.
  const site = toSite({ siteId: 's1', hostId: 'h1' });
  assert.equal(site?.siteId, 's1');
  assert.equal(site?.name, 's1', 'the id stands in for a name we do not have');
  assert.deepEqual(site?.counts, {});
  assert.equal(site?.wanUptimePercent, undefined);
  assert.equal(site?.internetIssues, undefined, 'unknown is not the same as fine');
});

test('a site with no id is dropped, because nothing can be asked about it', () => {
  assert.equal(toSite({ hostId: 'h1' }), null);
  assert.equal(toSite({ siteId: 's1' }), null, 'no host id means no way to fetch its devices');
});

test('the friendlier of the two site names leads', () => {
  const site = toSite({ siteId: 's1', hostId: 'h1', meta: { name: 'default', desc: 'Default' } });
  assert.equal(site?.name, 'Default');
  assert.equal(site?.description, 'default');
});

test('an empty internet-issues array means no issues, and a missing one means unknown', () => {
  assert.equal(toSite({ siteId: 's', hostId: 'h', statistics: { internetIssues: [] } })?.internetIssues, false);
  assert.equal(toSite({ siteId: 's', hostId: 'h', statistics: {} })?.internetIssues, undefined);
  assert.equal(toSite({ siteId: 's', hostId: 'h', statistics: { internetIssues: [{}] } })?.internetIssues, true);
});

test('a device falls back to its MAC for an id and its model for a name', () => {
  const device = toDevice({ mac: 'F4E2C6C23F13', model: 'UDM SE' });
  assert.equal(device?.id, 'F4E2C6C23F13');
  assert.equal(device?.name, 'UDM SE');
});

test('nulls in a device record are dropped, not rendered', () => {
  // Every one of these is null in Ubiquiti's own documented example.
  const device = toDevice({
    id: 'x',
    name: 'AP',
    updateAvailable: null,
    adoptionTime: null,
    note: null,
    startupTime: null,
  });
  assert.equal(device?.updateAvailable, undefined);
  assert.equal(device?.adoptedAt, undefined);
  assert.equal(device?.note, undefined);
  assert.equal(device?.startedAt, undefined);
});

test('false flags are omitted rather than stored as false', () => {
  const device = toDevice({ id: 'x', name: 'AP', isConsole: false, isManaged: false });
  assert.equal(device?.isConsole, undefined);
  assert.equal(device?.isManaged, undefined);
});
