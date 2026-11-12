import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../src/engine/check.ts';
import { templateFor } from '../src/lang-html/templates/index.ts';

const root = path.resolve('test/fixtures/markup');
const targets = 'safari 15, ios_saf 15.0-15.1, chrome 100';
const result = await check({ root, paths: ['.'], targets, postcss: false });
const inFile = (name: string) => result.findings.filter((f) => path.basename(f.location.file) === name);
const at = (name: string, line: number) => inFile(name).filter((f) => f.location.line === line);
const ids = (name: string, line: number) => at(name, line).map((f) => f.ruleId);

describe('html elements and attributes', () => {
  it('flags unsupported elements as rendering inline', () => {
    expect(at('page.html', 10).find((f) => f.ruleId === 'bcd:html.elements.dialog')).toMatchObject({
      failure: 'element-unknown',
      severity: 'warning',
      location: { line: 10, column: 3 },
    });
  });

  it('flags element attributes, global attributes and attribute values', () => {
    expect(ids('page.html', 11)).toContain('bcd:html.elements.details.name');
    expect(ids('page.html', 12)).toEqual(expect.arrayContaining(['bcd:html.global_attributes.inert']));
    expect(ids('page.html', 13)).toContain('bcd:html.global_attributes.popover');
    expect(ids('page.html', 4)).toContain('bcd:html.elements.link.rel.modulepreload');
    expect(at('page.html', 12).find((f) => f.ruleId === 'bcd:html.global_attributes.inert')?.failure).toBe('attribute-ignored');
  });

  it('leaves custom elements alone', () => {
    expect(at('page.html', 15)).toEqual([]);
  });

  it('analyses <style>, style attributes and inline scripts at their real positions', () => {
    expect(ids('page.html', 6)).toContain('bcd:css.types.length.viewport_percentage_units_small');
    const dvh = at('page.html', 14).find((f) => f.ruleId.endsWith('viewport_percentage_units_dynamic'));
    expect(dvh?.location.column).toBe(67);
    expect(at('page.html', 17).find((f) => f.ruleId === 'bcd:api.HTMLDialogElement.showModal')).toMatchObject({
      failure: 'throws',
      location: { file: path.join(root, 'page.html'), line: 17 },
    });
  });

  it('skips non-JS script types and honours HTML ignore comments', () => {
    expect(at('page.html', 19)).toEqual([]);
    expect(at('page.html', 21)[0]?.suppressed?.reason).toBe('ignore-comment');
  });
});

describe('liquid plug-in', () => {
  it('keeps length and line breaks while neutralising template syntax', () => {
    const source = '<p class="{{ a }}">{% if x %}\n{{ b }}{% endif %}</p>';
    const out = templateFor('x.liquid')!.preprocess(source);
    expect(out.text).toHaveLength(source.length);
    expect(out.text.split('\n')).toHaveLength(2);
    expect(out.text).toContain('class="0      "');
  });

  it('ignores markup inside comments and schema blocks', () => {
    expect(at('section.liquid', 2)).toEqual([]);
    expect(at('section.liquid', 14)).toEqual([]);
  });

  it('analyses markup around Liquid tags', () => {
    expect(ids('section.liquid', 5)).toContain('bcd:html.elements.search');
  });

  it('analyses {% style %} as CSS and {% javascript %} as JS at their real positions', () => {
    expect(at('section.liquid', 8).find((f) => f.ruleId.endsWith('viewport_percentage_units_dynamic'))?.location.column).toBe(50);
    expect(ids('section.liquid', 11)).toContain('bcd:api.structuredClone');
  });

  it('parses every embedded block', () => {
    expect(result.unparsed).toEqual([]);
  });
});

describe('liquid edge cases', () => {
  it('parses stylesheets that are entirely Liquid output', () => {
    expect(result.unparsed).toEqual([]);
  });

  it('blanks comments nested inside style blocks', () => {
    expect(at('section.liquid', 19)).toEqual([]);
    expect(at('section.liquid', 20).map((f) => f.ruleId)).not.toContain('bcd:css.selectors.nesting');
  });
});
