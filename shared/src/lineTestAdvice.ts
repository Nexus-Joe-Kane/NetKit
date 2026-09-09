import type { LineTestResult, TestMetric } from './operations';
import type { AccessTechnology } from './types';

/**
 * What a line test actually means, and what to do about it.
 *
 * A supplier's test output is written for the supplier. "ONT LOS asserted"
 * is precise and tells an engineer at three in the afternoon nothing about
 * whether to ring the customer or book a visit. This turns each of them into
 * the next action, in the order it should be taken.
 *
 * Two rules run through all of it:
 *
 * 1. **Cheap checks first.** A visit costs the customer money, so anything
 *    that can be ruled out over the phone gets ruled out first. Every
 *    escalation names what has to be true before it is fair to book.
 * 2. **Never claim the test said something it did not.** Where the mapping
 *    is a guess from a phrase, it says so. An engineer who is told "this
 *    usually means" behaves differently from one told "this means".
 */

export type Side = 'customer' | 'network' | 'unclear';

export interface TestFinding {
  /** Stable key, so the UI can group without matching prose. */
  kind: string;
  /** What the test is saying, in words an engineer would use. */
  meaning: string;
  /** Where the fault sits, which decides who fixes it. */
  side: Side;
  /** In order. The cheap checks come first, always. */
  steps: string[];
  /**
   * What has to be true before booking an engineer is fair to the customer.
   * Absent where a visit is not the answer.
   */
  beforeBooking?: string;
  /** The reason to put on a fault, matching the site-visit reason list. */
  suggestedReason?: SiteVisitReason;
  severity: 'critical' | 'warning' | 'info';
}

/**
 * Why an external engineer is going to site.
 *
 * A fixed list because it goes into a customer-facing email: free text there
 * becomes either a technical sentence nobody understands or an admission
 * nobody meant to make.
 */
export type SiteVisitReason =
  | 'ont-damage'
  | 'ont-no-light'
  | 'fibre-underground'
  | 'copper-underground'
  | 'copper-joint'
  | 'exchange'
  | 'cabinet'
  | 'internal-wiring'
  | 'master-socket'
  | 'line-plant'
  | 'no-dial-tone'
  | 'intermittent-drops'
  | 'speed-below-estimate'
  | 'provisioning'
  | 'unknown';

export interface SiteVisitReasonDef {
  id: SiteVisitReason;
  /** What the engineer picks from the list. */
  label: string;
  /**
   * How it reads to the customer. Plainer, and never accusatory.
   *
   * A noun phrase, always — it is dropped into "They are coming out because
   * of ___", and a clause there reads as "because of the fibre terminal is
   * not receiving a signal". There is a test below that keeps them that way.
   */
  customerWording: string;
  side: Side;
  /** Only offered for lines where it is possible. */
  technologies?: AccessTechnology[];
}

export const SITE_VISIT_REASONS: readonly SiteVisitReasonDef[] = [
  {
    id: 'ont-no-light',
    label: 'ONT reporting loss of light',
    customerWording: 'a loss of signal to the fibre terminal at the property',
    side: 'network',
    technologies: ['FTTP'],
  },
  {
    id: 'ont-damage',
    label: 'ONT damaged or failed',
    customerWording: 'a failed fibre terminal at the property, which needs replacing',
    side: 'network',
    technologies: ['FTTP'],
  },
  {
    id: 'fibre-underground',
    label: 'Damage to underground fibre',
    customerWording: 'damage to the underground fibre serving the building',
    side: 'network',
    technologies: ['FTTP'],
  },
  {
    id: 'copper-underground',
    label: 'Damage to underground copper',
    customerWording: 'damage to the underground cabling serving the building',
    side: 'network',
  },
  {
    id: 'copper-joint',
    label: 'Faulty joint in the copper path',
    customerWording: 'a faulty connection in the cabling between the exchange and the building',
    side: 'network',
  },
  {
    id: 'exchange',
    label: 'Fault at the exchange',
    customerWording: 'a fault in the provider’s equipment at the local exchange',
    side: 'network',
  },
  {
    id: 'cabinet',
    label: 'Fault at the street cabinet',
    customerWording: 'a fault in the provider’s equipment at the street cabinet',
    side: 'network',
  },
  {
    id: 'line-plant',
    label: 'Fault in the external line plant',
    customerWording: 'a fault in the provider’s external network serving the building',
    side: 'network',
  },
  {
    id: 'master-socket',
    label: 'Master socket faulty or missing',
    customerWording: 'a master socket at the property that needs replacing',
    side: 'customer',
  },
  {
    id: 'internal-wiring',
    label: 'Internal wiring fault',
    customerWording: 'a fault in the wiring inside the property',
    side: 'customer',
  },
  {
    id: 'no-dial-tone',
    label: 'No dial tone',
    customerWording: 'a loss of signal on the line',
    side: 'unclear',
  },
  {
    id: 'intermittent-drops',
    label: 'Repeated drops',
    customerWording: 'the connection dropping repeatedly',
    side: 'unclear',
  },
  {
    id: 'speed-below-estimate',
    label: 'Speed well below estimate',
    customerWording: 'the connection running well below the speed it should',
    side: 'unclear',
  },
  {
    id: 'provisioning',
    label: 'Provisioning or configuration error',
    customerWording: 'the service needing reconfiguring at the provider’s end',
    side: 'network',
  },
  { id: 'unknown', label: 'Cause not yet identified', customerWording: 'a fault on the line', side: 'unclear' },
] as const;

export const reasonDef = (id: SiteVisitReason): SiteVisitReasonDef =>
  SITE_VISIT_REASONS.find((r) => r.id === id) ?? SITE_VISIT_REASONS[SITE_VISIT_REASONS.length - 1]!;

/* ------------------------------------------------------------------ *
 * The translations
 * ------------------------------------------------------------------ */

interface Pattern {
  kind: string;
  /** Whole-word where it matters: `LOS` appears inside `CLOSE`. */
  match: RegExp;
  meaning: string;
  side: Side;
  steps: string[];
  beforeBooking?: string;
  suggestedReason?: SiteVisitReason;
  severity: TestFinding['severity'];
}

/**
 * Ordered most specific first.
 *
 * The order is the whole safety of this: "no power at the ONT" and "loss of
 * light at the ONT" both contain "ONT", and they need opposite first actions
 * — one is a plug, the other is a dig. A general pattern reached first would
 * send an engineer to site over an unplugged power brick.
 */
const PATTERNS: readonly Pattern[] = [
  {
    kind: 'ont-power',
    match: /\b(ont|nte)\b[^.]*\b(power|powered down|no power|unpowered|mains)\b|\bpower (off|down|fail)/i,
    meaning: 'The fibre terminal in the building is not powered. The network cannot see it because it is off.',
    side: 'customer',
    steps: [
      'Ring the customer before anything else. This is a plug nine times out of ten.',
      'Ask them to confirm the ONT — the small white box the fibre goes into — has any lights on at all.',
      'Ask them to check the power brick at both ends: the socket and the ONT itself. Have them unplug it, wait ten seconds and plug it back in.',
      'Ask for a photo of the ONT with the lights visible. That photo is what turns this from a guess into evidence.',
      'If the photo shows the power light on and the network still cannot see it, the ONT itself has failed — book the visit.',
    ],
    beforeBooking:
      'A photo showing the ONT powered on. Booking a visit to a switched-off ONT is a £165 + VAT charge for a plug.',
    suggestedReason: 'ont-damage',
    severity: 'critical',
  },
  {
    kind: 'ont-los',
    match: /\b(los|loss of (light|signal)|no light|dying gasp)\b/i,
    meaning:
      'The fibre terminal is powered but receiving no light from the network. The break is on the provider’s side of the terminal.',
    side: 'network',
    steps: [
      'Confirm with the customer that the ONT is powered and note which lights are lit.',
      'If the fibre light is off or red while the power light is on, the fibre path into the building is broken.',
      'Ask whether there has been any building work, a new floor, or anything pulled through a duct recently. It changes what the engineer brings.',
      'Raise the fault as a network-side loss of light and book the visit.',
    ],
    beforeBooking:
      'The ONT is powered and the fibre light is off or red. Nothing inside the building can fix a loss of light.',
    suggestedReason: 'ont-no-light',
    severity: 'critical',
  },
  {
    kind: 'ont-unreachable',
    match: /\bont\b[^.]*\b(unreachable|not (found|present|responding)|no response|absent)\b/i,
    meaning: 'The network cannot reach the fibre terminal at all — it is either off, unplugged, or has failed.',
    side: 'unclear',
    steps: [
      'Ring the customer and get the lights on the ONT described or photographed.',
      'No lights at all means power. Power light only means the fibre. Both lit means the terminal itself.',
      'Only book once the photo rules out power.',
    ],
    beforeBooking: 'A photo of the ONT lights, so the visit is not a wasted trip to a switched-off box.',
    suggestedReason: 'ont-damage',
    severity: 'critical',
  },
  {
    kind: 'disconnected-line',
    match: /\b(disconnect|open circuit|no continuity|line (open|disconnected)|cut)\b/i,
    meaning: 'The copper path is broken between the exchange and the building.',
    side: 'network',
    steps: [
      'Ask whether there has been any digging, scaffolding or building work nearby — it is usually the cause and it tells the engineer where to start.',
      'Check whether neighbours on the same route are affected. Several at once is a cable rather than one line.',
      'Raise the fault as a break in the external path.',
    ],
    beforeBooking: 'Nothing inside the building can repair a broken external path — this is a visit.',
    suggestedReason: 'copper-underground',
    severity: 'critical',
  },
  {
    kind: 'battery-contact',
    match: /\b(battery contact|foreign (battery|voltage)|earth fault|short|hr fault|high resistance)\b/i,
    meaning:
      'Water or a damaged joint in the copper path. Classically a wet joint after rain, and it usually gets worse.',
    side: 'network',
    steps: [
      'Ask how long it has been happening and whether it tracks the weather. "Worse when it rains" is the giveaway.',
      'Have the customer test at the master socket with a known-good router, to take internal wiring out of the picture.',
      'Raise the fault as a suspected faulty joint.',
    ],
    beforeBooking: 'A test at the master socket, so internal wiring cannot be blamed for a fault in the street.',
    suggestedReason: 'copper-joint',
    severity: 'critical',
  },
  {
    kind: 'no-dial-tone',
    match: /\bno dial ?tone\b/i,
    meaning: 'No dial tone at the exchange test. Something between the exchange and the socket is not carrying.',
    side: 'unclear',
    steps: [
      'Have the customer plug a handset directly into the test socket behind the faceplate of the master socket.',
      'Dial tone there and none elsewhere is internal wiring, which is the customer’s side.',
      'No dial tone at the test socket is the provider’s side. Raise it as such.',
    ],
    beforeBooking: 'A test at the test socket behind the master faceplate — it is the line that decides who pays.',
    suggestedReason: 'no-dial-tone',
    severity: 'critical',
  },
  {
    kind: 'internal-wiring',
    match: /\b(internal|customer (side|premises|equipment)|cpe|home environment|extension|faceplate)\b/i,
    meaning:
      'The test puts the fault inside the building — wiring, extensions, or the customer’s own equipment rather than the network.',
    side: 'customer',
    steps: [
      'Have the customer test at the master socket with a known-good router, nothing else plugged in.',
      'If it works there, the problem is an extension, a faceplate or their own kit — and a provider visit will be charged as no fault found.',
      'If it still fails at the master socket with a known-good router, that contradicts the test: re-run it and, if it holds, raise it anyway with the master-socket result stated.',
    ],
    beforeBooking:
      'A master-socket test with a known-good router that still fails. Without it a visit is billed as no fault found.',
    suggestedReason: 'internal-wiring',
    severity: 'warning',
  },
  {
    kind: 'snr-low',
    match: /\b(snr|signal[- ]to[- ]noise|noise margin)\b/i,
    meaning:
      'The noise margin is tight. The line is syncing but has little headroom, which is what produces drops rather than a hard failure.',
    side: 'unclear',
    steps: [
      'Ask what changed. New equipment, a new TV, a phone charger in the same socket — noise usually arrives with something.',
      'Have them test at the master socket with everything else unplugged, including any extension leads.',
      'Check whether the provider has banded the line: a low profile after repeated drops is the cause of the slow speed, not the fault itself.',
      'If it is stable at the master socket, the problem is inside. If not, raise it as a line fault.',
    ],
    suggestedReason: 'intermittent-drops',
    severity: 'warning',
  },
  {
    kind: 'retrains',
    match: /\b(retrain|resync|re-?sync|drop(ped|s)?|unstable|flapping)\b/i,
    meaning: 'The line is dropping and re-establishing. Repeated drops get the line banded, which caps its speed.',
    side: 'unclear',
    steps: [
      'Get the number of drops and when they cluster. Evenings point at noise; office hours at something being switched on.',
      'Test at the master socket with a known-good router for at least a few hours if the customer can.',
      'Where a 5G backup is fitted, check it has not been carrying the traffic and masking the drops.',
      'Raise it as repeated drops with the count and the times — a supplier will reject "keeps dropping" without them.',
    ],
    suggestedReason: 'intermittent-drops',
    severity: 'warning',
  },
  {
    kind: 'exchange',
    match: /\b(exchange|msan|dslam|head ?end|olt)\b/i,
    meaning: 'The test points at the provider’s own equipment rather than the line or the building.',
    side: 'network',
    steps: [
      'Check the provider’s network status first — equipment faults are often already known and a per-site fault gets closed as a duplicate.',
      'If nothing is published, raise it naming the equipment the test named.',
    ],
    beforeBooking: 'Usually no visit to the premises at all — the work is at the exchange.',
    suggestedReason: 'exchange',
    severity: 'critical',
  },
  {
    kind: 'cabinet',
    match: /\b(cabinet|pcp|scp|street ?cab)\b/i,
    meaning: 'The test points at the street cabinet.',
    side: 'network',
    steps: [
      'Check the provider’s network status: a cabinet fault affects everybody on it.',
      'Raise it naming the cabinet from the Openreach detail on the site report.',
    ],
    beforeBooking: 'The work is at the cabinet, so nobody necessarily needs to be in the building.',
    suggestedReason: 'cabinet',
    severity: 'critical',
  },
  {
    kind: 'authentication',
    match: /\b(auth|radius|credential|password|username|pppoe|ipoe)\b/i,
    meaning:
      'The line is up but the session is not authenticating. This is nearly always the credentials in the router, not the line.',
    side: 'customer',
    steps: [
      'Check the username on the router against the one on this record — a copied config from another site is the usual cause.',
      'Re-enter the password. It is not recoverable from the router, so it has to come from here.',
      'If the credentials are right and it still fails, the fault is at the provider and worth raising as a provisioning error.',
    ],
    suggestedReason: 'provisioning',
    severity: 'warning',
  },
  {
    kind: 'pass',
    match: /\b(no fault found|test pass(ed)?|within (spec|tolerance)|nff)\b/i,
    meaning: 'The test found nothing wrong with the line itself.',
    side: 'customer',
    steps: [
      'Believe it, at least at first. A clean line test with a customer reporting a fault almost always means the problem is between the master socket and the desk.',
      'Check the router is powered and the WAN light is on. Ask for a photo.',
      'Check the customer’s own switch, firewall and Wi-Fi before anything else.',
      'Where a 5G backup is fitted, check whether it has failed over — the line can be fine and the site still be on the backup.',
      'Do not raise a fault on a clean test without something concrete that contradicts it. It will come back as no fault found and be charged.',
    ],
    severity: 'info',
  },
];

/**
 * Everything the test is saying, translated.
 *
 * Reads the outcome, the summary, the detail and every metric, because
 * providers put the useful sentence in a different field each time. Findings
 * are deduplicated by kind and ordered by severity, and a test that produced
 * nothing recognisable says so rather than inventing an interpretation.
 */
export function translateTest(result: LineTestResult): TestFinding[] {
  const haystack = [
    result.outcome,
    result.summary ?? '',
    result.detail ?? '',
    result.faultLocation ?? '',
    ...(result.recommendations ?? []),
    ...result.metrics.map((m) => `${m.label} ${m.value}`),
  ].join(' \n ');

  const found = new Map<string, TestFinding>();
  for (const pattern of PATTERNS) {
    if (!pattern.match.test(haystack)) continue;
    if (found.has(pattern.kind)) continue;
    found.set(pattern.kind, {
      kind: pattern.kind,
      meaning: pattern.meaning,
      side: pattern.side,
      steps: pattern.steps,
      ...(pattern.beforeBooking ? { beforeBooking: pattern.beforeBooking } : {}),
      ...(pattern.suggestedReason ? { suggestedReason: pattern.suggestedReason } : {}),
      severity: pattern.severity,
    });
  }

  const order = { critical: 0, warning: 1, info: 2 } as const;
  const findings = [...found.values()].sort((a, b) => order[a.severity] - order[b.severity]);

  // A clean pass alongside a critical finding is contradictory; the critical
  // one is what matters and the pass would only reassure somebody wrongly.
  if (findings.length > 1 && findings.some((f) => f.severity === 'critical')) {
    return findings.filter((f) => f.kind !== 'pass');
  }

  if (findings.length === 0) {
    return [
      {
        kind: 'untranslated',
        meaning:
          'Nothing in this result matched a known pattern, so it has not been interpreted. The raw output is below — read it rather than trusting a summary that does not exist.',
        side: 'unclear',
        steps: [
          'Read the raw result. Providers word the same fault differently and this list does not know every phrasing.',
          'If it turns out to be a common one, it is worth adding so nobody has to work it out twice.',
        ],
        severity: 'info',
      },
    ];
  }

  return findings;
}

/** A reading the provider flagged, for the "readings" block. */
export const flaggedMetrics = (metrics: TestMetric[]): TestMetric[] =>
  metrics.filter((m) => m.verdict === 'fail' || m.verdict === 'warn');

/** Which side the findings point at, for the fault form's internal/external question. */
export function overallSide(findings: readonly TestFinding[]): Side {
  const sides = new Set(findings.filter((f) => f.severity !== 'info').map((f) => f.side));
  if (sides.size === 1) return [...sides][0]!;
  if (sides.has('network') && !sides.has('customer')) return 'network';
  if (sides.has('customer') && !sides.has('network')) return 'customer';
  return 'unclear';
}
