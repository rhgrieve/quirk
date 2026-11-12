import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only quirk's own tests. Never collect files from evaluation checkouts in .scratch/.
    include: ['test/**/*.test.ts'],
    exclude: ['.scratch/**', 'node_modules/**'],
  },
});
