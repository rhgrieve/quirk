import browserslist from 'browserslist';

/** browserslist agent → BCD browser id. Agents without BCD data are reported as skipped. */
const AGENT_TO_BCD: Record<string, string> = {
  chrome: 'chrome',
  and_chr: 'chrome_android',
  edge: 'edge',
  firefox: 'firefox',
  and_ff: 'firefox_android',
  safari: 'safari',
  ios_saf: 'safari_ios',
  samsung: 'samsunginternet_android',
  opera: 'opera',
  op_mob: 'opera_android',
  android: 'webview_android',
};

export interface Target {
  /** BCD browser id, e.g. `safari_ios`. */
  browser: string;
  /** Oldest version of this browser the query selects. */
  version: string;
}

export interface ResolvedTargets {
  query: string;
  targets: Target[];
  /** browserslist entries with no BCD equivalent (`op_mini all`, `kaios 2.5`, …). */
  skipped: string[];
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Resolves the project's browserslist (or an explicit query) to the oldest selected
 * version per BCD browser. Support is checked at that version: BCD support is
 * monotonic apart from `version_removed`, which is checked separately.
 */
export function resolveTargets(root: string, query?: string): ResolvedTargets {
  const entries = browserslist(query, { path: root });
  const effectiveQuery = query ?? (browserslist.loadConfig({ path: root }) ?? ['defaults']).join(', ');
  const oldest = new Map<string, string>();
  const skipped: string[] = [];
  for (const entry of entries) {
    const [agent, rawVersion] = entry.split(' ') as [string, string];
    const browser = AGENT_TO_BCD[agent];
    // ios_saf ranges such as "16.6-16.7": the lower bound is the oldest.
    const version = rawVersion.split('-')[0]!;
    if (!browser || !/^\d+(\.\d+)*$/.test(version)) {
      skipped.push(entry);
      continue;
    }
    const current = oldest.get(browser);
    if (!current || compareVersions(version, current) < 0) oldest.set(browser, version);
  }
  const targets = [...oldest].map(([browser, version]) => ({ browser, version }));
  targets.sort((a, b) => a.browser.localeCompare(b.browser));
  return { query: effectiveQuery, targets, skipped };
}
