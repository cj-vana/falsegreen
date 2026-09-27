import { afterEach, describe, expect, it } from 'vitest';

import { trackedFiles } from '../src/core/git';
import type { Marker } from '../src/core/marker';
import { candidateDir, markerName, type Shape } from '../src/faults/placement';
import type { FaultContext, ToolInvocation } from '../src/faults/types';
import { makeRepo, type TempRepo } from './helpers/repo';

const m: Marker = { id: 'abc123', snake: 'falsegreen_abc123', pascal: 'Falsegreenabc123' };
const TEST_SHAPE: Shape = { kind: 'test', exts: ['.ts'], testPattern: /\.test\.ts$/ };
const SOURCE_SHAPE: Shape = { kind: 'source', exts: ['.ts'], testPattern: /\.test\.ts$/ };

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
    invocation: { tool: 'vitest', argv: ['vitest', 'run'], cwd: '', pathArgs: [], via: [], ...inv },
    marker: m,
    ...(place === undefined ? {} : { place }),
    read: () => '',
  };
}

describe('candidateDir', () => {
  it('picks the directory with the most matching files', () => {
    const c = ctx({ 'test/a.test.ts': '', 'test/b.test.ts': '', 'src/c.test.ts': '' });
    expect(candidateDir(c, TEST_SHAPE)).toEqual({ dir: 'test', neighbor: 'test/a.test.ts' });
  });

  it('stays under the paths the tool was given, or its working directory', () => {
    const files = { 'test/a.test.ts': '', 'test/b.test.ts': '', 'web/src/c.test.ts': '' };
    expect(candidateDir(ctx(files, { pathArgs: ['web'] }), TEST_SHAPE)?.dir).toBe('web/src');
    expect(candidateDir(ctx(files, { cwd: 'web' }), TEST_SHAPE)?.dir).toBe('web/src');
  });

  it('uses the directory of a single file the tool was pointed at', () => {
    const c = ctx(
      { 'test/a.test.ts': '', 'test/b.test.ts': '', 'e2e/x.test.ts': '' },
      { pathArgs: ['e2e/x.test.ts'] },
    );
    expect(candidateDir(c, TEST_SHAPE)).toEqual({ dir: 'e2e', neighbor: 'e2e/x.test.ts' });
  });

  it('skips fixture, testdata and vendored directories', () => {
    const c = ctx({
      'test/fixtures/a.test.ts': '',
      'test/fixtures/b.test.ts': '',
      'vendor/c.test.ts': '',
      'pkg/testdata/d.test.ts': '',
      'test/real.test.ts': '',
    });
    expect(candidateDir(c, TEST_SHAPE)?.dir).toBe('test');
  });

  it('keeps test files out of source placement', () => {
    const c = ctx({
      'src/a.ts': '',
      'src/a.test.ts': '',
      'test/b.test.ts': '',
      'test/c.test.ts': '',
    });
    expect(candidateDir(c, SOURCE_SHAPE)).toEqual({ dir: 'src', neighbor: 'src/a.ts' });
  });

  it('honors an accept filter and a configured directory', () => {
    const files = { 'src/a.ts': '', 'lib/b.ts': '', 'lib/c.ts': '' };
    expect(
      candidateDir(ctx(files), { ...SOURCE_SHAPE, accept: (p) => p.startsWith('src/') })?.dir,
    ).toBe('src');
    expect(candidateDir(ctx(files, {}, 'src'), SOURCE_SHAPE)).toEqual({
      dir: 'src',
      neighbor: 'src/a.ts',
    });
    expect(candidateDir(ctx(files, {}, 'fresh/dir'), SOURCE_SHAPE)).toEqual({ dir: 'fresh/dir' });
  });

  it('returns undefined when nothing matches', () => {
    expect(candidateDir(ctx({ 'README.md': '' }), TEST_SHAPE)).toBeUndefined();
  });
});

describe('markerName', () => {
  it.each([
    ['test/sum.test.ts', 'js', 'test/falsegreen_abc123.test.ts'],
    ['test/foo-test.js', 'js', 'test/falsegreen_abc123-test.js'],
    ['src/__tests__/foo.tsx', 'js', 'src/__tests__/falsegreen_abc123.tsx'],
    ['tests/test_calc.py', 'python', 'tests/test_falsegreen_abc123.py'],
    ['tests/calc_test.py', 'python', 'tests/falsegreen_abc123_test.py'],
    ['src/main.py', 'python', 'src/falsegreen_abc123.py'],
    ['pkg/calc_test.go', 'go', 'pkg/falsegreen_abc123_test.go'],
    ['pkg/calc.go', 'go', 'pkg/falsegreen_abc123.go'],
    ['src/lib.rs', 'rust', 'src/falsegreen_abc123.rs'],
    ['src/test/java/com/x/CalcTest.java', 'jvm', 'src/test/java/com/x/Falsegreenabc123Test.java'],
    ['src/test/java/com/x/CalcTests.java', 'jvm', 'src/test/java/com/x/Falsegreenabc123Tests.java'],
    ['src/test/java/com/x/TestCalc.java', 'jvm', 'src/test/java/com/x/TestFalsegreenabc123.java'],
    ['src/test/kotlin/CalcSpec.kt', 'jvm', 'src/test/kotlin/Falsegreenabc123Spec.kt'],
  ] as const)('%s', (neighbor, lang, expected) => {
    expect(markerName(neighbor, m, lang)).toBe(expected);
  });
});
