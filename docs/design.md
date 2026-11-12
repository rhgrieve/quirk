# quirk: design and roadmap

## Why

Testing cross-browser behaviour usually means running real browsers. In practice, many
suites run only Chromium, so Safari, iOS WebKit and Firefox differences go unnoticed
until users hit them. Many projects also never declare a `browserslist`, so their
build tools quietly fall back to `defaults`.

quirk reads source (CSS, JS/TS, HTML and template languages) and checks it against a
corpus of known browser differences: support gaps, spec deviations and documented bugs.
It reports findings with evidence, without launching a browser.

Scope:

- **Compatibility only.** Functional flows (does checkout work?) still need a browser
  suite. Static analysis can't verify behaviour end to end, and quirk doesn't pretend to.
- **Generic.** Any web project can use it; nothing is specific to one framework or site.
- **Corpus order:** structured data first (MDN browser-compat-data, web-features), then
  curated behavioural rules from public sources, then assisted mining of bug trackers
  and WPT results.

## Two kinds of rules

1. **Support rules (generated).** "Feature X isn't supported, or needs a prefix, in
   target Y." These are lookups in `@mdn/browser-compat-data` and `web-features`.
   Existing tools (`eslint-plugin-compat`, `doiuse`,
   `stylelint-no-unsupported-browser-features`) cover parts of this. quirk reuses the
   data, not those tools, so every language goes through one engine and one output
   format.
2. **Quirk rules (curated; not started).** "Feature X *is* supported but behaves
   differently in Y under condition Z." Examples: `100vh` with the iOS URL bar,
   `position: sticky` under an `overflow` ancestor, `ResizeObserver` loop errors,
   `IntersectionObserver` `rootMargin` inside iframes. Each rule is a pattern, a
   condition, evidence and a fix.

## Architecture

```
src/
  data/        BCD and web-features access, CSS unit/function indexes
  engine/      targets, support evaluation, findings, failure modes, ignores, baseline, check
  lang-css/    PostCSS adapter: properties, values, units, functions, at-rules, selectors
  lang-js/     TypeScript checker adapter: type-aware Web API and built-in resolution
  lang-html/   parse5 adapter: elements, attributes, embedded CSS/JS; template plug-ins
  cli/         check, baseline, explain, targets; text, JSON and SARIF reporters
corpus/        curated data (not-applicable platform gaps today)
eval/          multi-codebase evaluation harness
```

**Targets** come from the project's browserslist, resolved to the oldest selected
version per browser.

**Severity** comes from how the code fails where the feature is missing. The adapters
work this out from syntax alone, with no per-feature curation:

| How it fails | Severity |
| --- | --- |
| A JS call or global reference throws | error |
| An unknown selector drops the other selectors in its list | error |
| A rule, at-rule block or element stops working | warning |
| A JS read returns `undefined`, or an assignment does nothing | warning |
| A declaration or attribute is ignored and falls back | info |
| Partial support (behaviour differs) | info |

**Guard awareness** is the main defence against false positives:
- matching `@supports` blocks
- fallback declarations
- prefixed siblings
- feature detection: `in`, `typeof`, optional chaining, early exits, `try`
- guards through helpers and around inline callbacks

**Source vs build:** CSS files go through the project's own PostCSS config, so features
it compiles away aren't reported. CSS embedded in markup is analysed as written.

**Templates** are plug-ins that neutralise template syntax without moving anything, so
every finding points at the original line and column. Liquid is the first plug-in.

**Output:** text, JSON and SARIF. Inline `quirk-ignore` comments and a baseline file
make adoption start from zero.

## Staying generic

quirk must not be tuned to one codebase. Three rules keep it that way:

- **Rules come from public sources only.** These are BCD and its notes, caniuse known
  issues, WebKit/Chromium/Mozilla bugs with a web-platform-tests case, and Interop focus
  areas. A rule qualifies because many sites hit it, and its repro page has nothing to do
  with any app. No rule is written from one project's history.
- **Consumer codebases are evaluation data, never rule sources.** A project's past
  browser fixes make a held-out recall set.
- **Changes are judged on several codebases.** `npm run eval` runs quirk against
  pinned open-source frontends with different stacks, plus any local held-out projects
  listed in the gitignored `eval/corpora.local.json`. A heuristic or rule ships only if
  precision holds up on all of them.

## Keeping a curated corpus honest

Each curated rule will ship with a minimal repro page in `corpus-lab/`. CI will run
those pages in real WebKit, Firefox and Chromium and record whether each quirk still
reproduces in each version, writing the result back into the rule's version range.
Browser testing then happens once per rule here, not once per app on every change.

## Roadmap

1. **Support rules (done).** CSS and JS adapters, BCD and web-features, browserslist
   targets, guard awareness.
2. **Failure-mode severity and evaluation harness (done).**
3. **HTML and template plug-ins (done, except cross-file context).** There is no
   CSS × markup context yet (for example, a sticky element inside an `overflow`
   ancestor defined in another file).
4. **Adoption (done).** Baseline, SARIF, `quirk explain`, an installable build, and
   recipes in `docs/adoption.md`.
5. **Curated quirks from public sources (on hold).** Behavioural rules with repro pages,
   each holding up across the evaluation harness. Assisted mining of bug trackers and
   WPT diffs produces draft rules that need a reproducing page and human review.

## Verification

- **Unit tests:** each behaviour has positive, negative and guarded fixtures.
- **Held-out recall:** for past browser fixes in a consumer project, check out the
  pre-fix commit and confirm quirk flags it. The incidents measure quirk; they never
  become rules.
- **Precision across codebases:** `npm run eval` reports precision from labelled
  findings. Keep under 20% false positives on every project before recommending CI
  blocking beyond `--fail-on error`.

## Open questions

- Weighting severity by real traffic share per browser.
- Real-device coverage (iOS) for the corpus lab.
- SVG/MathML elements and inline event-handler attributes.
