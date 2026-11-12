import { blank, placeholder, type Preprocessed, type Region, type TemplateLanguage } from './shared.ts';

/**
 * Liquid (Shopify and other Liquid hosts).
 * - `{{ … }}` becomes a `0` placeholder, which stays valid in HTML, CSS values and JS expressions.
 * - `{% … %}` becomes spaces, including multi-line `{% liquid %}` tags.
 * - `{% comment %}`, `{% doc %}` and `{% schema %}` blocks are blanked.
 * - `{% raw %}` bodies are kept literally.
 * - `{% style %}` / `{% stylesheet %}` bodies are CSS regions; `{% javascript %}` bodies are JS regions.
 */
const BLOCK = /{%-?\s*(comment|doc|schema|raw|style|stylesheet|javascript)\b[^%]*?-?%}([\s\S]*?){%-?\s*end\1\s*-?%}/g;
const OUTPUT = /{{[\s\S]*?}}/g;
const TAG = /{%[\s\S]*?%}/g;
const COMMENT = /{%-?\s*(comment|doc)\b[\s\S]*?{%-?\s*end\1\s*-?%}/g;

/** Comments nested inside other blocks are blanked whole, so their prose never reaches a parser. */
function neutralise(s: string, output: (m: string) => string = placeholder): string {
  return s.replace(COMMENT, blank).replace(OUTPUT, output).replace(TAG, blank);
}

function preprocess(source: string): Preprocessed {
  const text = build(source, placeholder);
  const css = build(source, blank).text;
  let html = text.text;
  for (const r of text.regions) html = html.slice(0, r.start) + blank(html.slice(r.start, r.end)) + html.slice(r.end);
  return { text: text.text, css, html, regions: text.regions };
}

function build(source: string, output: (m: string) => string): { text: string; regions: Region[] } {
  let text = '';
  const regions: Region[] = [];
  let last = 0;
  for (const m of source.matchAll(BLOCK)) {
    const [whole, kind, body] = m as unknown as [string, string, string];
    const start = m.index!;
    const bodyStart = start + whole.indexOf(body, whole.indexOf('%}') + 2);
    const bodyEnd = bodyStart + body.length;
    text += neutralise(source.slice(last, start), output);
    const open = blank(source.slice(start, bodyStart));
    const close = blank(source.slice(bodyEnd, start + whole.length));
    if (kind === 'comment' || kind === 'doc' || kind === 'schema') {
      text += blank(whole);
    } else if (kind === 'raw') {
      text += open + body + close;
    } else {
      text += open;
      regions.push({ lang: kind === 'javascript' ? 'js' : 'css', start: text.length, end: text.length + body.length });
      text += neutralise(body, output) + close;
    }
    last = start + whole.length;
  }
  text += neutralise(source.slice(last), output);
  return { text, regions };
}

export const liquid: TemplateLanguage = { name: 'liquid', extensions: ['.liquid'], preprocess };
