import { describe, expect, it } from 'vitest';

import {
  conditionHolds,
  expressionsIn,
  substitute,
  type ExprContext,
} from '../src/workflow/expressions';

const ctx: ExprContext = {
  matrix: { shard: '2', 'node-version': '22', name: '' },
  env: { A: 'alpha' },
  github: { workspace: '/repo', repository: 'o/r' },
  runner: { os: 'Linux' },
  inputs: { dir: 'src' },
};

describe('substitute', () => {
  it('replaces matrix, env, github, runner and inputs references', () => {
    expect(
      substitute(
        'npm test -- --shard ${{ matrix.shard }} ${{matrix.node-version}} ${{ env.A }} ${{ github.workspace }} ${{ runner.os }} ${{ inputs.dir }}',
        ctx,
      ),
    ).toEqual({ text: 'npm test -- --shard 2 22 alpha /repo Linux src', unresolved: [] });
  });

  it('leaves secrets in place and lists them as unresolved', () => {
    expect(substitute('deploy --token ${{ secrets.TOKEN }}', ctx)).toEqual({
      text: 'deploy --token ${{ secrets.TOKEN }}',
      unresolved: ['secrets.TOKEN'],
    });
  });

  it('evaluates string literals and || fallbacks', () => {
    expect(substitute("${{ matrix.name || 'default' }}", ctx).text).toBe('default');
    expect(substitute("${{ 'lit' }}", ctx).text).toBe('lit');
  });

  it('treats unknown contexts and function calls as unresolved', () => {
    expect(substitute('${{ steps.x.outputs.y }}', ctx).unresolved).toEqual(['steps.x.outputs.y']);
    expect(substitute("${{ hashFiles('**/package-lock.json') }}", ctx).unresolved).toEqual([
      "hashFiles('**/package-lock.json')",
    ]);
    expect(substitute('${{ matrix.missing }}', ctx).unresolved).toEqual(['matrix.missing']);
  });
});

describe('expressionsIn', () => {
  it('lists every expression body', () => {
    expect(expressionsIn('a ${{ x }} b ${{y.z}}')).toEqual(['x', 'y.z']);
  });
});

describe('conditionHolds', () => {
  const on = (matrix: Record<string, string>) => (cond: string) => conditionHolds(cond, matrix);

  it('compares matrix values the way GitHub does', () => {
    const node20 = on({ node: '20', os: 'ubuntu-latest', experimental: 'true' });
    expect(node20('matrix.node == 20')).toBe(true);
    expect(node20('${{ matrix.node != 20 }}')).toBe(false);
    expect(node20("matrix.node == '20'")).toBe(true);
    expect(node20('matrix.node >= 22')).toBe(false);
    expect(node20("matrix.os == 'Ubuntu-Latest'")).toBe(true);
    expect(node20('matrix.experimental')).toBe(true);
    expect(node20('!matrix.experimental')).toBe(false);
    expect(node20("contains(matrix.os, 'ubuntu') && startsWith(matrix.os, 'UBUNTU')")).toBe(true);
    expect(node20("matrix.missing == ''")).toBe(true);
  });

  it('assumes the steps before passed', () => {
    const any = on({});
    expect(any('always()')).toBe(true);
    expect(any('success()')).toBe(true);
    expect(any('failure()')).toBe(false);
    expect(any('cancelled() || failure()')).toBe(false);
  });

  it('knows nothing about contexts other than the matrix', () => {
    const node22 = on({ node: '22' });
    expect(node22("github.event_name == 'push'")).toBeUndefined();
    expect(node22("runner.os == 'Linux'")).toBeUndefined();
    expect(node22("matrix.node == 20 || github.event_name == 'push'")).toBeUndefined();
    expect(node22("matrix.node == 22 || github.event_name == 'push'")).toBe(true);
    expect(node22("matrix.node == 20 && github.ref == 'refs/heads/main'")).toBe(false);
    expect(node22("hashFiles('go.sum') != ''")).toBeUndefined();
    expect(node22("matrix['node'] == 22")).toBeUndefined();
  });
});
