import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { applyIgnores, parseIgnores } from '../src/engine/ignore.ts';
import { resolveTargets } from '../src/engine/targets.ts';
import { analyzeJs, createAnalysis } from '../src/lang-js/analyze.ts';

const file = path.resolve('test/fixtures/js/sample.ts');
const { targets } = resolveTargets(process.cwd(), 'safari 13, chrome 100');
const analysis = createAnalysis([file]);
const findings = analyzeJs(analysis, file, targets);
applyIgnores(findings, parseIgnores(readFileSync(file, 'utf8')));
const at = (line: number) => findings.filter((f) => f.location.line === line);

describe('js support findings', () => {
  it('resolves instance members through the receiver type', () => {
    expect(at(2).map((f) => f.ruleId)).toEqual(['bcd:api.HTMLDialogElement.showModal']);
    expect(at(2)[0]!.suppressed).toBeUndefined();
  });

  it('suppresses feature-detected uses, including early exits', () => {
    expect(at(6)[0]!.suppressed?.reason).toBe('feature-detect');
    expect(at(11)[0]!.suppressed?.detail).toMatch(/early exit/);
  });

  it('resolves globals, built-in methods and static members', () => {
    expect(at(14).map((f) => f.ruleId)).toContain('bcd:api.structuredClone');
    expect(at(15).map((f) => f.ruleId)).toContain('bcd:javascript.builtins.Array.at');
    expect(at(16).map((f) => f.ruleId)).toContain('bcd:javascript.builtins.Object.groupBy');
  });

  it('walks base interfaces for custom elements and mixins', () => {
    expect(at(20).map((f) => f.ruleId)).toEqual(['bcd:api.HTMLElement.attachInternals']);
    // Element.append is supported in Safari 10+, so no finding.
    expect(at(21)).toEqual([]);
  });

  it('derives the failure mode from the use site', () => {
    expect(at(2)[0]).toMatchObject({ failure: 'throws', severity: 'error' });
    expect(at(14)[0]).toMatchObject({ failure: 'throws' });
    expect(at(37).find((f) => f.ruleId === 'bcd:api.HTMLElement.inert')).toMatchObject({ failure: 'no-op', severity: 'warning' });
    expect(at(38).find((f) => f.ruleId === 'bcd:api.HTMLElement.popover')).toMatchObject({ failure: 'undefined-value' });
  });

  it('treats optional calls as feature detection', () => {
    expect(at(26)[0]!.suppressed?.reason).toBe('feature-detect');
  });

  it('honours quirk-ignore comments', () => {
    expect(at(30)[0]!.suppressed?.reason).toBe('ignore-comment');
  });
});

describe('reachability', () => {
  it('guards a value whose result is optional-chained, and skips members of unsupported interfaces', () => {
    const { targets: webview } = resolveTargets(process.cwd(), 'android 157');
    const f = analyzeJs(analysis, file, webview).filter((x) => x.location.line === 33);
    expect(f.find((x) => x.ruleId === 'bcd:api.Navigator.permissions')?.suppressed?.reason).toBe('feature-detect');
    // PermissionStatus does not exist in WebView, so `status.state` cannot run there.
    expect(f.find((x) => x.ruleId === 'bcd:api.PermissionStatus.state')).toBeUndefined();
  });
});

describe('guards across callbacks and helpers', () => {
  const { targets: chrome } = resolveTargets(process.cwd(), 'chrome 100');
  const found = analyzeJs(analysis, file, chrome).filter((f) => f.ruleId === 'bcd:api.Document.startViewTransition');
  const atLine = (line: number) => found.find((f) => f.location.line === line);

  it('treats a getter that returns the feature as a detection, not a use', () => {
    expect(atLine(43)?.suppressed?.detail).toBe('returned from a detection getter');
  });

  it('follows a guard through a helper and out of an inline callback', () => {
    expect(atLine(47)?.suppressed?.detail).toBe('if (this.available)');
  });

  it('does not let a try block guard a callback it cannot catch', () => {
    expect(atLine(50)?.suppressed).toBeUndefined();
    expect(atLine(50)?.failure).toBe('throws');
  });
});
