import { createRequire } from 'node:module';
import { browserName, compatAt, webFeatureFor, type WebFeature } from '../data/bcd.ts';
import { FAILURE, type FailureMode, type Severity } from './failure.ts';
import { gaps, supportAt, type TargetSupport } from './support.ts';
import type { Target } from './targets.ts';

export type { FailureMode, Severity } from './failure.ts';

export interface Location {
  file: string;
  line: number;
  column: number;
}

export interface Finding {
  /** `bcd:<path>` for support rules; curated quirk rules will use `quirk:<id>`. */
  ruleId: string;
  kind: 'support' | 'quirk';
  severity: Severity;
  /** How the code fails in the affected browsers; drives severity. */
  failure: FailureMode;
  location: Location;
  /** The construct as written: `gap`, `color-mix()`, `:has()`, `HTMLDialogElement.showModal`. */
  subject: string;
  message: string;
  affected: TargetSupport[];
  feature?: WebFeature;
  evidence: string[];
  /** Set when a guard, fallback or ignore comment suppresses the finding. */
  suppressed?: {
    reason: 'supports-guard' | 'feature-detect' | 'fallback' | 'prefixed-sibling' | 'ignore-comment' | 'not-applicable' | 'baseline';
    detail?: string;
  };
}

interface NotApplicable {
  match: string;
  browsers: string[];
  reason: string;
}

const { entries: notApplicable } = createRequire(import.meta.url)('../../corpus/not-applicable.json') as { entries: NotApplicable[] };

function notApplicableFor(bcdPath: string, browser: string): NotApplicable | undefined {
  return notApplicable.find(
    (e) => (bcdPath === e.match || bcdPath.startsWith(`${e.match}.`)) && e.browsers.includes(browser),
  );
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, '');

export interface SupportCandidate {
  bcdPath: string;
  subject: string;
  location: Location;
  /** How this use fails where the feature is missing, as derived by the language adapter. */
  failure: FailureMode;
  /**
   * BCD path of the interface an instance member belongs to. Where that interface is itself
   * unsupported, no instance can exist, so only the entry point (already reported) matters.
   */
  ownerPath?: string;
}

function describe(s: TargetSupport): string {
  const name = `${browserName(s.browser)} ${s.version}`;
  const from = s.supportedFrom ? `, full support from ${s.supportedFrom}` : '';
  switch (s.status) {
    case 'no':
      return `${name} (unsupported${from})`;
    case 'prefix':
      return `${name} (only as ${s.prefix ? `${s.prefix}prefixed` : `\`${s.alternativeName}\``}${from})`;
    case 'partial':
      return `${name} (partial${from})`;
    default:
      return name;
  }
}

/** Turns a candidate use of a BCD feature into a finding, or nothing when every target supports it. */
export function supportFinding(candidate: SupportCandidate, targets: Target[]): Finding | undefined {
  const compat = compatAt(candidate.bcdPath);
  if (!compat) return undefined;
  const owner = candidate.ownerPath ? compatAt(candidate.ownerPath) : undefined;
  const reachable = owner ? targets.filter((t) => supportAt(owner, t).status !== 'no') : targets;
  const all = gaps(compat, reachable);
  if (all.length === 0) return undefined;
  // Curated corpus: drop targets where the gap does not change anything for users.
  const applicable = all.filter((a) => !notApplicableFor(candidate.bcdPath, a.browser));
  const notApplicableEntry = applicable.length === 0 ? notApplicableFor(candidate.bcdPath, all[0]!.browser) : undefined;
  const affected = applicable.length ? applicable : all;

  // Prefix-only support fails like no support for unprefixed code; partial support only differs.
  const failure: FailureMode = affected.every((a) => a.status === 'partial') ? 'differs' : candidate.failure;
  const { severity, summary } = FAILURE[failure];
  const feature = webFeatureFor(candidate.bcdPath);
  const evidence = [compat.mdn_url, ...(Array.isArray(compat.spec_url) ? compat.spec_url : [compat.spec_url])].filter(
    (u): u is string => Boolean(u),
  );
  const description = compat.description ? stripTags(compat.description) : '';
  const context = description && description !== candidate.subject ? ` (${description})` : '';
  // BCD's per-browser notes are where most behavioural differences are recorded.
  const byNote = new Map<string, string[]>();
  for (const a of affected) {
    for (const n of a.notes ?? []) {
      // BCD repeats a note per browser, naming the browser inside it; compare without the name.
      const key = stripTags(n).replaceAll(browserName(a.browser), '{browser}');
      byNote.set(key, [...(byNote.get(key) ?? []), browserName(a.browser)]);
    }
  }
  const notes = [...byNote].map(([note, browsers]) => `${browsers.join(', ')}: ${note.replaceAll('{browser}', browsers[0]!)}`);
  const message =
    `\`${candidate.subject}\`${context} is not fully supported in: ${affected.map(describe).join('; ')}; ${summary}.` +
    (notes.length ? ` Notes – ${notes.slice(0, 3).join(' ')}` : '');

  return {
    ruleId: `bcd:${candidate.bcdPath}`,
    kind: 'support',
    severity,
    failure,
    location: candidate.location,
    subject: candidate.subject,
    message,
    affected,
    feature,
    evidence,
    ...(notApplicableEntry ? { suppressed: { reason: 'not-applicable' as const, detail: notApplicableEntry.reason } } : {}),
  };
}
