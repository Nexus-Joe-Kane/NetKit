/**
 * What can be done to a SIM, and what it costs to get it wrong.
 *
 * Every one of these is an action on a live service somebody is using. A bar
 * stops a delivery driver's phone working; a cease cannot be undone and the
 * number is gone. So each carries its consequence, whether it is reversible,
 * and whether it needs a typed confirmation rather than a click — and the
 * server enforces that rather than trusting the form.
 */

export type SimAction =
  | 'bar'
  | 'fullbar'
  | 'unbar'
  | 'cease'
  | 'activate'
  | 'tariffchange'
  | 'bolton'
  | 'simswap';

export interface SimActionDef {
  id: SimAction;
  label: string;
  /** What actually happens, in the words somebody would use to explain it. */
  effect: string;
  /** True where it can be put back the way it was. */
  reversible: boolean;
  /**
   * True where a click is not enough.
   *
   * Reserved for the two that cannot be undone. A confirmation on everything
   * is a confirmation nobody reads, and then the one that matters is clicked
   * through as well.
   */
  needsTypedConfirmation: boolean;
  /** What has to be supplied alongside. */
  requires?: 'tariff' | 'bolton' | 'iccid';
  /** States the SIM must be in for this to make sense. */
  from?: ReadonlyArray<string>;
}

export const SIM_ACTIONS: readonly SimActionDef[] = [
  {
    id: 'bar',
    label: 'Bar data',
    effect: 'Data stops. Calls and texts keep working. Used when a SIM is running away with its allowance.',
    reversible: true,
    needsTypedConfirmation: false,
    from: ['active'],
  },
  {
    id: 'fullbar',
    label: 'Bar everything',
    effect: 'Data, calls and texts all stop. The SIM is dead until it is unbarred. Used when a phone is lost.',
    reversible: true,
    needsTypedConfirmation: false,
    from: ['active'],
  },
  {
    id: 'unbar',
    label: 'Lift the bar',
    effect: 'Puts the SIM back exactly as it was.',
    reversible: true,
    needsTypedConfirmation: false,
    from: ['suspended'],
  },
  {
    id: 'cease',
    label: 'Cease',
    effect:
      'Ends the service permanently. The number is lost and cannot be recovered — if the customer might want ' +
      'to keep it, port it out first.',
    reversible: false,
    needsTypedConfirmation: true,
    from: ['active', 'suspended', 'spare', 'test'],
  },
  {
    id: 'activate',
    label: 'Activate',
    effect: 'Brings a spare SIM into service and starts its billing.',
    reversible: false,
    needsTypedConfirmation: false,
    requires: 'tariff',
    from: ['spare', 'pending', 'test'],
  },
  {
    id: 'tariffchange',
    label: 'Change tariff',
    effect: 'Moves the SIM to a different tariff. Takes effect on the next billing cycle unless Jola say otherwise.',
    reversible: true,
    needsTypedConfirmation: false,
    requires: 'tariff',
    from: ['active', 'suspended'],
  },
  {
    id: 'bolton',
    label: 'Add a bolt-on',
    effect: 'Adds extra allowance for the current period. Charged whether it gets used or not.',
    reversible: false,
    needsTypedConfirmation: false,
    requires: 'bolton',
    from: ['active'],
  },
  {
    id: 'simswap',
    label: 'Swap the SIM',
    effect:
      'Moves the number to a different physical SIM. The old one stops working the moment this goes through, ' +
      'so do not do it until the replacement is in somebody’s hand.',
    reversible: false,
    needsTypedConfirmation: true,
    requires: 'iccid',
    from: ['active', 'suspended'],
  },
];

export const simActionDef = (id: SimAction): SimActionDef | undefined => SIM_ACTIONS.find((a) => a.id === id);

/**
 * The path Jola expect, which is not always the word.
 *
 * `tarrifchange` is misspelled in their live API. Spelling it correctly
 * gives a 404, and a comment is the only place that fact can live where
 * somebody will find it before spending an afternoon on it.
 */
const PATHS: Record<SimAction, string> = {
  bar: 'orders/bar',
  fullbar: 'orders/fullbar',
  unbar: 'orders/unbar',
  cease: 'orders/cease',
  activate: 'orders/activation',
  tariffchange: 'orders/tarrifchange',
  bolton: 'orders/bolton',
  simswap: 'orders/simswap',
};

export const simActionPath = (id: SimAction): string => PATHS[id];

/**
 * Why this action cannot be run on this SIM, or nothing.
 *
 * State is checked because Jola's own errors are unhelpful — a bar on an
 * already-barred SIM comes back as a generic failure, and an engineer who
 * gets that at eight in the morning concludes the integration is broken
 * rather than that the SIM was already barred.
 */
export function simActionProblem(input: {
  action: SimAction;
  state?: string;
  tariff?: string;
  boltOn?: string;
  newIccid?: string;
  typedConfirmation?: string;
  /** What the caller must type: the number, so it cannot be muscle memory. */
  expectedConfirmation?: string;
}): string | undefined {
  const def = simActionDef(input.action);
  if (!def) return 'That is not something that can be done to a SIM.';

  if (def.from && input.state && !def.from.includes(input.state)) {
    return `A SIM that is ${input.state} cannot be ${def.label.toLowerCase()}ed. ${
      input.state === 'ceased' ? 'A ceased SIM is gone for good.' : `This needs the SIM to be ${def.from.join(' or ')}.`
    }`;
  }

  if (def.requires === 'tariff' && !(input.tariff ?? '').trim()) return 'Say which tariff.';
  if (def.requires === 'bolton' && !(input.boltOn ?? '').trim()) return 'Say which bolt-on.';
  if (def.requires === 'iccid') {
    const iccid = (input.newIccid ?? '').replace(/\s+/g, '');
    // 19 or 20 digits. A typo here moves a number onto a SIM nobody holds.
    if (!/^\d{19,20}$/.test(iccid)) return 'The new SIM’s ICCID is 19 or 20 digits. Check it against the card.';
  }

  if (def.needsTypedConfirmation) {
    const expected = (input.expectedConfirmation ?? '').trim();
    if (!expected) return 'Nothing to confirm against — the SIM has no number or ICCID to type back.';
    if ((input.typedConfirmation ?? '').replace(/\s+/g, '') !== expected.replace(/\s+/g, '')) {
      return `This cannot be undone. Type ${expected} to confirm.`;
    }
  }

  return undefined;
}

/** What the operator has to type back for the irreversible ones. */
export function confirmationFor(sim: { msisdn?: string; iccid?: string }): string | undefined {
  return sim.msisdn ?? sim.iccid;
}

/**
 * Live session state, from Jola's `networkdetails`.
 *
 * Distinct from the estate's `state` and worth having next to it: a SIM can
 * be `active` in their billing system and not have held a data session for a
 * week, which is exactly the case somebody rings up about.
 */
export interface SimNetworkState {
  online?: boolean;
  privateIp?: string;
  sessionStart?: string;
  sessionEnd?: string;
  /** What we could not find out, so a blank is not read as a no. */
  unknown?: boolean;
}

/**
 * How the session reads.
 *
 * "Online" and "not online" are both answers; "we could not tell" is a third
 * and is not the same as offline.
 */
export function sessionSummary(state: SimNetworkState): string {
  if (state.unknown || state.online === undefined) {
    return 'Jola did not report a session state for this SIM.';
  }
  if (state.online) {
    return state.sessionStart
      ? `Online, connected since ${state.sessionStart}.`
      : 'Online.';
  }
  return state.sessionEnd
    ? `Not online. Its last session ended ${state.sessionEnd}.`
    : 'Not online, and no last session was reported.';
}
