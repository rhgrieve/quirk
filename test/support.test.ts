import { describe, expect, it } from 'vitest';
import { supportFinding } from '../src/engine/finding.ts';
import { supportAt } from '../src/engine/support.ts';
import { compareVersions, resolveTargets } from '../src/engine/targets.ts';

const loc = { file: 'x.css', line: 1, column: 1 };

describe('support evaluation', () => {
  it('compares dotted versions numerically', () => {
    expect(compareVersions('15.10', '15.4')).toBeGreaterThan(0);
    expect(compareVersions('16', '16.0')).toBe(0);
  });

  it('treats version_added null as unknown and false as unsupported', () => {
    const compat = { support: { safari: { version_added: null }, chrome: { version_added: false } } };
    expect(supportAt(compat, { browser: 'safari', version: '17' }).status).toBe('unknown');
    expect(supportAt(compat, { browser: 'chrome', version: '120' }).status).toBe('no');
  });

  it('respects version_removed and prefixes', () => {
    const compat = {
      support: { safari: [{ version_added: '18' }, { version_added: '9', prefix: '-webkit-' }], firefox: { version_added: '4', version_removed: '79' } },
    };
    expect(supportAt(compat, { browser: 'safari', version: '17' })).toMatchObject({ status: 'prefix', prefix: '-webkit-', supportedFrom: '18' });
    expect(supportAt(compat, { browser: 'safari', version: '18' }).status).toBe('yes');
    expect(supportAt(compat, { browser: 'firefox', version: '100' }).status).toBe('no');
  });

  it('resolves ios_saf ranges to their lower bound and skips agents without BCD data', () => {
    const t = resolveTargets(process.cwd(), 'ios_saf 16.6-16.7, op_mini all');
    expect(t.targets).toEqual([{ browser: 'safari_ios', version: '16.6' }]);
    expect(t.skipped).toEqual(['op_mini all']);
  });
});

describe('curated corpus', () => {
  it('marks gaps listed as not applicable as suppressed', () => {
    const { targets } = resolveTargets(process.cwd(), 'ios_saf 18.5');
    const f = supportFinding({ bcdPath: 'css.properties.cursor.pointer', subject: 'cursor: pointer', location: loc, failure: 'declaration-ignored' }, targets);
    expect(f?.suppressed?.reason).toBe('not-applicable');
  });

  it('includes BCD notes, which carry most behavioural differences', () => {
    const { targets } = resolveTargets(process.cwd(), 'safari 17');
    const f = supportFinding({ bcdPath: 'api.CustomElementRegistry.get', subject: 'customElements.get', location: loc, failure: 'throws' }, targets);
    expect(f?.message).toMatch(/Customized built-in elements/);
    // Partial support only differs; it never throws, whatever the use site.
    expect(f).toMatchObject({ failure: 'differs', severity: 'info' });
  });
});
