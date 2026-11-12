import { parse, parseFragment } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { compatAt } from '../data/bcd.ts';
import type { FailureMode } from '../engine/failure.ts';
import { supportFinding, type Finding } from '../engine/finding.ts';
import type { Target } from '../engine/targets.ts';
import { blank, templateFor, type Region } from './templates/index.ts';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];

const HTML_NS = 'http://www.w3.org/1999/xhtml';
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'module', 'text/ecmascript']);

/** CSS or JS embedded in markup, padded so offsets equal those in the original file. */
export interface Embedded {
  lang: 'css' | 'js';
  /** Text with everything before the region blanked: positions map 1:1 to the source file. */
  padded: string;
  /** Offset where the embedded text starts. */
  start: number;
  /** `style="…"` attribute bodies are declaration lists, not stylesheets. */
  declarationsOnly?: boolean;
}

export interface MarkupAnalysis {
  findings: Finding[];
  embedded: Embedded[];
}

function lineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < offset; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: offset - lineStart + 1 };
}

function pad(text: string, start: number, end: number): string {
  return blank(text.slice(0, start)) + text.slice(start, end);
}

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

/** Candidate BCD keys for an attribute value: `input.type_date`, `link.rel.preload`, `script.type.module`. */
function valuePaths(tag: string, attr: string, value: string): string[] {
  const tokens = attr === 'rel' ? value.split(/\s+/) : [value];
  return tokens
    .filter((t) => /^[a-z][a-z0-9-]*$/.test(t))
    .flatMap((t) => [`html.elements.${tag}.${attr}_${t}`, `html.elements.${tag}.${attr}.${t}`])
    .filter((p) => compatAt(p));
}

/**
 * Elements, attributes and attribute values checked against BCD, plus the CSS and JS
 * embedded in the markup (`<style>`, `style=""`, `<script>` and template-language regions)
 * for the CSS and JS analysers.
 */
export function analyzeMarkup(file: string, source: string, targets: Target[]): MarkupAnalysis {
  const template = templateFor(file);
  const pre = template ? template.preprocess(source) : { text: source, css: source, html: source, regions: [] as Region[] };
  const isDocument = /<!doctype|<html[\s>]/i.test(pre.html.slice(0, 2000));
  const tree = isDocument
    ? parse(pre.html, { sourceCodeLocationInfo: true })
    : parseFragment(pre.html, { sourceCodeLocationInfo: true });

  const findings: Finding[] = [];
  const embedded: Embedded[] = pre.regions.map((r) => ({
    lang: r.lang,
    start: r.start,
    padded: pad(r.lang === 'css' ? pre.css : pre.text, r.start, r.end),
  }));
  const seen = new Set<string>();

  const report = (bcdPath: string, subject: string, offset: number, failure: FailureMode) => {
    const key = `${bcdPath}@${offset}`;
    if (seen.has(key)) return;
    seen.add(key);
    const finding = supportFinding({ bcdPath, subject, location: { file, ...lineColumn(pre.text, offset) }, failure }, targets);
    if (finding) findings.push(finding);
  };

  const visit = (node: Node) => {
    if (isElement(node) && node.namespaceURI === HTML_NS && node.sourceCodeLocation) {
      const tag = node.tagName.toLowerCase();
      const loc = node.sourceCodeLocation;
      // Custom elements are the author's own; their behaviour comes from script, not the browser.
      if (!tag.includes('-')) {
        const elementPath = `html.elements.${tag}`;
        if (compatAt(elementPath)) report(elementPath, `<${tag}>`, loc.startOffset, 'element-unknown');

        for (const attr of node.attrs) {
          const name = attr.name.toLowerCase();
          if (name.startsWith('data-') || name.startsWith('aria-')) continue;
          const offset = loc.attrs?.[attr.name]?.startOffset ?? loc.startOffset;
          const attrPath = [`html.elements.${tag}.${name}`, `html.global_attributes.${name}`].find((p) => compatAt(p));
          if (attrPath) report(attrPath, `${name} attribute on <${tag}>`, offset, 'attribute-ignored');
          for (const valuePath of valuePaths(tag, name, attr.value.trim().toLowerCase())) {
            report(valuePath, `<${tag} ${name}="${attr.value.trim()}">`, offset, 'attribute-ignored');
          }

          if (name === 'style' && loc.attrs?.[attr.name]) {
            // Value sits between the quotes: name="…" → skip `name="`.
            const a = loc.attrs[attr.name]!;
            const raw = pre.text.slice(a.startOffset, a.endOffset);
            const quote = raw.search(/["']/);
            if (quote > 0) {
              const start = a.startOffset + quote + 1;
              const end = a.endOffset - 1;
              if (end > start) embedded.push({ lang: 'css', start, padded: pad(pre.css, start, end), declarationsOnly: true });
            }
          }
        }
      }

      // <style> and inline <script> bodies: analysed by the CSS and JS analysers.
      const body = (tag === 'style' || tag === 'script') && loc.startTag && loc.endTag
        ? { start: loc.startTag.endOffset, end: loc.endTag.startOffset }
        : undefined;
      if (body && body.end > body.start) {
        if (tag === 'style') {
          embedded.push({ lang: 'css', start: body.start, padded: pad(pre.css, body.start, body.end) });
        } else {
          const type = (node.attrs.find((a) => a.name === 'type')?.value ?? '').trim().toLowerCase();
          const external = node.attrs.some((a) => a.name === 'src');
          if (!external && JS_TYPES.has(type)) embedded.push({ lang: 'js', start: body.start, padded: pad(pre.text, body.start, body.end) });
        }
      }
    }
    // <template> content lives in a separate fragment.
    if (isElement(node) && node.tagName === 'template' && 'content' in node) visit((node as DefaultTreeAdapterMap['template']).content);
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
  };
  visit(tree as Node);
  return { findings, embedded };
}

/**
 * A `style=""` body as a stylesheet with offsets unchanged: the two blanked characters
 * before the value (`="`) become `a{`, and a closing brace is appended.
 */
export function declarationsAsRule(e: Embedded): string {
  return `${e.padded.slice(0, e.start - 2)}a{${e.padded.slice(e.start)}}`;
}
