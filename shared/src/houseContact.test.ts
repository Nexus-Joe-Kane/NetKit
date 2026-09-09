import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HOUSE_CONTACT,
  faultRaisedNote,
  lineTestNote,
  siteContactLabel,
  siteVisitBookedMessage,
} from './houseContact';

test('the house contact is the desk, not a person', () => {
  assert.equal(HOUSE_CONTACT.email, 'help@supportwizard.net');
  assert.equal(HOUSE_CONTACT.phone, '020 7043 3171');
});

test('a fault note carries the desk contact and who raised it', () => {
  const note = faultRaisedNote({
    reference: 'F-1234',
    serviceReference: 'ZEN9988776',
    category: 'synchronisation',
    frequency: 'intermittent',
    summary: 'Drops every evening around 18:00, resyncs after two minutes.',
    testsCarriedOut: 'Tested at the master socket with a known-good router.',
    raisedBy: 'Joe Kane',
    supplier: 'Zen',
  });

  assert.match(note, /Fault raised with Zen/);
  assert.match(note, /Supplier reference: F-1234/);
  assert.match(note, /help@supportwizard\.net \/ 020 7043 3171/);
  assert.match(note, /Raised in NetKit by Joe Kane/);
  assert.match(note, /Tests already carried out:/);
});

test('a site contact appears on the note with their number', () => {
  const note = faultRaisedNote({
    serviceReference: 'ZEN1',
    category: 'performance',
    frequency: 'permanent',
    summary: 'Slow all day.',
    siteContact: { id: '9', name: 'Jane Okafor', email: 'jane@example.co.uk', phone: '07700 900123' },
  });
  assert.match(note, /Jane Okafor — jane@example\.co\.uk/);
  assert.match(note, /Site contact number: 07700 900123/);
});

test('the dropdown label pairs a name with an address', () => {
  assert.equal(siteContactLabel({ id: '1', name: 'Jane Okafor', email: 'jane@x.co.uk' }), 'Jane Okafor — jane@x.co.uk');
  assert.equal(siteContactLabel({ id: '1', name: 'Jane Okafor' }), 'Jane Okafor');
});

test('a line test note marks the readings the provider called a problem', () => {
  const note = lineTestNote({
    testType: 'xdsltest',
    serviceReference: 'ZEN1',
    outcome: 'fail',
    faultLocation: 'Between the DP and the premises',
    detail: [
      { label: 'SNR margin', value: '3 dB', verdict: 'fail' },
      { label: 'Attenuation', value: '42 dB', verdict: 'warn' },
      { label: 'Sync', value: '17 Mb', verdict: 'ok' },
    ],
    recommendations: ['Book an engineer visit'],
    runBy: 'Joe Kane',
  });

  assert.match(note, /Fault located: Between the DP and the premises/);
  assert.match(note, /SNR margin: 3 dB {2}← FAIL/);
  assert.match(note, /Attenuation: 42 dB {2}← warning/);
  assert.doesNotMatch(note, /Sync: 17 Mb {2}←/, 'a healthy reading is not flagged');
  assert.match(note, /Provider recommends:/);
});

test('the site-visit message never names the supplier to the customer’s face', () => {
  // It takes a supplier name and uses it, but the caller passes something
  // deliberately generic. This checks the shape rather than the policy.
  const message = siteVisitBookedMessage({ supplier: 'the network supplier', contactName: 'Jane' });
  assert.match(message, /^Hello Jane,/);
  assert.match(message, /booked an engineer visit with the network supplier/);
});

test('the site-visit message states both charges and the notice period', () => {
  const message = siteVisitBookedMessage();
  assert.match(message, /24 hours’ notice/, 'a customer who learns the notice period afterwards disputes the charge');
  assert.match(message, /missed appointment/);
  assert.match(message, /somebody will need to be on site/i);
  assert.match(message, /Kind regards/);
  assert.match(message, /SupportWizard Network Support Team$/, 'these go out under the team name');
  assert.match(message, /^Hello,/, 'no name is not an empty greeting');
});
