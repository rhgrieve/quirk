import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { check } from '../src/engine/check.ts';

const css = '.a { height: 100dvh; }\n';

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'quirk-git-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  writeFileSync(path.join(dir, '.gitignore'), 'generated/\nvendor/\n');
  for (const f of ['src/a.css', 'generated/b.css', 'vendor/c.css']) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), css);
  }
  // Tracked despite the ignore rule: still checked.
  execFileSync('git', ['add', '-f', 'vendor/c.css'], { cwd: dir });
  return dir;
}

const files = (r: Awaited<ReturnType<typeof check>>, root: string) =>
  [...new Set(r.findings.map((f) => path.relative(root, f.location.file)))].sort();

describe('gitignore', () => {
  const options = { paths: ['.'], targets: 'safari 15', postcss: false as const, baseline: false as const };

  it('skips files git ignores but keeps tracked ones', async () => {
    const root = repo();
    const result = await check({ root, ...options });
    expect(files(result, root)).toEqual(['src/a.css', 'vendor/c.css']);
    expect(result.gitignored).toBe(1);
  });

  it('checks ignored files on request', async () => {
    const root = repo();
    const result = await check({ root, ...options, gitignore: false });
    expect(files(result, root)).toEqual(['generated/b.css', 'src/a.css', 'vendor/c.css']);
    expect(result.gitignored).toBe(0);
  });

  it('checks everything outside a git repository', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'quirk-nogit-'));
    mkdirSync(path.join(root, 'generated'));
    writeFileSync(path.join(root, '.gitignore'), 'generated/\n');
    writeFileSync(path.join(root, 'generated/b.css'), css);
    const result = await check({ root, ...options });
    expect(files(result, root)).toEqual(['generated/b.css']);
  });
});
