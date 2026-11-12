/**
 * SARIF 2.1.0 output for code-scanning UIs (GitHub code scanning, IDEs). Suppressed
 * findings are included with a `suppressions` entry so dashboards show them as dismissed;
 * `partialFingerprints` use the baseline key so results track across line shifts.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CheckResult } from '../engine/check.ts';
import type { Finding, Severity } from '../engine/finding.ts';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };

const LEVEL: Record<Severity, 'error' | 'warning' | 'note'> = { error: 'error', warning: 'warning', info: 'note' };

function fingerprint(f: Finding, root: string, cache: Map<string, string[]>): string {
  let lines = cache.get(f.location.file);
  if (!lines) {
    lines = existsSync(f.location.file) ? readFileSync(f.location.file, 'utf8').split(/\r?\n/) : [];
    cache.set(f.location.file, lines);
  }
  const text = (lines[f.location.line - 1] ?? '').trim();
  const rel = path.relative(root, f.location.file).split(path.sep).join('/');
  return createHash('sha256').update(`${f.ruleId}\u0000${rel}\u0000${text}`).digest('hex');
}

export function formatSarif(result: CheckResult, root: string): string {
  const ruleIndex = new Map<string, number>();
  const rules: object[] = [];
  for (const f of result.findings) {
    if (ruleIndex.has(f.ruleId)) continue;
    ruleIndex.set(f.ruleId, rules.length);
    rules.push({
      id: f.ruleId,
      name: f.ruleId.replace(/[^A-Za-z0-9]+/g, '_'),
      shortDescription: { text: f.feature?.name ? `${f.feature.name}: ${f.subject}` : f.subject },
      fullDescription: { text: f.message },
      ...(f.evidence[0] ? { helpUri: f.evidence[0] } : {}),
      help: { text: `${f.message}\n\nRun \`quirk explain ${f.ruleId}\` for per-browser support.` },
      properties: { tags: ['compatibility', f.kind, ...(f.feature ? [`web-feature:${f.feature.id}`] : [])] },
    });
  }

  const cache = new Map<string, string[]>();
  const results = result.findings.map((f) => ({
    ruleId: f.ruleId,
    ruleIndex: ruleIndex.get(f.ruleId),
    level: LEVEL[f.severity],
    message: { text: f.message },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: path.relative(root, f.location.file).split(path.sep).join('/'), uriBaseId: 'SRCROOT' },
          region: { startLine: f.location.line, startColumn: f.location.column },
        },
      },
    ],
    partialFingerprints: { 'quirk/v1': fingerprint(f, root, cache) },
    properties: { failure: f.failure, affected: f.affected.map((a) => `${a.browser} ${a.version}: ${a.status}`) },
    ...(f.suppressed
      ? {
          suppressions: [
            {
              kind: f.suppressed.reason === 'baseline' ? 'external' : 'inSource',
              justification: `${f.suppressed.reason}${f.suppressed.detail ? `: ${f.suppressed.detail}` : ''}`,
            },
          ],
        }
      : {}),
  }));

  return JSON.stringify(
    {
      $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
      version: '2.1.0',
      runs: [
        {
          tool: { driver: { name: 'quirk', version, rules } },
          originalUriBaseIds: { SRCROOT: { uri: pathToFileURL(`${root}${path.sep}`).href } },
          results,
        },
      ],
    },
    null,
    2,
  );
}
