# quirk

Static cross-browser compatibility checks. quirk reads CSS, JS/TS, HTML and template
files and checks them against a corpus of known browser differences, without launching
a browser. It complements a functional browser test suite; it doesn't replace one.
Static analysis can't tell you that checkout works.

Design and roadmap: [docs/design.md](docs/design.md). quirk is meant to be generic:
rules come from public sources only, and changes are judged across several codebases
(see [Staying generic](docs/design.md#staying-generic)).

## Install

quirk isn't on npm. Install a release tarball as a dev dependency:

```bash
npm install --save-dev https://github.com/rhgrieve/quirk/releases/download/v0.1.1/quirk-0.1.1.tgz
```

Release tarballs include the compiled build, so nothing is built on install.

## Usage

```bash
npx quirk targets                          # browsers and versions being checked
npx quirk check src                        # report findings
npx quirk check src templates --format json
npx quirk baseline src templates           # accept today's findings
npx quirk explain bcd:css.properties.gap.flex_context
npx quirk check src --format sarif > quirk.sarif
```

Adopting quirk in a project (browserslist, baseline, lefthook, CI, SARIF):
[docs/adoption.md](docs/adoption.md).

| Option | Meaning |
| --- | --- |
| `--root <dir>` | Project root holding browserslist, tsconfig and PostCSS config (default: cwd) |
| `--targets <query>` | browserslist query instead of the project's config |
| `--raw-css` | Analyse CSS as written. By default the project's PostCSS config runs first, so features it compiles away (nesting, prefixes) are not reported |
| `--tsconfig <file>` | tsconfig for type resolution (default: `<root>/tsconfig.json`) |
| `--format text\|json\|sarif` | Output format |
| `--baseline <file>` | Baseline of accepted findings (default `.quirk-baseline.json` in the root, used when present) |
| `--ignore-baseline` | Report every finding, ignoring the baseline |
| `--include-ignored` | Also check files git ignores. By default they are skipped (build output, generated files); tracked files are always checked |
| `--show-suppressed` | Also list findings suppressed by guards, fallbacks, ignore comments, the corpus or the baseline |
| `--fail-on error\|warning\|info\|never` | Exit 1 when findings at or above that level remain (default: `never`, report-only) |

Other commands:

```bash
node bin/quirk.mjs baseline src --root ../my-site      # accept today's findings
node bin/quirk.mjs explain bcd:css.properties.gap.flex_context           # per-browser support
node bin/quirk.mjs check src --format sarif > quirk.sarif               # code scanning
```

Adopting quirk in a project (browserslist, baseline, lefthook, CI, SARIF):
[docs/adoption.md](docs/adoption.md).

Requires Node ≥ 22.18. In a checkout the CLI runs the TypeScript source directly. An
installed copy runs the build that `prepare` produces (`npm run build`), since Node won't
strip types under `node_modules`.

Requires Node ≥ 22.18.

## What it checks

Targets come from the project's browserslist, resolved to the oldest selected
version per browser. Agents with no BCD data (Opera Mini, UC, KaiOS) are listed
as skipped.

- **CSS** (PostCSS AST): properties, property values, units (`dvh`, `cqi`),
  functions (`color-mix()`, `round()`), at-rules, media features and range
  syntax, selectors and pseudo-classes, and nesting. It also checks layout-dependent
  support: `gap` is checked against `flex_context` when the rule is a flex container.
  When a selector list contains an unsupported selector, the finding says the whole
  rule is dropped (but not inside `:is()`/`:where()`).
- **JS/TS** (TypeScript type checker): every property access and global that
  resolves to TypeScript's own lib files maps to BCD (`api.HTMLDialogElement.showModal`,
  `api.structuredClone`, `javascript.builtins.Array.at`, `javascript.builtins.Object.groupBy`).
  Receivers are resolved through base interfaces, so `this.attachInternals()` in a
  custom element resolves to `HTMLElement`, and mixin members resolve too. User code
  and node_modules typings are never looked up. Syntax is not checked; the bundler
  transpiles it.
- **HTML and templates** (parse5): elements, element and global attributes, and
  attribute values (`<input type="date">`, `<link rel="modulepreload">`,
  `<script type="module">`). Custom elements, `data-*` and `aria-*` are skipped.
  Embedded `<style>`, `style=""` and inline `<script>` go to the CSS and JS analysers
  at their real line and column. Inline scripts join the TypeScript program as
  virtual files, so types flow across them. Embedded CSS is analysed as written,
  because a project's PostCSS pipeline never sees it.

Template languages are plug-ins
([src/lang-html/templates/](src/lang-html/templates)). A plug-in returns text of
the same length and line breaks as the source, with template syntax neutralised:

| Liquid source | Becomes |
| --- | --- |
| `{{ … }}` | A `0` placeholder in markup and JS (blank in CSS, so a stylesheet that is entirely output still parses) |
| `{% … %}` | Blank |
| `{% comment %}`, `{% doc %}`, `{% schema %}` | Blank, including when nested in other blocks |
| `{% raw %}` | Kept literally |
| `{% style %}` / `{% stylesheet %}` bodies | CSS regions |
| `{% javascript %}` bodies | JS regions |

Plain `.html`/`.htm` needs no plug-in. Adding a language means adding one file that
implements `TemplateLanguage`.

Messages include BCD's per-browser notes, which is where most behavioural
differences are recorded. For example, Safari's `devicePixelRatio` doesn't change
on zoom.

## Severity comes from how the code fails

Each finding records how the code fails where the feature is missing. The
adapters work this out from syntax alone, with no per-feature curation, and
severity follows from it:

| Failure mode | Severity | Where it comes from |
| --- | --- | --- |
| `throws` | error | JS: a missing method called or constructed, or a missing global referenced |
| `rule-list-dropped` | error | CSS: an unknown selector in a list invalidates every selector in it (not inside `:is()`/`:where()`) |
| `rule-ignored` | warning | CSS: a single-selector or nested rule is dropped |
| `block-ignored` | warning | CSS: an unknown at-rule, media feature or query syntax; the block never applies |
| `undefined-value` | warning | JS: reading a missing property |
| `no-op` | warning | JS: assigning to a missing property |
| `declaration-ignored` | info | CSS: an unknown property or value; the earlier or inherited value applies |
| `differs` | info | Partial support; see the BCD notes in the message |

`--fail-on error` is the useful CI gate: it fails only on code that breaks.

## False-positive controls

| Suppression | Example |
| --- | --- |
| `@supports` naming the feature | `@supports (height: 100dvh) { … }` |
| Fallback declaration | `height: 100vh; height: 100dvh;` |
| Prefixed sibling | `-webkit-user-select: none; user-select: none;` |
| Feature detection | `if ('showModal' in d)`, early `if (!X) return`, `typeof X`, `x?.()`, `x?.y`, `CSS.supports(…) &&`, `try` blocks |
| Unreachable members | `status.state` on a `PermissionStatus` is skipped where `PermissionStatus` doesn't exist. Elements are excepted, because the parser still creates them as `HTMLElement` |
| Curated corpus | [corpus/not-applicable.json](corpus/not-applicable.json): gaps that don't affect users (cursor and resize on touch browsers) |
| Inline comment | `/* quirk-ignore bcd:css.types.length -- reason */` or `// quirk-ignore flexbox-gap`. Applies to its own line and the next; the id can be a rule id, a rule-id prefix or a web-features id |

BCD `version_added: null` means unknown and is never reported.

## Evaluation across codebases

```bash
npm run eval              # every project in eval/corpora.json; rewrites eval/REPORT.md
npm run eval -- dawn      # one project
```

[eval/corpora.json](eval/corpora.json) pins open-source frontends with different
stacks: Bootstrap, Turbo, Alpine, Pico and Dawn. Remote projects are fetched at a
fixed commit into `.scratch/eval/` and only read: their PostCSS configs are never
loaded and nothing is installed or run.

To also measure quirk on your own projects without publishing them, list them in
`eval/corpora.local.json`, with `"local": "<path>"` in place of `repo`/`rev`. Their
labels go in `eval/labels/local/`. Both paths are gitignored. Local projects always
count as held out, are printed when you run the harness, and never appear in
`eval/REPORT.md`.

Precision comes from [eval/labels/](eval/labels), keyed by
`<ruleId> <file>:<line>`, with a `tp`/`fp` verdict and a note. Unlabelled findings
are counted as unlabelled, not as correct. A labelled finding that disappears
shows up as a stale label. Results: [eval/REPORT.md](eval/REPORT.md).

## Limits

- No cross-file context between CSS and markup: for example, whether a sticky
  element's ancestor has `overflow` set.
- SVG and MathML elements, and inline event-handler attributes (`onclick`), are
  not checked.
- Untyped JS loses precision. `document.getElementById(...)` is typed
  `HTMLElement`, so `.showModal()` on it doesn't resolve; `querySelector('dialog')`
  does.
- Attribute severity is uniform (`info`), although an ignored `popover` or `inert`
  attribute changes what users see or can reach.
- Curated quirk rules with repro pages arrive in phase 2. There is no
  `corpus-lab/` yet.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run eval        # see "Evaluation across codebases"
node bin/quirk.mjs check src --root ../some-project
```

In a checkout, `bin/quirk.mjs` runs the TypeScript source directly. An installed copy
runs `dist/`, built by `npm run build`, because Node won't strip types under
`node_modules`.

## Releasing

```bash
npm version <patch|minor|major>
npm pack                      # runs prepare → build; produces quirk-<version>.tgz
```

Attach the tarball to a GitHub release tagged `v<version>`. Consumers install it by URL,
as shown under Install.
