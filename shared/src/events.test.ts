import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  clearEvent,
  eventSubject,
  eventTicketNote,
  glance,
  newWatchState,
  openEvent,
  sortEvents,
  sortFindings,
  withDiagnosis,
  type EventFinding,
  type NetEvent,
  type OpenEventInput,
} from './index';

const AT = '2026-09-09T07:12:00.000Z';

const base: OpenEventInput = {
  id: 'evt-1',
  kind: 'outage',
  clientKey: 'market-halls',
  clientName: 'Market Halls Ltd',
  siteName: 'Market Halls Victoria',
  address: '191 Victoria Street, London, SW1E 5NE',
  because: '2 checks in a row could not reach the site.',
  at: AT,
};

/* ---- Who opened it --------------------------------------------------- */

test('an event the portal opened is not credited to anybody', () => {
  const event = openEvent(base);
  assert.equal(event.automatic, true);
  assert.equal(event.openedBy, undefined);
  assert.match(eventTicketNote(event), /Opened automatically by NetKit/);
});

test('an event somebody raised carries their name and drops the automatic line', () => {
  const event = openEvent({ ...base, kind: 'manual', by: { name: 'Joe Kane' } });
  assert.equal(event.automatic, false);
  assert.deepEqual(event.openedBy, { name: 'Joe Kane' });
  assert.doesNotMatch(eventTicketNote(event), /Opened automatically/);
});

test('a sweep running on somebody’s behalf is still automatic', () => {
  // The name is there so the row can be traced, not because they decided it.
  const event = openEvent({ ...base, by: { name: 'Joe Kane' }, automatic: true });
  assert.equal(event.automatic, true);
  assert.equal(event.openedBy, undefined);
});

/* ---- The subject somebody scans a queue for -------------------------- */

test('the subject leads with the client and says what is wrong', () => {
  const event = openEvent(base);
  assert.equal(eventSubject(event), 'Market Halls Ltd — Market Halls Victoria: site off');
});

test('the subject carries the blame once it is known', () => {
  const event = withDiagnosis(openEvent(base), { attribution: 'supplier' }, AT);
  assert.match(eventSubject(event), /looks like the supplier/);
});

test('an unclear cause is not put in the subject', () => {
  // "(not yet clear)" on every ticket is noise on every ticket.
  const event = withDiagnosis(openEvent(base), { attribution: 'unclear' }, AT);
  assert.equal(eventSubject(event), 'Market Halls Ltd — Market Halls Victoria: site off');
});

test('a site named the same as the client is not said twice', () => {
  const event = openEvent({ ...base, siteName: 'Market Halls Ltd' });
  assert.equal(eventSubject(event), 'Market Halls Ltd: site off');
});

/* ---- Findings -------------------------------------------------------- */

test('symptoms sort above context', () => {
  const findings: EventFinding[] = [
    { source: 'unifi', label: 'Uptime', value: '4 days', verdict: 'good' },
    { source: 'line-test', label: 'Line test', value: 'No sync at the NTE', verdict: 'bad' },
    { source: 'radius', label: 'Last authentication', value: '06:58', verdict: 'info' },
    { source: 'mobile', label: 'Allowance used', value: '82%', verdict: 'warn' },
  ];
  assert.deepEqual(
    sortFindings(findings).map((f) => f.verdict),
    ['bad', 'warn', 'info', 'good'],
  );
});

test('the ticket carries the symptoms and not the good news', () => {
  // A ticket is triaged, not read. Six lines that matter beat forty that do
  // not, and everything else is on the event a click away.
  const event = withDiagnosis(
    openEvent(base),
    {
      attribution: 'supplier',
      attributionBecause: 'The line test found a fault in the network.',
      findings: [
        { source: 'line-test', label: 'Line test', value: 'No sync at the NTE', verdict: 'bad' },
        { source: 'unifi', label: 'Uptime', value: '4 days', verdict: 'good' },
      ],
    },
    AT,
  );
  const note = eventTicketNote(event, 'https://netkit.example/#/events/evt-1');
  assert.match(note, /No sync at the NTE/);
  assert.doesNotMatch(note, /4 days/);
  assert.match(note, /Looks like the supplier/);
  assert.match(note, /https:\/\/netkit\.example\/#\/events\/evt-1/);
});

test('the ticket says where to look even with no link configured', () => {
  // A deployment with no public URL must not produce a ticket that trails off.
  const note = eventTicketNote(openEvent(base));
  assert.match(note, /on the event in NetKit/);
});

/* ---- The 5G unit and its SIM, which is the pair nobody can find ------ */

test('the 5G unit and its SIM are on the ticket together', () => {
  const event = withDiagnosis(
    openEvent(base),
    {
      inventory: {
        mobiles: [
          {
            deviceName: 'U-LTE-Pro',
            msisdn: '07700900123',
            operator: 'EE',
            tariff: '100GB pooled',
            online: true,
            usedPercent: 81.6,
          },
        ],
      },
    },
    AT,
  );
  const note = eventTicketNote(event);
  assert.match(note, /U-LTE-Pro — 07700900123 — EE — 100GB pooled — online — 82% of allowance used/);
});

test('a supplier having a bad morning is on the ticket', () => {
  const event = withDiagnosis(
    openEvent(base),
    {
      providers: [
        { provider: 'BT', state: 'outage', reports: 4210, checkedAt: AT, source: 'downdetector' },
        { provider: 'EE', state: 'ok', checkedAt: AT, source: 'downdetector' },
      ],
    },
    AT,
  );
  const note = eventTicketNote(event);
  assert.match(note, /BT — outage \(4210 reports\)/);
  assert.doesNotMatch(note, /EE/, 'a supplier who is fine is not news');
});

/* ---- The trail ------------------------------------------------------- */

test('the trail travels with the ticket, automatic steps flagged', () => {
  const event: NetEvent = {
    ...openEvent(base),
    activity: [
      { at: AT, action: 'diagnostics.test_run', summary: 'ZEN123456', outcome: 'No sync', automatic: true },
    ],
  };
  const note = eventTicketNote(event);
  assert.match(note, /What has been done/);
  assert.match(note, /NetKit, automatically/);
});

/* ---- Drops ----------------------------------------------------------- */

test('the drop count on the ticket is the one that still counts', () => {
  // A resolution watermark is the whole reason this is not `disconnections.length`.
  const watch = {
    ...newWatchState('market-halls', 'Market Halls Victoria'),
    disconnections: ['2026-09-09T05:00:00.000Z', '2026-09-09T06:00:00.000Z', '2026-09-09T07:00:00.000Z'],
    countingFrom: '2026-09-09T05:30:00.000Z',
  };
  const event = openEvent({ ...base, watch });
  assert.equal(event.dropsInWindow, 2);
  assert.match(eventTicketNote(event), /2 drops in the last 24 hours/);
});

test('no drops means no sentence about drops', () => {
  const event = openEvent({ ...base, watch: newWatchState('a', 'b') });
  assert.equal(event.dropsInWindow, undefined);
  assert.doesNotMatch(eventTicketNote(event), /drops in the last/);
});

/* ---- The glance ------------------------------------------------------ */

test('the glance counts what is on fire, not what has been dealt with', () => {
  const off = openEvent(base);
  const unstable = openEvent({ ...base, id: 'evt-2', kind: 'unstable' });
  const cleared = clearEvent(openEvent({ ...base, id: 'evt-3' }), {
    disposition: 'resolved',
    at: '2026-09-09T08:00:00.000Z',
  });

  const result = glance({ events: [off, unstable, cleared], appointments: 2, faults: 1 });
  assert.deepEqual(result, { appointments: 2, faults: 1, sitesOff: 1, sitesUnstable: 1, untouched: 2 });
});

test('an event a person has worked on is no longer untouched', () => {
  // The number that should be zero: automatic events nobody has looked at.
  const touched: NetEvent = {
    ...openEvent(base),
    activity: [
      { at: AT, action: 'diagnostics.test_run', summary: 'ZEN123456', automatic: true },
      { at: AT, action: 'fault.raised', summary: 'No sync', actor: { name: 'Joe Kane' } },
    ],
  };
  assert.equal(glance({ events: [touched], appointments: 0, faults: 0 }).untouched, 0);
});

test('automatic steps alone do not count as somebody having looked', () => {
  const onlyRobots: NetEvent = {
    ...openEvent(base),
    activity: [{ at: AT, action: 'diagnostics.test_run', summary: 'ZEN123456', automatic: true }],
  };
  assert.equal(glance({ events: [onlyRobots], appointments: 0, faults: 0 }).untouched, 1);
});

/* ---- The order they are worked in ------------------------------------ */

test('off before unstable, unattributed before attributed, oldest first', () => {
  const events: NetEvent[] = [
    openEvent({ ...base, id: 'unstable', kind: 'unstable', at: '2026-09-09T05:00:00.000Z' }),
    withDiagnosis(openEvent({ ...base, id: 'blamed', at: '2026-09-09T06:00:00.000Z' }), { attribution: 'supplier' }, AT),
    openEvent({ ...base, id: 'unknown-new', at: '2026-09-09T08:00:00.000Z' }),
    openEvent({ ...base, id: 'unknown-old', at: '2026-09-09T07:00:00.000Z' }),
  ];
  assert.deepEqual(
    sortEvents(events).map((e) => e.id),
    ['unknown-old', 'unknown-new', 'blamed', 'unstable'],
  );
});

test('cleared events sort below open ones whatever they are', () => {
  const open = openEvent({ ...base, id: 'open', kind: 'manual', at: '2026-09-09T09:00:00.000Z' });
  const cleared = clearEvent(openEvent({ ...base, id: 'cleared' }), { disposition: 'resolved', at: AT });
  assert.deepEqual(sortEvents([cleared, open]).map((e) => e.id), ['open', 'cleared']);
});

/* ---- Clearing -------------------------------------------------------- */

test('clearing records what was chosen, not just that it happened', () => {
  const event = clearEvent(openEvent(base), {
    disposition: 'expected',
    at: '2026-09-09T08:00:00.000Z',
    until: '2026-09-10T08:00:00.000Z',
    by: 'Joe Kane',
    note: 'Openreach planned works',
  });
  assert.equal(event.status, 'cleared');
  assert.equal(event.clearance?.disposition, 'expected');
  assert.equal(event.clearance?.note, 'Openreach planned works');
  assert.equal(event.clearedAt, '2026-09-09T08:00:00.000Z');
});

test('a diagnosis adds to findings rather than replacing them', () => {
  const first = withDiagnosis(openEvent(base), {
    findings: [{ source: 'circuit', label: 'Circuit', value: 'down', verdict: 'bad' }],
  }, AT);
  const second = withDiagnosis(first, {
    findings: [{ source: 'line-test', label: 'Line test', value: 'clean', verdict: 'good' }],
  }, AT);
  assert.equal(second.findings?.length, 2);
});
