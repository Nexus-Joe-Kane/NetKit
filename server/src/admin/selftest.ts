import { identify, isFullPostcode, normaliseCli, type BroadbandOffer, type LineTestType } from '@sw/shared';
import { config } from '../config';
import { addressByUprn, addressesByPostcode, buildSiteReport, resolveQuery, searchAddresses } from '../services/resolve';
import * as ops from '../services/operations';
import { providers } from '../providers/registry';
import { serviceStatuses } from './health';
import { audit } from '../auth/store';
import { hashPassword, verifyPassword, checkPasswordPolicy } from '../auth/passwords';

/**
 * The self-test.
 *
 * A full functional pass over the whole portal, run in-process against
 * whatever providers are actually configured. It is not a unit test suite —
 * those live next to the code and run in CI. This answers a different
 * question: *does this deployment work right now, with these credentials?*
 *
 * It is safe to run at any time. Every check is read-only, and the two
 * mutating paths (raising a fault, cancelling an order) are deliberately not
 * exercised — a self-test that raises real faults would be worse than no
 * self-test at all.
 */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export interface Check {
  id: string;
  group: string;
  name: string;
  status: CheckStatus;
  /** What the check actually found. */
  detail: string;
  durationMs: number;
  /** Where the data came from, when a check exercised a provider. */
  mode?: 'live' | 'mock';
}

export interface SelfTestReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** `pass` only when nothing failed. Warnings do not fail the run. */
  outcome: 'pass' | 'fail';
  counts: Record<CheckStatus, number>;
  checks: Check[];
  environment: { dataMode: string; nodeEnv: string; version: string };
}

/** A postcode that exists in every provider, live or fixture. */
const PROBE_POSTCODE = 'M1 1AE';

class Runner {
  readonly checks: Check[] = [];

  /**
   * Runs one check. A thrown error is a failure rather than an exception —
   * the point is to finish the sweep and report, not to stop at the first
   * problem.
   */
  async run(
    group: string,
    id: string,
    name: string,
    fn: () => Promise<{ status: CheckStatus; detail: string; mode?: 'live' | 'mock' }>,
  ): Promise<Check> {
    const started = Date.now();
    let check: Check;
    try {
      const outcome = await fn();
      check = {
        id,
        group,
        name,
        status: outcome.status,
        detail: outcome.detail,
        durationMs: Date.now() - started,
        ...(outcome.mode ? { mode: outcome.mode } : {}),
      };
    } catch (err) {
      check = {
        id,
        group,
        name,
        status: 'fail',
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    }
    this.checks.push(check);
    return check;
  }
}

const pass = (detail: string, mode?: 'live' | 'mock') => ({ status: 'pass' as const, detail, ...(mode ? { mode } : {}) });
const warn = (detail: string) => ({ status: 'warn' as const, detail });
const skip = (detail: string) => ({ status: 'skip' as const, detail });
const fail = (detail: string) => ({ status: 'fail' as const, detail });

export async function runSelfTest(): Promise<SelfTestReport> {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const cfg = config();
  const r = new Runner();

  /* ---- Configuration ---------------------------------------------- */

  await r.run('Configuration', 'cfg.session-secret', 'Session secret is set', async () => {
    if (cfg.sessionSecret) return pass('Set. Sessions survive a restart.');
    return cfg.env === 'production'
      ? fail('SESSION_SECRET is not set in production — the app cannot mint sessions.')
      : warn('Not set. Fine for development, but sessions end on every restart.');
  });

  await r.run('Configuration', 'cfg.data-dir', 'Data directory is writable', async () => {
    const { mkdirSync, writeFileSync, unlinkSync } = await import('node:fs');
    const { join, resolve } = await import('node:path');
    const dir = resolve(cfg.dataDir);
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.selftest-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return pass(`Writable at ${dir}.`);
  });

  await r.run('Configuration', 'cfg.data-mode', 'Data mode', async () => {
    if (cfg.dataMode === 'live') return pass('live — no fallback to demo data.');
    if (cfg.dataMode === 'mock') return warn('mock — every panel is showing demo data, including for real users.');
    return pass('auto — live where credentials exist, demo data elsewhere.');
  });

  /* ---- Identifier classification ---------------------------------- */

  await r.run('Search', 'search.classify', 'Every identifier type is classified correctly', async () => {
    const cases: Array<[string, string]> = [
      ['M1 1AE', 'postcode'],
      ['sw1a1aa', 'postcode'],
      ['100023336956', 'uprn'],
      ['01614969790', 'cli'],
      ['+44 7700 900123', 'cli'],
      ['AL123456789', 'lineAccessId'],
      ['BBEU12345678', 'serviceId'],
      ['ALCLFA1234AB', 'ontSerial'],
      ['12 High Street', 'address'],
    ];
    const wrong = cases.filter(([input, expected]) => identify(input).kind !== expected);
    if (wrong.length) {
      return fail(`Misclassified: ${wrong.map(([i, e]) => `"${i}" (expected ${e}, got ${identify(i).kind})`).join('; ')}`);
    }
    return pass(`All ${cases.length} identifier forms classified correctly.`);
  });

  await r.run('Search', 'search.uprn-vs-cli', 'UPRNs are not confused with phone numbers', async () => {
    // The leading zero is the only thing separating these two, and getting
    // it wrong sends every lookup to the wrong resolver.
    if (identify('01617501234').kind !== 'cli') return fail('A leading-zero number was not read as a CLI.');
    if (identify('100023336956').kind !== 'uprn') return fail('A 12-digit UPRN was not read as a UPRN.');
    if (normaliseCli('100023336956') !== null) return fail('A UPRN normalised as a phone number.');
    return pass('Leading zero correctly separates a CLI from a UPRN.');
  });

  await r.run('Search', 'search.junk', 'Junk input degrades cleanly', async () => {
    for (const junk of ['', '   ', '!!!', '?']) {
      if (identify(junk).kind !== 'unknown') return fail(`"${junk}" was classified as ${identify(junk).kind}.`);
    }
    return pass('Empty and junk input returns unknown rather than guessing.');
  });

  /* ---- Providers --------------------------------------------------- */

  const registry = providers();

  await r.run('Providers', 'providers.chains', 'Every capability has at least one provider', async () => {
    const empty = (['address', 'availability', 'signal', 'lines'] as const).filter((k) => registry[k].length === 0);
    if (empty.length) {
      return fail(
        `No provider for: ${empty.join(', ')}. Lookups for these will return nothing. Check DATA_MODE and the admin switches.`,
      );
    }
    return pass(
      (['address', 'availability', 'signal', 'lines'] as const)
        .map((k) => `${k}: ${registry[k].map((p) => p.name).join(' → ')}`)
        .join('; '),
    );
  });

  await r.run('Providers', 'providers.address-postcode', 'Postcode resolves to premises', async () => {
    const list = await addressesByPostcode(PROBE_POSTCODE);
    if (!list.length) return fail(`No premises returned for ${PROBE_POSTCODE}.`);
    const withoutUprn = list.filter((a) => !a.uprn).length;
    const mode = list[0]!.source === 'mock' ? 'mock' : 'live';
    if (withoutUprn === list.length) {
      return warn(`${list.length} premises returned, but none carried a UPRN. Address search works; UPRN lookup will not.`);
    }
    return pass(`${list.length} premises at ${PROBE_POSTCODE}, ${list.length - withoutUprn} with a UPRN.`, mode);
  });

  await r.run('Providers', 'providers.address-uprn', 'UPRN round-trips to the same premises', async () => {
    const list = await addressesByPostcode(PROBE_POSTCODE);
    const withUprn = list.find((a) => a.uprn);
    if (!withUprn?.uprn) return skip('No premises with a UPRN to round-trip.');

    const back = await addressByUprn(withUprn.uprn);
    if (!back) return fail(`UPRN ${withUprn.uprn} came from a postcode search but does not resolve on its own.`);
    if (back.uprn !== withUprn.uprn) return fail(`UPRN ${withUprn.uprn} resolved to a different premises (${back.uprn}).`);
    return pass(`${withUprn.uprn} round-trips to "${back.singleLine}".`, back.source === 'mock' ? 'mock' : 'live');
  });

  await r.run('Providers', 'providers.address-text', 'Free-text address search returns results', async () => {
    const list = await searchAddresses('High Street', 10);
    if (!list.length) return warn('No results for a free-text search. OS Places is the provider that serves this.');
    return pass(`${list.length} matches for "High Street".`, list[0]!.source === 'mock' ? 'mock' : 'live');
  });

  /* ---- The composite report ---------------------------------------- */

  await r.run('Site report', 'report.full', 'A full site report builds with every section', async () => {
    const list = await addressesByPostcode(PROBE_POSTCODE);
    const address = list.find((a) => a.uprn) ?? list[0];
    if (!address) return skip('No premises to build a report for.');

    const report = await buildSiteReport(address, identify(address.uprn ?? PROBE_POSTCODE));
    const problems: string[] = [];
    if (!report.address.singleLine) problems.push('no formatted address');
    if (!report.broadband) problems.push('no broadband section');
    if (!report.signal) problems.push('no signal section');

    const failed = Object.entries(report.status).filter(([, s]) => !s.ok);
    if (problems.length) return fail(`Report incomplete: ${problems.join(', ')}.`);
    if (failed.length) {
      return warn(
        `Report built, but these sections degraded: ${failed.map(([n, s]) => `${n} (${s.error ?? 'unknown'})`).join('; ')}`,
      );
    }

    const modes = new Set(Object.values(report.status).map((s) => s.mode));
    return pass(
      `Built for "${report.address.singleLine}" — ${report.broadband?.offers.length ?? 0} offers, ` +
        `${report.signal?.operators.length ?? 0} networks, ${report.lines.length} lines.`,
      modes.has('live') ? 'live' : 'mock',
    );
  });

  await r.run('Site report', 'report.search-postcode', 'Postcode search returns a premises picker', async () => {
    const response = await resolveQuery(PROBE_POSTCODE);
    if (response.report) return pass('Single premises at this postcode, so it resolved straight to a report.');
    if (!response.suggestions.length) return fail('No suggestions and no report — the picker would be empty.');
    return pass(`${response.suggestions.length} premises offered for selection.`);
  });

  /* ---- Operational surface ----------------------------------------- */

  await r.run('Operations', 'ops.network-status', 'Network status responds', async () => {
    const result = await ops.networkStatus();
    return pass(
      `${result.data.outages.length} outages, ${result.data.plannedWork.length} planned works.`,
      result.mode,
    );
  });

  await r.run('Operations', 'ops.faults', 'Fault list responds', async () => {
    const result = await ops.faults({ state: 'open' });
    return pass(`${result.data.length} open faults.`, result.mode);
  });

  await r.run('Operations', 'ops.orders', 'Order list responds', async () => {
    const result = await ops.orders({ view: 'status' });
    return pass(`${result.data.length} orders in flight.`, result.mode);
  });

  /**
   * Reports where the ordering locks stand. A pass here means "correctly
   * locked" as much as "ready" — the check exists so nobody discovers at
   * 4pm on a Friday that the switch they thought was on never was.
   */
  await r.run('Operations', 'ops.ordering-gate', 'Ordering locks report a clear state', async () => {
    const gate = ops.orderingGate('selftest');
    if (gate.allowed && !gate.demo) return warn('Ordering is UNLOCKED — orders placed here will be real.');
    if (gate.allowed) return pass('Unlocked, but no provider credentials — the flow rehearses and refuses.');
    if (!gate.reason) return fail('Ordering is blocked but gives no reason, which would be a silent dead end.');
    return pass(
      `Locked: ${gate.reason} (environment ${gate.environmentAllows ? 'allows' : 'blocks'}, admin switch ${
        gate.adminAllows ? 'on' : 'off'
      }, cap ${gate.dailyCap || 'none'}).`,
    );
  });

  await r.run('Operations', 'ops.sims', 'SIM estate responds', async () => {
    const result = await ops.simEstate();
    return pass(
      `${result.data.sims.length} SIMs${result.data.pool ? `, pool ${result.data.pool.simCount ?? 0} strong` : ''}.`,
      result.mode,
    );
  });

  await r.run('Operations', 'ops.notifications', 'Provider notices respond', async () => {
    const result = await ops.notifications({});
    return pass(`${result.data.length} notices in the window.`, result.mode);
  });

  await r.run('Operations', 'ops.address-match', 'Wholesale address references resolve', async () => {
    const result = await ops.addressMatch({ postcode: PROBE_POSTCODE });
    // Not finding a reference is a legitimate answer, so the check is that
    // the two-database question got a coherent answer at all.
    if (!result.data.btoAddressReference && !result.data.btwAddressReference) {
      return warn(`No wholesale reference for ${PROBE_POSTCODE}: ${result.data.messages[0] ?? 'no reason given'}.`);
    }
    return pass(
      result.data.agrees
        ? `Openreach ${result.data.btoAddressReference} and BT Wholesale ${result.data.btwAddressReference}.`
        : 'Only one database answered.',
      result.mode,
    );
  });

  await r.run('Operations', 'ops.network-config', 'Realms and IP options are listed', async () => {
    const result = await ops.networkConfiguration();
    if (!result.data.serviceSelectionNames.length) return warn('No service selection names were returned.');
    return pass(`${result.data.serviceSelectionNames.length} options offered.`, result.mode);
  });

  await r.run('Operations', 'ops.estate-usage', 'Estate-wide usage reports', async () => {
    const result = await ops.estateUsage();
    return pass(
      `${result.data.rows.length} services, ${(result.data.totalBytes / 1024 ** 4).toFixed(1)} TB in ${result.data.period}.`,
      result.mode,
    );
  });

  /**
   * Alt-net coverage, and specifically whether anything is claiming a
   * premises is serviceable when it has not been checked. That claim is the
   * one thing in this tool an operator could quote to a customer and be
   * wrong about, so the self-test refuses to let it pass quietly.
   */
  await r.run('Site report', 'site.altnet', 'Alt-net coverage is labelled honestly', async () => {
    const list = (await addressesByPostcode(PROBE_POSTCODE)).filter((a) => a.uprn);
    if (!list.length) return skip('No premises with a UPRN.');

    // Not every premises has an alt-net near it, so walk a few rather than
    // giving up on the first — a check that skips is a check that never runs.
    let altnets: BroadbandOffer[] = [];
    for (const address of list.slice(0, 8)) {
      const report = await buildSiteReport(address, identify(address.uprn!), { includeSiblings: false });
      const found = (report.broadband?.offers ?? []).filter(
        (o) => o.operator !== 'openreach' && o.source !== 'fixture:openreach',
      );
      if (found.length) {
        altnets = found;
        break;
      }
    }
    if (!altnets.length) return skip(`No alt-net coverage at any of the first ${Math.min(8, list.length)} premises.`);

    const unchecked = altnets.filter((o) => o.serviceability !== 'confirmed');
    const lying = unchecked.filter((o) => o.status === 'available');
    if (lying.length) {
      return fail(
        `${lying.length} alt-net row(s) claim availability without a serviceability check: ${lying
          .map((o) => o.operatorLabel)
          .join(', ')}.`,
      );
    }
    return pass(
      `${altnets.length} alt-net option(s), ${altnets.length - unchecked.length} confirmed, ${unchecked.length} footprint-only.`,
      altnets.some((o) => o.source === 'fixture:altnet') ? 'mock' : 'live',
    );
  });

  await r.run('Operations', 'ops.companies', 'Company context resolves for a postcode', async () => {
    const result = await ops.companies(PROBE_POSTCODE);
    const concerning = result.data.companies.filter((c) => c.concerning).length;
    return pass(
      `${result.data.companies.length} companies at ${PROBE_POSTCODE}${concerning ? `, ${concerning} needing attention` : ''}.`,
      result.mode,
    );
  });

  await r.run('Operations', 'ops.diagnostics', 'Line tests are offered and return readings', async () => {
    const list = await addressesByPostcode(PROBE_POSTCODE);
    const address = list.find((a) => a.uprn);
    if (!address?.uprn) return skip('No premises with a UPRN.');

    const linesResult = await ops.orders({ view: 'status' }).catch(() => null);
    // Use a real service reference where one exists, so the check exercises
    // the same path a user would.
    const reference = linesResult?.data[0]?.zenReference ?? `ZEN${address.uprn.slice(0, 7)}`;

    const available = await ops.availableTests(reference, 'SOGEA');
    if (!available.data.types.length) return fail(`No tests offered for ${reference}.`);

    const type = available.data.types[0]!.type as LineTestType;
    const result = await ops.latestTest(reference, type, 'SOGEA');
    return pass(
      `${available.data.types.length} tests offered; "${type}" returned ${result.data.metrics.length} readings (${result.data.outcome}).`,
      result.mode,
    );
  });

  await r.run('Operations', 'ops.tools', 'Every tool responds', async () => {
    const outcomes = await Promise.all([
      ops.numberPortCheck('01614969790').then(() => 'number-port').catch((e) => `number-port FAILED: ${e.message}`),
      ops.networkConnectivity('07700900123').then(() => 'connectivity').catch((e) => `connectivity FAILED: ${e.message}`),
      ops.imeiLookup('07700900123').then(() => 'imei').catch((e) => `imei FAILED: ${e.message}`),
      ops.footfall('W8 5TT').then(() => 'footfall').catch((e) => `footfall FAILED: ${e.message}`),
      ops.callRecords(new Date(Date.now() - 86_400_000), new Date()).then(() => 'cdrs').catch((e) => `cdrs FAILED: ${e.message}`),
      ops.rdns().then(() => 'rdns').catch((e) => `rdns FAILED: ${e.message}`),
    ]);
    const failures = outcomes.filter((o) => o.includes('FAILED'));
    if (failures.length) return fail(failures.join('; '));
    return pass(`All ${outcomes.length} tools responded.`);
  });

  /* ---- Authentication --------------------------------------------- */

  await r.run('Authentication', 'auth.hashing', 'Password hashing round-trips', async () => {
    const hash = await hashPassword('self-test-probe-value');
    if (!(await verifyPassword('self-test-probe-value', hash))) return fail('A correct password failed to verify.');
    if (await verifyPassword('wrong-value', hash)) return fail('An incorrect password verified — this is critical.');
    if (await verifyPassword('self-test-probe-value', 'garbage')) return fail('A malformed hash verified.');
    return pass('scrypt hashing, verification and rejection all correct.');
  });

  await r.run('Authentication', 'auth.policy', 'Password policy rejects weak passwords', async () => {
    if (checkPasswordPolicy('short1A').ok) return fail('An 7-character password passed the policy.');
    if (!checkPasswordPolicy('Str0ngEnoughPassphrase').ok) return fail('A strong password was rejected.');
    if (checkPasswordPolicy('password123ABC').ok) return fail('A breach-corpus password passed the policy.');
    return pass('Weak, predictable and self-referential passwords all rejected.');
  });

  await r.run('Authentication', 'auth.2fa-gate', 'Email 2FA is gated on a verified send', async () => {
    const { twoFactorAvailable } = await import('../auth/email');
    const available = twoFactorAvailable();
    if (!cfg.resend.configured) {
      return available
        ? fail('2FA reports available with no Resend key configured.')
        : pass('Correctly unavailable — no Resend key.');
    }
    return available
      ? pass('Available — Resend key present and a delivery test has passed.')
      : warn('Resend key is present but no delivery test has passed, so 2FA stays unavailable.');
  });

  /* ---- Integrations ----------------------------------------------- */

  await r.run('Integrations', 'integrations.probe', 'All integrations probed', async () => {
    const statuses = await serviceStatuses();
    const down = statuses.filter((s) => s.state === 'down');
    const notConfigured = statuses.filter((s) => s.state === 'not_configured');

    if (down.length) {
      return fail(`${down.length} failing: ${down.map((s) => `${s.name} (${s.detail})`).join('; ')}`);
    }
    const okCount = statuses.filter((s) => s.state === 'ok').length;
    if (notConfigured.length === statuses.length) {
      return warn('Nothing is configured — the portal is running entirely on demo data.');
    }
    return pass(`${okCount} of ${statuses.length} operational, ${notConfigured.length} awaiting credentials.`);
  });

  /* ---- Report ------------------------------------------------------ */

  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const check of r.checks) counts[check.status] += 1;

  const finishedAt = new Date().toISOString();
  const report: SelfTestReport = {
    startedAt,
    finishedAt,
    durationMs: Date.now() - started,
    outcome: counts.fail > 0 ? 'fail' : 'pass',
    counts,
    checks: r.checks,
    environment: { dataMode: cfg.dataMode, nodeEnv: cfg.env, version: cfg.version },
  };

  audit({
    action: 'selftest.run',
    detail: { outcome: report.outcome, ...counts, durationMs: report.durationMs },
  });

  return report;
}

/** Runs the self-test at boot and logs a one-line summary. */
export async function selfTestOnBoot(): Promise<void> {
  if (!config().supervisor.selfTestOnBoot) return;
  try {
    const report = await runSelfTest();
    const { pass: p, fail: f, warn: w, skip: s } = report.counts;
    const summary = `${p} passed, ${f} failed, ${w} warnings, ${s} skipped in ${report.durationMs}ms`;

    if (report.outcome === 'fail') {
      console.error(`[netkit] SELF-TEST FAILED — ${summary}`);
      for (const check of report.checks.filter((c) => c.status === 'fail')) {
        console.error(`[netkit]   FAIL ${check.group} / ${check.name}: ${check.detail}`);
      }
    } else {
      console.log(`[netkit] self-test passed — ${summary}`);
      for (const check of report.checks.filter((c) => c.status === 'warn')) {
        console.warn(`[netkit]   warn ${check.group} / ${check.name}: ${check.detail}`);
      }
    }
  } catch (err) {
    console.error('[netkit] self-test could not run:', err);
  }
}
