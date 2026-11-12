# Adopting quirk in a project

These steps work for any web project: a framework app, a static site or a template-based
theme. Commands assume quirk is installed as a dev dependency from a release tarball (see
the README's Install section).

## 1. Declare your browser targets

quirk reads the project's browserslist (`package.json`, `.browserslistrc` or
`browserslist`), the same config autoprefixer and postcss-preset-env use. Without one,
everything falls back to `defaults`.

```bash
npx quirk targets
```

## 2. Look before you gate

```bash
npx quirk check src
npx quirk check src templates --format json > quirk.json
npx quirk explain bcd:css.properties.gap.flex_context
```

Pass every directory that holds CSS, JS/TS, HTML or template files; the default is `src`.
If a project has a PostCSS config, CSS files run through it first, so features it compiles
away are not reported. CSS embedded in markup is checked as written.

Severity follows how the code fails where a feature is missing:

| Severity | Typical meaning |
| --- | --- |
| error | The code throws, or a selector drops other selectors in its list |
| warning | A rule, block or element stops working, or a read returns `undefined` |
| info | A declaration or attribute is ignored and something falls back |

Fix what matters, then handle the rest:

- **Intentional uses:** an inline `quirk-ignore <rule> -- reason` comment, in any comment
  syntax (`/* */`, `//`, `<!-- -->`, `{% comment %}`).
- **Everything else you accept for now:** a baseline (next step).
- **The wrong target list:** change browserslist, not quirk.

## 3. Baseline today's findings

```bash
npx quirk baseline src templates
```

This writes `.quirk-baseline.json`. Commit it, and `quirk check` will report only findings
that aren't in it. Entries match on rule, file and line text, not line numbers, so
unrelated edits don't disturb them. When code is fixed, `check` reports stale entries;
run `quirk baseline` again to prune them. Regenerate only on purpose: running it with new
findings present accepts them too.

## 4. Gate in pre-commit (lefthook)

```yaml
pre-commit:
  jobs:
    - name: quirk
      glob: "**/*.{css,js,mjs,ts,tsx,html,liquid}"
      run: npx quirk check {staged_files} --fail-on error
```

Start with `--fail-on error`, which only fails on code that breaks. Staged runs are fast
because only those files are analysed. Imports still resolve through the tsconfig, so
types flow in from unstaged files.

## 5. Report in CI

Plain gate, any CI:

```bash
npx quirk check src templates --fail-on error
```

GitHub code scanning, which shows findings inline on pull requests:

```yaml
jobs:
  quirk:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npx quirk check src templates --format sarif > quirk.sarif
      - uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: quirk.sarif
          category: quirk
```

Code scanning on private repositories needs GitHub's code security features enabled for
the organisation. Without them, use the plain gate. SARIF output includes suppressed
findings, marked as dismissed, and fingerprints that follow code across line changes.

## 6. Keep it current

quirk's support data comes from `@mdn/browser-compat-data` and `web-features`. Findings
change when that data updates or browserslist moves on. Pin quirk's version and upgrade
deliberately, then run `quirk check` and prune or extend the baseline in the same change.
