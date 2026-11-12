import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import postcss, { type AcceptedPlugin, type Root } from 'postcss';
import { analyzeCss, parseCss } from '../lang-css/analyze.ts';
import { analyzeMarkup, declarationsAsRule } from '../lang-html/analyze.ts';
import { MARKUP_EXTENSIONS } from '../lang-html/templates/index.ts';
import { analyzeJs, createAnalysis } from '../lang-js/analyze.ts';
import type { Finding } from './finding.ts';
import { applyBaseline, DEFAULT_BASELINE, readBaseline, type BaselineResult } from './baseline.ts';
import { applyIgnores, parseIgnores } from './ignore.ts';
import { resolveTargets, type ResolvedTargets } from './targets.ts';

export interface CheckOptions {
  root: string;
  paths: string[];
  /** Paths (relative to root) to leave out, such as test directories. */
  exclude?: string[];
  /** browserslist query; defaults to the project's own config. */
  targets?: string;
  /**
   * Run the project's PostCSS config first, so features it compiles away (nesting, prefixes)
   * are not reported. `auto` (default) does so when a config file exists.
   */
  postcss?: boolean | 'auto';
  tsconfig?: string;
  /**
   * Baseline file of accepted findings. Defaults to `<root>/.quirk-baseline.json` when it
   * exists; `false` ignores any baseline (used to regenerate it).
   */
  baseline?: string | false;
}

export interface CheckResult {
  targets: ResolvedTargets;
  /** Whether CSS files were analysed after the project's PostCSS pipeline. */
  postcss: boolean;
  /** Embedded CSS or JS that could not be parsed, as `file:line – reason`. */
  unparsed: string[];
  /** Set when a baseline was applied. */
  baseline?: BaselineResult & { file: string };
  files: number;
  findings: Finding[];
}

const CSS_EXT = new Set(['.css', '.pcss']);
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.tsx']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

export function discover(entries: string[]): string[] {
  const files: string[] = [];
  const visit = (p: string) => {
    const stat = statSync(p);
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(p))) return;
      for (const name of readdirSync(p).sort()) visit(path.join(p, name));
    } else {
      const ext = path.extname(p).toLowerCase();
      if ((CSS_EXT.has(ext) || JS_EXT.has(ext) || MARKUP_EXTENSIONS.has(ext)) && !p.endsWith('.d.ts')) files.push(p);
    }
  };
  // Paths that no longer exist (a staged deletion, say) are skipped rather than failing the
  // run, but never silently: a typo would otherwise pass as "0 files, 0 findings".
  for (const entry of entries) {
    if (existsSync(entry)) visit(path.resolve(entry));
    else process.stderr.write(`quirk: skipping missing path ${entry}\n`);
  }
  return files;
}

function postcssConfigFile(root: string): string | undefined {
  const candidates = ['postcss.config.mjs', 'postcss.config.js', 'postcss.config.cjs'];
  return candidates.map((c) => path.join(root, c)).find((f) => existsSync(f));
}

async function loadPostcssPlugins(root: string): Promise<AcceptedPlugin[]> {
  const file = postcssConfigFile(root);
  if (!file) throw new Error(`no postcss.config.{mjs,js,cjs} in ${root}`);
  const mod = await import(pathToFileURL(file).href);
  let config = mod.default ?? mod;
  if (typeof config === 'function') config = await config({ env: 'production' });
  const plugins = config.plugins ?? [];
  if (Array.isArray(plugins)) return plugins;
  throw new Error('--postcss: object-form `plugins` maps are not supported yet; use an array');
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const root = path.resolve(options.root);
  const targets = resolveTargets(root, options.targets);
  const excluded = (options.exclude ?? []).map((p) => path.resolve(root, p));
  const files = discover(options.paths.length ? options.paths.map((p) => path.resolve(root, p)) : [path.join(root, 'src')]).filter(
    (f) => !excluded.some((e) => f === e || f.startsWith(`${e}${path.sep}`)),
  );
  const cssFiles = files.filter((f) => CSS_EXT.has(path.extname(f).toLowerCase()));
  const jsFiles = files.filter((f) => JS_EXT.has(path.extname(f).toLowerCase()));
  const markupFiles = files.filter((f) => MARKUP_EXTENSIONS.has(path.extname(f).toLowerCase()));
  const unparsed: string[] = [];

  const findings: Finding[] = [];
  const usePostcss = (options.postcss ?? 'auto') === 'auto' ? Boolean(postcssConfigFile(root)) : options.postcss === true;
  const plugins = usePostcss && cssFiles.length ? await loadPostcssPlugins(root) : undefined;

  for (const file of cssFiles) {
    const text = readFileSync(file, 'utf8');
    let ast: Root;
    if (plugins) {
      // Nodes keep their original `source`, so findings still point at the source file.
      const result = await postcss(plugins).process(text, { from: file });
      ast = result.root;
    } else {
      ast = parseCss(text, file);
    }
    const fileFindings = analyzeCss(ast, file, targets.targets);
    applyIgnores(fileFindings, parseIgnores(text));
    findings.push(...fileFindings);
  }

  // Markup: elements and attributes now; embedded CSS now; inline scripts join the JS program
  // as virtual files whose positions equal those in the markup file.
  const inlineScripts = new Map<string, string>();
  const inlineOwner = new Map<string, string>();
  const markupFindings = new Map<string, Finding[]>();
  for (const file of markupFiles) {
    const source = readFileSync(file, 'utf8');
    const { findings: htmlFindings, embedded } = analyzeMarkup(file, source, targets.targets);
    const fileFindings = [...htmlFindings];
    embedded.forEach((e, i) => {
      if (e.lang === 'js') {
        const name = `${file}.quirk-inline-${i}.js`;
        inlineScripts.set(name, e.padded);
        inlineOwner.set(name, file);
        return;
      }
      try {
        // Embedded CSS ships as written: the project's PostCSS pipeline never sees it.
        const css = e.declarationsOnly ? declarationsAsRule(e) : e.padded;
        fileFindings.push(...analyzeCss(parseCss(css, file), file, targets.targets));
      } catch (error) {
        const line = e.padded.slice(0, e.start).split('\n').length;
        unparsed.push(`${path.relative(root, file)}:${line} – ${error instanceof Error ? error.message.split('\n')[0] : error}`);
      }
    });
    markupFindings.set(file, fileFindings);
  }

  if (jsFiles.length || inlineScripts.size) {
    const tsconfig = options.tsconfig ?? (existsSync(path.join(root, 'tsconfig.json')) ? path.join(root, 'tsconfig.json') : undefined);
    const analysis = createAnalysis(jsFiles, tsconfig, inlineScripts);
    for (const file of jsFiles) {
      const fileFindings = analyzeJs(analysis, file, targets.targets);
      applyIgnores(fileFindings, parseIgnores(readFileSync(file, 'utf8')));
      findings.push(...fileFindings);
    }
    for (const [name, owner] of inlineOwner) {
      const inline = analyzeJs(analysis, name, targets.targets);
      for (const f of inline) f.location.file = owner;
      markupFindings.get(owner)!.push(...inline);
    }
  }

  for (const [file, fileFindings] of markupFindings) {
    applyIgnores(fileFindings, parseIgnores(readFileSync(file, 'utf8')));
    findings.push(...fileFindings);
  }

  let baseline: CheckResult['baseline'];
  if (options.baseline !== false) {
    const file = path.resolve(root, options.baseline ?? DEFAULT_BASELINE);
    const data = readBaseline(file);
    if (data) baseline = { file, ...applyBaseline(findings, data, root, files) };
    else if (options.baseline) throw new Error(`baseline not found: ${file}`);
  }

  return { targets, postcss: Boolean(plugins), unparsed, baseline, files: files.length, findings };
}
