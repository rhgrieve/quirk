import postcss, { type AtRule, type ChildNode, type Container, type Declaration, type Node, type Root, type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import valueParser from 'postcss-value-parser';
import { compatAt, compatChild, cssTypeIndexes } from '../data/bcd.ts';
import type { FailureMode } from '../engine/failure.ts';
import { supportFinding, type Finding, type Location, type SupportCandidate } from '../engine/finding.ts';
import type { Target } from '../engine/targets.ts';

const VENDOR = /^-(webkit|moz|ms|o|khtml)-/i;

/** Properties whose support depends on the layout they are used in. */
const LAYOUT_CONTEXT: Record<string, Record<string, string>> = {
  gap: { flex: 'flex_context', 'inline-flex': 'flex_context', grid: 'grid_context', 'inline-grid': 'grid_context' },
  'row-gap': { flex: 'flex_context', 'inline-flex': 'flex_context', grid: 'grid_context', 'inline-grid': 'grid_context' },
  'column-gap': { flex: 'flex_context', 'inline-flex': 'flex_context', grid: 'grid_context', 'inline-grid': 'grid_context' },
};

type Token = { kind: 'property' | 'value' | 'selector' | 'at-rule'; name: string };

interface Pending {
  candidate: SupportCandidate;
  node: Node;
  token: Token;
  /** For value tokens: the declaration they belong to. */
  decl?: Declaration;
}

function locationOf(node: Node, file: string, offset = 0): Location {
  const start = node.source?.start;
  return {
    file: node.source?.input.file ?? file,
    line: start?.line ?? 1,
    column: (start?.column ?? 1) + offset,
  };
}

function valueOffset(decl: Declaration): number {
  return decl.prop.length + (decl.raws.between?.length ?? 1);
}

function siblingsBefore(node: ChildNode): ChildNode[] {
  const parent = node.parent as Container | undefined;
  if (!parent) return [];
  const index = parent.index(node);
  return parent.nodes!.slice(0, index);
}

function siblingDecls(node: ChildNode): Declaration[] {
  const parent = node.parent as Container | undefined;
  return (parent?.nodes ?? []).filter((n): n is Declaration => n.type === 'decl');
}

/** `@supports` ancestor whose condition names the token. `@supports not (…)` is not a guard. */
function supportsGuard(node: Node, token: Token): string | undefined {
  const needle = token.name.toLowerCase();
  for (let p = node.parent as Node | undefined; p; p = p.parent as Node | undefined) {
    if (p.type === 'atrule') {
      const at = p as AtRule;
      if (at.name.toLowerCase() === 'supports') {
        const params = at.params.toLowerCase();
        if (!params.trimStart().startsWith('not') && params.includes(needle)) return `@supports ${at.params}`;
      }
    }
  }
  return undefined;
}

function suppress(finding: Finding, pending: Pending): void {
  const guard = supportsGuard(pending.node, pending.token);
  if (guard) {
    finding.suppressed = { reason: 'supports-guard', detail: guard };
    return;
  }

  const decl = pending.decl;
  if (pending.token.kind === 'value' && decl) {
    // `height: 100vh; height: 100dvh;` – browsers drop the declaration they cannot parse.
    const fallback = siblingsBefore(decl).find(
      (n): n is Declaration => n.type === 'decl' && n.prop.toLowerCase() === decl.prop.toLowerCase(),
    );
    if (fallback) {
      finding.suppressed = { reason: 'fallback', detail: `${fallback.prop}: ${fallback.value}` };
      return;
    }
  }

  const prefixes = finding.affected.map((a) => (a.status === 'prefix' ? a.prefix : undefined));
  if (prefixes.every((p): p is string => Boolean(p)) && pending.node.type === 'decl') {
    const d = pending.node as Declaration;
    const siblings = siblingDecls(d);
    const covered = prefixes.every((prefix) =>
      pending.token.kind === 'property'
        ? siblings.some((s) => s.prop.toLowerCase() === `${prefix}${d.prop.toLowerCase()}`)
        : siblings.some(
            (s) => s.prop.toLowerCase() === d.prop.toLowerCase() && s.value.toLowerCase().includes(`${prefix}${pending.token.name}`),
          ),
    );
    if (covered) finding.suppressed = { reason: 'prefixed-sibling', detail: prefixes[0] };
  }
}

function declCandidates(decl: Declaration, file: string, out: Pending[]): void {
  const prop = decl.prop.toLowerCase();
  const isCustom = prop.startsWith('--');
  if (VENDOR.test(prop)) return;
  const propPath = `css.properties.${prop}`;

  if (!isCustom && compatAt(propPath)) {
    out.push({
      candidate: { bcdPath: propPath, subject: prop, location: locationOf(decl, file), failure: 'declaration-ignored' },
      node: decl,
      token: { kind: 'property', name: prop },
    });

    const contexts = LAYOUT_CONTEXT[prop];
    if (contexts) {
      const display = siblingDecls(decl).find((d) => d.prop.toLowerCase() === 'display')?.value.trim().toLowerCase();
      const sub = display ? contexts[display] : undefined;
      const path = sub ? compatChild(propPath, sub) : undefined;
      if (path) {
        out.push({
          candidate: {
            bcdPath: path,
            subject: `${prop} (with display: ${display})`,
            location: locationOf(decl, file),
            failure: 'declaration-ignored',
          },
          node: decl,
          token: { kind: 'property', name: prop },
        });
      }
    }
  }

  const { units, functions } = cssTypeIndexes();
  const base = valueOffset(decl);
  valueParser(decl.value).walk((node) => {
    const at = (subject: string, bcdPath: string, name: string) =>
      out.push({
        candidate: { bcdPath, subject, location: locationOf(decl, file, base + node.sourceIndex), failure: 'declaration-ignored' },
        node: decl,
        decl,
        token: { kind: 'value', name },
      });

    if (node.type === 'function') {
      const name = node.value.toLowerCase();
      if (!name || VENDOR.test(name)) return;
      const path = functions.get(name);
      if (path) at(`${name}()`, path, name);
      return;
    }
    if (node.type !== 'word') return;
    const word = node.value.toLowerCase();
    if (VENDOR.test(word)) return;
    const dimension = valueParser.unit(word);
    if (dimension && dimension.unit) {
      const path = units.get(dimension.unit.toLowerCase());
      if (path) at(`${dimension.unit.toLowerCase()} unit`, path, dimension.unit.toLowerCase());
      return;
    }
    if (!isCustom && /^[a-z][a-z-]*$/.test(word)) {
      const path = compatChild(propPath, word);
      if (path) at(`${prop}: ${word}`, path, word);
    }
  });
}

const MEDIA_FEATURE = /\(\s*(?:min-|max-)?([a-z-]+)\s*(?:[:)<>=])/gi;

function atRuleCandidates(at: AtRule, file: string, out: Pending[]): void {
  const name = at.name.toLowerCase();
  if (VENDOR.test(name)) return;
  const path = `css.at-rules.${name}`;
  if (!compatAt(path)) return;
  const push = (bcdPath: string, subject: string, token: string) =>
    out.push({
      candidate: { bcdPath, subject, location: locationOf(at, file), failure: 'block-ignored' },
      node: at,
      token: { kind: 'at-rule', name: token },
    });

  push(path, `@${name}`, name);

  if (name === 'media') {
    const seen = new Set<string>();
    for (const m of at.params.matchAll(MEDIA_FEATURE)) {
      const feature = m[1]!.toLowerCase();
      if (seen.has(feature)) continue;
      seen.add(feature);
      const featurePath = compatChild(path, feature);
      if (featurePath) push(featurePath, `@media (${feature})`, feature);
    }
    // Range syntax: (width >= 600px), (400px < width < 800px)
    if (/\([^)]*[<>]=?[^)]*\)/.test(at.params)) {
      const rangePath = compatChild(path, 'range_syntax');
      if (rangePath) push(rangePath, '@media range syntax', 'range');
    }
  }
}

function ruleCandidates(rule: Rule, file: string, out: Pending[]): void {
  const push = (bcdPath: string, subject: string, token: string, failure: FailureMode = 'rule-ignored') =>
    out.push({ candidate: { bcdPath, subject, location: locationOf(rule, file), failure }, node: rule, token: { kind: 'selector', name: token } });

  // A style rule inside another style rule is CSS nesting even without `&`.
  if (rule.parent?.type === 'rule' && compatAt('css.selectors.nesting')) push('css.selectors.nesting', 'CSS nesting', '&');

  let ast: selectorParser.Root;
  try {
    ast = selectorParser().astSync(rule.selector);
  } catch {
    return;
  }
  const listLength = ast.nodes.length;
  const seen = new Set<string>();
  ast.walk((node) => {
    if (node.type === 'nesting') {
      if (!seen.has('nesting') && rule.parent?.type !== 'rule') push('css.selectors.nesting', 'CSS nesting (&)', '&');
      seen.add('nesting');
      return;
    }
    if (node.type !== 'pseudo') return;
    const name = node.value.replace(/^:+/, '').toLowerCase();
    if (!name || VENDOR.test(name) || seen.has(name)) return;
    seen.add(name);
    const path = `css.selectors.${name}`;
    if (!compatAt(path)) return;
    // Inside :is()/:where() a selector list is forgiving; elsewhere one unknown selector drops the rule.
    let forgiving = false;
    for (let p = node.parent; p; p = p.parent) {
      if (p.type === 'pseudo' && /^:(is|where)$/i.test(p.value)) forgiving = true;
    }
    const isFunctional = node.nodes.length > 0;
    // Dropping the list only costs more when some selector in it doesn't use this pseudo itself.
    const usesIt = (sel: selectorParser.Selector) => {
      let hit = false;
      sel.walkPseudos((p) => {
        if (p.value.replace(/^:+/, '').toLowerCase() === name) hit = true;
      });
      return hit;
    };
    const dropsOthers = listLength > 1 && !forgiving && ast.nodes.some((sel) => !usesIt(sel));
    push(path, `${node.value}${isFunctional ? '()' : ''}`, name, dropsOthers ? 'rule-list-dropped' : 'rule-ignored');
  });
}

/** Support findings for one stylesheet. `root` may be the raw parse or the output of the project's PostCSS pipeline. */
export function analyzeCss(root: Root, file: string, targets: Target[]): Finding[] {
  const pending: Pending[] = [];
  root.walk((node) => {
    if (node.type === 'decl') declCandidates(node, file, pending);
    else if (node.type === 'atrule') atRuleCandidates(node, file, pending);
    else if (node.type === 'rule') ruleCandidates(node, file, pending);
  });

  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const p of pending) {
    const key = `${p.candidate.bcdPath}@${p.candidate.location.file}:${p.candidate.location.line}:${p.candidate.location.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const finding = supportFinding(p.candidate, targets);
    if (!finding) continue;
    suppress(finding, p);
    findings.push(finding);
  }
  return findings;
}

export function parseCss(text: string, file: string): Root {
  return postcss.parse(text, { from: file });
}
