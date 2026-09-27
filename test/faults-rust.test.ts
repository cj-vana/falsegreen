import { describe, expect, it } from 'vitest';

import type { Marker } from '../src/core/marker';
import { toolDef } from '../src/faults/registry';
import { RUST_TOOLS, targetCrate, testPlace, type Crate } from '../src/faults/rust';
import type { Fault, FaultContext, ToolId, ToolInvocation } from '../src/faults/types';

const m: Marker = { id: 'abc123', snake: 'falsegreen_abc123', pascal: 'Falsegreenabc123' };

const PKG = (name: string, extra = ''): string =>
  `[package]\nname = "${name}"\nversion = "0.1.0"\nedition = "2024"\n${extra}`;

const LIB = 'pub fn one() -> u32 {\n    1\n}\n';

function ctx(
  files: Record<string, string>,
  command = 'cargo test',
  inv: Partial<ToolInvocation> = {},
  place?: string,
): FaultContext {
  return {
    root: '/unused',
    tracked: Object.keys(files).sort(),
    invocation: {
      tool: 'cargo-test',
      argv: command.split(' '),
      cwd: '',
      pathArgs: [],
      via: [command],
      ...inv,
    },
    marker: m,
    ...(place === undefined ? {} : { place }),
    read: (p) => {
      const text = files[p];
      if (text === undefined) throw new Error(`read of untracked ${p}`);
      return text;
    },
  };
}

function fault(tool: ToolId, c: FaultContext, tier: 'reach' | 'semantic'): Fault {
  const f = toolDef(tool)!.faults(c, tier);
  if ('skip' in f) throw new Error(`unexpected skip: ${f.skip}`);
  return f;
}

function skip(tool: ToolId, c: FaultContext, tier: 'reach' | 'semantic'): string {
  const f = toolDef(tool)!.faults(c, tier);
  if (!('skip' in f)) throw new Error(`expected a skip, got ${f.description}`);
  return f.skip;
}

const crate = (c: Crate | { skip: string }): Crate => {
  if ('skip' in c) throw new Error(c.skip);
  return c;
};

const WORKSPACE = {
  'Cargo.toml': '[workspace]\nresolver = "3"\nmembers = ["crates/*", "tools/gen"]\n',
  'crates/app/Cargo.toml': PKG('app'),
  'crates/app/src/main.rs': 'fn main() {}\n',
  'crates/core/Cargo.toml': PKG('core'),
  'crates/core/src/lib.rs': LIB,
  'crates/docs/Cargo.toml': PKG('docs'),
  'tools/gen/Cargo.toml': PKG('gen'),
  'tools/gen/src/main.rs': 'fn main() {}\n',
  'vendor/other/Cargo.toml': PKG('other'),
  'vendor/other/src/lib.rs': LIB,
};

describe('targetCrate', () => {
  it('finds the crate at the repository root with its library and binary roots', () => {
    const c = ctx({ 'Cargo.toml': PKG('solo'), 'src/lib.rs': LIB, 'src/main.rs': '' });
    expect(targetCrate(c)).toEqual({
      dir: '',
      name: 'solo',
      lib: 'src/lib.rs',
      bin: 'src/main.rs',
      autotests: true,
    });
  });

  it('reads [lib] path and autotests from the manifest', () => {
    const manifest = `${PKG('custom', 'autotests = false\n')}\n[lib]\npath = "./lib.rs"\n`;
    const c = ctx({ 'Cargo.toml': manifest, 'lib.rs': LIB });
    expect(targetCrate(c)).toEqual({ dir: '', name: 'custom', lib: 'lib.rs', autotests: false });
  });

  it('walks up from the working directory to the nearest Cargo.toml, as cargo does', () => {
    const files = { 'svc/Cargo.toml': PKG('svc'), 'svc/src/lib.rs': LIB };
    expect(crate(targetCrate(ctx(files, 'cargo test', { cwd: 'svc/src/nested' }))).dir).toBe('svc');
  });

  it('uses the directory of -p or --manifest-path, and place: over both', () => {
    expect(crate(targetCrate(ctx(WORKSPACE, 'cargo test', { pathArgs: ['tools/gen'] }))).dir).toBe(
      'tools/gen',
    );
    expect(
      crate(targetCrate(ctx(WORKSPACE, 'cargo test', { pathArgs: ['.'] }, 'crates/app/tests'))).dir,
    ).toBe('crates/app');
  });

  it('picks the first member of a virtual workspace that has a crate root', () => {
    // crates/docs has neither src/lib.rs nor src/main.rs; vendor/ is not a member.
    expect(crate(targetCrate(ctx(WORKSPACE))).dir).toBe('crates/app');
  });

  it('leaves out members that --exclude or [workspace] exclude remove', () => {
    const c = ctx(WORKSPACE, 'cargo test --workspace --exclude app');
    expect(crate(targetCrate(c)).dir).toBe('crates/core');
    const excluded = {
      ...WORKSPACE,
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\nexclude = ["crates/app"]\n',
    };
    expect(crate(targetCrate(ctx(excluded))).dir).toBe('crates/core');
  });

  it('follows default-members unless the command asks for the whole workspace', () => {
    const files = {
      ...WORKSPACE,
      'Cargo.toml':
        '[workspace]\nmembers = [\n  "crates/*",\n  "tools/gen",\n]\ndefault-members = ["tools/gen"]\n',
    };
    expect(crate(targetCrate(ctx(files))).dir).toBe('tools/gen');
    expect(crate(targetCrate(ctx(files, 'cargo test --workspace'))).dir).toBe('crates/app');
  });

  it('skips when there is no usable manifest', () => {
    expect(targetCrate(ctx({ 'src/lib.rs': LIB }, 'cargo test', { cwd: 'src' }))).toEqual({
      skip: 'no Cargo.toml at or above src',
    });
    expect(targetCrate(ctx({ 'Cargo.toml': '[dependencies]\n' }))).toEqual({
      skip: 'the Cargo.toml in the repository root has neither [package] nor [workspace]',
    });
    const empty = {
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'crates/docs/Cargo.toml': PKG('docs'),
    };
    expect(targetCrate(ctx(empty))).toEqual({
      skip: 'no member of the workspace in the repository root has a src/lib.rs or src/main.rs',
    });
  });
});

describe('testPlace', () => {
  const full: Crate = { dir: '', lib: 'src/lib.rs', bin: 'src/main.rs', autotests: true };
  const argv = (s: string): string[] => s.split(' ');

  it('plants in tests/ when integration tests run', () => {
    for (const cmd of ['cargo test', 'cargo test --tests', 'cargo nextest run --all-targets']) {
      expect(testPlace(full, argv(cmd))).toEqual({ kind: 'tests' });
    }
    expect(testPlace(full, argv('cargo test -- --lib'))).toEqual({ kind: 'tests' });
  });

  it('plants a unit test module when only the library or the binaries are tested', () => {
    expect(testPlace(full, argv('cargo test --lib'))).toEqual({
      kind: 'module',
      root: 'src/lib.rs',
    });
    expect(testPlace(full, argv('cargo test --bins'))).toEqual({
      kind: 'module',
      root: 'src/main.rs',
    });
    expect(testPlace({ ...full, autotests: false }, argv('cargo test'))).toEqual({
      kind: 'module',
      root: 'src/lib.rs',
    });
  });

  it('skips targets it cannot plant in', () => {
    expect(testPlace(full, argv('cargo test --doc'))).toEqual({
      skip: 'the command tests only --doc targets; planted tests go in tests/, the library or src/main.rs',
    });
    expect(
      testPlace({ dir: 'b', bin: 'b/src/main.rs', autotests: true }, argv('cargo test --lib')),
    ).toEqual({
      skip: 'the command tests only --lib and b/Cargo.toml has no matching crate root',
    });
    expect(testPlace({ dir: '', autotests: false }, argv('cargo test'))).toEqual({
      skip: 'Cargo.toml sets autotests = false and the crate has no src/lib.rs or src/main.rs',
    });
  });
});

describe('cargo-test and cargo-nextest faults', () => {
  const files = { 'Cargo.toml': PKG('solo'), 'src/lib.rs': LIB };

  it('plants an unparsable test file and a panicking test in tests/', () => {
    const reach = fault('cargo-test', ctx(files), 'reach');
    expect(reach.files).toEqual([
      { path: 'tests/falsegreen_abc123.rs', content: '#[test]\nfn falsegreen_abc123() {\n' },
    ]);
    expect(reach.appends).toEqual([]);
    expect(reach.description).toBe('test file that does not parse: tests/falsegreen_abc123.rs');

    const semantic = fault('cargo-nextest', ctx(files, 'cargo nextest run'), 'semantic');
    expect(semantic.tool).toBe('cargo-nextest');
    expect(semantic.files[0]!.content).toBe(
      '#[test]\nfn falsegreen_abc123() {\n    panic!("falsegreen_abc123: planted failing test");\n}\n',
    );
  });

  it('puts the test in the member that -p names', () => {
    const c = ctx(WORKSPACE, 'cargo test -p core', { pathArgs: ['crates/core'] });
    expect(fault('cargo-test', c, 'semantic').files[0]!.path).toBe(
      'crates/core/tests/falsegreen_abc123.rs',
    );
  });

  it('declares a module in the library for cargo test --lib', () => {
    const f = fault('cargo-test', ctx(files, 'cargo test --lib'), 'semantic');
    expect(f.files[0]!.path).toBe('src/falsegreen_abc123.rs');
    expect(f.appends).toEqual([{ path: 'src/lib.rs', text: '\nmod falsegreen_abc123;\n' }]);
    expect(f.description).toBe('failing test: src/falsegreen_abc123.rs, declared in src/lib.rs');
  });

  it.each([
    ['cargo test --no-run', 'the command builds the tests without running them'],
    ['cargo test -- --ignored', 'the command runs only ignored tests'],
    ['cargo nextest run --run-ignored only', 'the command runs only ignored tests'],
    [
      'cargo nextest run -E test(=parse)',
      'the command selects tests with the filterset test(=parse)',
    ],
    [
      'cargo nextest run --partition=hash:1/2',
      'the command runs one partition of the tests (hash:1/2), which may leave the planted test out',
    ],
    ['cargo test -p solo parse', 'the command runs only tests whose names contain "parse"'],
  ])('skips the semantic fault for %s', (command, reason) => {
    const tool: ToolId = command.includes('nextest') ? 'cargo-nextest' : 'cargo-test';
    expect(skip(tool, ctx(files, command), 'semantic')).toBe(reason);
    expect(fault(tool, ctx(files, command), 'reach').files[0]!.path).toBe(
      'tests/falsegreen_abc123.rs',
    );
  });

  it('does not read flag values as a test name filter', () => {
    const command = 'cargo +stable test --features serde --target-dir out -j 2 -- --nocapture';
    expect(fault('cargo-test', ctx(files, command), 'semantic').files).toHaveLength(1);
    // A gate mapped to cargo-test in the config runs some other command; it has no TESTNAME.
    expect(fault('cargo-test', ctx(files, 'just ci'), 'semantic').files).toHaveLength(1);
  });

  it('passes on the reason a crate cannot take a test', () => {
    expect(skip('cargo-test', ctx({}), 'reach')).toBe(
      'no Cargo.toml at or above the repository root',
    );
    expect(skip('cargo-test', ctx(files, 'cargo test --doc'), 'reach')).toMatch(/only --doc/);
  });
});

describe('module faults: cargo-clippy, cargo-fmt, cargo-check', () => {
  const files = { 'Cargo.toml': PKG('solo'), 'src/lib.rs': LIB, 'src/main.rs': 'fn main() {}' };

  it('appends the module declaration to the library root, keeping one blank line before it', () => {
    const f = fault('cargo-check', ctx(files, 'cargo check'), 'reach');
    expect(f.files).toEqual([
      { path: 'src/falsegreen_abc123.rs', content: 'fn falsegreen_abc123() {\n' },
    ]);
    expect(f.appends).toEqual([{ path: 'src/lib.rs', text: '\nmod falsegreen_abc123;\n' }]);
    expect(f.description).toBe(
      'module that does not parse: src/falsegreen_abc123.rs, declared in src/lib.rs',
    );
  });

  it('uses src/main.rs when there is no library and separates a root without a final newline', () => {
    const bin = { 'Cargo.toml': PKG('bin'), 'src/main.rs': 'fn main() {}' };
    expect(fault('cargo-fmt', ctx(bin, 'cargo fmt --check'), 'reach').appends).toEqual([
      { path: 'src/main.rs', text: '\n\nmod falsegreen_abc123;\n' },
    ]);
    const empty = { 'Cargo.toml': PKG('bin'), 'src/main.rs': '' };
    expect(fault('cargo-fmt', ctx(empty, 'cargo fmt --check'), 'reach').appends[0]!.text).toBe(
      'mod falsegreen_abc123;\n',
    );
  });

  it('plants a needless return for clippy and a badly spaced module for rustfmt', () => {
    const lint = fault('cargo-clippy', ctx(files, 'cargo clippy'), 'semantic');
    expect(lint.files[0]!.content).toBe(
      '#![allow(dead_code)]\n\nfn falsegreen_abc123() -> u32 {\n    return 1;\n}\n',
    );
    expect(lint.description).toBe(
      'needless_return lint: src/falsegreen_abc123.rs, declared in src/lib.rs',
    );
    const fmt = fault('cargo-fmt', ctx(files, 'cargo fmt --check'), 'semantic');
    expect(fmt.files[0]!.content).toBe('fn   falsegreen_abc123 ( )->u32{\n        1 }\n');
    expect(fmt.expectSurvival).toBeUndefined();
  });

  it.each([
    ['cargo clippy', true],
    ['cargo clippy --all-targets -- -W clippy::pedantic', true],
    ['cargo clippy -- -D clippy::pedantic', true],
    ['cargo clippy -- -D warnings', false],
    ['cargo clippy -- -Dwarnings', false],
    ['cargo clippy -- --deny=clippy::all', false],
    ['cargo clippy -- -D clippy::needless-return', false],
    ['cargo clippy -- -F clippy::style', false],
  ])('%s: expectSurvival set is %s', (command, survives) => {
    const f = fault('cargo-clippy', ctx(files, command), 'semantic');
    expect(f.expectSurvival !== undefined).toBe(survives);
    expect(fault('cargo-clippy', ctx(files, command), 'reach').expectSurvival).toBeUndefined();
  });

  it('has no semantic fault for cargo check', () => {
    expect(skip('cargo-check', ctx(files, 'cargo build'), 'semantic')).toBe(
      'cargo check and cargo build have a reach fault only: code that compiles passes them',
    );
  });

  it('skips a crate without a library or src/main.rs', () => {
    const only = { 'Cargo.toml': PKG('tools'), 'src/bin/a.rs': 'fn main() {}\n' };
    expect(skip('cargo-clippy', ctx(only, 'cargo clippy'), 'reach')).toBe(
      'Cargo.toml has no src/lib.rs or src/main.rs to declare a module in',
    );
    expect(skip('cargo-fmt', ctx({}, 'cargo fmt --check'), 'semantic')).toBe(
      'no Cargo.toml at or above the repository root',
    );
  });
});

describe('RUST_TOOLS', () => {
  it('covers every cargo tool id once', () => {
    expect(RUST_TOOLS.map((t) => t.id).sort()).toEqual([
      'cargo-check',
      'cargo-clippy',
      'cargo-fmt',
      'cargo-nextest',
      'cargo-test',
    ]);
    expect(RUST_TOOLS.every((t) => t.language === 'rust' && toolDef(t.id) === t)).toBe(true);
  });
});
