import { describe, expect, it } from 'vitest';

import { expressionsIn, substitute, type ExprContext } from '../src/workflow/expressions';

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
