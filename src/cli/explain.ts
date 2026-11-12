import { browserName, plainText, compatAt, webFeatureFor } from '../data/bcd.ts';
import { supportAt } from '../engine/support.ts';
import type { ResolvedTargets } from '../engine/targets.ts';

const strip = plainText;

/** Per-target support for one rule (`bcd:css.properties.gap.flex_context` or the bare BCD path). */
export function explain(id: string, targets: ResolvedTargets): string | undefined {
  const bcdPath = id.replace(/^bcd:/, '');
  const compat = compatAt(bcdPath);
  if (!compat) return undefined;
  const lines: string[] = [];
  const feature = webFeatureFor(bcdPath);
  lines.push(`bcd:${bcdPath}${compat.description ? ` – ${strip(compat.description)}` : ''}`);
  if (feature) {
    const b = feature.baseline;
    const status = b === 'high' ? 'Baseline widely available' : b === 'low' ? `Baseline newly available (${feature.baselineLowDate})` : b === false ? 'not Baseline' : 'Baseline status unknown';
    lines.push(`web feature: ${feature.name} (${feature.id}), ${status}`);
  }
  const flags = Object.entries(compat.status ?? {}).filter(([k, v]) => v && k !== 'standard_track').map(([k]) => k);
  if (flags.length) lines.push(`status: ${flags.join(', ')}`);
  if (compat.mdn_url) lines.push(`mdn: ${compat.mdn_url}`);
  for (const spec of [compat.spec_url].flat().filter(Boolean)) lines.push(`spec: ${spec}`);
  lines.push('', `targets (${targets.query}):`);
  for (const t of targets.targets) {
    const s = supportAt(compat, t);
    const how = s.status === 'prefix' ? `prefix ${s.prefix ?? s.alternativeName}` : s.status;
    const from = s.status !== 'yes' && s.supportedFrom ? `, full support from ${s.supportedFrom}` : '';
    lines.push(`  ${s.status === 'yes' ? '✓' : s.status === 'unknown' ? '?' : '✗'} ${browserName(t.browser)} ${t.version}: ${how}${from}`);
    for (const note of s.notes ?? []) lines.push(`      ${strip(note)}`);
  }
  lines.push('', 'Severity depends on how code uses it (called, read, a selector in a list, …); see the README.');
  return lines.join('\n');
}
