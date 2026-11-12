import type { Finding } from './finding.ts';

/**
 * Inline suppression: `quirk-ignore <rule-or-feature> -- reason` in any comment.
 * It applies to findings on the comment's own line and the line after it.
 * The id may be a full rule id (`bcd:css.properties.gap.flex_context`), a prefix of one
 * (`bcd:css.properties.gap`), or a web-features id (`flexbox-gap`).
 */
const IGNORE = /quirk-ignore\s+([^\s*]+)(?:\s+--\s*([^*\n]*))?/g;

export interface IgnoreDirective {
  line: number;
  id: string;
  reason?: string;
}

export function parseIgnores(text: string): IgnoreDirective[] {
  const directives: IgnoreDirective[] = [];
  const lines = text.split('\n');
  lines.forEach((content, index) => {
    for (const m of content.matchAll(IGNORE)) {
      directives.push({ line: index + 1, id: m[1]!, reason: m[2]?.trim() || undefined });
    }
  });
  return directives;
}

function matches(id: string, finding: Finding): boolean {
  if (finding.feature?.id === id) return true;
  return finding.ruleId === id || finding.ruleId.startsWith(`${id}.`);
}

export function applyIgnores(findings: Finding[], directives: IgnoreDirective[]): void {
  for (const finding of findings) {
    if (finding.suppressed) continue;
    const hit = directives.find(
      (d) => (finding.location.line === d.line || finding.location.line === d.line + 1) && matches(d.id, finding),
    );
    if (hit) finding.suppressed = { reason: 'ignore-comment', detail: hit.reason };
  }
}
