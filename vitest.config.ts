import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

// Everything the tests write (temp repos, fixture copies, planted faults) stays
// inside this checkout. Workers inherit TMPDIR, so os.tmpdir() lands here too.
const tmp = join(dirname(fileURLToPath(import.meta.url)), 'tmp');
mkdirSync(tmp, { recursive: true });
process.env.TMPDIR = tmp;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Fixture repositories carry their own test files; they run only inside fixture tests.
    exclude: [...configDefaults.exclude, 'test/fixtures/**'],
    environment: 'node',
    // Fixture tests run real toolchains (cargo, gradle) against planted faults.
    testTimeout: 300_000,
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
      thresholds: {
        statements: 80,
        branches: 70,
        functions: 80,
        lines: 80,
      },
    },
  },
});
