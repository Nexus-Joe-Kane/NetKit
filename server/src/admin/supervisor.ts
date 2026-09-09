import { config } from '../config';
import { audit, isProviderEnabled, listUsers } from '../auth/store';
import { escalationEmail, recoveryEmail } from '../auth/email';
import { notifyChannel, sendNotice } from '../services/notify';
import { probeService, serviceStatuses, type ServiceStatus } from './health';
import { resetZenTokens } from '../providers/zen/client';
import { clearZenCaches } from '../providers/zen/adapters';
import { resetBtTokens } from '../providers/bt/client';
import { clearPostcodeCache } from '../providers/address/postcodesIo';
import { clearOsPlacesCache } from '../providers/address/osPlaces';
import { loadDataset } from '../providers/signal/ofcom';
import { clearReportCache } from '../services/resolve';
import { clearCompaniesCache } from '../providers/companies/companiesHouse';
import { clearOfcomBroadbandCache } from '../providers/coverage/ofcomBroadband';
import { clearOpenCellIdCache } from '../providers/signal/openCellId';
import { clearThinkbroadbandCache } from '../providers/altnet/thinkbroadband';
import { resetGiacomTokens } from '../providers/giacom/client';
import { clearZendeskCache } from '../providers/tickets/zendesk';
import { clearItGlueCache } from '../providers/docs/itGlue';
import { clearUnifiCache } from '../providers/network/unifi';
import { clearGiacomCaches } from '../providers/giacom/adapters';
import { sweepWatches } from '../services/watchSweep';
import { refreshIfStale } from '../services/clientIndex';

/**
 * The recovery supervisor.
 *
 * Probes every integration on an interval, and when one starts failing it
 * tries to fix it rather than only reporting it. Three mechanisms:
 *
 *   1. A **circuit breaker** stops NetKit hammering a dead upstream. After a
 *      run of failures the circuit opens and lookups go straight to the
 *      fallback, which keeps the portal fast instead of making every page
 *      wait for a timeout.
 *   2. **Recovery actions** per integration — re-mint an OAuth token, drop a
 *      poisoned cache, reload a dataset from disk. Most real failures are one
 *      of those three, and all three are safe to retry.
 *   3. **Exponential backoff** on reattempts, so a long outage costs almost
 *      nothing.
 *
 * The circuit is deliberately separate from the admin on/off switch: this
 * supervisor never overrides a human decision, and a human switch is never
 * quietly undone by automation.
 */

export type HealthState =
  | 'healthy'
  | 'degraded'
  | 'failing'
  | 'circuit_open'
  | 'recovering'
  | 'not_configured'
  | 'disabled';

export interface RecoveryAttempt {
  at: string;
  action: string;
  outcome: 'recovered' | 'still_failing' | 'error';
  detail?: string;
}

export interface IntegrationHealth {
  key: string;
  name: string;
  vendor: string;
  /** What it provides, carried through for the escalation email. */
  capability?: string;
  /** When the current run of failures began. */
  failingSince?: string;
  /** When a human was told, so they are told once per incident. */
  escalatedAt?: string;
  state: HealthState;
  consecutiveFailures: number
  consecutiveSuccesses: number;
  lastCheckedAt?: string;
  lastOkAt?: string;
  lastError?: string;
  latencyMs?: number;
  /** Circuit breaker state. */
  circuit: { open: boolean; openedAt?: string; nextAttemptAt?: string; backoffSeconds: number };
  /** What recovery has been tried, newest first. */
  recoveries: RecoveryAttempt[];
  /** Rolling probe history, newest last, for an availability figure. */
  history: Array<{ at: string; ok: boolean; ms: number }>;
  /** Percentage of probes in the window that succeeded. */
  availability?: number;
}

/** Consecutive failures before recovery is attempted. */
const FAILURES_TO_RECOVER = 2;
/** Consecutive failures before the circuit opens. */
const FAILURES_TO_OPEN = 3;
/** Successes needed while half-open before the circuit closes. */
const SUCCESSES_TO_CLOSE = 1;
const BACKOFF_LADDER_SECONDS = [30, 60, 120, 300, 900];
const HISTORY_LENGTH = 60;

const state = new Map<string, IntegrationHealth>();
let timer: NodeJS.Timeout | null = null;
let running = false;
let lastSweepAt: string | null = null;
let sweepCount = 0;

/* ------------------------------------------------------------------ *
 * Recovery actions
 * ------------------------------------------------------------------ */

interface RecoveryAction {
  name: string;
  run: () => void | Promise<void>;
}

/**
 * What to try for a given integration, in order. Every action here is
 * idempotent and safe to run against a healthy system — that matters,
 * because recovery runs unattended.
 */
function recoveryActionsFor(key: string): RecoveryAction[] {
  if (key.startsWith('zen-')) {
    return [
      {
        // By far the most common real cause: a token that expired, was
        // revoked, or was minted before a scope was granted.
        name: 'Re-mint the Zen OAuth token',
        run: () => resetZenTokens(),
      },
      {
        name: 'Drop cached Zen results',
        run: () => {
          clearZenCaches();
          clearReportCache();
        },
      },
    ];
  }

  if (key.startsWith('bt-')) {
    return [{ name: 'Re-mint the BT access token', run: () => resetBtTokens() }];
  }

  if (key === 'os-places') {
    return [{ name: 'Drop cached OS Places results', run: () => clearOsPlacesCache() }];
  }

  if (key.startsWith('giacom-')) {
    return [
      {
        // Same story as Zen: an expired, revoked or pre-scope token is the
        // most common real failure, and re-minting fixes it unnoticed.
        name: 'Re-mint the Giacom OAuth token',
        run: () => resetGiacomTokens(),
      },
      { name: 'Drop cached Giacom results', run: () => clearGiacomCaches() },
    ];
  }

  if (key === 'thinkbroadband') {
    return [{ name: 'Drop cached alt-net coverage', run: () => clearThinkbroadbandCache() }];
  }

  if (key === 'companies-house') {
    return [{ name: 'Drop cached company records', run: () => clearCompaniesCache() }];
  }

  if (key === 'postcodes-io') {
    return [{ name: 'Drop cached postcode geography', run: () => clearPostcodeCache() }];
  }

  if (key === 'ofcom-broadband') {
    return [{ name: 'Drop cached Ofcom predictions', run: () => clearOfcomBroadbandCache() }];
  }

  if (key === 'opencellid') {
    return [{ name: 'Drop cached cell sites', run: () => clearOpenCellIdCache() }];
  }

  if (key === 'ofcom-coverage') {
    return [
      {
        // A dataset that was mid-write when first read, or has since been
        // replaced with a new Ofcom release.
        name: 'Reload the Ofcom dataset from disk',
        run: () => {
          loadDataset(true);
        },
      },
    ];
  }

  if (key === 'resend') {
    // Nothing safe to retry: re-sending a test email unattended would spam
    // the admin's inbox every sweep.
    return [];
  }

  return [{ name: 'Drop cached lookup results', run: () => clearReportCache() }];
}

/* ------------------------------------------------------------------ *
 * State transitions
 * ------------------------------------------------------------------ */

const backoffFor = (failures: number): number =>
  BACKOFF_LADDER_SECONDS[Math.min(failures - FAILURES_TO_OPEN, BACKOFF_LADDER_SECONDS.length - 1)] ??
  BACKOFF_LADDER_SECONDS[BACKOFF_LADDER_SECONDS.length - 1]!;

function blank(status: ServiceStatus): IntegrationHealth {
  return {
    key: status.key,
    name: status.name,
    vendor: status.vendor,
    capability: status.capability,
    state: 'healthy',
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    circuit: { open: false, backoffSeconds: 0 },
    recoveries: [],
    history: [],
  };
}

/** Maps a probe result onto a health state, respecting the circuit. */
function stateFrom(status: ServiceStatus, health: IntegrationHealth): HealthState {
  if (status.state === 'disabled') return 'disabled';
  if (status.state === 'not_configured') return 'not_configured';
  if (health.circuit.open) return 'circuit_open';
  if (status.state === 'ok') return 'healthy';
  if (status.state === 'degraded') return 'degraded';
  return 'failing';
}

function record(health: IntegrationHealth, ok: boolean, ms: number): void {
  health.history.push({ at: new Date().toISOString(), ok, ms });
  if (health.history.length > HISTORY_LENGTH) health.history.shift();
  const considered = health.history.filter((h) => h.ok !== undefined);
  health.availability = considered.length
    ? Math.round((considered.filter((h) => h.ok).length / considered.length) * 100)
    : undefined;
}

/* ------------------------------------------------------------------ *
 * A single sweep
 * ------------------------------------------------------------------ */

export interface SweepResult {
  at: string;
  checked: number;
  healthy: number;
  failing: number;
  recovered: string[];
  circuitsOpened: string[];
  circuitsClosed: string[];
  /** True when a sweep was already in flight and this one stood down. */
  skipped?: boolean;
}

/**
 * Probes everything once, then attempts recovery on anything failing.
 * Safe to call concurrently — overlapping sweeps are skipped rather than
 * queued, because a slow upstream should not build a backlog of probes.
 */
export async function sweep(): Promise<SweepResult> {
  if (running) {
    return {
      at: new Date().toISOString(),
      checked: 0,
      healthy: 0,
      failing: 0,
      recovered: [],
      circuitsOpened: [],
      circuitsClosed: [],
      skipped: true,
    };
  }
  running = true;

  const result: SweepResult = {
    at: new Date().toISOString(),
    checked: 0,
    healthy: 0,
    failing: 0,
    recovered: [],
    circuitsOpened: [],
    circuitsClosed: [],
  };

  try {
    const statuses = await serviceStatuses();
    result.checked = statuses.length;

    for (const status of statuses) {
      const health = state.get(status.key) ?? blank(status);
      state.set(status.key, health);
      health.name = status.name;
      health.vendor = status.vendor;
      health.capability = status.capability;
      health.lastCheckedAt = status.checkedAt;
      if (status.latencyMs != null) health.latencyMs = status.latencyMs;

      // Nothing to supervise for an unconfigured or switched-off integration.
      if (status.state === 'not_configured' || status.state === 'disabled') {
        health.state = status.state === 'disabled' ? 'disabled' : 'not_configured';
        health.consecutiveFailures = 0;
        health.circuit = { open: false, backoffSeconds: 0 };
        continue;
      }

      const ok = status.state === 'ok';
      record(health, ok, status.latencyMs ?? 0);

      if (ok) {
        health.consecutiveSuccesses += 1;
        health.consecutiveFailures = 0;
        health.lastOkAt = status.checkedAt;
        delete health.lastError;
        result.healthy += 1;

        // Close a circuit once it has proved itself.
        if (health.circuit.open && health.consecutiveSuccesses >= SUCCESSES_TO_CLOSE) {
          health.circuit = { open: false, backoffSeconds: 0 };
          result.circuitsClosed.push(status.key);
          audit({
            action: 'supervisor.circuit_closed',
            detail: { key: status.key, name: status.name },
          });
        }
        // If a person was told about this, tell them it is back.
        if (health.escalatedAt && health.failingSince) {
          const downForMinutes = Math.max(
            1,
            Math.round((Date.now() - new Date(health.failingSince).getTime()) / 60_000),
          );
          void notifyAdmins(recoveryEmail({ name: health.name, downForMinutes }), 'supervisor.escalation_cleared', {
            key: status.key,
            downForMinutes,
          });
          delete health.escalatedAt;
        }
        delete health.failingSince;

        health.state = 'healthy';
        continue;
      }

      // ---- Failing --------------------------------------------------
      health.consecutiveSuccesses = 0;
      health.consecutiveFailures += 1;
      health.lastError = status.detail;
      health.failingSince ??= new Date().toISOString();
      result.failing += 1;
      health.state = status.state === 'degraded' ? 'degraded' : 'failing';

      // A degraded integration is still answering, so it is not worth
      // opening a circuit or re-minting anything over.
      if (status.state === 'degraded') continue;

      // One failure is a blip and not worth re-minting tokens over; from the
      // second, try to fix it — which gives recovery a chance before the
      // breaker trips at the third.
      if (health.consecutiveFailures >= FAILURES_TO_RECOVER) {
        const recovered = await attemptRecovery(health);
        if (recovered) {
          result.recovered.push(status.key);
          result.healthy += 1;
          result.failing -= 1;
          continue;
        }
      }

      if (health.consecutiveFailures >= FAILURES_TO_OPEN && !health.circuit.open) {
        const backoffSeconds = backoffFor(health.consecutiveFailures);
        health.circuit = {
          open: true,
          openedAt: new Date().toISOString(),
          nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
          backoffSeconds,
        };
        health.state = 'circuit_open';
        result.circuitsOpened.push(status.key);
        audit({
          action: 'supervisor.circuit_opened',
          detail: {
            key: status.key,
            name: status.name,
            failures: health.consecutiveFailures,
            backoffSeconds,
            error: status.detail,
          },
        });
      } else if (health.circuit.open) {
        // Still failing while open — extend the backoff.
        const backoffSeconds = backoffFor(health.consecutiveFailures);
        health.circuit.backoffSeconds = backoffSeconds;
        health.circuit.nextAttemptAt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
        health.state = 'circuit_open';
      }

      // Recovery has had its chance and the breaker is doing its job; past a
      // point this is no longer something automation can fix.
      await maybeEscalate(health);
    }

    lastSweepAt = result.at;
    sweepCount += 1;

    // Watched premises ride the same interval rather than a timer of their
    // own. They are due once a day and the supervisor already runs, so a
    // second scheduler would be two things to reason about instead of one.
    // Never allowed to fail the sweep: the recovery board matters more than
    // a background re-check.
    try {
      await sweepWatches();
    } catch {
      // A failing watch records its own error against the watch itself.
    }

    // And the client index, on the same reasoning: it is due once a day, and
    // it only rebuilds when it is actually stale. Each source records its own
    // outcome, so a failure here has somewhere better to be reported than
    // the recovery board.
    try {
      refreshIfStale();
    } catch {
      // Started rather than awaited; it cannot fail the sweep.
    }
  } finally {
    running = false;
  }

  return result;
}

/**
 * Runs each recovery action in turn, re-probing after each. Stops at the
 * first one that works, so a healthy system is disturbed as little as
 * possible.
 */
async function attemptRecovery(health: IntegrationHealth): Promise<boolean> {
  const actions = recoveryActionsFor(health.key);
  if (!actions.length) return false;

  health.state = 'recovering';

  for (const action of actions) {
    const attempt: RecoveryAttempt = { at: new Date().toISOString(), action: action.name, outcome: 'still_failing' };

    try {
      await action.run();
      // Re-probe just this integration to see whether the action helped.
      const after = await probeService(health.key);

      if (after?.state === 'ok') {
        attempt.outcome = 'recovered';
        health.recoveries.unshift(attempt);
        health.recoveries = health.recoveries.slice(0, 10);
        health.consecutiveFailures = 0;
        health.consecutiveSuccesses = 1;
        health.lastOkAt = new Date().toISOString();
        delete health.lastError;
        health.state = 'healthy';
        if (health.circuit.open) health.circuit = { open: false, backoffSeconds: 0 };

        audit({
          action: 'supervisor.recovered',
          detail: { key: health.key, name: health.name, action: action.name },
        });
        return true;
      }

      attempt.detail = after?.detail;
    } catch (err) {
      attempt.outcome = 'error';
      attempt.detail = err instanceof Error ? err.message : String(err);
    }

    health.recoveries.unshift(attempt);
    health.recoveries = health.recoveries.slice(0, 10);
  }

  health.state = health.circuit.open ? 'circuit_open' : 'failing';
  return false;
}

/**
 * Forgets everything every provider had cached.
 *
 * Called when a credential changes. A cached token, a cached address or a
 * cached "not configured" answer taken under the old key is worse than no
 * cache at all: the integration would go on failing, or go on working, for
 * as long as the entry lived, and the operator would reasonably conclude the
 * new key was wrong.
 */
export function clearAllProviderCaches(): void {
  resetZenTokens();
  clearZenCaches();
  resetBtTokens();
  resetGiacomTokens();
  clearGiacomCaches();
  clearPostcodeCache();
  clearOsPlacesCache();
  clearCompaniesCache();
  clearOfcomBroadbandCache();
  clearOpenCellIdCache();
  clearThinkbroadbandCache();
  clearZendeskCache();
  clearItGlueCache();
  clearUnifiCache();
  clearReportCache();
}

/* ------------------------------------------------------------------ *
 * Escalation
 * ------------------------------------------------------------------ */

/**
 * Tells every active administrator. Failures are logged, never thrown.
 *
 * Goes through the notice router rather than straight to the mailer, so an
 * escalation becomes a Zendesk ticket where Zendesk is configured — which is
 * what an escalation wants to be. It is a thing somebody has to pick up, and
 * a ticket can be assigned and closed where an email can only be read.
 *
 * There is no early return when nothing is configured: the router records the
 * escalation in the audit log with the reason it could not be sent, which is
 * how a deployment with no channel at all still leaves a trail.
 */
async function notifyAdmins(
  message: { subject: string; html: string; text: string },
  action: string,
  detail: Record<string, unknown>,
): Promise<void> {
  const admins = listUsers().filter((u) => u.role === 'admin' && !u.disabled);

  await sendNotice(
    {
      subject: message.subject,
      text: message.text,
      html: message.html,
      recipients: admins.map((a) => a.email),
      tags: ['netkit-supervisor'],
      priority: action === 'supervisor.escalated' ? 'high' : 'low',
    },
    action,
    detail,
  );
}

/** Which channel escalations would use right now, for the status board. */
export const escalationChannel = notifyChannel;

/**
 * Tells a human once an integration has been failing long enough that
 * recovery has demonstrably not worked. Once per incident, not per sweep.
 */
async function maybeEscalate(health: IntegrationHealth): Promise<void> {
  if (health.escalatedAt || !health.failingSince) return;

  const failingForMs = Date.now() - new Date(health.failingSince).getTime();
  if (failingForMs < config().supervisor.escalateAfterMinutes * 60_000) return;

  health.escalatedAt = new Date().toISOString();
  await notifyAdmins(
    escalationEmail({
      name: health.name,
      key: health.key,
      failingSince: health.failingSince,
      ...(health.lastError ? { lastError: health.lastError } : {}),
      recoveryAttempts: health.recoveries.length,
      capability: health.capability ?? 'not recorded',
    }),
    'supervisor.escalated',
    {
      key: health.key,
      name: health.name,
      failingSince: health.failingSince,
      recoveryAttempts: health.recoveries.length,
      error: health.lastError,
    },
  );
}

/* ------------------------------------------------------------------ *
 * Circuit gate, consulted by the orchestration layer
 * ------------------------------------------------------------------ */

/**
 * Whether a live call should be attempted. A closed circuit means yes; an
 * open one means no until the backoff expires, at which point one probe is
 * allowed through (half-open).
 */
export function shouldAttempt(key: string): boolean {
  const health = state.get(key);
  if (!health?.circuit.open) return true;
  if (!health.circuit.nextAttemptAt) return true;
  return new Date(health.circuit.nextAttemptAt).getTime() <= Date.now();
}

/** Why a call was skipped, for the UI. */
export function circuitReason(key: string): string | undefined {
  const health = state.get(key);
  if (!health?.circuit.open) return undefined;
  return `${health.name} has failed ${health.consecutiveFailures} checks in a row, so calls are paused until ${
    health.circuit.nextAttemptAt ? new Date(health.circuit.nextAttemptAt).toLocaleTimeString('en-GB') : 'the next sweep'
  }. Last error: ${health.lastError ?? 'unknown'}`;
}

/** Records a failure seen by a real request, not just a probe. */
export function reportLiveFailure(key: string, message: string): void {
  const health = state.get(key);
  if (!health) return;
  health.consecutiveFailures += 1;
  health.consecutiveSuccesses = 0;
  health.lastError = message;
  if (health.consecutiveFailures >= FAILURES_TO_OPEN && !health.circuit.open) {
    const backoffSeconds = backoffFor(health.consecutiveFailures);
    health.circuit = {
      open: true,
      openedAt: new Date().toISOString(),
      nextAttemptAt: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
      backoffSeconds,
    };
    health.state = 'circuit_open';
    audit({ action: 'supervisor.circuit_opened', detail: { key, viaLiveRequest: true, error: message } });
  }
}

/** Records a success seen by a real request. */
export function reportLiveSuccess(key: string): void {
  const health = state.get(key);
  if (!health) return;
  health.consecutiveFailures = 0;
  health.consecutiveSuccesses += 1;
  health.lastOkAt = new Date().toISOString();
  if (health.circuit.open) {
    health.circuit = { open: false, backoffSeconds: 0 };
    health.state = 'healthy';
    audit({ action: 'supervisor.circuit_closed', detail: { key, viaLiveRequest: true } });
  }
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

export function supervisorState(): {
  enabled: boolean;
  intervalSeconds: number;
  lastSweepAt: string | null;
  sweeps: number;
  integrations: IntegrationHealth[];
} {
  const cfg = config();
  return {
    enabled: cfg.supervisor.enabled,
    intervalSeconds: cfg.supervisor.intervalSeconds,
    lastSweepAt,
    sweeps: sweepCount,
    integrations: [...state.values()].sort((a, b) => {
      // Anything needing attention floats to the top.
      const rank = (h: IntegrationHealth) =>
        h.state === 'circuit_open' || h.state === 'failing' ? 0 : h.state === 'degraded' ? 1 : h.state === 'healthy' ? 2 : 3;
      return rank(a) - rank(b) || a.name.localeCompare(b.name);
    }),
  };
}

/** Starts the interval. Idempotent. */
export function startSupervisor(): void {
  const cfg = config();
  if (!cfg.supervisor.enabled || timer) return;

  // An immediate first sweep, so the board is populated rather than empty
  // until the first interval elapses.
  void sweep().catch(() => undefined);

  timer = setInterval(() => {
    void sweep().catch(() => undefined);
  }, cfg.supervisor.intervalSeconds * 1000);
  // Never hold the process open on this alone.
  timer.unref();
}

export function stopSupervisor(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Test hook. */
export function resetSupervisor(): void {
  stopSupervisor();
  state.clear();
  lastSweepAt = null;
  sweepCount = 0;
}

export const __supervisorTesting = {
  backoffFor,
  recoveryActionsFor,
  FAILURES_TO_RECOVER,
  FAILURES_TO_OPEN,
  BACKOFF_LADDER_SECONDS,
};
