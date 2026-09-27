/**
 * Rust faults. Test faults are integration tests in the crate's tests/ directory; every other
 * fault is a new module next to the crate root, declared by appending `mod falsegreen_<id>;` to it.
 *
 * Recorded behavior (cargo 1.98.1, clippy 0.1.98, rustfmt 1.9.0-stable, cargo-nextest 0.9.146,
 * macOS arm64, 2026-09-27):
 * - cargo test, reach (tests/falsegreen_<id>.rs that does not parse): exit 101,
 *   "--> tests/falsegreen_<id>.rs:2:26", then "could not compile `<crate>` (test "falsegreen_<id>")".
 * - cargo test, semantic (a #[test] that panics): exit 101, "test falsegreen_<id> ... FAILED" and
 *   "panicked at tests/falsegreen_<id>.rs:3:5".
 * - cargo test --lib, the same test in an appended module: exit 101,
 *   "test falsegreen_<id>::falsegreen_<id> ... FAILED".
 * - cargo nextest run: reach exits 101 with the cargo build error above; semantic exits 100,
 *   "FAIL [   0.005s] (2/2) <crate>::falsegreen_<id> falsegreen_<id>".
 * - cargo clippy, cargo check and cargo build, reach (a module that does not parse): exit 101,
 *   "--> src/falsegreen_<id>.rs:1:26".
 * - cargo clippy, semantic (needless_return in the module): exit 0 with the warning
 *   "unneeded `return` statement --> src/falsegreen_<id>.rs:4:5"; with `-- -D warnings` exit 101
 *   and the same lines as an error.
 * - cargo fmt --check, reach: exit 1, "Error writing files: failed to resolve mod
 *   `falsegreen_<id>`: cannot parse <absolute path>/src/falsegreen_<id>.rs".
 * - cargo fmt --check, semantic (a badly spaced module): exit 1,
 *   "Diff in <absolute path>/src/falsegreen_<id>.rs:1:".
 * - Virtual workspace (test/fixtures/rust-workspace): cargo fmt --check without --all, run at the
 *   root, reports the module planted in the member crates/greet (exit 1). Compiler errors name
 *   paths relative to the workspace root ("--> crates/hello/src/falsegreen_<id>.rs:1:26"), also
 *   when the step runs in the member's directory.
 */
import { posix } from 'node:path';

import type { Marker } from '../core/marker';
import type { Tier } from '../core/types';
import type { Fault, FaultContext, ToolDef, ToolId } from './types';

type Skip = { skip: string };

export interface Crate {
  /** Directory holding the crate's Cargo.toml, repo-relative ('' is the repository root). */
  dir: string;
  name?: string;
  /** Library crate root, repo-relative, when tracked. */
  lib?: string;
  /** src/main.rs, when tracked. */
  bin?: string;
  /** False when [package] sets `autotests = false`, so files in tests/ are not test targets. */
  autotests: boolean;
}

const inDir = (dir: string, path: string): string => (dir === '' ? path : `${dir}/${path}`);

function normalizeDir(dir: string): string {
  const d = posix.normalize(dir).replace(/\/+$/, '');
  return d === '.' ? '' : d;
}

function parentDir(dir: string): string | undefined {
  if (dir === '') return undefined;
  const p = posix.dirname(dir);
  return p === '.' ? '' : p;
}

/** The lines of a TOML table, from its header to the next header. */
function table(text: string, name: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.replace(/#.*/, '').trim() === `[${name}]`);
  if (start < 0) return undefined;
  const next = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  return lines.slice(start + 1, next < 0 ? undefined : next).join('\n');
}

function stringValue(body: string, key: string): string | undefined {
  return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']*)["']`, 'm').exec(body)?.[1];
}

function stringArray(body: string, key: string): string[] | undefined {
  const m = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(body);
  return m ? [...m[1]!.matchAll(/["']([^"']*)["']/g)].map((x) => x[1]!) : undefined;
}

/** A workspace `members` entry as a regex over member paths; `*` and `?` stay within one segment. */
function memberPattern(glob: string): RegExp {
  const body = normalizeDir(glob)
    .split('')
    .map((c) => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${body}$`);
}

function readManifest(ctx: FaultContext, dir: string): string | undefined {
  const path = inDir(dir, 'Cargo.toml');
  return ctx.tracked.includes(path) ? ctx.read(path) : undefined;
}

function crateAt(ctx: FaultContext, dir: string, manifest: string): Crate | undefined {
  const pkg = table(manifest, 'package');
  if (pkg === undefined) return undefined;
  const libPath = stringValue(table(manifest, 'lib') ?? '', 'path');
  const lib = inDir(dir, posix.normalize(libPath ?? 'src/lib.rs'));
  const bin = inDir(dir, 'src/main.rs');
  const name = stringValue(pkg, 'name');
  return {
    dir,
    ...(name === undefined ? {} : { name }),
    ...(ctx.tracked.includes(lib) ? { lib } : {}),
    ...(ctx.tracked.includes(bin) ? { bin } : {}),
    autotests: !/^\s*autotests\s*=\s*false/m.test(pkg),
  };
}

/** The command's own arguments and the ones after `--`, which go to the test binary or lints. */
function splitArgs(argv: string[]): { own: string[]; after: string[] } {
  const dash = argv.indexOf('--');
  return dash < 0
    ? { own: argv, after: [] }
    : { own: argv.slice(0, dash), after: argv.slice(dash + 1) };
}

const hasFlag = (args: string[], flag: string): boolean =>
  args.some((a) => a === flag || a.startsWith(`${flag}=`));

/** Every value given to one of the flags, as `--flag value` or `--flag=value`. */
function flagValues(args: string[], names: string[]): string[] {
  const values: string[] = [];
  args.forEach((a, i) => {
    if (names.includes(a) && args[i + 1] !== undefined) values.push(args[i + 1]!);
    for (const n of names) if (a.startsWith(`${n}=`)) values.push(a.slice(n.length + 1));
  });
  return values;
}

/** Members of the workspace rooted at `dir` that the command builds, sorted by path. */
function memberCrates(ctx: FaultContext, dir: string, manifest: string): Crate[] {
  const ws = table(manifest, 'workspace') ?? '';
  const { own } = splitArgs(ctx.invocation.argv);
  const everything = hasFlag(own, '--workspace') || hasFlag(own, '--all');
  const globs =
    (everything ? undefined : stringArray(ws, 'default-members')) ??
    stringArray(ws, 'members') ??
    [];
  const patterns = globs.map(memberPattern);
  const excludedDirs = (stringArray(ws, 'exclude') ?? []).map(normalizeDir);
  const excludedNames = flagValues(own, ['--exclude']);

  const members: Crate[] = [];
  for (const file of ctx.tracked) {
    if (posix.basename(file) !== 'Cargo.toml') continue;
    const memberDir = parentDir(file)!;
    const rel = dir === '' ? memberDir : memberDir.slice(dir.length + 1);
    if (memberDir === dir || (dir !== '' && !memberDir.startsWith(`${dir}/`))) continue;
    if (!patterns.some((p) => p.test(rel)) || excludedDirs.includes(rel)) continue;
    const krate = crateAt(ctx, memberDir, ctx.read(file));
    if (krate && !(krate.name !== undefined && excludedNames.includes(krate.name))) {
      members.push(krate);
    }
  }
  return members.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * The crate a cargo command works on: the nearest Cargo.toml at or above the `place:` directory,
 * the `-p`/`--manifest-path` directory, or the step's working directory, as cargo itself finds it.
 * A virtual workspace manifest resolves to its first member with a library or binary crate root.
 */
export function targetCrate(ctx: FaultContext): Crate | Skip {
  const inv = ctx.invocation;
  const start = normalizeDir(ctx.place ?? inv.pathArgs[0] ?? inv.cwd);
  for (let dir: string | undefined = start; dir !== undefined; dir = parentDir(dir)) {
    const manifest = readManifest(ctx, dir);
    if (manifest === undefined) continue;
    const krate = crateAt(ctx, dir, manifest);
    if (krate) return krate;
    const where = dir === '' ? 'the repository root' : dir;
    if (table(manifest, 'workspace') === undefined) {
      return { skip: `the Cargo.toml in ${where} has neither [package] nor [workspace]` };
    }
    const member = memberCrates(ctx, dir, manifest).find((c) => c.lib ?? c.bin);
    return (
      member ?? {
        skip: `no member of the workspace in ${where} has a src/lib.rs or src/main.rs`,
      }
    );
  }
  return { skip: `no Cargo.toml at or above ${start === '' ? 'the repository root' : start}` };
}

const TARGET_FLAGS = [
  '--lib',
  '--bins',
  '--bin',
  '--examples',
  '--example',
  '--tests',
  '--test',
  '--benches',
  '--bench',
  '--all-targets',
  '--doc',
];

/** Where the planted test goes: tests/, or a module in the crate root the command tests. */
export function testPlace(
  krate: Crate,
  argv: string[],
): { kind: 'tests' } | { kind: 'module'; root: string } | Skip {
  const { own } = splitArgs(argv);
  const chosen = TARGET_FLAGS.filter((f) => hasFlag(own, f));
  const integration =
    chosen.length === 0 || chosen.includes('--tests') || chosen.includes('--all-targets');
  if (integration && krate.autotests) return { kind: 'tests' };

  let root: string | undefined;
  if (integration) root = krate.lib ?? krate.bin;
  else if (chosen.includes('--lib')) root = krate.lib;
  else if (chosen.includes('--bins')) root = krate.bin;
  else {
    return {
      skip: `the command tests only ${chosen.join(', ')} targets; planted tests go in tests/, the library or src/main.rs`,
    };
  }
  if (root !== undefined) return { kind: 'module', root };
  const manifest = inDir(krate.dir, 'Cargo.toml');
  return {
    skip: integration
      ? `${manifest} sets autotests = false and the crate has no src/lib.rs or src/main.rs`
      : `the command tests only ${chosen.join(', ')} and ${manifest} has no matching crate root`,
  };
}

/** `cargo test` flags that take a value (`cargo test --help`, cargo 1.98.1). */
const CARGO_TEST_VALUE_FLAGS = new Set([
  '--message-format',
  '--color',
  '--config',
  '-Z',
  '-p',
  '--package',
  '--exclude',
  '--bin',
  '--example',
  '--test',
  '--bench',
  '-F',
  '--features',
  '-j',
  '--jobs',
  '--profile',
  '--target',
  '--target-dir',
  '-m',
  '--manifest-path',
]);

/** The TESTNAME filter of `cargo test [OPTIONS] [TESTNAME]`, if the command gives one. */
function testNameFilter(own: string[]): string | undefined {
  const sub = own.findIndex((a) => a === 'test' || a === 't');
  if (sub < 0) return undefined;
  for (let i = sub + 1; i < own.length; i++) {
    const a = own[i]!;
    if (CARGO_TEST_VALUE_FLAGS.has(a)) i++;
    else if (!a.startsWith('-')) return a;
  }
  return undefined;
}

/** Why a failing test would not run even though it compiles: the command filters or skips it. */
function runSkip(tool: ToolId, argv: string[]): string | undefined {
  const { own, after } = splitArgs(argv);
  if (hasFlag(own, '--no-run')) return 'the command builds the tests without running them';
  if (after.includes('--ignored') || flagValues(own, ['--run-ignored']).includes('only')) {
    return 'the command runs only ignored tests';
  }
  const filterset = flagValues(own, ['-E', '--filterset'])[0];
  if (filterset !== undefined) return `the command selects tests with the filterset ${filterset}`;
  const partition = flagValues(own, ['--partition'])[0];
  if (partition !== undefined) {
    return `the command runs one partition of the tests (${partition}), which may leave the planted test out`;
  }
  const filter = tool === 'cargo-test' ? testNameFilter(own) : undefined;
  if (filter !== undefined) return `the command runs only tests whose names contain "${filter}"`;
  return undefined;
}

/** A module next to the crate root, declared by appending `mod <marker>;` to the root. */
function moduleFault(
  ctx: FaultContext,
  root: string,
  content: string,
): Pick<Fault, 'files' | 'appends'> & { path: string } {
  const m = ctx.marker;
  const dir = parentDir(root)!;
  const path = inDir(dir, `${m.snake}.rs`);
  const text = ctx.read(root);
  const gap = text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return {
    path,
    files: [{ path, content }],
    appends: [{ path: root, text: `${gap}mod ${m.snake};\n` }],
  };
}

const unparsableTest = (m: Marker): string => `#[test]\nfn ${m.snake}() {\n`;

const failingTest = (m: Marker): string =>
  `#[test]\nfn ${m.snake}() {\n    panic!("${m.snake}: planted failing test");\n}\n`;

function testFault(tool: ToolId, ctx: FaultContext, tier: Tier): Fault | Skip {
  const krate = targetCrate(ctx);
  if ('skip' in krate) return krate;
  const place = testPlace(krate, ctx.invocation.argv);
  if ('skip' in place) return place;
  if (tier === 'semantic') {
    const skip = runSkip(tool, ctx.invocation.argv);
    if (skip !== undefined) return { skip };
  }
  const m = ctx.marker;
  const content = tier === 'reach' ? unparsableTest(m) : failingTest(m);
  const what = tier === 'reach' ? 'test file that does not parse' : 'failing test';
  if (place.kind === 'tests') {
    const path = inDir(krate.dir, `tests/${m.snake}.rs`);
    return {
      tool,
      tier,
      marker: m,
      files: [{ path, content }],
      appends: [],
      description: `${what}: ${path}`,
    };
  }
  const { path, files, appends } = moduleFault(ctx, place.root, content);
  return {
    tool,
    tier,
    marker: m,
    files,
    appends,
    description: `${what}: ${path}, declared in ${place.root}`,
  };
}

/** Lints that turn clippy's needless_return warning into an error when passed after `--`. */
const DENIES_NEEDLESS_RETURN = new Set([
  'warnings',
  'clippy::all',
  'clippy::style',
  'clippy::needless_return',
]);

function deniesNeedlessReturn(after: string[]): boolean {
  return after.some((a, i) => {
    const joined = /^(?:-D|-F|--deny=|--forbid=)(.+)$/.exec(a)?.[1];
    const lint = joined ?? (['-D', '-F', '--deny', '--forbid'].includes(a) ? after[i + 1] : '');
    return DENIES_NEEDLESS_RETURN.has((lint ?? '').replace(/-/g, '_'));
  });
}

/** A tool's semantic-tier module, or why the tool has none. */
type ModuleSemantic =
  | {
      content(m: Marker): string;
      describe: string;
      expectSurvival?(argv: string[]): string | undefined;
    }
  | { none: string };

function crateModuleFault(
  tool: ToolId,
  semantic: ModuleSemantic,
  ctx: FaultContext,
  tier: Tier,
): Fault | Skip {
  if (tier === 'semantic' && 'none' in semantic) return { skip: semantic.none };
  const krate = targetCrate(ctx);
  if ('skip' in krate) return krate;
  const root = krate.lib ?? krate.bin;
  if (root === undefined) {
    return {
      skip: `${inDir(krate.dir, 'Cargo.toml')} has no src/lib.rs or src/main.rs to declare a module in`,
    };
  }
  const m = ctx.marker;
  const planted = tier === 'semantic' && !('none' in semantic) ? semantic : undefined;
  const { path, files, appends } = moduleFault(
    ctx,
    root,
    planted ? planted.content(m) : `fn ${m.snake}() {\n`,
  );
  const survival = planted?.expectSurvival?.(ctx.invocation.argv);
  return {
    tool,
    tier,
    marker: m,
    files,
    appends,
    description: `${planted ? planted.describe : 'module that does not parse'}: ${path}, declared in ${root}`,
    ...(survival === undefined ? {} : { expectSurvival: survival }),
  };
}

const moduleTool = (
  id: ToolId,
  category: ToolDef['category'],
  semantic: ModuleSemantic,
): ToolDef => ({
  id,
  language: 'rust',
  category,
  faults: (ctx, tier) => crateModuleFault(id, semantic, ctx, tier),
});

export const cargoTest: ToolDef = {
  id: 'cargo-test',
  language: 'rust',
  category: 'test',
  faults: (ctx, tier) => testFault('cargo-test', ctx, tier),
};

export const cargoNextest: ToolDef = {
  id: 'cargo-nextest',
  language: 'rust',
  category: 'test',
  faults: (ctx, tier) => testFault('cargo-nextest', ctx, tier),
};

export const cargoClippy = moduleTool('cargo-clippy', 'lint', {
  content: (m) => `#![allow(dead_code)]\n\nfn ${m.snake}() -> u32 {\n    return 1;\n}\n`,
  describe: 'needless_return lint',
  expectSurvival: (argv) =>
    deniesNeedlessReturn(splitArgs(argv).after)
      ? undefined
      : 'cargo clippy exits 0 when lints only warn; run it as `cargo clippy -- -D warnings` or set RUSTFLAGS=-Dwarnings',
});

export const cargoFmt = moduleTool('cargo-fmt', 'format', {
  content: (m) => `fn   ${m.snake} ( )->u32{\n        1 }\n`,
  describe: 'badly formatted module',
});

export const cargoCheck = moduleTool('cargo-check', 'compile', {
  none: 'cargo check and cargo build have a reach fault only: code that compiles passes them',
});

export const RUST_TOOLS: ToolDef[] = [cargoTest, cargoNextest, cargoClippy, cargoFmt, cargoCheck];
