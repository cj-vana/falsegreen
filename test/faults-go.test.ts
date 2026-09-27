import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { trackedFiles } from '../src/core/git';
import type { Marker } from '../src/core/marker';
import { GO_TOOLS, goHeader, goVisible, packageFor } from '../src/faults/go';
import type { Fault, FaultContext, ToolId, ToolInvocation } from '../src/faults/types';
import { makeRepo, type TempRepo } from './helpers/repo';

const m: Marker = { id: 'abc123', snake: 'falsegreen_abc123', pascal: 'Falsegreenabc123' };

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.remove();
  repo = undefined;
});

function ctx(
  files: Record<string, string>,
  inv: Partial<ToolInvocation> = {},
  place?: string,
): FaultContext {
  repo = makeRepo(files);
  const root = repo.root;
  return {
    root,
    tracked: trackedFiles(root),
    invocation: {
      tool: 'go-test',
      argv: ['go', 'test', './...'],
      cwd: '',
      pathArgs: [],
      via: [],
      ...inv,
    },
    marker: m,
    ...(place === undefined ? {} : { place }),
    read: (p) => readFileSync(join(root, p), 'utf8'),
  };
}

function fault(tool: ToolId, c: FaultContext, tier: 'reach' | 'semantic'): Fault {
  const def = GO_TOOLS.find((d) => d.id === tool)!;
  const f = def.faults({ ...c, invocation: { ...c.invocation, tool } }, tier);
  if ('skip' in f) throw new Error(`unexpected skip: ${f.skip}`);
  return f;
}

const CALC = {
  'go.mod': 'module example.com/x\n\ngo 1.22\n',
  'calc/calc.go':
    '// Package calc adds.\npackage calc\n\nfunc Add(a, b int) int { return a + b }\n',
  'calc/calc_test.go': 'package calc_test\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {}\n',
};

describe('goHeader', () => {
  it.each([
    ['package calc\n', { pkg: 'calc', constrained: false }],
    [
      '// Package calc adds.\n\n/* license\n package fake */\npackage calc_test\n',
      { pkg: 'calc_test', constrained: false },
    ],
    ['//go:build linux\n\npackage calc\n', { pkg: 'calc', constrained: true }],
    ['// +build ignore\n\npackage main\n', { pkg: 'main', constrained: true }],
    ['// no clause yet\nfunc main() {}\n', { constrained: false }],
  ])('%j', (text, expected) => {
    expect(goHeader(text)).toEqual(expected);
  });
});

describe('goVisible', () => {
  it('skips files Go ignores and files of other modules', () => {
    const c = ctx({
      ...CALC,
      '_examples/a.go': 'package examples\n',
      '.hidden/b.go': 'package hidden\n',
      'calc/_scratch.go': 'package calc\n',
      'tools/go.mod': 'module example.com/x/tools\n',
      'tools/gen/gen.go': 'package gen\n',
    });
    const visible = goVisible(c);
    expect(c.tracked.filter((p) => p.endsWith('.go') && visible(p))).toEqual([
      'calc/calc.go',
      'calc/calc_test.go',
    ]);
    const fromTools = goVisible({ ...c, invocation: { ...c.invocation, cwd: 'tools/gen' } });
    expect(fromTools('tools/gen/gen.go')).toBe(true);
    expect(fromTools('calc/calc.go')).toBe(false);
  });

  it('accepts every module when no go.mod sits above the working directory', () => {
    const c = ctx({ 'a/go.mod': 'module a\n', 'a/a.go': 'package a\n', 'b/b.go': 'package b\n' });
    const visible = goVisible(c);
    expect(visible('a/a.go')).toBe(true);
    expect(visible('b/b.go')).toBe(true);
  });
});

describe('packageFor', () => {
  it('skips a build-constrained generator that sorts first', () => {
    const c = ctx({
      'calc/aaa_gen.go': '//go:build ignore\n\npackage main\n\nfunc main() {}\n',
      'calc/calc.go': 'package calc\n',
    });
    expect(packageFor(c, 'calc', false)).toBe('calc');
  });

  it('copies an external test package for tests and never for source files', () => {
    const c = ctx(CALC);
    expect(packageFor(c, 'calc', true)).toBe('calc_test');
    expect(packageFor(c, 'calc', false)).toBe('calc');
  });

  it('falls back to files of the other kind, then to constrained files', () => {
    const tests = ctx({ 'it/flow_test.go': 'package it_test\n' });
    expect(packageFor(tests, 'it', false)).toBe('it');
    repo?.remove();
    const tagged = ctx({ 'sys/sys_linux.go': '//go:build linux\n\npackage sys\n' });
    expect(packageFor(tagged, 'sys', true)).toBe('sys');
  });

  it('returns undefined for a directory without Go files', () => {
    expect(packageFor(ctx(CALC), 'docs', false)).toBeUndefined();
  });
});

describe('Go faults', () => {
  it('registers every Go tool id', () => {
    expect(GO_TOOLS.map((d) => [d.id, d.language, d.category])).toEqual([
      ['go-test', 'go', 'test'],
      ['go-vet', 'go', 'lint'],
      ['golangci-lint', 'go', 'lint'],
      ['staticcheck', 'go', 'lint'],
      ['gofmt', 'go', 'format'],
      ['goimports', 'go', 'format'],
      ['gofumpt', 'go', 'format'],
    ]);
  });

  it('plants a failing test in the neighbor test package', () => {
    const f = fault('go-test', ctx(CALC), 'semantic');
    expect(f.files).toEqual([
      {
        path: 'calc/falsegreen_abc123_test.go',
        content: [
          'package calc_test',
          '',
          'import "testing"',
          '',
          'func TestFalsegreenabc123(t *testing.T) {',
          '\tt.Fatal("falsegreen_abc123: planted failing test")',
          '}',
          '',
        ].join('\n'),
      },
    ]);
    expect(f.expectSurvival).toBeUndefined();
  });

  it('plants an unterminated test for the reach tier', () => {
    const f = fault('go-test', ctx(CALC), 'reach');
    expect(f.files[0]!.path).toBe('calc/falsegreen_abc123_test.go');
    expect(f.files[0]!.content).toMatch(
      /^package calc_test\n[\s\S]*func TestFalsegreenabc123\(t \*testing\.T\) \{\n$/,
    );
    expect(f.description).toBe('Go file that does not parse: calc/falsegreen_abc123_test.go');
  });

  it('keeps test faults out of a nested module the pattern does not reach', () => {
    const c = ctx({
      ...CALC,
      'tools/go.mod': 'module example.com/x/tools\n',
      'tools/gen/a_test.go': 'package gen\n',
      'tools/gen/b_test.go': 'package gen\n',
    });
    expect(fault('go-test', c, 'semantic').files[0]!.path).toBe('calc/falsegreen_abc123_test.go');
  });

  it('plants a Printf verb mismatch in a source file for the linters', () => {
    const c = ctx(CALC);
    for (const tool of ['go-vet', 'staticcheck', 'golangci-lint'] as const) {
      const f = fault(tool, c, 'semantic');
      expect(f.files[0]!.path).toBe('calc/falsegreen_abc123.go');
      expect(f.files[0]!.content).toContain('package calc\n\nimport "fmt"\n');
      expect(f.files[0]!.content).toContain('\tfmt.Printf("%d\\n", "falsegreen_abc123")\n');
      expect(f.expectSurvival).toBeUndefined();
    }
    expect(fault('go-vet', c, 'reach').files[0]!.content).toBe(
      'package calc\n\nfunc Falsegreenabc123() {\n',
    );
  });

  it('plants a badly spaced file that still compiles for the formatters', () => {
    const f = fault('gofmt', ctx(CALC), 'semantic');
    expect(f.files[0]).toEqual({
      path: 'calc/falsegreen_abc123.go',
      content: 'package calc\n\nfunc   Falsegreenabc123 ( a,b int )int{\nreturn a+b }\n',
    });
    expect(f.description).toBe('badly formatted Go file: calc/falsegreen_abc123.go');
  });

  it('explains which invocations let a fault survive', () => {
    const c = ctx(CALC);
    const expectation = (tool: ToolId, argv: string[], tier: 'reach' | 'semantic') =>
      fault(tool, { ...c, invocation: { ...c.invocation, argv } }, tier).expectSurvival;

    expect(expectation('go-test', ['go', 'test', '-run', 'TestAdd', './...'], 'semantic')).toBe(
      'go test -run runs only the tests its pattern matches; the planted test is TestFalsegreenabc123.',
    );
    expect(expectation('go-test', ['go', 'test', '-run=TestAdd'], 'reach')).toBeUndefined();

    expect(
      expectation('golangci-lint', ['golangci-lint', 'run', '--issues-exit-code=0'], 'reach'),
    ).toMatch(/exit 0 on every issue/);
    expect(
      expectation('golangci-lint', ['golangci-lint', 'run', '--issues-exit-code', '0'], 'semantic'),
    ).toMatch(/exit 0 on every issue/);
    expect(
      expectation('golangci-lint', ['golangci-lint', 'run', '--issues-exit-code', '3'], 'semantic'),
    ).toBeUndefined();

    expect(expectation('gofmt', ['gofmt', '-l', '.'], 'semantic')).toBe(
      'gofmt -l lists files that need formatting and exits 0.',
    );
    expect(expectation('gofmt', ['gofmt', '-d', '.'], 'semantic')).toBeUndefined();
    expect(expectation('gofmt', ['gofmt', '-l', '.'], 'reach')).toBe(
      'gofmt reports a file it cannot parse on stderr, not in its -l list, and exits 2.',
    );
    expect(expectation('gofumpt', ['gofumpt', '-l', '.'], 'semantic')).toMatch(/^gofumpt -l/);
    expect(expectation('gofumpt', ['gofumpt', '-d', '.'], 'semantic')).toBeUndefined();
    expect(expectation('gofumpt', ['gofumpt', '-d', '.'], 'reach')).toMatch(/^gofumpt reports/);
    expect(expectation('goimports', ['goimports', '-d', '.'], 'semantic')).toMatch(
      /^goimports exits 0/,
    );
    expect(expectation('goimports', ['goimports', '-l', '.'], 'reach')).toMatch(
      /^goimports reports/,
    );
  });

  it('says why when there are no test files', () => {
    const def = GO_TOOLS.find((d) => d.id === 'go-test')!;
    expect(
      def.faults(ctx({ 'go.mod': 'module x\n', 'main.go': 'package main\n' }), 'semantic'),
    ).toEqual({
      skip: 'no Go test files found where go-test runs',
    });
  });

  it('says why when a configured directory has no package clause to copy', () => {
    const def = GO_TOOLS.find((d) => d.id === 'go-test')!;
    expect(def.faults(ctx(CALC, {}, 'fresh'), 'semantic')).toEqual({
      skip: 'no Go file in fresh to copy a package clause from',
    });
  });

  it('uses a configured directory and its package clause', () => {
    const c = ctx({ ...CALC, 'e2e/flow.go': 'package e2e\n' }, {}, 'e2e');
    expect(fault('go-test', c, 'semantic').files[0]).toMatchObject({
      path: 'e2e/falsegreen_abc123_test.go',
      content: expect.stringMatching(/^package e2e\n/),
    });
  });
});
