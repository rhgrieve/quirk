import path from 'node:path';
import { browserName } from '../data/bcd.ts';
import type { CheckResult } from '../engine/check.ts';
import { SEVERITY_RANK, type Severity } from '../engine/failure.ts';
import type { Finding } from '../engine/finding.ts';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint(2, s);
const yellow = (s: string) => paint(33, s);
const cyan = (s: string) => paint(36, s);
const red = (s: string) => paint(31, s);
const LABEL: Record<Severity, (s: string) => string> = { error: red, warning: yellow, info: cyan };

function baselineLabel(f: Finding): string {
  if (!f.feature || f.feature.baseline === undefined) return '';
  const b = f.feature.baseline;
  const status = b === 'high' ? 'Baseline widely available' : b === 'low' ? `Baseline ${f.feature.baselineLowDate?.slice(0, 4) ?? ''} newly available` : 'not Baseline';
  return dim(` [${f.feature.name}: ${status}]`);
}

/** Groups by rule so a feature used 40 times reads as one entry with 40 locations. */
export function formatText(result: CheckResult, root: string, showSuppressed: boolean): string {
  const lines: string[] = [];
  const t = result.targets;
  lines.push(dim(`targets (${t.query}): ${t.targets.map((x) => `${browserName(x.browser)} ${x.version}+`).join(', ')}`));
  if (t.skipped.length) lines.push(dim(`no compat data for: ${t.skipped.join(', ')}`));
  lines.push(dim(result.postcss ? 'css: analysed after the project PostCSS pipeline' : 'css: analysed as written'));
  if (result.gitignored) lines.push(dim(`skipped ${result.gitignored} gitignored file(s) (--include-ignored to check them)`));
  if (result.baseline) {
    const { matched, stale, file } = result.baseline;
    lines.push(dim(`baseline ${path.relative(root, file)}: ${matched} accepted findings hidden${stale ? `, ${stale} entries no longer match (run quirk baseline to prune)` : ''}`));
  }
  if (result.unparsed.length) {
    lines.push(dim(`could not parse ${result.unparsed.length} embedded block(s); first: ${result.unparsed[0]}`));
  }
  lines.push('');

  const active = result.findings.filter((f) => !f.suppressed);
  const suppressed = result.findings.filter((f) => f.suppressed);
  const groups = new Map<string, Finding[]>();
  for (const f of showSuppressed ? result.findings : active) {
    const list = groups.get(f.ruleId) ?? [];
    list.push(f);
    groups.set(f.ruleId, list);
  }
  // One rule can fail differently at different use sites (a method called vs read); worst first.
  for (const group of groups.values()) group.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const ordered = [...groups.values()].sort(
    (a, b) => SEVERITY_RANK[b[0]!.severity] - SEVERITY_RANK[a[0]!.severity] || b.length - a.length,
  );
  for (const group of ordered) {
    const first = group[0]!;
    const label = LABEL[first.severity](first.severity);
    lines.push(`${label} ${first.ruleId} ${dim(`(${first.failure})`)}${baselineLabel(first)}`);
    lines.push(`  ${first.message}`);
    if (first.evidence[0]) lines.push(dim(`  ${first.evidence[0]}`));
    for (const f of group) {
      const where = `${path.relative(root, f.location.file)}:${f.location.line}:${f.location.column}`;
      const note = f.suppressed ? dim(` (suppressed: ${f.suppressed.reason}${f.suppressed.detail ? ` – ${f.suppressed.detail}` : ''})`) : '';
      const mode = f.failure === first.failure ? '' : dim(` (${f.failure})`);
      lines.push(`    ${where}${mode}${note}`);
    }
    lines.push('');
  }
  const count = (s: Severity) => active.filter((f) => f.severity === s).length;
  lines.push(
    `${result.files} files, ${active.length} findings (${count('error')} errors, ${count('warning')} warnings, ${count('info')} info) in ${
      new Set(active.map((f) => f.ruleId)).size
    } features; ${suppressed.length} suppressed by guards, fallbacks, ignore comments, the corpus or the baseline${showSuppressed ? '' : ' (--show-suppressed to list)'}.`,
  );
  return lines.join('\n');
}

export function formatJson(result: CheckResult, root: string): string {
  return JSON.stringify(
    {
      targets: result.targets,
      files: result.files,
      findings: result.findings.map((f) => ({ ...f, location: { ...f.location, file: path.relative(root, f.location.file) } })),
    },
    null,
    2,
  );
}
