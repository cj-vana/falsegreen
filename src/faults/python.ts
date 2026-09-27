/**
 * Python faults.
 *
 * Recorded behavior (CPython 3.14.6, macOS, 2026-09-27; `<m>` is `falsegreen_<id>`, `<abs>` the
 * absolute path of the planted file):
 * - pytest 9.1.1. reach: exit 2, "ERROR tests/test_<m>.py". semantic: exit 1,
 *   "E       AssertionError: <m>: planted failing test".
 * - unittest. reach: exit 1, "ImportError: Failed to import test module: test_<m>". semantic:
 *   exit 1, "FAIL: test_<m> (test_<m>.Test<pascal>.test_<m>)". `python -m unittest tests.test_calc`
 *   exits 0 on both: it loads only the named module.
 * - ruff check 0.16.9. reach: exit 1, " --> app/<m>.py:2:23". semantic: exit 1, " --> app/<m>.py:3:8"
 *   (F401). Its default rules include I001, so it also fails the isort fault.
 * - flake8 7.4.1. reach: exit 1, "app/<m>.py:2:22: E999 SyntaxError: '[' was never closed".
 *   semantic: exit 1, "app/<m>.py:3:1: F401 'os' imported but unused". With --exit-zero both print
 *   the same line and exit 0.
 * - pylint 4.0.9 (exit status is a bit mask). reach: exit 2, "app/<m>.py:2:21: E0001: Parsing
 *   failed". semantic: exit 4, "app/<m>.py:3:0: W0611: Unused import os (unused-import)".
 * - mypy 2.3.1. reach: exit 2, "app/<m>.py:2: error: '[' was never closed  [syntax]". semantic:
 *   exit 1, "app/<m>.py:3: error: Incompatible types in assignment ... [assignment]".
 * - pyright 1.1.414 and basedpyright 1.40.1. reach: exit 1, "<abs>:2:21 - error: "[" was not
 *   closed". semantic: exit 1, "<abs>:3:26 - error: Type "Literal['<m>']" is not assignable to
 *   declared type "int"". pyright with `typeCheckingMode: off` still fails the reach fault and
 *   exits 0 on the semantic one. basedpyright's default mode also fails on warnings, so it rejects
 *   the unused-import fault too (reportUnusedImport).
 * - black 26.5.1. reach: exit 123, "error: cannot format <abs>: Cannot parse: 2:21". semantic:
 *   exit 1, "would reformat <abs>".
 * - ruff format 0.16.9 --check. reach: exit 2, " --> app/<m>.py:2:23". semantic: exit 1,
 *   " --> app/<m>.py:3:22".
 * - isort 9.0.1. reach: exit 1, "ERROR: isort failed to parse the given literal <m> = [". A plain
 *   syntax error exits 0. semantic: exit 1, "ERROR: <abs> Imports are incorrectly sorted and/or
 *   formatted.".
 * - pre-commit 4.6.2 with `repo: local` hooks. `pre-commit run` prints "[WARNING] Unstaged
 *   intent-to-add files detected." and "(no files to check)Skipped", exit 0: it takes files added
 *   with --intent-to-add as unstaged. `pre-commit run --all-files` runs the hooks on them.
 */
import { posix } from 'node:path';

import type { Marker } from '../core/marker';
import type { Tier } from '../core/types';
import { candidateDir, markerName } from './placement';
import type { Category, Fault, FaultContext, ToolDef, ToolId } from './types';

const PY = ['.py'];

/** pytest's default `python_files`: `test_*.py` and `*_test.py`. */
export const PYTEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;

/**
 * The reach fault for every Python tool. isort does not parse Python and exits 0 on a plain syntax
 * error; the `# isort: list` comment makes it evaluate the literal that follows, and that failure
 * quotes the code rather than the path, so the assignment target carries the marker.
 */
export function unparseable(m: Marker): string {
  return `# isort: list\n${m.snake} = [\n`;
}

/**
 * Planted files carry docstrings and upper-case module constants so that pylint, when it covers the
 * same directory, finds nothing in a fault meant for another tool.
 */
function failingTest(m: Marker): string {
  const says = `${m.snake}: planted failing test`;
  return (
    `"""${says}."""\n\nimport unittest\n\n\n` +
    `class Test${m.pascal}(unittest.TestCase):\n    """${says}."""\n\n` +
    `    def test_${m.snake}(self) -> None:\n        """${says}."""\n` +
    `        self.fail("${says}")\n`
  );
}

interface Semantic {
  content(m: Marker): string;
  description: string;
}

const UNUSED_IMPORT: Semantic = {
  content: (m) => `"""${m.snake}: planted unused import."""\n\nimport os\n`,
  description: 'unused import',
};

const TYPE_ERROR: Semantic = {
  content: (m) =>
    `"""${m.snake}: planted type error."""\n\n${m.snake.toUpperCase()}: int = "${m.snake}"\n`,
  description: 'str assigned to an int',
};

/** `1+2` is left alone by pycodestyle's default ignore list (E226), so flake8 stays quiet. */
const UNFORMATTED: Semantic = {
  content: (m) => `"""${m.snake}: planted formatting."""\n\n${m.snake.toUpperCase()} = 1+2\n`,
  description: 'unformatted code',
};

const UNSORTED_IMPORTS: Semantic = {
  content: (m) =>
    `"""${m.snake}: planted unsorted imports."""\n\nimport sys\nimport os\n\n` +
    `${m.snake.toUpperCase()} = (os.sep, sys.platform)\n`,
  description: 'unsorted imports',
};

const UNITTEST_VALUE_FLAGS = new Set([
  '-s',
  '--start-directory',
  '-t',
  '--top-level-directory',
  '-k',
  '--durations',
]);

/**
 * What `python -m unittest` runs: discovery with a file pattern (`-p`, or the second positional
 * after `discover`, default `test*.py`), or the modules named on the command line.
 */
export function unittestTarget(argv: string[]): { pattern: string } | { names: string[] } {
  const discover = argv[1]?.toLowerCase() === 'discover';
  const rest = argv.slice(discover ? 2 : 1);
  const positional: string[] = [];
  let pattern: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq < 0 ? arg : arg.slice(0, eq);
    if (flag === '-p' || flag === '--pattern') {
      pattern = eq < 0 ? rest[++i] : arg.slice(eq + 1);
    } else if (arg.startsWith('-')) {
      if (eq < 0 && UNITTEST_VALUE_FLAGS.has(arg)) i++;
    } else {
      positional.push(arg);
    }
  }
  if (discover) return { pattern: pattern ?? positional[1] ?? 'test*.py' };
  return positional.length > 0 ? { names: positional } : { pattern: 'test*.py' };
}

/** unittest matches its pattern against base names with fnmatch; `*` and `?` are the wildcards. */
export function globToRegExp(glob: string): RegExp {
  const body = [...glob]
    .map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`(^|/)${body}$`);
}

/**
 * The planted test's path: the neighbor's shape when the runner would collect it, else the first
 * of `test_<marker>.py`, `<marker>_test.py` and a name built from the glob that it would.
 */
export function testPath(
  where: { dir: string; neighbor?: string },
  m: Marker,
  collects: RegExp,
  glob?: string,
): string | undefined {
  const names = [`test_${m.snake}.py`, `${m.snake}_test.py`];
  if (glob !== undefined) {
    names.push(glob.replace('*', m.snake).replaceAll('*', '').replaceAll('?', 'x'));
  }
  const candidates = [
    ...(where.neighbor === undefined ? [] : [markerName(where.neighbor, m, 'python')]),
    ...names.map((n) => posix.join(where.dir, n)),
  ];
  return candidates.find((p) => collects.test(p));
}

function testFault(
  id: 'pytest' | 'unittest',
  ctx: FaultContext,
  tier: Tier,
): Fault | { skip: string } {
  const m = ctx.marker;
  let collects = PYTEST_FILE;
  let glob: string | undefined;
  let expectSurvival: string | undefined;
  if (id === 'unittest') {
    const target = unittestTarget(ctx.invocation.argv);
    if ('names' in target) {
      glob = 'test*.py';
      expectSurvival = `python -m unittest ${target.names.join(' ')} runs only the tests it names; a new test file is never loaded`;
    } else {
      glob = target.pattern;
    }
    collects = globToRegExp(glob);
  }
  const where = candidateDir(ctx, { kind: 'test', exts: PY, testPattern: collects });
  if (!where) return { skip: `no test files found where ${id} runs` };
  const path = testPath(where, m, collects, glob);
  if (path === undefined)
    return { skip: `cannot name a file that ${id} would collect in ${where.dir || '.'}` };
  return {
    tool: id,
    tier,
    marker: m,
    files: [{ path, content: tier === 'reach' ? unparseable(m) : failingTest(m) }],
    appends: [],
    description:
      tier === 'reach' ? `test file that does not parse: ${path}` : `failing test: ${path}`,
    ...(expectSurvival === undefined ? {} : { expectSurvival }),
  };
}

function sourceFault(
  id: ToolId,
  semantic: Semantic,
  ctx: FaultContext,
  tier: Tier,
): Fault | { skip: string } {
  const where = candidateDir(ctx, { kind: 'source', exts: PY, testPattern: PYTEST_FILE });
  if (!where) return { skip: `no Python source files found where ${id} runs` };
  const m = ctx.marker;
  const path = where.neighbor
    ? markerName(where.neighbor, m, 'python')
    : posix.join(where.dir, `${m.snake}.py`);
  const exitZero = ctx.invocation.argv.includes('--exit-zero');
  return {
    tool: id,
    tier,
    marker: m,
    files: [{ path, content: tier === 'reach' ? unparseable(m) : semantic.content(m) }],
    appends: [],
    description:
      tier === 'reach' ? `file that does not parse: ${path}` : `${semantic.description}: ${path}`,
    ...(exitZero
      ? { expectSurvival: '--exit-zero makes the tool exit 0 whatever it reports' }
      : {}),
  };
}

function testDef(id: 'pytest' | 'unittest'): ToolDef {
  return {
    id,
    language: 'python',
    category: 'test',
    faults: (ctx, tier) => testFault(id, ctx, tier),
  };
}

function sourceDef(id: ToolId, category: Category, semantic: Semantic): ToolDef {
  return {
    id,
    language: 'python',
    category,
    faults: (ctx, tier) => sourceFault(id, semantic, ctx, tier),
  };
}

export const PYTHON_TOOLS: ToolDef[] = [
  testDef('pytest'),
  testDef('unittest'),
  sourceDef('ruff-check', 'lint', UNUSED_IMPORT),
  sourceDef('flake8', 'lint', UNUSED_IMPORT),
  sourceDef('pylint', 'lint', UNUSED_IMPORT),
  sourceDef('mypy', 'types', TYPE_ERROR),
  sourceDef('pyright', 'types', TYPE_ERROR),
  sourceDef('basedpyright', 'types', TYPE_ERROR),
  sourceDef('black', 'format', UNFORMATTED),
  sourceDef('ruff-format', 'format', UNFORMATTED),
  sourceDef('isort', 'format', UNSORTED_IMPORTS),
];
