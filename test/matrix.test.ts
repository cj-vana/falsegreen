import { describe, expect, it } from 'vitest';

import { expandMatrix } from '../src/workflow/matrix';

// Semantics from https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations
describe('expandMatrix', () => {
  it('returns one empty combination without a matrix', () => {
    expect(expandMatrix(undefined)).toEqual([{}]);
  });

  it('builds the cartesian product in key order', () => {
    expect(
      expandMatrix({ axes: { os: ['a', 'b'], node: [20, 22] }, include: [], exclude: [] }),
    ).toEqual([
      { os: 'a', node: '20' },
      { os: 'a', node: '22' },
      { os: 'b', node: '20' },
      { os: 'b', node: '22' },
    ]);
  });

  it('removes excluded combinations by partial match', () => {
    expect(
      expandMatrix({
        axes: { os: ['a', 'b'], node: [20, 22] },
        include: [],
        exclude: [{ os: 'b', node: 22 }],
      }),
    ).toHaveLength(3);
  });

  it('adds include keys to matching combinations and appends the rest', () => {
    expect(
      expandMatrix({
        axes: { node: [20, 22], os: ['a'] },
        exclude: [{ node: 22 }],
        include: [
          { node: 24, extra: 'x' },
          { os: 'a', flag: 'on' },
        ],
      }),
    ).toEqual([
      { node: '20', os: 'a', flag: 'on' },
      { node: '24', extra: 'x' },
    ]);
  });

  it('expands an include-only matrix', () => {
    expect(
      expandMatrix({ axes: {}, include: [{ name: 'lint' }, { name: 'test' }], exclude: [] }),
    ).toEqual([{ name: 'lint' }, { name: 'test' }]);
  });

  it('returns one unknown combination for a matrix built by an expression', () => {
    expect(
      expandMatrix({ axes: {}, include: [], exclude: [], expression: '${{ fromJSON(x) }}' }),
    ).toEqual([{}]);
  });
});
