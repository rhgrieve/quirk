/**
 * Access to MDN browser-compat-data (BCD) and web-features.
 *
 * Support rules are not stored as files: a finding's rule id is the BCD path
 * (`bcd:css.properties.gap.flex_context`) and the data is read at check time.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export type VersionValue = string | boolean | null;

export interface SupportStatement {
  version_added: VersionValue;
  version_removed?: VersionValue;
  version_last?: string;
  prefix?: string;
  alternative_name?: string;
  flags?: unknown[];
  partial_implementation?: boolean;
  notes?: string | string[];
}

export interface CompatStatement {
  description?: string;
  mdn_url?: string;
  spec_url?: string | string[];
  tags?: string[];
  status?: { experimental: boolean; standard_track: boolean; deprecated: boolean };
  support: Record<string, SupportStatement | SupportStatement[] | undefined>;
}

export interface BcdNode {
  __compat?: CompatStatement;
  [key: string]: BcdNode | CompatStatement | undefined;
}

export interface WebFeature {
  id: string;
  name: string;
  baseline: 'high' | 'low' | false | undefined;
  baselineLowDate?: string;
}

const bcd = require('@mdn/browser-compat-data') as Record<string, BcdNode> & {
  browsers: Record<string, { name: string }>;
};
const { features } = require('web-features') as {
  features: Record<string, { kind: string; name?: string; status?: { baseline?: 'high' | 'low' | false; baseline_low_date?: string } }>;
};

/** Returns the BCD node at a dotted path such as `css.properties.gap`, if it exists. */
export function bcdNode(path: string): BcdNode | undefined {
  let node: BcdNode | undefined = bcd as unknown as BcdNode;
  for (const part of path.split('.')) {
    if (!node || part === '__compat' || !Object.hasOwn(node, part)) return undefined;
    node = node[part] as BcdNode | undefined;
  }
  return node;
}

/** Returns the compat statement at a dotted path, or undefined when the path is not a feature. */
export function compatAt(path: string): CompatStatement | undefined {
  return bcdNode(path)?.__compat;
}

/** Child keys of a BCD path whose node carries compat data (`css.properties.display` → `flex`, `grid`, …). */
export function compatChild(path: string, key: string): string | undefined {
  const child = `${path}.${key}`;
  return compatAt(child) ? child : undefined;
}

/** BCD descriptions and notes are HTML fragments: drop the tags and decode the entities. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, '&');
}

export function browserName(id: string): string {
  return bcd.browsers[id]?.name ?? id;
}

/** The web-features entry a BCD key belongs to, via BCD's `web-features:<id>` tag. */
export function webFeatureFor(path: string): WebFeature | undefined {
  const tag = compatAt(path)?.tags?.find((t) => t.startsWith('web-features:'));
  if (!tag) return undefined;
  const id = tag.slice('web-features:'.length);
  const feature = features[id];
  if (!feature || feature.kind !== 'feature') return { id, name: id, baseline: undefined };
  return {
    id,
    name: feature.name ?? id,
    baseline: feature.status?.baseline,
    baselineLowDate: feature.status?.baseline_low_date,
  };
}

const CODE_TOKEN = /<code>([^<]+)<\/code>/g;

function codeTokens(description: string | undefined): string[] {
  if (!description) return [];
  return [...description.matchAll(CODE_TOKEN)].map((m) => m[1]!.trim());
}

function walk(path: string, node: BcdNode, visit: (path: string, compat: CompatStatement) => void): void {
  for (const [key, child] of Object.entries(node)) {
    if (key === '__compat' || !child) continue;
    const childPath = `${path}.${key}`;
    const childNode = child as BcdNode;
    if (childNode.__compat) visit(childPath, childNode.__compat);
    walk(childPath, childNode, visit);
  }
}

let cssTypeIndex: { units: Map<string, string>; functions: Map<string, string> } | undefined;

/**
 * Maps CSS units (`dvh`) and functions (`color-mix`) to the BCD key under `css.types`
 * that describes them. BCD names them in each entry's description, for example
 * "<code>dvb</code>, <code>dvh</code> … units" or "<code>color-mix()</code>".
 */
export function cssTypeIndexes(): { units: Map<string, string>; functions: Map<string, string> } {
  if (cssTypeIndex) return cssTypeIndex;
  const units = new Map<string, string>();
  const functions = new Map<string, string>();
  const types = bcdNode('css.types');
  if (types) {
    walk('css.types', types, (path, compat) => {
      for (const token of codeTokens(compat.description)) {
        const fn = /^([a-z][a-z0-9-]*)\(\)$/i.exec(token);
        if (fn) {
          // The first (shallowest) entry naming a function wins: `css.types.color.color-mix`.
          if (!functions.has(fn[1]!.toLowerCase())) functions.set(fn[1]!.toLowerCase(), path);
        } else if (path.startsWith('css.types.length.') && /^[a-z]+$/i.test(token)) {
          if (!units.has(token.toLowerCase())) units.set(token.toLowerCase(), path);
        }
      }
    });
  }
  cssTypeIndex = { units, functions };
  return cssTypeIndex;
}
