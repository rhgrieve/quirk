import path from 'node:path';
import { parseArgs } from 'node:util';
import { browserName } from '../data/bcd.ts';
import { createBaseline, DEFAULT_BASELINE, writeBaseline } from '../engine/baseline.ts';
import { check } from '../engine/check.ts';
import { SEVERITY_RANK, type Severity } from '../engine/failure.ts';
import { resolveTargets } from '../engine/targets.ts';
import { explain } from './explain.ts';
import { formatHtml } from './html.ts';
import { formatJson, formatText } from './report.ts';
import { formatSarif } from './sarif.ts';

const HELP = `quirk – static cross-browser compatibility checks

Usage:
  quirk check [paths...]      Check CSS, JS/TS, HTML and template files (default: <root>/src)
  quirk baseline [paths...]   Accept today's findings in ${DEFAULT_BASELINE}; check then reports only new ones
  quirk explain <rule>        Per-browser support for a rule, e.g. bcd:css.properties.gap.flex_context
  quirk targets               Show the browsers and versions being checked

Options:
  --root <dir>            Project root holding browserslist, tsconfig and postcss config (default: cwd)
  --targets <query>       browserslist query instead of the project's config
  --raw-css               Analyse CSS files as written; by default the project's PostCSS config runs
                          first (when present) so features it compiles away are not reported
  --tsconfig <file>       tsconfig for type resolution (default: <root>/tsconfig.json if present)
  --baseline <file>       Baseline file (default: <root>/${DEFAULT_BASELINE}, used when it exists)
  --ignore-baseline       Report every finding, ignoring the baseline
  --include-ignored       Also check files git ignores (skipped by default)
  --format <format>       text | json | sarif | html (default: text)
  --show-suppressed       List findings suppressed by guards, fallbacks, ignore comments, corpus or baseline
  --fail-on <level>       Exit 1 on findings at or above: error | warning | info | never (default: never)
`;

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: 'string', default: process.cwd() },
      targets: { type: 'string' },
      'raw-css': { type: 'boolean', default: false },
      tsconfig: { type: 'string' },
      baseline: { type: 'string' },
      'ignore-baseline': { type: 'boolean', default: false },
      'include-ignored': { type: 'boolean', default: false },
      format: { type: 'string', default: 'text' },
      'show-suppressed': { type: 'boolean', default: false },
      'fail-on': { type: 'string', default: 'never' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...args] = positionals;
  const root = path.resolve(values.root);

  if (values.help || !command) {
    process.stdout.write(HELP);
    return values.help ? 0 : 2;
  }

  if (command === 'targets') {
    const t = resolveTargets(root, values.targets);
    console.log(`query: ${t.query}`);
    for (const target of t.targets) console.log(`  ${browserName(target.browser)} ${target.version}+  (${target.browser})`);
    if (t.skipped.length) console.log(`no compat data: ${t.skipped.join(', ')}`);
    return 0;
  }

  if (command === 'explain') {
    const [id] = args;
    if (!id) throw new Error('usage: quirk explain <rule>, e.g. quirk explain bcd:api.HTMLDialogElement.showModal');
    const text = explain(id, resolveTargets(root, values.targets));
    if (!text) throw new Error(`unknown rule: ${id}. Rule ids look like bcd:css.properties.gap or bcd:api.Element.checkVisibility`);
    console.log(text);
    return 0;
  }

  const options = {
    root,
    paths: args,
    targets: values.targets,
    postcss: values['raw-css'] ? (false as const) : ('auto' as const),
    tsconfig: values.tsconfig,
    gitignore: !values['include-ignored'],
  };

  if (command === 'baseline') {
    const result = await check({ ...options, baseline: false });
    const file = path.resolve(root, values.baseline ?? DEFAULT_BASELINE);
    const baseline = createBaseline(result.findings, root);
    writeBaseline(file, baseline);
    const accepted = baseline.entries.reduce((n, e) => n + e.count, 0);
    console.log(`wrote ${path.relative(process.cwd(), file) || file}: ${accepted} findings accepted in ${baseline.entries.length} entries`);
    return 0;
  }

  if (command !== 'check') {
    process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  }

  const result = await check({ ...options, baseline: values['ignore-baseline'] ? false : values.baseline });
  const format = values.format;
  if (format === 'json') console.log(formatJson(result, root));
  else if (format === 'sarif') console.log(formatSarif(result, root));
  else if (format === 'html') process.stdout.write(formatHtml(result, root));
  else if (format === 'text') console.log(formatText(result, root, values['show-suppressed']));
  else throw new Error(`--format must be text, json, sarif or html; got ${format}`);

  const threshold = values['fail-on'];
  if (threshold === 'never') return 0;
  if (!(threshold in SEVERITY_RANK)) throw new Error(`--fail-on must be error, warning, info or never; got ${threshold}`);
  const min = SEVERITY_RANK[threshold as Severity];
  return result.findings.some((f) => !f.suppressed && SEVERITY_RANK[f.severity] >= min) ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`quirk: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  },
);
