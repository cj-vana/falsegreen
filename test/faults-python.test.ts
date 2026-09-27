import { describe, expect, it } from 'vitest';

import type { Marker } from '../src/core/marker';
import type { Tier } from '../src/core/types';
import {
  globToRegExp,
  PYTEST_FILE,
  PYTHON_TOOLS,
  testPath,
  unittestTarget,
  unparseable,
} from '../src/faults/python';
import type { Fault, FaultContext, ToolId, ToolInvocation } from '../src/faults/types';

const m: Marker = { id: 'abc123', snake: 'falsegreen_abc123', pascal: 'Falsegreenabc123' };

function ctx(tracked: string[], inv: Partial<ToolInvocation> & { tool: ToolId }): FaultContext {
  return {
    root: '',
    tracked,
    invocation: { argv: [inv.tool], cwd: '', pathArgs: [], via: [], ...inv },
    marker: m,
    read: () => '',
  };
}

function fault(c: FaultContext, tier: Tier = 'semantic'): Fault {
  const def = PYTHON_TOOLS.find((d) => d.id === c.invocation.tool)!;
  const f = def.faults(c, tier);
  if ('skip' in f) throw new Error(`unexpected skip: ${f.skip}`);
  return f;
}

describe('PYTHON_TOOLS', () => {
  it('defines every Python tool once', () => {
    expect(PYTHON_TOOLS.map((d) => d.id)).toEqual([
      'pytest',
      'unittest',
      'ruff-check',
      'flake8',
      'pylint',
      'mypy',
      'pyright',
      'basedpyright',
      'black',
      'ruff-format',
      'isort',
    ]);
  });

  it('plants the same unparseable file for every reach fault', () => {
    const tracked = ['app/calc.py', 'tests/test_calc.py'];
    for (const def of PYTHON_TOOLS) {
      const f = def.faults(ctx(tracked, { tool: def.id }), 'reach');
      expect('skip' in f ? f.skip : f.files[0]!.content).toBe(unparseable(m));
    }
    expect(unparseable(m)).toBe('# isort: list\nfalsegreen_abc123 = [\n');
  });
});

describe('test faults', () => {
  it('copies the neighbor test file shape for pytest', () => {
    const f = fault(ctx(['app/calc.py', 'tests/test_calc.py'], { tool: 'pytest' }));
    expect(f.files[0]!.path).toBe('tests/test_falsegreen_abc123.py');
    expect(f.files[0]!.content).toContain('class TestFalsegreenabc123(unittest.TestCase):');
    expect(f.files[0]!.content).toContain('self.fail("falsegreen_abc123: planted failing test")');

    const suffixed = fault(ctx(['pkg/calc_test.py'], { tool: 'pytest' }));
    expect(suffixed.files[0]!.path).toBe('pkg/falsegreen_abc123_test.py');
  });

  it('skips when the runner has no test files to sit next to', () => {
    const def = PYTHON_TOOLS.find((d) => d.id === 'pytest')!;
    expect(def.faults(ctx(['app/calc.py'], { tool: 'pytest' }), 'semantic')).toEqual({
      skip: 'no test files found where pytest runs',
    });
  });

  it('names the unittest file after the -p pattern', () => {
    const argv = ['unittest', 'discover', '-s', 'legacy', '-p', '*_spec.py'];
    const tracked = ['tests/test_calc.py', 'tests/test_text.py', 'legacy/calc_spec.py'];
    const f = fault(ctx(tracked, { tool: 'unittest', argv, pathArgs: ['legacy'] }));
    expect(f.files[0]!.path).toBe('legacy/falsegreen_abc123_spec.py');
    expect(f.expectSurvival).toBeUndefined();
  });

  it('avoids a neighbor name that the default unittest pattern would not load', () => {
    const argv = ['unittest', 'discover'];
    const f = fault(ctx(['pkg/tests.py'], { tool: 'unittest', argv }));
    expect(f.files[0]!.path).toBe('pkg/test_falsegreen_abc123.py');
  });

  it('expects survival when unittest runs only the modules it names', () => {
    const argv = ['unittest', 'tests.test_calc'];
    const f = fault(ctx(['tests/test_calc.py'], { tool: 'unittest', argv }));
    expect(f.files[0]!.path).toBe('tests/test_falsegreen_abc123.py');
    expect(f.expectSurvival).toMatch(/runs only the tests it names/);
  });
});

describe('source faults', () => {
  it('goes next to source files, not test files', () => {
    const tracked = ['app/__init__.py', 'app/calc.py', 'tests/test_a.py', 'tests/test_b.py'];
    const f = fault(ctx(tracked, { tool: 'ruff-check', argv: ['ruff', 'check', '.'] }));
    expect(f.files[0]!.path).toBe('app/falsegreen_abc123.py');
    expect(f.files[0]!.content).toContain('\nimport os\n');
  });

  it('plants a type error, unformatted code and unsorted imports for the other tools', () => {
    const tracked = ['app/calc.py'];
    const content = (tool: ToolId) => fault(ctx(tracked, { tool })).files[0]!.content;
    expect(content('mypy')).toContain('FALSEGREEN_ABC123: int = "falsegreen_abc123"');
    expect(content('black')).toContain('FALSEGREEN_ABC123 = 1+2');
    expect(content('isort')).toContain('import sys\nimport os\n');
  });

  it('uses the configured directory when place is set', () => {
    const c = { ...ctx(['app/calc.py', 'scripts/bump.py'], { tool: 'mypy' }), place: 'app' };
    expect(fault(c).files[0]!.path).toBe('app/falsegreen_abc123.py');
  });

  it('expects survival under --exit-zero', () => {
    const argv = ['flake8', '--exit-zero', 'app'];
    const f = fault(ctx(['app/calc.py'], { tool: 'flake8', argv, pathArgs: ['app'] }));
    expect(f.expectSurvival).toMatch(/--exit-zero/);
  });
});

describe('unittestTarget', () => {
  it.each([
    [['unittest'], { pattern: 'test*.py' }],
    [['unittest', '-v'], { pattern: 'test*.py' }],
    [['unittest', 'discover', '-s', 'tests'], { pattern: 'test*.py' }],
    [['unittest', 'discover', '-s', 'tests', '-p', '*_test.py'], { pattern: '*_test.py' }],
    [['unittest', 'discover', '--pattern=check_*.py'], { pattern: 'check_*.py' }],
    [['unittest', 'discover', 'tests', '*_spec.py'], { pattern: '*_spec.py' }],
    [['unittest', 'discover', '-t', '.', 'tests'], { pattern: 'test*.py' }],
    [['unittest', '-v', 'tests.test_calc'], { names: ['tests.test_calc'] }],
  ])('%j', (argv, expected) => {
    expect(unittestTarget(argv)).toEqual(expected);
  });
});

describe('globToRegExp', () => {
  it('matches base names the way fnmatch does', () => {
    const spec = globToRegExp('*_spec.py');
    expect(spec.test('legacy/calc_spec.py')).toBe(true);
    expect(spec.test('calc_spec.pyc')).toBe(false);
    expect(globToRegExp('test*.py').test('pkg/testxpy')).toBe(false);
    expect(globToRegExp('test?.py').test('test1.py')).toBe(true);
  });
});

describe('testPath', () => {
  it('falls back to a name built from the glob', () => {
    const where = { dir: 'legacy', neighbor: 'legacy/calc_spec.py' };
    expect(testPath(where, m, globToRegExp('*_spec.py'), '*_spec.py')).toBe(
      'legacy/falsegreen_abc123_spec.py',
    );
    expect(testPath({ dir: 'tests' }, m, PYTEST_FILE)).toBe('tests/test_falsegreen_abc123.py');
    expect(testPath({ dir: 'tests' }, m, globToRegExp('check_*.py'))).toBeUndefined();
  });
});
