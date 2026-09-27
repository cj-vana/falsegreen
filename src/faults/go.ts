/**
 * Go faults.
 *
 * Recorded behavior (go 1.26.5, staticcheck 2026.2.1 (v0.8.1), golangci-lint 2.14.0 release binary
 * built with go1.27.0, gofumpt v0.12.0, goimports from golang.org/x/tools v0.50.0; darwin/arm64,
 * 2026-09-27). <f> is the planted file, e.g. calc/falsegreen_<id>.go.
 * - go test, reach (unterminated _test.go): exit 1, "<f>:5:43: expected '}', found 'EOF'" then
 *   "FAIL example.com/fixture/calc [setup failed]". The same with -run TestAdd.
 * - go test, semantic (t.Fatal): exit 1, "--- FAIL: TestFalsegreen<id>" and
 *   "falsegreen_<id>_test.go:6: falsegreen_<id>: planted failing test". With -run TestAdd: exit 0.
 * - go vet, reach: exit 1, "<f>:4:1: syntax error: unexpected EOF, expected }". Semantic (Printf
 *   %d given a string): exit 1, "<f>:7:14: fmt.Printf format %d has arg "falsegreen_<id>" of
 *   wrong type string".
 * - staticcheck, reach: exit 1, "<f>:4:1: syntax error: unexpected EOF, expected } (compile)".
 *   Semantic: exit 1, "<f>:7:13: Printf format %d has arg #1 of wrong type string (SA5009)".
 * - golangci-lint run, reach: exit 1, "<f>:3:27: expected '}', found 'EOF' (typecheck)". Semantic:
 *   exit 1, "<f>:7:14: printf: fmt.Printf format %d has arg ... of wrong type string (govet)".
 *   With --issues-exit-code=0 both print the same and exit 0.
 * - gofmt, goimports, gofumpt with -l or -d, reach: exit 2, "<f>:3:27: expected '}', found 'EOF'"
 *   on stderr and nothing on stdout, so `test -z "$(gofmt -l .)"` exits 0.
 * - Semantic (badly spaced file): -l prints "<f>" and exits 0 for all three, and
 *   `test -z "$(gofmt -l .)"` exits 1 printing nothing. -d prints a diff of <f> and exits 1 for
 *   gofmt and gofumpt, but 0 for goimports.
 */
import { posix } from 'node:path';

import type { Marker } from '../core/marker';
import type { Tier } from '../core/types';
import { candidateDir } from './placement';
import type { Fault, FaultContext, ToolDef, ToolId } from './types';

const GO_TEST_FILE = /_test\.go$/;

const dirOf = (path: string): string => {
  const d = posix.dirname(path);
  return d === '.' ? '' : d;
};

export interface GoHeader {
  /** The package clause's name, absent when the file has none before its first declaration. */
  pkg?: string;
  /** A `//go:build` or `// +build` line before the package clause. */
  constrained: boolean;
}

/** Reads the comments and package clause at the top of a Go file. */
export function goHeader(text: string): GoHeader {
  const lead = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/.exec(text)![0];
  const pkg = /^package\s+([\p{L}_][\p{L}\p{N}_]*)/u.exec(text.slice(lead.length))?.[1];
  const constrained = /^\/\/(go:build\s|\s*\+build\s)/m.test(lead);
  return pkg === undefined ? { constrained } : { pkg, constrained };
}

/** Go skips files and directories whose names start with `.` or `_`. */
const goIgnores = (path: string): boolean =>
  path.split('/').some((s) => s.startsWith('.') || s.startsWith('_'));

/** The directory of the nearest go.mod at or above `dir`. */
function moduleOf(dir: string, modules: Set<string>): string | undefined {
  for (let d = dir; ; d = dirOf(d)) {
    if (modules.has(d)) return d;
    if (d === '') return undefined;
  }
}

/**
 * Files the tool can see from its working directory. A package pattern such as `./...` stops at a
 * nested go.mod, so only files of the working directory's own module qualify. Without a go.mod
 * above the working directory (a go.work root) every module does.
 */
export function goVisible(ctx: FaultContext): (path: string) => boolean {
  const modules = new Set(ctx.tracked.filter((p) => posix.basename(p) === 'go.mod').map(dirOf));
  const home = moduleOf(ctx.invocation.cwd, modules);
  return (path) =>
    !goIgnores(path) && (home === undefined || moduleOf(dirOf(path), modules) === home);
}

/**
 * The package clause a new file in `dir` must use. Files of the same kind (test or not) and
 * without build constraints come first: a `//go:build ignore` generator may declare `package
 * main` beside a library.
 */
export function packageFor(ctx: FaultContext, dir: string, test: boolean): string | undefined {
  const rank = (path: string, h: GoHeader): number =>
    (h.constrained ? 2 : 0) + (GO_TEST_FILE.test(path) === test ? 0 : 1);
  const best = ctx.tracked
    .filter((p) => dirOf(p) === dir && p.endsWith('.go') && !goIgnores(p))
    .sort()
    .map((p) => ({ p, h: goHeader(ctx.read(p)) }))
    .filter(({ h }) => h.pkg !== undefined)
    .sort((a, b) => rank(a.p, a.h) - rank(b.p, b.h))[0];
  if (!best) return undefined;
  // A source file cannot join an external test package.
  return test ? best.h.pkg : best.h.pkg!.replace(/_test$/, '');
}

interface Spot {
  path: string;
  pkg: string;
}

/**
 * Where the planted file goes and its package clause. The name is always `falsegreen_<id>.go` or
 * `falsegreen_<id>_test.go`: Go reads build constraints from file name suffixes such as `_linux`,
 * so copying the neighbor's stem could keep the file out of the build.
 */
function spot(ctx: FaultContext, test: boolean): Spot | { skip: string } {
  const kind = test ? 'test' : 'source';
  const where = candidateDir(ctx, {
    kind,
    exts: ['.go'],
    testPattern: GO_TEST_FILE,
    accept: goVisible(ctx),
  });
  if (!where) return { skip: `no Go ${kind} files found where ${ctx.invocation.tool} runs` };
  const pkg = packageFor(ctx, where.dir, test);
  if (pkg === undefined) {
    return { skip: `no Go file in ${where.dir || '.'} to copy a package clause from` };
  }
  const name = `${ctx.marker.snake}${test ? '_test' : ''}.go`;
  return { path: posix.join(where.dir, name), pkg };
}

const lines = (...ls: string[]): string => `${ls.join('\n')}\n`;

/** Unterminated function body: every Go parser stops at EOF. */
function unparsable(pkg: string, m: Marker, test: boolean): string {
  return test
    ? lines(`package ${pkg}`, '', 'import "testing"', '', `func Test${m.pascal}(t *testing.T) {`)
    : lines(`package ${pkg}`, '', `func ${m.pascal}() {`);
}

function failingTest(pkg: string, m: Marker): string {
  return lines(
    `package ${pkg}`,
    '',
    'import "testing"',
    '',
    `func Test${m.pascal}(t *testing.T) {`,
    `\tt.Fatal("${m.snake}: planted failing test")`,
    '}',
  );
}

/** go vet's printf analyzer, staticcheck SA5009 and golangci-lint's default govet all flag it. */
function printfMismatch(pkg: string, m: Marker): string {
  return lines(
    `package ${pkg}`,
    '',
    'import "fmt"',
    '',
    `// ${m.pascal} passes a string to the %d verb.`,
    `func ${m.pascal}() {`,
    `\tfmt.Printf("%d\\n", "${m.snake}")`,
    '}',
  );
}

/** Compiles, so a step that also builds or vets judges only the formatting. */
function badlySpaced(pkg: string, m: Marker): string {
  return lines(`package ${pkg}`, '', `func   ${m.pascal} ( a,b int )int{`, 'return a+b }');
}

interface GoTool {
  id: ToolId;
  category: ToolDef['category'];
  test: boolean;
  semantic: (pkg: string, m: Marker) => string;
  describe: string;
  /** Known behavior that lets a fault of this tier survive this invocation. */
  expectSurvival?: (argv: string[], tier: Tier, m: Marker) => string | undefined;
}

function goFault(tool: GoTool, ctx: FaultContext, tier: Tier): Fault | { skip: string } {
  const at = spot(ctx, tool.test);
  if ('skip' in at) return at;
  const m = ctx.marker;
  const reach = tier === 'reach';
  const expect = tool.expectSurvival?.(ctx.invocation.argv, tier, m);
  return {
    tool: tool.id,
    tier,
    marker: m,
    files: [
      {
        path: at.path,
        content: reach ? unparsable(at.pkg, m, tool.test) : tool.semantic(at.pkg, m),
      },
    ],
    appends: [],
    description: `${reach ? 'Go file that does not parse' : tool.describe}: ${at.path}`,
    ...(expect === undefined ? {} : { expectSurvival: expect }),
  };
}

function def(tool: GoTool): ToolDef {
  return {
    id: tool.id,
    language: 'go',
    category: tool.category,
    faults: (ctx, tier) => goFault(tool, ctx, tier),
  };
}

const flagGiven = (argv: string[], name: string): boolean =>
  argv.some((a) => a === name || a.startsWith(`${name}=`));

const LINT: Pick<GoTool, 'category' | 'test' | 'semantic' | 'describe'> = {
  category: 'lint',
  test: false,
  semantic: printfMismatch,
  describe: 'Printf verb that does not match its argument',
};

const FORMAT: Pick<GoTool, 'category' | 'test' | 'semantic' | 'describe'> = {
  category: 'format',
  test: false,
  semantic: badlySpaced,
  describe: 'badly formatted Go file',
};

/** `diffFails`: whether -d exits 1 on a diff (gofmt, gofumpt) or 0 (goimports). */
function formatter(id: 'gofmt' | 'goimports' | 'gofumpt', diffFails: boolean): ToolDef {
  return def({
    id,
    ...FORMAT,
    expectSurvival: (argv, tier) => {
      if (tier === 'reach')
        return `${id} reports a file it cannot parse on stderr, not in its -l list, and exits 2.`;
      if (!diffFails)
        return `${id} exits 0 when it lists (-l) or diffs (-d) files that need formatting.`;
      return argv.includes('-d')
        ? undefined
        : `${id} -l lists files that need formatting and exits 0.`;
    },
  });
}

const goTest = def({
  id: 'go-test',
  category: 'test',
  test: true,
  semantic: failingTest,
  describe: 'failing test',
  expectSurvival: (argv, tier, m) =>
    tier === 'semantic' && (flagGiven(argv, '-run') || flagGiven(argv, '--run'))
      ? `go test -run runs only the tests its pattern matches; the planted test is Test${m.pascal}.`
      : undefined,
});

const goVet = def({ id: 'go-vet', ...LINT });

const staticcheck = def({ id: 'staticcheck', ...LINT });

const golangciLint = def({
  id: 'golangci-lint',
  ...LINT,
  expectSurvival: (argv) =>
    argv.some(
      (a, i) => a === '--issues-exit-code=0' || (a === '--issues-exit-code' && argv[i + 1] === '0'),
    )
      ? '--issues-exit-code=0 makes golangci-lint exit 0 on every issue, parse errors included.'
      : undefined,
});

export const GO_TOOLS: ToolDef[] = [
  goTest,
  goVet,
  golangciLint,
  staticcheck,
  formatter('gofmt', true),
  formatter('goimports', false),
  formatter('gofumpt', true),
];
