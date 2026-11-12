import type { CompatStatement, SupportStatement, VersionValue } from '../data/bcd.ts';
import { compareVersions, type Target } from './targets.ts';

export type SupportStatus = 'yes' | 'partial' | 'prefix' | 'no' | 'unknown';

export interface TargetSupport {
  browser: string;
  version: string;
  status: SupportStatus;
  /** Vendor prefix or alternative name that works at this version, when status is `prefix`. */
  prefix?: string;
  alternativeName?: string;
  /** First version with unprefixed, full support, when known. */
  supportedFrom?: string;
  notes?: string[];
}

/** BCD versions can be "15.4", "≤79" (supported at or before 79), "preview", true, false or null. */
function parseVersion(value: VersionValue | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.replace(/^≤/, '');
  return /^\d+(\.\d+)*$/.test(v) ? v : undefined;
}

function appliesAt(statement: SupportStatement, version: string): boolean {
  if (statement.flags?.length) return false;
  const added = parseVersion(statement.version_added);
  if (!added) return statement.version_added === true;
  if (compareVersions(added, version) > 0) return false;
  const removed = parseVersion(statement.version_removed);
  return !removed || compareVersions(version, removed) < 0;
}

function asNotes(notes: SupportStatement['notes']): string[] | undefined {
  if (!notes) return undefined;
  return Array.isArray(notes) ? notes : [notes];
}

const RANK: Record<SupportStatus, number> = { yes: 4, partial: 3, prefix: 2, no: 1, unknown: 0 };

/** Support for one target. `unknown` means BCD has no data for that browser, so nothing is reported. */
export function supportAt(compat: CompatStatement, target: Target): TargetSupport {
  const raw = compat.support[target.browser];
  const base = { browser: target.browser, version: target.version };
  if (!raw) return { ...base, status: 'unknown' };
  const statements = Array.isArray(raw) ? raw : [raw];
  // `version_added: null` means BCD does not know; only `false` means unsupported.
  if (statements.every((s) => s.version_added === null)) return { ...base, status: 'unknown' };

  const fullSupport = statements.find(
    (s) => !s.flags?.length && !s.prefix && !s.alternative_name && !s.partial_implementation && parseVersion(s.version_added),
  );
  const supportedFrom = fullSupport ? parseVersion(fullSupport.version_added) : undefined;

  const unsupportedNotes = asNotes(statements.find((s) => s.version_added === false)?.notes);
  let best: TargetSupport = { ...base, status: 'no', supportedFrom, notes: unsupportedNotes };
  for (const s of statements) {
    if (!appliesAt(s, target.version)) continue;
    let candidate: TargetSupport;
    if (s.prefix || s.alternative_name) {
      candidate = { ...base, status: 'prefix', prefix: s.prefix, alternativeName: s.alternative_name, supportedFrom, notes: asNotes(s.notes) };
    } else if (s.partial_implementation) {
      candidate = { ...base, status: 'partial', notes: asNotes(s.notes), supportedFrom };
    } else {
      candidate = { ...base, status: 'yes' };
    }
    if (RANK[candidate.status] > RANK[best.status]) best = candidate;
  }
  return best;
}

/** Targets where the feature is not fully supported. Empty means no finding. */
export function gaps(compat: CompatStatement, targets: Target[]): TargetSupport[] {
  return targets.map((t) => supportAt(compat, t)).filter((s) => s.status !== 'yes' && s.status !== 'unknown');
}
