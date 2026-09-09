import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  clientLocation,
  clientMark,
  deviceKind,
  deviceKindLabel,
  deviceKindMark,
  needsExtraCare,
  restartImpact,
  sortClients,
  vendorForMac,
  type NetworkClient,
} from './index';

/* ---- What a device is ------------------------------------------------ */

test('the console saying it is a console beats any pattern', () => {
  assert.equal(deviceKind({ isConsole: true, model: 'Cloud Key Gen2' }), 'gateway');
});

test('both of Ubiquiti’s naming conventions are recognised', () => {
  // Two conventions, and this is what makes it fiddlier than it looks: the
  // console's `shortModel` is concatenated (`UDMPROSE`) while `model` is
  // hyphenated (`USW-Pro-Max-24-PoE`). A pattern closed with a word
  // boundary matches the second and never the first.
  const cases: Array<[string, string]> = [
    ['UDMPROSE', 'gateway'],
    ['UXGPRO', 'gateway'],
    ['USW-Pro-Max-24-PoE', 'switch'],
    ['US-24-250W', 'switch'],
    ['U6-Enterprise-IW', 'access-point'],
    ['U7-Pro', 'access-point'],
    ['UNVR-Pro', 'nvr'],
    ['UCK-G2-PLUS', 'nvr'],
    ['UA-Hub', 'door-access'],
    ['UVP-X', 'phone'],
  ];
  for (const [model, expected] of cases) {
    assert.equal(deviceKind({ shortModel: model }), expected, model);
  }
});

test('a Flex camera is not a Flex switch', () => {
  // `UVC-G3-Flex` is a camera and `USW-Flex-Mini` is a switch. A pattern
  // loose enough to catch one catches the other, which is why cameras are
  // tested first rather than in alphabetical order.
  assert.equal(deviceKind({ shortModel: 'UVC-G3-Flex' }), 'camera');
  assert.equal(deviceKind({ shortModel: 'USW-Flex-Mini' }), 'switch');
});

test('a switch is not read as a desk phone', () => {
  // `UP` (UniFi Phone) sits inside `USW-Pro`, and a switch offered the wrong
  // buttons is a switch somebody restarts thinking it drops one handset.
  assert.equal(deviceKind({ shortModel: 'USW-Pro-24' }), 'switch');
  assert.notEqual(deviceKind({ shortModel: 'USW-Pro-24' }), 'phone');
});

test('the product line classifies what the model code does not', () => {
  assert.equal(deviceKind({ productLine: 'protect', shortModel: 'MYSTERY' }), 'camera');
  assert.equal(deviceKind({ productLine: 'access', shortModel: 'MYSTERY' }), 'door-access');
});

test('the name is deliberately not used to classify', () => {
  // A device somebody called "Reception Switch" might be an access point on
  // a shelf behind reception, and the classification decides which buttons
  // appear and what warning goes with them. The signature does not accept a
  // name at all, so this cannot regress by somebody adding one line.
  assert.equal(deviceKind({}), 'other');
  assert.equal(deviceKind({ model: 'Reception Switch' }), 'other', 'and a name in the model field is not a pattern');
});

test('an unknown device is labelled and marked rather than left blank', () => {
  assert.equal(deviceKindLabel('other'), 'Device');
  assert.equal(deviceKindMark('other'), '··');
  assert.equal(deviceKindMark('access-point'), 'AP');
});

/* ---- What restarting it costs --------------------------------------- */

test('a gateway restart is an outage and says so', () => {
  const { impact, warning } = restartImpact('gateway');
  assert.equal(impact, 'site');
  assert.match(warning, /whole site/i);
  assert.match(warning, /every till/i, 'the consequence in words somebody feels');
  assert.equal(needsExtraCare('gateway'), true);
});

test('a switch restart takes the access points with it', () => {
  // The thing people forget: the Wi-Fi goes too, because the APs are
  // plugged into the switch.
  const { impact, warning } = restartImpact('switch');
  assert.equal(impact, 'segment');
  assert.match(warning, /access points included/i);
});

test('an access point restart is thirty seconds of one room', () => {
  const { impact, warning } = restartImpact('access-point');
  assert.equal(impact, 'local');
  assert.match(warning, /Wired kit is unaffected/i);
  assert.equal(needsExtraCare('access-point'), false);
});

test('an unclassifiable device is treated as needing care, not as harmless', () => {
  // Not knowing what something is, is a reason to be careful rather than a
  // reason to assume it is a light switch.
  const { impact, warning } = restartImpact('other');
  assert.equal(impact, 'unknown');
  assert.match(warning, /could not work out/i);
  assert.equal(needsExtraCare('other'), true);
});

/* ---- Who made it ---------------------------------------------------- */

test('a MAC prefix we know gives a vendor, and one we do not gives nothing', () => {
  assert.equal(vendorForMac('245a4c:11:22:33'), 'Ubiquiti');
  assert.equal(vendorForMac('AC-87-A3-11-22-33'), 'Apple');
  assert.equal(vendorForMac('805ec0112233'), 'Yealink');
  // Never a guess: the UI shows the MAC, which is what somebody would look
  // up anyway.
  assert.equal(vendorForMac('ffffff112233'), undefined);
  assert.equal(vendorForMac(undefined), undefined);
  assert.equal(vendorForMac('ab'), undefined);
});

test('a mark falls back to the connection type rather than a blank', () => {
  assert.equal(clientMark({ vendor: 'Raspberry Pi', connection: 'wired' }), 'RP');
  assert.equal(clientMark({ vendor: 'Apple', connection: 'wireless' }), 'AP');
  assert.equal(clientMark({ connection: 'wired' }), 'LAN');
  assert.equal(clientMark({ connection: 'wireless' }), 'WiFi');
  assert.equal(clientMark({ connection: 'unknown' }), '··');
});

/* ---- Where a thing is ----------------------------------------------- */

test('a wired client is located by switch and port', () => {
  // "Port 14 of the back-office switch" ends a phone call that "it is on the
  // network" does not.
  const client: NetworkClient = {
    id: 'c1',
    connection: 'wired',
    via: { deviceName: 'Back Office Switch', port: 14 },
  };
  assert.equal(clientLocation(client), 'Port 14 of Back Office Switch');
});

test('a wireless client is located by access point, SSID and band', () => {
  const client: NetworkClient = {
    id: 'c2',
    connection: 'wireless',
    via: { deviceName: 'Front AP', ssid: 'MarketHalls-Staff', band: '5 GHz' },
  };
  assert.equal(clientLocation(client), 'Front AP on MarketHalls-Staff (5 GHz)');
});

test('a client the console did not place says so rather than reading as placed', () => {
  assert.match(clientLocation({ id: 'c3', connection: 'wired' }), /device not reported/);
  assert.match(clientLocation({ id: 'c4', connection: 'wireless' }), /access point not reported/);
});

test('the list groups itself: wired first, then by device and port', () => {
  const clients: NetworkClient[] = [
    { id: 'w1', connection: 'wireless', via: { deviceName: 'Front AP' } },
    { id: 'l2', connection: 'wired', via: { deviceName: 'Back Office Switch', port: 14 } },
    { id: 'l1', connection: 'wired', via: { deviceName: 'Back Office Switch', port: 2 } },
    { id: 'u1', connection: 'unknown' },
  ];
  assert.deepEqual(sortClients(clients).map((c) => c.id), ['l1', 'l2', 'w1', 'u1']);
});
