/**
 * JavaScript and TypeScript faults.
 *
 * Recorded behavior (vitest 5.0.2, Node 26, 2026-09-27):
 * - reach, an unterminated test file: exit 1, "FAIL  test/falsegreen_<id>.test.ts".
 * - semantic, a test that throws: exit 1, "FAIL  test/falsegreen_<id>.test.ts > falsegreen_<id>
 *   planted failing test".
 */
import { posix } from 'node:path';

import type { Tier } from '../core/types';
import { candidateDir, markerName } from './placement';
import type { Fault, FaultContext, ToolDef, ToolId } from './types';

export const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
export const JS_TEST_FILE = /((\.|_|-)(test|spec)\.[cm]?[jt]sx?$)|((^|\/)__tests__\/)/;

/** True when the neighbor is CommonJS, so the planted file must use require too. */
function usesRequire(ctx: FaultContext, neighbor: string | undefined, path: string): boolean {
  if (!/\.c?js$/.test(path) || neighbor === undefined) return false;
  const text = ctx.read(neighbor);
  return /\brequire\(/.test(text) && !/^\s*import\s/m.test(text);
}

interface TestRunner {
  id: ToolId;
  /** How the planted test registers itself with the runner. */
  register(cjs: boolean): { preamble: string; call: string };
}

function testFault(runner: TestRunner, ctx: FaultContext, tier: Tier): Fault | { skip: string } {
  const where = candidateDir(ctx, { kind: 'test', exts: JS_EXTS, testPattern: JS_TEST_FILE });
  if (!where) return { skip: `no test files found where ${runner.id} runs` };
  const m = ctx.marker;
  const path = where.neighbor
    ? markerName(where.neighbor, m, 'js')
    : posix.join(where.dir, `${m.snake}.test.ts`);
  const { preamble, call } = runner.register(usesRequire(ctx, where.neighbor, path));
  const content =
    tier === 'reach'
      ? `${preamble}\n${call}('${m.snake}', () => {\n`
      : `${preamble}\n\n${call}('${m.snake} planted failing test', () => {\n  throw new Error('${m.snake}: planted failing test');\n});\n`;
  return {
    tool: runner.id,
    tier,
    marker: m,
    files: [{ path, content }],
    appends: [],
    description:
      tier === 'reach' ? `test file that does not parse: ${path}` : `failing test: ${path}`,
  };
}

const vitestRunner: TestRunner = {
  id: 'vitest',
  register: (cjs) => ({
    preamble: cjs ? "const { test } = require('vitest');" : "import { test } from 'vitest';",
    call: 'test',
  }),
};

export const vitest: ToolDef = {
  id: 'vitest',
  language: 'js',
  category: 'test',
  faults: (ctx, tier) => testFault(vitestRunner, ctx, tier),
};
