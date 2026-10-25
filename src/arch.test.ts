import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function listTs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listTs(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('architecture: src/sim and src/world are pure', () => {
  const files = ['src/sim', 'src/world'].flatMap(listTs);

  it('imports no three', () => {
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      expect(src, f).not.toMatch(/from\s+['"]three(\/[^'"]*)?['"]|import\s*\(\s*['"]three|require\(\s*['"]three/);
    }
  });

  it('uses no window or document', () => {
    for (const f of files) {
      const src = stripComments(readFileSync(f, 'utf8'));
      expect(src, f).not.toMatch(/\b(window|document)\b/);
    }
  });
});
