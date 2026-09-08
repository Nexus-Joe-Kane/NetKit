import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __companiesHouseTesting } from './companiesHouse';

const { mapCompany } = __companiesHouseTesting;

test('an active company is not flagged', () => {
  const company = mapCompany(
    {
      company_number: '01234567',
      company_name: 'NORTHGATE SYSTEMS LIMITED',
      company_status: 'active',
      date_of_creation: '2014-03-11',
      registered_office_address: { premises: '12', address_line_1: 'High Street', locality: 'Manchester', postal_code: 'M1 1AE' },
      sic_codes: ['62020'],
    },
    'M1 1AE',
  );
  assert.ok(company);
  assert.equal(company.concerning, false);
  assert.equal(company.registeredHere, true, 'the office postcode matches the premises');
  assert.equal(company.registeredOffice, '12, High Street, Manchester, M1 1AE');
});

test('every winding-up status is flagged, because that is the point of the panel', () => {
  for (const status of [
    'liquidation',
    'receivership',
    'administration',
    'voluntary-arrangement',
    'insolvency-proceedings',
    'dissolved',
  ]) {
    const company = mapCompany({ company_number: '1', company_name: 'X LTD', company_status: status }, 'M1 1AE');
    assert.equal(company?.concerning, true, `${status} should be flagged`);
  }
});

test('a postcode that differs is not claimed as this address', () => {
  const company = mapCompany(
    {
      company_number: '01234567',
      company_name: 'X LTD',
      company_status: 'active',
      registered_office_address: { postal_code: 'LS1 4AP' },
    },
    'M1 1AE',
  );
  assert.equal(company?.registeredHere, undefined);
});

test('whitespace and case in postcodes do not create a false mismatch', () => {
  const company = mapCompany(
    { company_number: '1', company_name: 'X LTD', company_status: 'active', registered_office_address: { postal_code: 'm11ae' } },
    'M1 1AE',
  );
  assert.equal(company?.registeredHere, true);
});

test('overdue filings are surfaced separately from status', () => {
  const company = mapCompany(
    {
      company_number: '1',
      company_name: 'X LTD',
      company_status: 'active',
      accounts: { overdue: true },
      confirmation_statement: { overdue: true },
    },
    'M1 1AE',
  );
  assert.deepEqual(company?.overdue, ['Accounts overdue', 'Confirmation statement overdue']);
  // Overdue filings are a warning, not a reason to stop.
  assert.equal(company?.concerning, false);
});

test('a row with no number or no name is dropped rather than half-rendered', () => {
  assert.equal(mapCompany({ company_name: 'X LTD', company_status: 'active' }, 'M1 1AE'), null);
  assert.equal(mapCompany({ company_number: '1', company_status: 'active' }, 'M1 1AE'), null);
});

/* ---- Deep detail mappers ------------------------------------------- */

const { mapOfficer, mapPsc, mapFiling, mapCharge, mapInsolvencyCase, humanise, bornOn } = __companiesHouseTesting;

test('an officer maps with the fields a support call needs', () => {
  const officer = mapOfficer({
    name: 'SMITH, John Andrew',
    officer_role: 'director',
    appointed_on: '2018-02-01',
    nationality: 'British',
    occupation: 'Company Director',
    country_of_residence: 'England',
    date_of_birth: { month: 4, year: 1979 },
    address: { premises: '1', address_line_1: 'High Street', locality: 'Manchester', postal_code: 'M1 1AE' },
    links: { officer: { appointments: '/officers/abc123XYZ/appointments' } },
  });

  assert.equal(officer?.name, 'SMITH, John Andrew');
  assert.equal(officer?.role, 'Director', 'role should be readable, not a slug');
  assert.equal(officer?.active, true, 'no resignation means still serving');
  assert.equal(officer?.bornOn, '1979-04');
  assert.equal(officer?.officerId, 'abc123XYZ');
  assert.match(officer?.address ?? '', /High Street/);
});

test('a resigned officer is not shown as active', () => {
  const officer = mapOfficer({ name: 'JONES, Sara', officer_role: 'secretary', resigned_on: '2021-06-30' });
  assert.equal(officer?.active, false);
  assert.equal(officer?.resignedOn, '2021-06-30');
});

test('a corporate officer is flagged and has no date of birth', () => {
  const officer = mapOfficer({
    name: 'CORPORATE DIRECTORS LTD',
    officer_role: 'corporate-secretary',
    identification: { identification_type: 'uk-limited-company' },
  });
  assert.equal(officer?.corporate, true);
  assert.equal(officer?.bornOn, undefined);
});

test('an officer with no name is discarded rather than shown blank', () => {
  assert.equal(mapOfficer({ officer_role: 'director' }), null);
});

test('only the month and year of birth are kept', () => {
  // Companies House never publish the day, and this must not invent one.
  assert.equal(bornOn({ month: 12, year: 1965 }), '1965-12');
  assert.equal(bornOn({ year: 1965 }), '1965');
  assert.equal(bornOn(undefined), undefined);
  assert.equal(bornOn({ month: 3 }), undefined, 'a month with no year is useless');
});

test('a PSC records what control they actually hold', () => {
  const psc = mapPsc({
    name: 'Mr John Andrew Smith',
    kind: 'individual-person-with-significant-control',
    notified_on: '2016-04-06',
    natures_of_control: ['ownership-of-shares-75-to-100-percent', 'voting-rights-75-to-100-percent'],
    nationality: 'British',
  });
  assert.equal(psc?.active, true);
  assert.equal(psc?.kind, 'Individual person with significant control');
  assert.deepEqual(psc?.natureOfControl, [
    'Ownership of shares 75 to 100 percent',
    'Voting rights 75 to 100 percent',
  ]);
});

test('a ceased PSC is marked inactive', () => {
  const psc = mapPsc({ name: 'Old Owner Ltd', kind: 'corporate-entity-person-with-significant-control', ceased_on: '2023-01-01' });
  assert.equal(psc?.active, false);
});

test('a filing description template is filled in from its values', () => {
  // Companies House put placeholders in the description and the values in a
  // side object, so the raw description alone is unreadable.
  const filing = mapFiling({
    date: '2025-03-14',
    category: 'accounts',
    type: 'AA',
    description: 'accounts-with-accounts-type-small made up to {made_up_date}',
    description_values: { made_up_date: '31 March 2024' },
    pages: 9,
  });
  assert.equal(filing?.category, 'Accounts');
  assert.match(filing?.description ?? '', /31 March 2024/);
  assert.equal(filing?.pages, 9);
});

test('a filing with no date is discarded', () => {
  assert.equal(mapFiling({ category: 'accounts', description: 'x' }), null);
});

test('an outstanding charge is distinguished from a satisfied one', () => {
  const live = mapCharge({
    charge_number: 2,
    status: 'outstanding',
    created_on: '2020-05-01',
    persons_entitled: [{ name: 'LLOYDS BANK PLC' }],
    classification: { description: 'A registered charge' },
  });
  assert.equal(live.outstanding, true);
  assert.deepEqual(live.personsEntitled, ['LLOYDS BANK PLC']);

  for (const status of ['satisfied', 'fully-satisfied', 'fully-released', 'part-satisfied']) {
    assert.equal(mapCharge({ status }).outstanding, false, `${status} must not read as outstanding`);
  }
});

test('an insolvency case keeps the practitioner to actually ring', () => {
  const kase = mapInsolvencyCase({
    type: 'creditors-voluntary-liquidation',
    dates: [{ type: 'wound-up-on', date: '2025-11-02' }, { type: 'declaration-solvent', date: '' }],
    practitioners: [
      { name: 'BEGBIES TRAYNOR (CENTRAL) LLP', role: 'liquidator', appointed_on: '2025-11-02', address: { address_line_1: '340 Deansgate', locality: 'Manchester' } },
      { role: 'liquidator' },
    ],
    notes: ['Case reference 12345', ''],
  });
  assert.equal(kase.type, 'Creditors voluntary liquidation');
  assert.deepEqual(kase.dates, [{ label: 'Wound up on', date: '2025-11-02' }], 'a dateless entry is dropped');
  assert.equal(kase.practitioners.length, 1, 'a nameless practitioner is dropped');
  assert.equal(kase.practitioners[0]?.role, 'Liquidator');
  assert.deepEqual(kase.notes, ['Case reference 12345']);
});

test('slugs become sentences without mangling real text', () => {
  assert.equal(humanise('creditors-voluntary-liquidation'), 'Creditors voluntary liquidation');
  assert.equal(humanise('england_wales'), 'England wales');
  assert.equal(humanise(undefined), '');
  assert.equal(humanise('  '), '');
});

/* ---- Disqualification and other appointments ------------------------ */

const { mapDisqualification, mapAppointments } = __companiesHouseTesting;

test('a disqualification with no end date is in force', () => {
  const dq = mapDisqualification({
    disqualifications: [
      {
        disqualified_from: '2024-03-01',
        reason: { act: 'Company Directors Disqualification Act 1986', section: '6' },
        court_name: 'Manchester County Court',
        company_names: ['OLD TRADING LTD'],
      },
    ],
  });
  assert.equal(dq?.active, true);
  assert.equal(dq?.from, '2024-03-01');
  assert.match(dq?.reason ?? '', /Disqualification Act 1986/);
  assert.match(dq?.reason ?? '', /section 6/);
  assert.deepEqual(dq?.companies, ['OLD TRADING LTD']);
});

test('a disqualification that has expired is not in force', () => {
  const dq = mapDisqualification({
    disqualifications: [{ disqualified_from: '2015-01-01', disqualified_until: '2020-01-01' }],
  });
  assert.equal(dq?.active, false);
  assert.equal(dq?.to, '2020-01-01');
});

test('the most recent order is the one reported', () => {
  // Companies House do not guarantee an order, so this must not trust
  // position in the array.
  const dq = mapDisqualification({
    disqualifications: [
      { disqualified_from: '2015-01-01', court_name: 'Old Court' },
      { disqualified_from: '2024-06-01', court_name: 'Recent Court' },
    ],
  });
  assert.equal(dq?.authority, 'Recent Court');
});

test('no disqualification is the normal answer', () => {
  assert.equal(mapDisqualification(null), null);
  assert.equal(mapDisqualification({}), null);
  assert.equal(mapDisqualification({ disqualifications: [] }), null);
});

test('other appointments exclude the company being viewed', () => {
  const list = mapAppointments(
    {
      items: [
        { appointed_to: { company_name: 'THIS ONE LTD', company_number: '11112222', company_status: 'active' }, officer_role: 'director' },
        { appointed_to: { company_name: 'ANOTHER LTD', company_number: '33334444', company_status: 'active' }, officer_role: 'director' },
      ],
    },
    '11112222',
  );
  assert.equal(list.length, 1);
  assert.equal(list[0]?.companyNumber, '33334444');
});

test('a run of dissolved companies is surfaced, live and troubled first', () => {
  const list = mapAppointments(
    {
      items: [
        { appointed_to: { company_name: 'HEALTHY LTD', company_number: '1', company_status: 'active' }, officer_role: 'director' },
        { appointed_to: { company_name: 'GONE LTD', company_number: '2', company_status: 'dissolved' }, officer_role: 'director' },
        { appointed_to: { company_name: 'WINDING UP LTD', company_number: '3', company_status: 'liquidation' }, officer_role: 'director' },
        { appointed_to: { company_name: 'RESIGNED LTD', company_number: '4', company_status: 'active' }, officer_role: 'director', resigned_on: '2020-01-01' },
      ],
    },
    '99999999',
  );
  assert.equal(list.length, 4);
  assert.equal(list[0]?.concerning, true, 'a live appointment at a troubled company leads');
  assert.equal(list.at(-1)?.active, false, 'resignations sink');
  assert.equal(list.filter((a: { concerning: boolean }) => a.concerning).length, 2);
});

test('an appointment missing its company is discarded', () => {
  assert.deepEqual(mapAppointments({ items: [{ officer_role: 'director' }] }, '1'), []);
  assert.deepEqual(mapAppointments(null, '1'), []);
});
