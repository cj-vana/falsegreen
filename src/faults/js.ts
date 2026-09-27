/**
 * JavaScript and TypeScript faults.
 *
 * Recorded behavior (2026-09-27, Node 26; each tool run on each fault in a scratch git repo):
 * - vitest 5.0.2: reach exit 1 "FAIL  test/falsegreen_<id>.test.ts"; semantic exit 1, same line
 *   plus the test title.
 * - jest 30.5.2: reach exit 1 "FAIL test/falsegreen_<id>.test.js" (SyntaxError); semantic exit 1.
 * - mocha 12.0.2: reach exit 1 "SyntaxError[ @.../falsegreen_<id>.spec.js ]"; semantic exit 1
 *   "1) falsegreen_<id> planted failing test".
 * - node --test (Node 26): reach exit 1 "test/falsegreen_<id>.test.js"; semantic exit 1.
 * - bun test 1.3.14: reach exit 1 "test/falsegreen_<id>.test.ts:"; semantic exit 1.
 * - tsc 6.0.3 and vue-tsc 3.3.11: reach exit 2 "src/falsegreen_<id>.ts(1,35): error TS1109";
 *   semantic exit 2 "error TS2322".
 * - eslint 10.11 with typescript-eslint recommended: reach exit 1; semantic (unused variable)
 *   exit 1 "@typescript-eslint/no-unused-vars", file path printed.
 * - biome 2.5.14: `lint` reach exit 1; the unused variable is a warning and `biome lint` exits 0
 *   (exit 1 with --error-on-warnings). `format` reach exit 1, misformatted file exit 1.
 *   `check` and `ci` exit 1 on all three faults.
 * - oxlint 1.85.0: reach exit 1; the unused variable is a warning, exit 0 (exit 1 with
 *   --deny-warnings).
 * - prettier 3.9.9 --check: reach exit 2 "[error] src/falsegreen_<id>.ts: SyntaxError"; misformatted
 *   file exit 1 "[warn] src/falsegreen_<id>.ts".
 */
import { posix } from 'node:path';

import type { Tier } from '../core/types';
import { candidateDir, markerName, type Shape } from './placement';
import { tsconfigAccepts } from './tsconfig';
import type { Category, Fault, FaultContext, ToolDef, ToolId } from './types';

export const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts'];
export const JS_TEST_FILE = /((\.|_|-)(test|spec)\.[cm]?[jt]sx?$)|((^|\/)__tests__\/)/;
/** mocha and node --test also run files that merely sit in a test directory. */
const TEST_DIR_FILE = /((\.|_|-)(test|spec)\.[cm]?[jt]sx?$)|((^|\/)(__tests__|test|tests|spec)\/)/;

/** True when the planted file must be CommonJS: a .cjs name, or a .js neighbor that uses require. */
function commonJs(ctx: FaultContext, neighbor: string | undefined, path: string): boolean {
  if (path.endsWith('.cjs')) return true;
  if (!path.endsWith('.js') || neighbor === undefined) return false;
  const text = ctx.read(neighbor);
  return /\brequire\(/.test(text) && !/^\s*(import|export)\s/m.test(text);
}

function fault(
  ctx: FaultContext,
  tool: ToolId,
  tier: Tier,
  path: string,
  content: string,
  what: string,
): Fault {
  return {
    tool,
    tier,
    marker: ctx.marker,
    files: [{ path, content }],
    appends: [],
    description: tier === 'reach' ? `${what} that does not parse: ${path}` : `${what}: ${path}`,
  };
}

interface TestRunner {
  id: ToolId;
  testPattern: RegExp;
  /** The lines that make `test`/`it` available in the planted file, and which to call. */
  register(cjs: boolean): { preamble: string; call: string };
}

function testFault(runner: TestRunner, ctx: FaultContext, tier: Tier): Fault | { skip: string } {
  const where = candidateDir(ctx, { kind: 'test', exts: JS_EXTS, testPattern: runner.testPattern });
  if (!where) return { skip: `no test files found where ${runner.id} runs` };
  const m = ctx.marker;
  const path = where.neighbor
    ? markerName(where.neighbor, m, 'js')
    : posix.join(where.dir, `${m.snake}.test.js`);
  const { preamble, call } = runner.register(commonJs(ctx, where.neighbor, path));
  const head = preamble === '' ? '' : `${preamble}\n`;
  const content =
    tier === 'reach'
      ? `${head}${call}('${m.snake}', () => {\n`
      : `${head}\n${call}('${m.snake} planted failing test', () => {\n  throw new Error('${m.snake}: planted failing test');\n});\n`;
  return fault(
    ctx,
    runner.id,
    tier,
    path,
    content,
    tier === 'reach' ? 'test file' : 'failing test',
  );
}

const importFrom = (module: string, names: string) => (cjs: boolean) =>
  cjs ? `const { ${names} } = require('${module}');` : `import { ${names} } from '${module}';`;

const RUNNERS: TestRunner[] = [
  {
    id: 'vitest',
    testPattern: JS_TEST_FILE,
    register: (cjs) => ({ preamble: importFrom('vitest', 'test')(cjs), call: 'test' }),
  },
  // jest injects test() as a global by default.
  { id: 'jest', testPattern: JS_TEST_FILE, register: () => ({ preamble: '', call: 'test' }) },
  { id: 'mocha', testPattern: TEST_DIR_FILE, register: () => ({ preamble: '', call: 'it' }) },
  {
    id: 'node-test',
    testPattern: TEST_DIR_FILE,
    register: (cjs) => ({
      preamble: cjs ? "const test = require('node:test');" : "import test from 'node:test';",
      call: 'test',
    }),
  },
  {
    id: 'bun-test',
    testPattern: JS_TEST_FILE,
    register: (cjs) => ({ preamble: importFrom('bun:test', 'test')(cjs), call: 'test' }),
  },
];

/** A non-test JavaScript or TypeScript file the tool will read, and its CommonJS-ness. */
function sourceTarget(
  ctx: FaultContext,
  shape: Shape,
  tool: string,
): { path: string; cjs: boolean } | { skip: string } {
  const where = candidateDir(ctx, shape);
  if (!where) return { skip: `no source files found where ${tool} looks` };
  const path = where.neighbor
    ? markerName(where.neighbor, ctx.marker, 'js')
    : posix.join(where.dir, `${ctx.marker.snake}.ts`);
  return { path, cjs: commonJs(ctx, where.neighbor, path) };
}

function sourceTool(
  id: ToolId,
  category: Category,
  semantic: (m: string, cjs: boolean) => string,
  what: string,
  opts: { exts?: string[]; expectSurvival?: (ctx: FaultContext) => string | undefined } = {},
): ToolDef {
  return {
    id,
    language: 'js',
    category,
    faults(ctx, tier) {
      const shape: Shape = {
        kind: 'source',
        exts: opts.exts ?? JS_EXTS,
        testPattern: JS_TEST_FILE,
      };
      if (id === 'tsc' || id === 'vue-tsc') {
        const project = ctx.invocation.project ?? posix.join(ctx.invocation.cwd, 'tsconfig.json');
        shape.accept = tsconfigAccepts(ctx.root, project);
      }
      const target = sourceTarget(ctx, shape, id);
      if ('skip' in target) return target;
      const m = ctx.marker.snake;
      const content = tier === 'reach' ? `export const ${m} = (\n` : semantic(m, target.cjs);
      const f = fault(ctx, id, tier, target.path, content, tier === 'reach' ? 'source file' : what);
      const note = tier === 'semantic' ? opts.expectSurvival?.(ctx) : undefined;
      if (note !== undefined) f.expectSurvival = note;
      return f;
    },
  };
}

const typeError = (m: string): string => `export const ${m}: number = 'x';\n`;
const unusedVariable = (m: string, cjs: boolean): string =>
  `const ${m} = 1;\n${cjs ? 'module.exports = {};' : 'export {};'}\n`;
const badFormatting = (m: string, cjs: boolean): string =>
  cjs
    ? `const  ${m}   =   {a:1,b :2}\nmodule.exports={${m}}\n`
    : `export const  ${m}   =   {a:1,b :2}\n`;

const argvHas = (ctx: FaultContext, ...flags: string[]): boolean =>
  ctx.invocation.argv.some((a) => flags.includes(a));

export const JS_TOOLS: ToolDef[] = [
  ...RUNNERS.map((runner): ToolDef => ({
    id: runner.id,
    language: 'js',
    category: 'test',
    faults: (ctx, tier) => testFault(runner, ctx, tier),
  })),
  sourceTool('tsc', 'types', typeError, 'type error', { exts: TS_EXTS }),
  sourceTool('vue-tsc', 'types', typeError, 'type error', { exts: TS_EXTS }),
  sourceTool('eslint', 'lint', unusedVariable, 'unused variable'),
  sourceTool('biome-lint', 'lint', unusedVariable, 'unused variable', {
    expectSurvival: (ctx) =>
      ctx.invocation.argv[1] === 'lint' && !argvHas(ctx, '--error-on-warnings')
        ? '`biome lint` exits 0 on warnings, and noUnusedVariables is a warning by default. Add --error-on-warnings.'
        : undefined,
  }),
  sourceTool('oxlint', 'lint', unusedVariable, 'unused variable', {
    expectSurvival: (ctx) =>
      argvHas(ctx, '--deny-warnings')
        ? undefined
        : 'oxlint exits 0 on warnings, and no-unused-vars is a warning by default. Add --deny-warnings.',
  }),
  sourceTool('prettier', 'format', badFormatting, 'misformatted file'),
  sourceTool('biome-format', 'format', badFormatting, 'misformatted file'),
];
