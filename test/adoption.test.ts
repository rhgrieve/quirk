import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { explain } from '../src/cli/explain.ts';
import { formatSarif } from '../src/cli/sarif.ts';
import { createBaseline, writeBaseline } from '../src/engine/baseline.ts';
import { check } from '../src/engine/check.ts';
import { resolveTargets } from '../src/engine/targets.ts';

const targets = 'safari 15, chrome 100';

function project(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'quirk-'));
  cpSync(path.resolve('test/fixtures/markup/page.html'), path.join(dir, 'page.html'));
  return dir;
}

const active = (r: Awaited<ReturnType<typeof check>>) => r.findings.filter((f) => !f.suppressed);

describe('baseline', () => {
  it('hides accepted findings and still reports new ones', async () => {
    const root = project();
    const first = await check({ root, paths: ['.'], targets, postcss: false, baseline: false });
    expect(active(first).length).toBeGreaterThan(0);
    writeBaseline(path.join(root, '.quirk-baseline.json'), createBaseline(first.findings, root));

    const accepted = await check({ root, paths: ['.'], targets, postcss: false });
    expect(active(accepted)).toEqual([]);
    expect(accepted.baseline).toMatchObject({ matched: active(first).length, stale: 0 });

    // Shift every line down and add a new problem: old findings still match, the new one shows.
    const file = path.join(root, 'page.html');
    writeFileSync(file, readFileSync(file, 'utf8').replace('<body>', '<body>\n\n  <search>new</search>'));
    const later = await check({ root, paths: ['.'], targets, postcss: false });
    expect(active(later).map((f) => f.ruleId)).toEqual(['bcd:html.elements.search']);
  });

  it('counts entries that no longer match as stale', async () => {
    const root = project();
    const first = await check({ root, paths: ['.'], targets, postcss: false, baseline: false });
    writeBaseline(path.join(root, '.quirk-baseline.json'), createBaseline(first.findings, root));
    const file = path.join(root, 'page.html');
    writeFileSync(file, readFileSync(file, 'utf8').replace('<dialog id="d">Hello</dialog>', ''));
    const later = await check({ root, paths: ['.'], targets, postcss: false });
    expect(later.baseline?.stale).toBeGreaterThan(0);
  });
});

describe('sarif', () => {
  it('emits valid-looking SARIF 2.1.0 with levels, fingerprints and suppressions', async () => {
    const root = project();
    const result = await check({ root, paths: ['.'], targets, postcss: false, baseline: false });
    const sarif = JSON.parse(formatSarif(result, root));
    expect(sarif.version).toBe('2.1.0');
    const run = sarif.runs[0];
    expect(run.tool.driver.name).toBe('quirk');
    const dialog = run.results.find((r: { ruleId: string }) => r.ruleId === 'bcd:html.elements.dialog');
    expect(dialog).toMatchObject({
      level: 'warning',
      locations: [{ physicalLocation: { artifactLocation: { uri: 'page.html', uriBaseId: 'SRCROOT' }, region: { startLine: 10 } } }],
    });
    expect(dialog.partialFingerprints['quirk/v1']).toMatch(/^[0-9a-f]{64}$/);
    expect(run.rules ?? run.tool.driver.rules).toBeDefined();
    const ignored = run.results.find((r: { suppressions?: unknown[] }) => r.suppressions);
    expect(ignored.suppressions[0]).toMatchObject({ kind: 'inSource' });
  });
});

describe('explain', () => {
  it('lists support per target with the first full version', () => {
    const text = explain('bcd:css.properties.gap.flex_context', resolveTargets(process.cwd(), 'safari 14'))!;
    expect(text).toContain('Flexbox gap');
    expect(text).toContain('Safari 14: no, full support from 14.1');
    expect(explain('bcd:not.a.feature', resolveTargets(process.cwd(), 'safari 14'))).toBeUndefined();
  });
});
