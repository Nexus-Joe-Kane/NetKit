import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { assignmentProblem, type AddressAssignment } from '@sw/shared';
import { config } from '../config';

/**
 * Addresses somebody has said belong to a client.
 *
 * The gap: a UPRN lookup finds a building, and the building does not know
 * whose it is. Once somebody says "this one is Market Halls", every later
 * lookup of that address can offer their UniFi site, their circuits and
 * their tickets — which is the whole promise of the portal, and it cannot be
 * inferred from a postcode because two of our customers share a business
 * park.
 *
 * Keyed on UPRN, one client per address. Shared across the desk, and written
 * with the same read-modify-write discipline as the credential vault:
 * Passenger runs several workers, and a whole-file write from a stale copy
 * is how entries disappear.
 */

interface AssignmentFile {
  assignments: AddressAssignment[];
}

const path = (): string => join(resolvePath(config().dataDir), 'assignments.json');

let cache: AssignmentFile | null = null;
let cacheMtimeMs = 0;

function fileMtimeMs(): number {
  try {
    return statSync(path()).mtimeMs;
  } catch {
    return 0; // No file yet.
  }
}

function readFile(): AssignmentFile {
  try {
    const file = existsSync(path()) ? (JSON.parse(readFileSync(path(), 'utf8')) as AssignmentFile) : { assignments: [] };
    if (!Array.isArray(file.assignments)) file.assignments = [];
    return file;
  } catch {
    return { assignments: [] };
  }
}

function state(): AssignmentFile {
  const mtime = fileMtimeMs();
  if (!cache || mtime !== cacheMtimeMs) {
    cache = readFile();
    cacheMtimeMs = mtime;
  }
  return cache;
}

/** Read-modify-write, so a stale worker cannot drop another's entries. */
function mutate<T>(change: (file: AssignmentFile) => T): T {
  const file = readFile();
  const result = change(file);
  try {
    const target = path();
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, target);
    cache = file;
    cacheMtimeMs = fileMtimeMs();
  } catch {
    // An assignment that did not save is worth a retry by the operator, not
    // a failed request that loses what they typed.
  }
  return result;
}

export function listAssignments(): AddressAssignment[] {
  return [...state().assignments].sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
}

export function assignmentByUprn(uprn: string): AddressAssignment | undefined {
  return state().assignments.find((a) => a.uprn === uprn);
}

/** Every address assigned to one client. */
export function assignmentsForClient(clientKey: string): AddressAssignment[] {
  return state().assignments.filter((a) => a.clientKey === clientKey);
}

export function assign(
  input: Omit<AddressAssignment, 'assignedAt'> & { assignedAt?: string },
): { ok: true; assignment: AddressAssignment } | { ok: false; error: string } {
  const assignment: AddressAssignment = { ...input, assignedAt: input.assignedAt ?? new Date().toISOString() };
  const problem = assignmentProblem(assignment);
  if (problem) return { ok: false, error: problem };

  return mutate((file) => {
    // One client per address. Reassigning is allowed — a building changes
    // hands — and replaces rather than accumulating, so a lookup never has
    // to choose between two owners.
    const index = file.assignments.findIndex((a) => a.uprn === assignment.uprn);
    if (index >= 0) file.assignments[index] = assignment;
    else file.assignments.push(assignment);
    return { ok: true as const, assignment };
  });
}

export function unassign(uprn: string): boolean {
  return mutate((file) => {
    const before = file.assignments.length;
    file.assignments = file.assignments.filter((a) => a.uprn !== uprn);
    return file.assignments.length !== before;
  });
}

/** Test hook — empties the store. */
export function resetAssignments(): void {
  mutate((file) => {
    file.assignments = [];
  });
}

/** Drops the in-memory copy, as a restart would. */
export function reloadAssignments(): void {
  cache = null;
  cacheMtimeMs = 0;
}
