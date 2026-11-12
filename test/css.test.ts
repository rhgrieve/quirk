import { describe, expect, it } from 'vitest';
import { applyIgnores, parseIgnores } from '../src/engine/ignore.ts';
import { resolveTargets } from '../src/engine/targets.ts';
import { analyzeCss, parseCss } from '../src/lang-css/analyze.ts';

const { targets } = resolveTargets(process.cwd(), 'safari 14, ios_saf 14.0-14.4, chrome 100, firefox 100');

function run(css: string) {
  const findings = analyzeCss(parseCss(css, 'test.css'), 'test.css', targets);
  applyIgnores(findings, parseIgnores(css));
  return findings;
}
const ids = (css: string) => run(css).filter((f) => !f.suppressed).map((f) => f.ruleId);

describe('css support findings', () => {
  it('flags flex gap only when the rule is a flex container', () => {
    expect(ids('.a { display: flex; gap: 1rem; }')).toContain('bcd:css.properties.gap.flex_context');
    expect(ids('.a { display: grid; gap: 1rem; }')).not.toContain('bcd:css.properties.gap.flex_context');
  });

  it('flags dynamic viewport units and reports the column of the value', () => {
    const [f] = run('.a {\n  height: 100dvh;\n}').filter((x) => x.ruleId.endsWith('viewport_percentage_units_dynamic'));
    expect(f).toBeDefined();
    expect(f!.location).toMatchObject({ line: 2, column: 11 });
    expect(f).toMatchObject({ failure: 'declaration-ignored', severity: 'info' });
  });

  it('treats an earlier declaration of the same property as a fallback', () => {
    const [f] = run('.a { height: 100vh; height: 100dvh; }').filter((x) => x.ruleId.endsWith('dynamic'));
    expect(f!.suppressed?.reason).toBe('fallback');
  });

  it('treats a matching @supports as a guard', () => {
    const [f] = run('@supports (height: 100dvh) { .a { height: 100dvh; } }').filter((x) => x.ruleId.endsWith('dynamic'));
    expect(f!.suppressed?.reason).toBe('supports-guard');
  });

  it('does not treat an unrelated @supports as a guard', () => {
    const [f] = run('@supports (display: grid) { .a { height: 100dvh; } }').filter((x) => x.ruleId.endsWith('dynamic'));
    expect(f!.suppressed).toBeUndefined();
  });

  it('rates an unsupported selector in a list as dropping the whole list', () => {
    const [f] = run('.a:has(img), .b { color: red; }').filter((x) => x.ruleId === 'bcd:css.selectors.has');
    expect(f).toMatchObject({ failure: 'rule-list-dropped', severity: 'error' });
    expect(f!.message).toMatch(/including the other selectors/);
    const [g] = run(':is(.a:has(img), .b) { color: red; }').filter((x) => x.ruleId === 'bcd:css.selectors.has');
    expect(g).toMatchObject({ failure: 'rule-ignored', severity: 'warning' });
    const [h] = run('.a:has(img) { color: red; }').filter((x) => x.ruleId === 'bcd:css.selectors.has');
    expect(h!.failure).toBe('rule-ignored');
  });

  it('rates ignored at-rules and media syntax as blocks that never apply', () => {
    const [f] = run('@media (width >= 600px) { .a { color: red; } }').filter((x) => x.ruleId.endsWith('range_syntax'));
    expect(f).toMatchObject({ failure: 'block-ignored', severity: 'warning' });
  });

  it('accepts a prefixed sibling for prefix-only support', () => {
    const [f] = run('.a { -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }').filter(
      (x) => x.ruleId === 'bcd:css.properties.backdrop-filter',
    );
    expect(f!.affected.every((a) => a.status === 'prefix' || a.browser === 'firefox')).toBe(true);
    const unprefixed = run('.a { backdrop-filter: blur(4px); }').find((x) => x.ruleId === 'bcd:css.properties.backdrop-filter');
    expect(unprefixed!.suppressed).toBeUndefined();
  });

  it('flags nested rules and CSS functions', () => {
    expect(ids('.a { .b { color: red; } }')).toContain('bcd:css.selectors.nesting');
    expect(ids('.a { color: color-mix(in srgb, red, blue); }')).toContain('bcd:css.types.color.color-mix');
  });

  it('flags media features and range syntax', () => {
    const found = ids('@media (width >= 600px) { .a { color: red; } }');
    expect(found).toContain('bcd:css.at-rules.media.range_syntax');
  });

  it('honours quirk-ignore comments by rule prefix or web-features id', () => {
    expect(ids('.a {\n  /* quirk-ignore bcd:css.types.length -- iOS 15.4+ only page */\n  height: 100dvh;\n}')).toEqual([]);
    expect(ids('/* quirk-ignore flexbox-gap */\n.a { display: flex; gap: 1rem; }')).not.toContain(
      'bcd:css.properties.gap.flex_context',
    );
  });

  it('reports nothing for well-supported CSS', () => {
    expect(ids('.a { display: flex; color: red; margin: 0 auto; }')).toEqual([]);
  });
});

describe('selector lists', () => {
  it('does not escalate a list whose selectors all use the same pseudo', () => {
    const { targets: ios } = resolveTargets(process.cwd(), 'ios_saf 18.5');
    const [f] = analyzeCss(parseCss('.a::selection, .b::selection { color: red; }', 't.css'), 't.css', ios);
    expect(f).toMatchObject({ ruleId: 'bcd:css.selectors.selection', failure: 'rule-ignored' });
  });
});
