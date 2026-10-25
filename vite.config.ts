import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'Tools/worldgen/**/*.test.ts'],
  },
});
