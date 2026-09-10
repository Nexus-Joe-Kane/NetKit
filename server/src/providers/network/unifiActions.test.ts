import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consoleLinks, unifiActionsConfigured, unifiActionsUnavailableReason, restartDevice, powerCyclePort } from './unifiActions';
import { resetConfig } from '../../config';

const withoutKey = <T>(run: () => T): T => {
  const before = process.env.UNIFI_INTEGRATION_KEY;
  delete process.env.UNIFI_INTEGRATION_KEY;
  resetConfig();
  try {
    return run();
  } finally {
    if (before === undefined) delete process.env.UNIFI_INTEGRATION_KEY;
    else process.env.UNIFI_INTEGRATION_KEY = before;
    resetConfig();
  }
};

/* ---- The two keys are different, and the error has to say so --------- */

test('without an integration key nothing can be restarted, and the reason names the key', async () => {
  // The failure this guards against is an engineer seeing "403" and
  // concluding the portal is broken. It is not: the Site Manager key they
  // pasted is read-only by Ubiquiti's own design, and a second key exists.
  await withoutKey(async () => {
    assert.equal(unifiActionsConfigured(), false);
    const reason = unifiActionsUnavailableReason();
    assert.match(reason ?? '', /different key/i);
    assert.match(reason ?? '', /Control Plane/);
    assert.match(reason ?? '', /5\.0\.3/, 'the firmware requirement is part of the answer');
  });
});

test('an action attempted without the key fails politely rather than throwing', async () => {
  await withoutKey(async () => {
    const restart = await restartDevice({ consoleId: 'c1', siteId: 's1', deviceId: 'd1' });
    assert.equal(restart.ok, false);
    assert.match(restart.detail, /Integration key/i);

    const port = await powerCyclePort({ consoleId: 'c1', siteId: 's1', deviceId: 'd1', portIndex: 4 });
    assert.equal(port.ok, false);
    assert.match(port.detail, /Integration key/i);
  });
});

/* ---- What we deliberately do not do --------------------------------- */

test('the things the API cannot do are links, with the reason attached', () => {
  // A button that silently does nothing is worse than a link that works.
  const links = consoleLinks({ consoleId: 'c1', siteId: 's1' });
  const speed = links.find((l) => /speed test/i.test(l.label));
  assert.ok(speed, 'a speed test has to go somewhere');
  assert.match(speed!.url, /^https:\/\/unifi\.ui\.com\//);
  assert.match(speed!.why, /no speed-test endpoint/i);

  const wan = links.find((l) => /WAN and DNS/i.test(l.label));
  assert.ok(wan);
  assert.match(wan!.why, /not in the documented API/i);
});

test('a device link only appears when there is a device to link to', () => {
  assert.equal(consoleLinks({ consoleId: 'c1', siteId: 's1' }).some((l) => /this device/i.test(l.label)), false);
  assert.equal(
    consoleLinks({ consoleId: 'c1', siteId: 's1', deviceId: 'd1' }).some((l) => /this device/i.test(l.label)),
    true,
  );
});

test('with no console known the links still go somewhere real', () => {
  // Better the account root than a URL with "undefined" in it.
  for (const link of consoleLinks({})) {
    assert.doesNotMatch(link.url, /undefined/);
    assert.match(link.url, /^https:\/\/unifi\.ui\.com/);
  }
});

test('ids are escaped into the URL rather than concatenated', () => {
  const [first] = consoleLinks({ consoleId: 'a/b c', siteId: 's 1' });
  assert.doesNotMatch(first!.url, / /);
  assert.match(first!.url, /a%2Fb%20c/);
});

/* ---- Two roads to the same action ---------------------------------- */

test('a console address and its own key are enough on their own', () => {
  // The point of the local road: an estate with a reachable console does not
  // need Ubiquiti's cloud, its firmware requirement, or a console id.
  const before = { ...process.env };
  delete process.env.UNIFI_INTEGRATION_KEY;
  process.env.UNIFI_CONTROLLER_URL = 'https://192.168.1.1';
  process.env.UNIFI_CONTROLLER_API_KEY = 'console-key';
  resetConfig();
  try {
    assert.equal(unifiActionsConfigured(), true);
    assert.equal(unifiActionsUnavailableReason(), undefined);
  } finally {
    process.env = before;
    resetConfig();
  }
});

test('the Site Manager address pasted as the console address is refused, not silently used', () => {
  // Otherwise every "local" call goes to Ubiquiti while the status panel
  // says the connection is direct.
  const before = { ...process.env };
  delete process.env.UNIFI_INTEGRATION_KEY;
  process.env.UNIFI_CONTROLLER_URL = 'https://unifi.ui.com/consoles/fc86acb6-6dfa-4e61-8f5a-e8fba0456986';
  process.env.UNIFI_CONTROLLER_API_KEY = 'console-key';
  resetConfig();
  try {
    assert.equal(unifiActionsConfigured(), false, 'a cloud address is not a console address');
  } finally {
    process.env = before;
    resetConfig();
  }
});
