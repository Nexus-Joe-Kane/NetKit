import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __giacomTesting } from './adapters';

const { mapService, lineStatusFrom, technologyFromName, operatorFromSupplier, statusFromQualification, characteristic } =
  __giacomTesting;

/**
 * Giacom's API is TM Forum shaped, which means the interesting fields sit
 * inside `serviceCharacteristic: [{name, value}]` rather than at the top
 * level. These tests pin that reading, and the enum mappings that would
 * otherwise be silent guesses.
 */

test('characteristics are read out of the TMF name/value array', () => {
  const service = {
    serviceCharacteristic: [
      { name: 'phoneNumber', value: '01614969790' },
      { name: 'downstreamSpeed', value: 80 },
      { name: 'supplier', value: 'CityFibre' },
    ],
  };
  assert.equal(characteristic(service, 'phoneNumber'), '01614969790');
  assert.equal(characteristic(service, 'downstreamSpeed'), '80');
  assert.equal(characteristic(service, 'supplier'), 'CityFibre');
  assert.equal(characteristic(service, 'notThere'), undefined);
});

test('a nested {value:{value}} characteristic is unwrapped', () => {
  // Common in TMF payloads and easy to miss.
  const service = { characteristic: [{ name: 'careLevel', value: { value: 'Care Level 2' } }] };
  assert.equal(characteristic(service, 'careLevel'), 'Care Level 2');
});

test('a service maps to a line with its supplier named', () => {
  const line = mapService({
    id: 'SVC-00123',
    name: 'SOGEA 80/20',
    state: 'active',
    serviceCharacteristic: [
      { name: 'phoneNumber', value: '01614969790' },
      { name: 'supplier', value: 'CityFibre' },
      { name: 'downstreamSpeed', value: 80 },
      { name: 'upstreamSpeed', value: 20 },
      { name: 'ipAddress', value: '51.148.22.9' },
    ],
  });
  assert.ok(line);
  assert.equal(line.id, 'SVC-00123');
  assert.equal(line.cli, '01614969790');
  assert.equal(line.status, 'active');
  assert.equal(line.technology, 'SOGEA');
  // Naming the supplier is the point: it says who to ring about the line.
  assert.equal(line.provider, 'Giacom (CityFibre)');
  assert.equal(line.discoveredVia, 'giacom');
  assert.equal(line.sync?.downstreamSyncKbps, 80_000);
  assert.equal(line.sync?.upstreamSyncKbps, 20_000);
  assert.deepEqual(line.ipAddresses, [{ family: 'IPv4', value: '51.148.22.9', assignment: 'static' }]);
});

test('a line says why it has no test button', () => {
  // Giacom publish no diagnostics endpoint, and someone will go looking.
  const line = mapService({ id: 'SVC-1', state: 'active' });
  assert.ok(line?.notes.some((n) => /no fault or diagnostics API/i.test(n)));
});

test('a service with no id is dropped rather than half-rendered', () => {
  assert.equal(mapService({ state: 'active' }), null);
  assert.equal(mapService(null), null);
});

test('TMF lifecycle states map to line status without guessing', () => {
  assert.equal(lineStatusFrom({ state: 'active' }), 'active');
  assert.equal(lineStatusFrom({ state: 'terminated' }), 'ceased');
  assert.equal(lineStatusFrom({ state: 'inactive' }), 'ceased');
  assert.equal(lineStatusFrom({ state: 'suspended' }), 'suspended');
  assert.equal(lineStatusFrom({ state: 'pendingActive' }), 'pending_provide');
  assert.equal(lineStatusFrom({ state: 'feasibilityChecked' }), 'pending_provide');
  // An unrecognised state must not be optimistically called active.
  assert.equal(lineStatusFrom({ state: 'somethingNew' }), 'unknown');
  assert.equal(lineStatusFrom({}), 'unknown');
});

test('technology is read from the product name', () => {
  assert.equal(technologyFromName('SOGEA 80/20'), 'SOGEA');
  assert.equal(technologyFromName('GEA-FTTP 900'), 'FTTP');
  assert.equal(technologyFromName('XGS-PON 2000'), 'XGS-PON');
  assert.equal(technologyFromName('SOADSL'), 'ADSL2+');
  assert.equal(technologyFromName('EoFTTC 100'), 'EoFTTC');
  assert.equal(technologyFromName('EAD 1000'), 'EAD');
  assert.equal(technologyFromName('Something unfamiliar'), 'Unknown');
  // The substring traps, pinned so the ordering cannot regress.
  assert.equal(technologyFromName('EoFTTC 100'), 'EoFTTC', 'EoFTTC contains FTTC');
  assert.equal(technologyFromName('SOGfast 160'), 'SOGFAST', 'SOGFAST contains SOGEA-ish text');
});

test('the supplier decides the operator, not the brand selling it', () => {
  // BT Wholesale, TalkTalk and Sky all ride Openreach — the network is
  // Openreach and the supplier is only the commercial route.
  assert.equal(operatorFromSupplier('BT Wholesale').operator, 'openreach');
  assert.equal(operatorFromSupplier('TalkTalk Business').operator, 'openreach');
  assert.equal(operatorFromSupplier('Sky Business').operator, 'openreach');
  assert.equal(operatorFromSupplier('CityFibre').operator, 'cityfibre');
  assert.equal(operatorFromSupplier('Virgin Media Business').operator, 'virgin-media');
  assert.equal(operatorFromSupplier('nexfibre').operator, 'virgin-media');
});

test('qualification results are read conservatively', () => {
  assert.equal(statusFromQualification({ state: 'qualified' }), 'available');
  assert.equal(statusFromQualification({ state: 'done' }), 'available');
  assert.equal(statusFromQualification({ state: 'unqualified' }), 'not_available');
  assert.equal(statusFromQualification({ state: 'rejected' }), 'not_available');
  assert.equal(statusFromQualification({ state: 'conditional' }), 'on_demand');
  // Silence is not a yes.
  assert.equal(statusFromQualification({}), 'unknown');
});
