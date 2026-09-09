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
  wanRow,
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
    disposition: 'exception',
    at: '2026-09-09T08:00:00.000Z',
    by: 'Joe Kane',
    resolution: 'Line tested clean, console back up.',
    exceptionReason: 'Fibre is 14 months out on this street.',
    signedOffBy: 'Sam Roffey',
  });
  assert.equal(event.status, 'cleared');
  assert.equal(event.clearance?.disposition, 'exception');
  assert.equal(event.clearance?.signedOffBy, 'Sam Roffey');
  assert.match(event.clearance?.exceptionReason ?? '', /14 months/);
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

/* ---- The technical breakdown every ticket carries -------------------- */

test('an unmanaged WAN says which provider it is and that we cannot test it', () => {
  // A blank column is a question. "No line test: G.Network on WAN 2 is not a
  // line we manage" is an answer.
  const row = wanRow({ id: 'wan2', label: 'WAN 2', providerName: 'G.Network', online: false });
  assert.equal(row.managed, false);
  assert.equal(row.lineTestRun, 'n/a');
  assert.equal(row.lineTestResult, 'unknown');
  assert.match(row.lineTestNote ?? '', /G\.Network on WAN 2 is not a line we manage/);
});

test('a managed line whose test would not run is different from one that passed', () => {
  const failedToRun = wanRow({
    id: 'wan1',
    label: 'WAN 1',
    providerName: 'Zen Internet',
    serviceReference: 'ZEN123456',
    test: { ran: false, error: 'Zen returned 401' },
  });
  assert.equal(failedToRun.lineTestRun, 'no');
  assert.equal(failedToRun.lineTestResult, 'unknown');
  assert.match(failedToRun.lineTestNote ?? '', /401/);

  const passed = wanRow({
    id: 'wan1',
    label: 'WAN 1',
    providerName: 'Zen Internet',
    serviceReference: 'ZEN123456',
    test: { ran: true, passed: true },
  });
  assert.equal(passed.lineTestRun, 'yes');
  assert.equal(passed.lineTestResult, 'pass');
  assert.equal(passed.lineTestNote, undefined);
});

test('the provider’s own figures go on the ticket verbatim, in a code block', () => {
  // Summarising a test into "fault found" loses the attenuation reading the
  // supplier asks for, and an engineer who has to re-run it to get that back
  // has been handed a worse ticket than no ticket.
  const event: NetEvent = {
    ...openEvent(base),
    wans: [
      wanRow({
        id: 'wan1',
        label: 'WAN 1',
        providerName: 'Zen Internet',
        serviceReference: 'ZEN123456',
        test: { ran: true, passed: false, output: 'Outcome: FAIL\nLine attenuation: 62.4 dB\nSNR margin: 0.0 dB' },
      }),
    ],
  };
  const note = eventTicketNote(event);
  assert.match(note, /```/);
  assert.match(note, /Line attenuation: 62\.4 dB/);
  assert.match(note, /SNR margin: 0\.0 dB/);
});

test('the environment is on the ticket, including when it went down', () => {
  const event: NetEvent = {
    ...openEvent(base),
    environment: {
      downSince: '2026-09-09T06:15:00.000Z',
      gatewayName: 'MH-OXF-GW',
      gatewayModel: 'UXG-Pro',
      totalDevices: 14,
      offlineDevices: 14,
      wiredClients: 0,
      wifiClients: 0,
      wanCount: 2,
      siteId: 'site-abc',
    },
  };
  const note = eventTicketNote(event);
  assert.match(note, /Offline since/);
  assert.match(note, /Gateway — MH-OXF-GW \/ UXG-Pro/);
  assert.match(note, /Devices — 14 total, 14 offline/);
  assert.match(note, /WANs configured — 2/);
  assert.match(note, /UniFi site — site-abc/);
});

test('with no environment gathered the ticket simply omits the section', () => {
  // Half a breakdown with "undefined" in it is worse than none.
  const note = eventTicketNote(openEvent(base));
  assert.doesNotMatch(note, /Environment/);
  assert.doesNotMatch(note, /undefined/);
});

test('a missing event link says why rather than trailing off', () => {
  // The live ticket mentioned an event and gave no way to find it.
  const note = eventTicketNote(openEvent(base));
  assert.match(note, /PUBLIC_URL is not set/);
  assert.match(note, /Admin portal → Credentials/);
});

test('the drop count is not stated twice with two different numbers', () => {
  // The live ticket said "5 drops" in one sentence and "6 drops" in the next.
  const event: NetEvent = {
    ...openEvent({ ...base, kind: 'unstable', because: '5 drops in the last 24 hours. The site is up, but not staying up.' }),
    dropsInWindow: 6,
  };
  const note = eventTicketNote(event);
  assert.equal(note.match(/drops? in the last 24 hours/g)?.length, 1, note);
});
