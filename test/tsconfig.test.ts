import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { tsconfigAccepts } from '../src/faults/tsconfig';
import { makeRepo, type TempRepo } from './helpers/repo';

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.remove();
  repo = undefined;
});

describe('tsconfigAccepts', () => {
  it('reads this repository tsconfig: src is in the program, test is not', () => {
    repo = makeRepo({
      'tsconfig.json': readFileSync(join(import.meta.dirname, '..', 'tsconfig.json'), 'utf8'),
    });
    const accepts = tsconfigAccepts(repo.root, 'tsconfig.json');
    expect(accepts('src/x.ts')).toBe(true);
    expect(accepts('src/deep/y.ts')).toBe(true);
    expect(accepts('test/x.ts')).toBe(false);
    expect(accepts('tmp/x.ts')).toBe(false);
  });

  it('follows a relative extends and lets the child override include', () => {
    repo = makeRepo({
      'tsconfig.base.json': '{ "include": ["lib"], "exclude": ["lib/gen"] }',
      'packages/a/tsconfig.json': '{ "extends": "../../tsconfig.base.json", "include": ["src"] }',
      'tsconfig.json': '{ "extends": "./tsconfig.base" }',
    });
    const root = tsconfigAccepts(repo.root, 'tsconfig.json');
    expect(root('lib/a.ts')).toBe(true);
    expect(root('lib/gen/b.ts')).toBe(false);
    expect(root('src/c.ts')).toBe(false);
    const pkg = tsconfigAccepts(repo.root, 'packages/a/tsconfig.json');
    expect(pkg('packages/a/src/d.ts')).toBe(true);
    expect(pkg('lib/a.ts')).toBe(false);
  });

  it('accepts only listed files when files is set without include', () => {
    repo = makeRepo({ 'tsconfig.json': '{ "files": ["src/a.ts"] }' });
    const accepts = tsconfigAccepts(repo.root, 'tsconfig.json');
    expect(accepts('src/a.ts')).toBe(true);
    expect(accepts('src/b.ts')).toBe(false);
  });

  it('includes everything under the config directory by default, minus node_modules and outDir', () => {
    repo = makeRepo({
      'web/tsconfig.json': [
        '{',
        '  // comments and trailing commas are allowed',
        '  "compilerOptions": { "outDir": "out", },',
        '}',
      ].join('\n'),
    });
    const accepts = tsconfigAccepts(repo.root, 'web/tsconfig.json');
    expect(accepts('web/src/a.ts')).toBe(true);
    expect(accepts('web/out/a.ts')).toBe(false);
    expect(accepts('other/a.ts')).toBe(false);
  });

  it('accepts everything when the tsconfig is missing', () => {
    repo = makeRepo();
    expect(tsconfigAccepts(repo.root, 'tsconfig.json')('anything.ts')).toBe(true);
  });
});
