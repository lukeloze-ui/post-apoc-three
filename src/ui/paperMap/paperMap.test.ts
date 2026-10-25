import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('paper map knows only the world before the disaster', () => {
  const dir = 'src/ui/paperMap';
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('imports no flood, bands, lakes, districts or ground data', () => {
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const imports = [...readFileSync(join(dir, f), 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const spec of imports) expect(spec, `${f} imports ${spec}`).not.toMatch(/flood|bands|lakes|district|surface|ground/i);
    }
  });
});
