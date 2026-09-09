import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  SIM_ACTIONS,
  confirmationFor,
  sessionSummary,
  simActionDef,
  simActionPath,
  simActionProblem,
  type SimAction,
} from './index';

/* ---- Jola's own spelling -------------------------------------------- */

test('the tariff change path is Jola’s misspelling, not ours', () => {
  // `tarrifchange` really is spelled that way in the live API. Spelling it
  // correctly gives a 404, and a test is the only place that fact survives
  // somebody "fixing" it.
  assert.equal(simActionPath('tariffchange'), 'orders/tarrifchange');
  assert.equal(simActionPath('cease'), 'orders/cease');
  assert.equal(simActionPath('activate'), 'orders/activation');
});

/* ---- Only the irreversible ones demand typing ----------------------- */

test('exactly the two that cannot be undone need a typed confirmation', () => {
  // A confirmation on everything is a confirmation nobody reads, and then
  // the one that matters is clicked through as well.
  const typed = SIM_ACTIONS.filter((a) => a.needsTypedConfirmation).map((a) => a.id);
  assert.deepEqual(typed.sort(), ['cease', 'simswap']);
});

test('a cease needs the SIM’s own number typed back', () => {
  const base = { action: 'cease' as const, state: 'active', expectedConfirmation: '07700900123' };
  assert.match(simActionProblem(base) ?? '', /cannot be undone/);
  assert.match(simActionProblem({ ...base, typedConfirmation: 'yes' }) ?? '', /Type 07700900123/);
  assert.equal(simActionProblem({ ...base, typedConfirmation: '07700900123' }), undefined);
  // Spaces are somebody reading it off a card, not a mistake.
  assert.equal(simActionProblem({ ...base, typedConfirmation: '077 009 00123' }), undefined);
});

test('a SIM with nothing to type back cannot be ceased by accident', () => {
  assert.match(
    simActionProblem({ action: 'cease', state: 'spare', typedConfirmation: 'x' }) ?? '',
    /Nothing to confirm against/,
  );
});

test('a reversible action does not ask for typing', () => {
  assert.equal(simActionProblem({ action: 'bar', state: 'active' }), undefined);
  assert.equal(simActionProblem({ action: 'unbar', state: 'suspended' }), undefined);
});

/* ---- State has to make the action sensible -------------------------- */

test('an action that makes no sense for the state is refused before Jola see it', () => {
  // Jola answer a bar on an already-barred SIM with a generic failure, and
  // an engineer who gets that at eight in the morning concludes the
  // integration is broken rather than that the SIM was already barred.
  assert.match(simActionProblem({ action: 'bar', state: 'suspended' }) ?? '', /cannot be/);
  assert.match(simActionProblem({ action: 'unbar', state: 'active' }) ?? '', /cannot be/);
  assert.match(simActionProblem({ action: 'bolton', state: 'ceased' }) ?? '', /gone for good/);
});

test('a spare SIM can be activated but not barred', () => {
  assert.equal(simActionProblem({ action: 'activate', state: 'spare', tariff: '100GB pooled' }), undefined);
  assert.match(simActionProblem({ action: 'bar', state: 'spare' }) ?? '', /cannot be/);
});

/* ---- What each action needs alongside ------------------------------- */

test('an activation or a tariff change needs a tariff', () => {
  assert.match(simActionProblem({ action: 'activate', state: 'spare' }) ?? '', /which tariff/);
  assert.match(simActionProblem({ action: 'tariffchange', state: 'active' }) ?? '', /which tariff/);
});

test('a bolt-on needs a bolt-on', () => {
  assert.match(simActionProblem({ action: 'bolton', state: 'active' }) ?? '', /which bolt-on/);
});

test('a swap needs a plausible ICCID, because a typo moves a number to nobody', () => {
  const base = {
    action: 'simswap' as const,
    state: 'active',
    expectedConfirmation: '07700900123',
    typedConfirmation: '07700900123',
  };
  assert.match(simActionProblem(base) ?? '', /19 or 20 digits/);
  assert.match(simActionProblem({ ...base, newIccid: '8944' }) ?? '', /19 or 20 digits/);
  assert.match(simActionProblem({ ...base, newIccid: '894411'.repeat(5) }) ?? '', /19 or 20 digits/);
  assert.equal(simActionProblem({ ...base, newIccid: '8944110012345678901' }), undefined);
  // Spaces again: read off a card.
  assert.equal(simActionProblem({ ...base, newIccid: '8944 1100 1234 5678 901' }), undefined);
});

test('an unknown action is refused rather than sent', () => {
  assert.ok(simActionProblem({ action: 'delete-everything' as SimAction }));
  assert.equal(simActionDef('delete-everything' as SimAction), undefined);
});

test('what to type is the number, or the card where there is no number', () => {
  assert.equal(confirmationFor({ msisdn: '07700900123', iccid: '8944110012345678901' }), '07700900123');
  assert.equal(confirmationFor({ iccid: '8944110012345678901' }), '8944110012345678901');
  assert.equal(confirmationFor({}), undefined);
});

/* ---- Live session state --------------------------------------------- */

test('"we could not tell" is a third answer, not offline', () => {
  // A SIM can be active in Jola's billing and not have connected for a week.
  // Reading a blank as offline would have somebody replace working kit.
  assert.match(sessionSummary({ unknown: true }), /did not report/);
  assert.match(sessionSummary({}), /did not report/);
  assert.match(sessionSummary({ online: true, sessionStart: '2026-09-08T22:14:00Z' }), /connected since/);
  assert.match(sessionSummary({ online: false, sessionEnd: '2026-09-02T09:00:00Z' }), /last session ended/);
  assert.match(sessionSummary({ online: false }), /no last session/);
});

test('every action explains what it does in words somebody would use', () => {
  for (const action of SIM_ACTIONS) {
    assert.ok(action.effect.length > 30, `${action.id} has no real explanation`);
    assert.ok(action.label.length > 2, `${action.id} has no label`);
  }
  // The two that matter most say so outright.
  assert.match(simActionDef('cease')!.effect, /cannot be recovered/);
  assert.match(simActionDef('simswap')!.effect, /stops working the moment/);
});
