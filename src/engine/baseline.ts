/**
 * Baseline: accept the findings a project has today so adoption starts from zero, and report
 * only new ones. An entry is keyed by rule, file and the trimmed text of the finding's line
 * (not its number), so edits elsewhere in a file don't invalidate it. A count covers
 * identical lines. Entries that no longer match are reported as stale so the file shrinks
 * as code is fixed.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Finding } from './finding.ts';

export const DEFAULT_BASELINE = '.quirk-baseline.json';

export interface BaselineEntry {
  rule: string;
  file: string;
  /** Trimmed source line the finding is on, at most 200 characters. */
  line: string;
  count: number;
}

export interface BaselineFile {
  $comment?: string;
  version: 1;
  entries: BaselineEntry[];
}

export interface BaselineResult {
  /** Findings marked as accepted by the baseline. */
  matched: number;
  /** Entries for checked files that matched nothing: the code was fixed or changed. */
  stale: number;
}

function lineText(file: string, line: number, cache: Map<string, string[]>): string {
  let lines = cache.get(file);
  if (!lines) {
    lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
    cache.set(file, lines);
  }
  return (lines[line - 1] ?? '').trim().slice(0, 200);
}

const keyOf = (e: Pick<BaselineEntry, 'rule' | 'file' | 'line'>) => `${e.rule}\u0000${e.file}\u0000${e.line}`;

function entryFor(f: Finding, root: string, cache: Map<string, string[]>): Omit<BaselineEntry, 'count'> {
  return {
    rule: f.ruleId,
    file: path.relative(root, f.location.file).split(path.sep).join('/'),
    line: lineText(f.location.file, f.location.line, cache),
  };
}

export function createBaseline(findings: Finding[], root: string): BaselineFile {
  const cache = new Map<string, string[]>();
  const counts = new Map<string, BaselineEntry>();
  for (const f of findings) {
    if (f.suppressed) continue;
    const e = entryFor(f, root, cache);
    const k = keyOf(e);
    const existing = counts.get(k);
    if (existing) existing.count++;
    else counts.set(k, { ...e, count: 1 });
  }
  const entries = [...counts.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.rule.localeCompare(b.rule) || a.line.localeCompare(b.line),
  );
  return {
    $comment: 'Accepted quirk findings. Regenerate with `quirk baseline`; entries are removed as code is fixed.',
    version: 1,
    entries,
  };
}

export function writeBaseline(file: string, baseline: BaselineFile): void {
  writeFileSync(file, `${JSON.stringify(baseline, null, 2)}\n`);
}

export function readBaseline(file: string): BaselineFile | undefined {
  if (!existsSync(file)) return undefined;
  const data = JSON.parse(readFileSync(file, 'utf8')) as BaselineFile;
  if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error(`${file}: not a quirk baseline (version 1)`);
  return data;
}

/** Marks findings the baseline accepts as suppressed. `checkedFiles` scopes stale counting. */
export function applyBaseline(findings: Finding[], baseline: BaselineFile, root: string, checkedFiles: string[]): BaselineResult {
  const cache = new Map<string, string[]>();
  const remaining = new Map(baseline.entries.map((e) => [keyOf(e), e.count]));
  let matched = 0;
  for (const f of findings) {
    if (f.suppressed) continue;
    const k = keyOf(entryFor(f, root, cache));
    const left = remaining.get(k) ?? 0;
    if (left > 0) {
      remaining.set(k, left - 1);
      f.suppressed = { reason: 'baseline' };
      matched++;
    }
  }
  const checked = new Set(checkedFiles.map((f) => path.relative(root, f).split(path.sep).join('/')));
  let stale = 0;
  for (const e of baseline.entries) {
    if (checked.has(e.file)) stale += remaining.get(keyOf(e)) ?? 0;
  }
  return { matched, stale };
}
