import { test } from 'node:test';
import assert from 'node:assert/strict';
import { companyRiskFlags, isClosedStatus, isInsolventStatus, strikeOffProposed, summariseRisks } from './companyRisk';

test('a plain active company raises nothing', () => {
  assert.deepEqual(companyRiskFlags({ status: 'active' }), []);
});

test('a strike-off qualifier is caught even though the status still reads active', () => {
  // This is the case the register hides: `company_status` is `active` and only
  // the qualifier says a Gazette notice has been published.
  const flags = companyRiskFlags({ status: 'active', statusDetail: 'active-proposal-to-strike-off' });
  assert.equal(flags[0]?.kind, 'strike-off');
  assert.equal(flags[0]?.severity, 'critical');
});

test('a GAZ1 filing counts as a strike-off notice on its own', () => {
  assert.equal(strikeOffProposed({ strikeOffProposed: true }), true);
  assert.equal(strikeOffProposed({ status: 'active' }), false);
});

test('late accounts are critical and name the date', () => {
  const flags = companyRiskFlags({ status: 'active', accountsOverdue: true, accountsNextDue: '2026-03-31' });
  const accounts = flags.find((f) => f.kind === 'accounts-overdue');
  assert.equal(accounts?.severity, 'critical');
  assert.match(accounts?.detail ?? '', /31 Mar 2026/);
});

test('a late confirmation statement is a warning, not a stop', () => {
  const flags = companyRiskFlags({ status: 'active', confirmationStatementOverdue: true });
  assert.equal(flags.find((f) => f.kind === 'confirmation-overdue')?.severity, 'warning');
});

test('liquidation and dissolution are told apart', () => {
  assert.equal(isInsolventStatus('liquidation'), true);
  assert.equal(isClosedStatus('liquidation'), false, 'a company in liquidation still exists');
  assert.equal(isClosedStatus('dissolved'), true);
  assert.equal(isInsolventStatus('dissolved'), false);
});

test('a dissolved company says when', () => {
  const flags = companyRiskFlags({ status: 'dissolved', dissolvedOn: '2019-07-02' });
  assert.match(flags.find((f) => f.kind === 'closed')?.label ?? '', /2 Jul 2019/);
});

test('previous insolvency is only news while the company is trading', () => {
  assert.ok(
    companyRiskFlags({ status: 'active', insolvencyHistory: true }).some((f) => f.kind === 'insolvency-history'),
  );
  assert.equal(
    companyRiskFlags({ status: 'liquidation', insolvencyHistory: true }).some((f) => f.kind === 'insolvency-history'),
    false,
    'telling somebody a company in liquidation has been insolvent before is noise',
  );
});

test('strike off outranks everything else, because it is usually the consequence', () => {
  const flags = companyRiskFlags({
    status: 'active',
    statusDetail: 'active-proposal-to-strike-off',
    accountsOverdue: true,
  });
  assert.equal(flags[0]?.kind, 'strike-off');
});

test('the summary reads as a sentence and does not repeat itself', () => {
  const flags = [
    ...companyRiskFlags({ status: 'active', statusDetail: 'active-proposal-to-strike-off' }),
    ...companyRiskFlags({ status: 'active', accountsOverdue: true }),
    ...companyRiskFlags({ status: 'active', accountsOverdue: true }),
  ];
  assert.equal(summariseRisks(flags), 'proposed for strike off and accounts overdue');
  assert.equal(summariseRisks([]), '');
});

test('an unchecked company is not reported as clean', () => {
  // Undefined risk fields mean the profile was never fetched. Nothing here
  // may invent a reassurance out of that.
  assert.deepEqual(companyRiskFlags({ status: 'active', accountsOverdue: undefined }), []);
});
