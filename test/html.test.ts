import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatHtml } from '../src/cli/html.ts';
import { check } from '../src/engine/check.ts';

async function report(extra?: (dir: string) => void) {
  const root = mkdtempSync(path.join(tmpdir(), 'quirk-html-'));
  cpSync(path.resolve('test/fixtures/markup/page.html'), path.join(root, 'page.html'));
  extra?.(root);
  const result = await check({ root, paths: ['.'], targets: 'safari 15, chrome 100', postcss: false, baseline: false });
  return { html: formatHtml(result, root), result };
}

const dataOf = (html: string) => {
  const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  return JSON.parse(m![1]!);
};

describe('html report', () => {
  it('is a self-contained document with embedded findings', async () => {
    const { html, result } = await report();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<(link|script)[^>]+(href|src)=/);
    const data = dataOf(html);
    expect(data.groups.reduce((n: number, g: { locations: unknown[] }) => n + g.locations.length, 0)).toBe(result.findings.length);
    const dialog = data.groups.find((g: { ruleId: string }) => g.ruleId === 'bcd:html.elements.dialog');
    expect(dialog.locations[0]).toMatchObject({ file: 'page.html', line: 10 });
    expect(dialog.locations[0].snippet.find((s: { line: number }) => s.line === 10).text).toContain('<dialog');
  });

  it('cannot be broken out of by source text', async () => {
    const { html } = await report((dir) =>
      writeFileSync(path.join(dir, 'evil.html'), '<!-- </script><script>alert(1)</script> -->\n<search>x</search>\n'),
    );
    // Only the two script elements the report itself defines.
    expect(html.match(/<script/g)).toHaveLength(2);
    const data = dataOf(html);
    const search = data.groups.find((g: { ruleId: string }) => g.ruleId === 'bcd:html.elements.search');
    expect(search.locations[0].snippet[0].text).toContain('</script>');
  });
});
