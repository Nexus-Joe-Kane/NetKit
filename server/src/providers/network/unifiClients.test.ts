import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toClient } from './unifiClients';

const named = new Map([
  ['aa:bb:cc:dd:ee:ff', 'Back Office Switch'],
  ['dev-ap-1', 'Front AP'],
]);

/* ---- The connection type is decided from evidence ------------------- */

test('an SSID or a signal reading means wireless', () => {
  assert.equal(toClient({ mac: '11:22:33:44:55:66', ssid: 'MarketHalls-Staff' }, named)?.connection, 'wireless');
  assert.equal(toClient({ mac: '11:22:33:44:55:66', rssi: -62 }, named)?.connection, 'wireless');
});

test('a switch port means wired', () => {
  assert.equal(toClient({ mac: '11:22:33:44:55:66', switchPort: 14 }, named)?.connection, 'wired');
});

test('no evidence either way is unknown, not wired', () => {
  // Defaulting to wired would file every phone in the building under a
  // switch nobody can find.
  assert.equal(toClient({ mac: '11:22:33:44:55:66' }, named)?.connection, 'unknown');
});

test('the console’s own type field is read where it gives one', () => {
  assert.equal(toClient({ mac: '11:22:33:44:55:66', type: 'WIRED' }, named)?.connection, 'wired');
  assert.equal(toClient({ mac: '11:22:33:44:55:66', connectionType: 'wireless' }, named)?.connection, 'wireless');
});

/* ---- Where it is plugged in ----------------------------------------- */

test('the uplink is named from the device list, by id or by MAC', () => {
  // Which one the client payload carries varies by firmware, so both are
  // looked up.
  const byMac = toClient({ mac: '11:22:33:44:55:66', switchPort: 14, swMac: 'AA:BB:CC:DD:EE:FF' }, named);
  assert.equal(byMac?.via?.deviceName, 'Back Office Switch');
  assert.equal(byMac?.via?.port, 14);

  const byId = toClient({ mac: '11:22:33:44:55:66', ssid: 'Staff', uplinkDeviceId: 'dev-ap-1' }, named);
  assert.equal(byId?.via?.deviceName, 'Front AP');
});

test('an uplink we cannot name keeps its id rather than losing it', () => {
  const client = toClient({ mac: '11:22:33:44:55:66', switchPort: 2, swMac: 'ZZ:ZZ:ZZ:ZZ:ZZ:ZZ' }, named);
  assert.equal(client?.via?.deviceName, undefined);
  assert.equal(client?.via?.deviceId, 'ZZ:ZZ:ZZ:ZZ:ZZ:ZZ');
});

/* ---- Tolerance ------------------------------------------------------ */

test('a row with neither an id nor a MAC is not a client', () => {
  assert.equal(toClient({ ip: '10.0.0.5' }, named), null);
  assert.equal(toClient(null, named), null);
  assert.equal(toClient('nonsense', named), null);
});

test('a MAC alone is enough, and becomes the id', () => {
  const client = toClient({ mac: '11:22:33:44:55:66' }, named);
  assert.equal(client?.id, '11:22:33:44:55:66');
});

test('the vendor is resolved from the MAC where we know the prefix', () => {
  assert.equal(toClient({ mac: '24:5a:4c:11:22:33', switchPort: 1 }, named)?.vendor, 'Ubiquiti');
  assert.equal(toClient({ mac: 'ff:ff:ff:11:22:33', switchPort: 1 }, named)?.vendor, undefined);
});

test('the alternate field names each firmware uses are all read', () => {
  const client = toClient(
    {
      _id: 'c1',
      macAddress: '11:22:33:44:55:66',
      displayName: 'Till 3',
      lastIp: '10.0.0.42',
      portIdx: 14,
      connectedFor: 86_400,
      isGuest: true,
    },
    named,
  );
  assert.equal(client?.id, 'c1');
  assert.equal(client?.name, 'Till 3');
  assert.equal(client?.ip, '10.0.0.42');
  assert.equal(client?.via?.port, 14);
  assert.equal(client?.uptimeSeconds, 86_400);
  assert.equal(client?.guest, true);
});

test('an empty string is treated as absent rather than as a value', () => {
  // Ubiquiti send `""` for fields they have nothing for, and a client named
  // empty-string renders as a blank row somebody has to click to identify.
  const client = toClient({ mac: '11:22:33:44:55:66', name: '', hostname: 'till-3', switchPort: 1 }, named);
  assert.equal(client?.name, undefined);
  assert.equal(client?.hostname, 'till-3');
});
