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
