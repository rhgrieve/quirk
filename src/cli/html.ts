/**
 * Self-contained HTML report: one file, no external requests, light and dark themes.
 * Findings are embedded as JSON and rendered with textContent, so nothing from the
 * analysed code is ever interpreted as HTML.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { browserName, plainText } from '../data/bcd.ts';
import type { CheckResult } from '../engine/check.ts';
import { FAILURE, SEVERITY_RANK } from '../engine/failure.ts';
import type { Finding } from '../engine/finding.ts';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
const strip = plainText;

interface ReportLocation {
  file: string;
  line: number;
  column: number;
  snippet: { line: number; text: string }[];
  suppressed?: string;
}

interface ReportGroup {
  ruleId: string;
  subject: string;
  severity: string;
  failure: string;
  failureSummary: string;
  message: string;
  feature?: { id: string; name: string; baseline: string };
  affected: { browser: string; version: string; status: string; from?: string; notes: string[] }[];
  evidence: string[];
  locations: ReportLocation[];
}

function baselineText(f: Finding): string {
  const b = f.feature?.baseline;
  if (b === 'high') return 'Baseline widely available';
  if (b === 'low') return `Baseline ${f.feature?.baselineLowDate?.slice(0, 4) ?? ''} newly available`.replace('  ', ' ');
  if (b === false) return 'Not Baseline';
  return '';
}

function snippetFor(file: string, line: number, cache: Map<string, string[]>): { line: number; text: string }[] {
  let lines = cache.get(file);
  if (!lines) {
    lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : [];
    cache.set(file, lines);
  }
  const out: { line: number; text: string }[] = [];
  for (let n = Math.max(1, line - 1); n <= Math.min(lines.length, line + 1); n++) {
    out.push({ line: n, text: (lines[n - 1] ?? '').slice(0, 240) });
  }
  return out;
}

function buildData(result: CheckResult, root: string) {
  const cache = new Map<string, string[]>();
  const groups = new Map<string, Finding[]>();
  for (const f of result.findings) {
    const list = groups.get(f.ruleId) ?? [];
    list.push(f);
    groups.set(f.ruleId, list);
  }
  const report: ReportGroup[] = [...groups.values()].map((list) => {
    list.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.location.file.localeCompare(b.location.file) || a.location.line - b.location.line);
    const first = list.find((f) => !f.suppressed) ?? list[0]!;
    return {
      ruleId: first.ruleId,
      subject: first.subject,
      severity: first.severity,
      failure: first.failure,
      failureSummary: FAILURE[first.failure].summary,
      // The failure mode and notes get their own lines in the report.
      message: first.message.split(' Notes – ')[0]!.replace(`; ${FAILURE[first.failure].summary}.`, '.'),
      feature: first.feature ? { id: first.feature.id, name: first.feature.name, baseline: baselineText(first) } : undefined,
      affected: first.affected.map((a) => ({
        browser: browserName(a.browser),
        version: a.version,
        status: a.status === 'prefix' ? `prefix ${a.prefix ?? a.alternativeName ?? ''}`.trim() : a.status,
        from: a.supportedFrom,
        notes: (a.notes ?? []).map(strip),
      })),
      evidence: first.evidence.filter((u) => /^https:\/\//.test(u)),
      locations: list.map((f) => ({
        file: path.relative(root, f.location.file).split(path.sep).join('/'),
        line: f.location.line,
        column: f.location.column,
        snippet: snippetFor(f.location.file, f.location.line, cache),
        suppressed: f.suppressed ? `${f.suppressed.reason}${f.suppressed.detail ? `: ${f.suppressed.detail}` : ''}` : undefined,
      })),
    };
  });
  return {
    tool: `quirk ${version}`,
    project: path.basename(root),
    generated: new Date().toISOString(),
    query: result.targets.query,
    targets: result.targets.targets.map((t) => ({ browser: browserName(t.browser), version: t.version })),
    skippedAgents: result.targets.skipped,
    files: result.files,
    postcss: result.postcss,
    gitignored: result.gitignored,
    unparsed: result.unparsed.length,
    baseline: result.baseline
      ? { file: path.relative(root, result.baseline.file), matched: result.baseline.matched, stale: result.baseline.stale }
      : undefined,
    groups: report,
  };
}

/** JSON safe inside a <script> element: no `</script>`, `<!--` or line separators survive. */
function embed(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function formatHtml(result: CheckResult, root: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="quirk ${version}">
<title>quirk report</title>
<style>${CSS}</style>
</head>
<body>
<header class="top">
  <div class="wrap">
    <div class="brand"><span class="mark" aria-hidden="true">q</span><div><h1>Compatibility report</h1><p class="sub" id="sub"></p></div></div>
    <ul class="targets" id="targets" aria-label="Target browsers"></ul>
  </div>
</header>
<main class="wrap">
  <section class="cards" id="cards" aria-label="Summary"></section>
  <p class="meta" id="meta"></p>
  <section class="toolbar" aria-label="Filters">
    <input id="q" type="search" placeholder="Filter by file, feature or rule" aria-label="Filter by file, feature or rule">
    <div class="sev" role="group" aria-label="Severity">
      <button type="button" data-sev="error" aria-pressed="true">Errors</button>
      <button type="button" data-sev="warning" aria-pressed="true">Warnings</button>
      <button type="button" data-sev="info" aria-pressed="true">Info</button>
    </div>
    <select id="browser" aria-label="Browser"><option value="">All browsers</option></select>
    <label class="check"><input id="supp" type="checkbox"> Show suppressed</label>
  </section>
  <p class="count" id="count" aria-live="polite"></p>
  <section id="list"></section>
</main>
<footer class="wrap foot" id="foot"></footer>
<script id="data" type="application/json">${embed(buildData(result, root))}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const CSS = `
:root{--bg:#f7f7f5;--panel:#fff;--ink:#1c1d1f;--muted:#62666d;--line:#e3e3df;--code:#f2f2ef;--hl:#fff4cc;
--error:#c4302b;--error-bg:#fdecea;--warning:#a35c00;--warning-bg:#fff3e0;--info:#2b6cb0;--info-bg:#e8f1fb;--ok:#2f7d4f;--accent:#1c1d1f;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#121315;--panel:#1b1c1f;--ink:#e8e8e6;--muted:#9a9ea5;--line:#2c2e33;--code:#232428;--hl:#3a3418;
--error:#ff7b72;--error-bg:#3a1d1c;--warning:#f0b35a;--warning-bg:#3a2a12;--info:#79b8ff;--info-bg:#152a40;--ok:#6fcf97;--accent:#e8e8e6}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 var(--sans)}
.wrap{max-width:1100px;margin:0 auto;padding:0 16px}
.top{background:var(--panel);border-bottom:1px solid var(--line);padding:20px 0}
.top .wrap{display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between}
.brand{display:flex;gap:12px;align-items:center}
.mark{flex:none;display:grid;place-items:center;width:36px;height:36px;border-radius:9px;background:var(--accent);color:var(--bg);font:700 20px/1 var(--mono)}
h1{font-size:20px;margin:0;letter-spacing:-.01em}
.sub{margin:2px 0 0;color:var(--muted);font-size:13px}
.targets{display:flex;flex-wrap:wrap;gap:6px;list-style:none;margin:0;padding:0}
.targets li{font-size:12px;padding:3px 8px;border:1px solid var(--line);border-radius:999px;color:var(--muted);white-space:nowrap}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:24px 0 8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:14px 16px}
.card b{display:block;font-size:28px;line-height:1.1;font-variant-numeric:tabular-nums}
.card span{color:var(--muted);font-size:13px}
.card.error b{color:var(--error)}.card.warning b{color:var(--warning)}.card.info b{color:var(--info)}
.meta{color:var(--muted);font-size:13px;margin:8px 0 20px}
.toolbar{position:sticky;top:0;z-index:2;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:12px 0;background:var(--bg)}
.toolbar input[type=search],.toolbar select{font:inherit;font-size:14px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink)}
.toolbar input[type=search]{flex:1 1 260px;min-width:0}
.sev{display:flex;border:1px solid var(--line);border-radius:8px;overflow:hidden}
.sev button{font:inherit;font-size:13px;padding:7px 12px;border:0;background:var(--panel);color:var(--muted);cursor:pointer}
.sev button+button{border-left:1px solid var(--line)}
.sev button[aria-pressed=true][data-sev=error]{background:var(--error-bg);color:var(--error)}
.sev button[aria-pressed=true][data-sev=warning]{background:var(--warning-bg);color:var(--warning)}
.sev button[aria-pressed=true][data-sev=info]{background:var(--info-bg);color:var(--info)}
.check{display:flex;gap:6px;align-items:center;font-size:14px;color:var(--muted)}
.count{color:var(--muted);font-size:13px;margin:4px 0 12px}
.group{background:var(--panel);border:1px solid var(--line);border-radius:12px;margin:0 0 12px;overflow:hidden}
.group>summary{list-style:none;cursor:pointer;padding:14px 16px;display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:center}
.group>summary::-webkit-details-marker{display:none}
.group>summary:focus-visible{outline:2px solid var(--info);outline-offset:-2px}
.pill{min-width:76px;text-align:center;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;padding:3px 8px;border-radius:999px}
.pill.error{background:var(--error-bg);color:var(--error)}.pill.warning{background:var(--warning-bg);color:var(--warning)}.pill.info{background:var(--info-bg);color:var(--info)}
.title{min-width:0}.title strong{display:block;overflow-wrap:anywhere}
.title code{font:12px var(--mono);color:var(--muted);overflow-wrap:anywhere}
.n{font-size:13px;color:var(--muted);white-space:nowrap}
.body{border-top:1px solid var(--line);padding:16px}
.msg{margin:0 0 6px}.msg code,.loc code{font:13px var(--mono);background:var(--code);padding:1px 5px;border-radius:5px}
.fail{margin:0 0 14px;color:var(--muted);font-size:14px}
.tag{display:inline-block;font:12px var(--mono);padding:1px 6px;border:1px solid var(--line);border-radius:6px;margin-right:6px}
.tablewrap{overflow-x:auto;margin:0 0 12px}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td.st-no{color:var(--error)}td.st-partial,td.st-prefix{color:var(--warning)}
.notes{margin:0 0 12px;padding-left:18px;color:var(--muted);font-size:14px}
.links{display:flex;flex-wrap:wrap;gap:12px;margin:0 0 14px;font-size:14px}
.links a{color:var(--info)}
.locs{display:grid;gap:10px}
.loc{border:1px solid var(--line);border-radius:10px;overflow:hidden}
.loc.supp{opacity:.62}
.loc header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:8px 12px;font:13px var(--mono);background:var(--code)}
.reason{font:12px var(--sans);color:var(--muted)}
pre{margin:0;padding:8px 0;overflow-x:auto;font:12.5px/1.6 var(--mono)}
pre div{display:grid;grid-template-columns:4.5em 1fr;white-space:pre}
pre div.at{background:var(--hl)}
pre span.ln{color:var(--muted);text-align:right;padding-right:14px;user-select:none}
.empty{padding:40px 16px;text-align:center;color:var(--muted);background:var(--panel);border:1px dashed var(--line);border-radius:12px}
.foot{color:var(--muted);font-size:12px;padding:24px 16px 40px}
@media (max-width:640px){.group>summary{grid-template-columns:1fr auto}.group>summary .pill{grid-column:1/-1;justify-self:start}}
`;

const SCRIPT = `
(() => {
  const data = JSON.parse(document.getElementById('data').textContent);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const RANK = { error: 3, warning: 2, info: 1 };
  const LABEL = { error: 'Error', warning: 'Warning', info: 'Info' };

  /* Backticked spans in messages become <code>, everything else stays text. */
  const rich = (text) => { const f = document.createDocumentFragment(); text.split('\`').forEach((part, i) => f.append(i % 2 ? el('code', null, part) : document.createTextNode(part))); return f; };

  document.getElementById('sub').textContent = data.project + ' · ' + data.files + ' files · ' + new Date(data.generated).toLocaleString();
  const targets = document.getElementById('targets');
  data.targets.forEach((t) => targets.append(el('li', null, t.browser + ' ' + t.version + '+')));

  const active = (loc) => !loc.suppressed;
  const count = (sev) => data.groups.filter((g) => g.severity === sev).reduce((n, g) => n + g.locations.filter(active).length, 0);
  const suppressedCount = data.groups.reduce((n, g) => n + g.locations.filter((l) => !active(l)).length, 0);
  const cards = document.getElementById('cards');
  [['error', 'Errors', count('error')], ['warning', 'Warnings', count('warning')], ['info', 'Info', count('info')], ['', 'Suppressed', suppressedCount], ['', 'Files checked', data.files]]
    .forEach(([cls, label, n]) => { const c = el('div', 'card ' + cls); c.append(el('b', null, String(n)), el('span', null, label)); cards.append(c); });

  const meta = ['Targets: ' + data.query];
  meta.push(data.postcss ? 'CSS analysed after the project PostCSS pipeline' : 'CSS analysed as written');
  if (data.baseline) meta.push('Baseline ' + data.baseline.file + ': ' + data.baseline.matched + ' accepted' + (data.baseline.stale ? ', ' + data.baseline.stale + ' stale entries' : ''));
  if (data.gitignored) meta.push(data.gitignored + ' gitignored files skipped');
  if (data.unparsed) meta.push(data.unparsed + ' embedded blocks could not be parsed');
  if (data.skippedAgents.length) meta.push('No compat data: ' + data.skippedAgents.join(', '));
  document.getElementById('meta').textContent = meta.join(' · ');
  document.getElementById('foot').textContent = 'Generated by ' + data.tool + ' from MDN browser-compat-data and web-features. Run quirk explain <rule> for per-browser detail.';

  const browserSelect = document.getElementById('browser');
  [...new Set(data.groups.flatMap((g) => g.affected.map((a) => a.browser)))].sort().forEach((b) => { const o = el('option', null, b); o.value = b; browserSelect.append(o); });

  const state = { q: '', sev: new Set(['error', 'warning', 'info']), browser: '', supp: false };

  const renderGroup = (g, locs) => {
    const d = el('details', 'group');
    const s = el('summary');
    const title = el('div', 'title');
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const heading = g.feature && norm(g.feature.name) !== norm(g.subject) ? g.feature.name + ' — ' + g.subject : g.subject;
    title.append(el('strong', null, heading), el('code', null, g.ruleId));
    s.append(el('span', 'pill ' + g.severity, LABEL[g.severity]), title, el('span', 'n', locs.length + (locs.length === 1 ? ' location' : ' locations')));
    d.append(s);
    d.addEventListener('toggle', () => { if (d.open && !d.dataset.filled) { d.dataset.filled = '1'; d.append(renderBody(g, locs)); } }, { once: false });
    return d;
  };

  const renderBody = (g, locs) => {
    const b = el('div', 'body');
    const msg = el('p', 'msg'); msg.append(rich(g.message)); b.append(msg);
    const fail = el('p', 'fail'); fail.append(el('span', 'tag', g.failure), document.createTextNode(g.failureSummary.charAt(0).toUpperCase() + g.failureSummary.slice(1) + '.'));
    if (g.feature && g.feature.baseline) fail.append(document.createTextNode(' ' + g.feature.name + ': ' + g.feature.baseline + '.'));
    b.append(fail);

    const wrap = el('div', 'tablewrap'); const t = el('table'); const head = el('tr');
    ['Browser', 'Target', 'Support', 'Full support from'].forEach((h) => head.append(el('th', null, h)));
    t.append(head);
    const notes = [];
    g.affected.forEach((a) => {
      const r = el('tr');
      r.append(el('td', null, a.browser), el('td', null, a.version), el('td', 'st-' + a.status.split(' ')[0], a.status), el('td', null, a.from || '—'));
      t.append(r);
      a.notes.forEach((n) => { if (!notes.includes(n)) notes.push(n); });
    });
    wrap.append(t); b.append(wrap);
    if (notes.length) { const ul = el('ul', 'notes'); notes.forEach((n) => ul.append(el('li', null, n))); b.append(ul); }
    if (g.evidence.length) {
      const links = el('div', 'links');
      g.evidence.forEach((u) => { const a = el('a', null, /developer\\.mozilla\\.org/.test(u) ? 'MDN reference' : 'Specification'); a.href = u; a.target = '_blank'; a.rel = 'noopener noreferrer'; links.append(a); });
      b.append(links);
    }
    const list = el('div', 'locs');
    locs.forEach((l) => {
      const box = el('div', 'loc' + (l.suppressed ? ' supp' : ''));
      const h = el('header'); h.append(el('span', null, l.file + ':' + l.line + ':' + l.column));
      if (l.suppressed) h.append(el('span', 'reason', 'Suppressed — ' + l.suppressed));
      const pre = el('pre');
      l.snippet.forEach((s) => { const row = el('div', s.line === l.line ? 'at' : ''); row.append(el('span', 'ln', String(s.line)), el('span', null, s.text)); pre.append(row); });
      box.append(h, pre); list.append(box);
    });
    b.append(list);
    return b;
  };

  const render = () => {
    const list = document.getElementById('list');
    list.textContent = '';
    const q = state.q.toLowerCase();
    let shownLocs = 0;
    const groups = data.groups
      .filter((g) => state.sev.has(g.severity))
      .filter((g) => !state.browser || g.affected.some((a) => a.browser === state.browser))
      .map((g) => {
        const groupMatch = !q || (g.ruleId + ' ' + g.subject + ' ' + (g.feature ? g.feature.name : '')).toLowerCase().includes(q);
        const locs = g.locations.filter((l) => (state.supp || active(l)) && (groupMatch || l.file.toLowerCase().includes(q)));
        return { g, locs };
      })
      .filter((x) => x.locs.length)
      .sort((a, b) => RANK[b.g.severity] - RANK[a.g.severity] || b.locs.length - a.locs.length);
    groups.forEach(({ g, locs }) => { shownLocs += locs.length; list.append(renderGroup(g, locs)); });
    if (!groups.length) list.append(el('div', 'empty', data.groups.length ? 'No findings match these filters.' : 'No findings. Every checked feature is supported in all targets.'));
    document.getElementById('count').textContent = groups.length + (groups.length === 1 ? ' feature, ' : ' features, ') + shownLocs + (shownLocs === 1 ? ' location' : ' locations');
    const first = list.querySelector('details');
    if (first && groups.length <= 3) groups.forEach((_, i) => { list.children[i].open = true; });
  };

  document.getElementById('q').addEventListener('input', (e) => { state.q = e.target.value.trim(); render(); });
  document.getElementById('browser').addEventListener('change', (e) => { state.browser = e.target.value; render(); });
  document.getElementById('supp').addEventListener('change', (e) => { state.supp = e.target.checked; render(); });
  document.querySelectorAll('.sev button').forEach((btn) => btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-pressed') !== 'true';
    btn.setAttribute('aria-pressed', String(on));
    if (on) state.sev.add(btn.dataset.sev); else state.sev.delete(btn.dataset.sev);
    render();
  }));
  render();
})();
`;
