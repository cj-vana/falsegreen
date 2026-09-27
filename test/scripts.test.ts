import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeCall } from '../src/resolve/make';
import { precommitTools } from '../src/resolve/precommit';
import { scriptCall, scriptFor } from '../src/resolve/scripts';
import { makeRepo, type TempRepo } from './helpers/repo';

describe('scriptCall', () => {
  it.each([
    ['npm test', { runner: 'npm', name: 'test', dir: '', ifPresent: false }],
    ['npm t', { runner: 'npm', name: 'test', dir: '', ifPresent: false }],
    ['npm run lint --if-present', { runner: 'npm', name: 'lint', dir: '', ifPresent: true }],
    ['npm --prefix web run lint', { runner: 'npm', name: 'lint', dir: 'web', ifPresent: false }],
    [
      'npm run lint -w packages/a',
      { runner: 'npm', name: 'lint', dir: 'packages/a', ifPresent: false },
    ],
    ['yarn test', { runner: 'yarn', name: 'test', dir: '', ifPresent: false }],
    ['yarn run check', { runner: 'yarn', name: 'check', dir: '', ifPresent: false }],
    ['pnpm -C app run check', { runner: 'pnpm', name: 'check', dir: 'app', ifPresent: false }],
  ])('%s', (cmd, expected) => {
    expect(scriptCall(cmd.split(' '), '')).toEqual(expected);
  });

  it('keeps a fallback for a pnpm or yarn command that may be a binary', () => {
    expect(scriptCall(['yarn', 'eslint', '.'], '')).toEqual({
      runner: 'yarn',
      name: 'eslint',
      dir: '',
      ifPresent: false,
      fallback: ['eslint', '.'],
    });
    expect(scriptCall(['bun', 'run', 'lint'], '')?.fallback).toEqual(['lint']);
  });

  it('ignores package-manager builtins and non-runners', () => {
    expect(scriptCall(['npm', 'ci'], '')).toBeUndefined();
    expect(scriptCall(['pnpm', 'install'], '')).toBeUndefined();
    expect(scriptCall(['yarn'], '')).toBeUndefined();
    expect(scriptCall(['bun', 'test'], '')).toBeUndefined();
    expect(scriptCall(['cargo', 'test'], '')).toBeUndefined();
  });
});

describe('scriptFor', () => {
  let repo: TempRepo;
  beforeAll(() => {
    repo = makeRepo({
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
      'packages/a/package.json': JSON.stringify({ name: 'a' }),
      'broken/package.json': '{ not json',
    });
  });
  afterAll(() => repo.remove());

  it('stops at the nearest package.json, which may not have the script', () => {
    expect(scriptFor(repo.root, '', 'test')).toEqual({ text: 'vitest run', packageDir: '' });
    expect(scriptFor(repo.root, 'packages/a', 'test')).toBeUndefined();
    expect(scriptFor(repo.root, 'packages/a/src', 'test')).toBeUndefined();
    expect(scriptFor(repo.root, 'broken', 'test')).toBeUndefined();
  });

  it('walks up from a directory without package.json', () => {
    expect(scriptFor(repo.root, 'docs/deep', 'test')).toEqual({
      text: 'vitest run',
      packageDir: '',
    });
  });
});

describe('makeCall', () => {
  it('reads -C, flags with values and variable assignments', () => {
    expect(makeCall(['make', '-C', 'sub', '-j', '4', 'test', 'V=1'], '')).toEqual({
      dir: 'sub',
      args: ['-j', '4', 'test', 'V=1'],
      label: 'sub/Makefile:test',
    });
    expect(makeCall(['make'], '')!.label).toBe('Makefile:(default)');
    expect(makeCall(['cmake', '.'], '')).toBeUndefined();
  });
});

describe('precommitTools', () => {
  let repo: TempRepo;
  beforeAll(() => {
    repo = makeRepo({
      '.pre-commit-config.yaml':
        'repos:\n  - repo: local\n    hooks:\n      - id: mypy\n      - id: custom-thing\n      - id: biome-check\n',
    });
  });
  afterAll(() => repo.remove());

  it('maps known hook ids, in order, and one hook on request', () => {
    expect(precommitTools(repo.root)).toEqual(['mypy', 'biome-lint', 'biome-format']);
    expect(precommitTools(repo.root, 'mypy')).toEqual(['mypy']);
  });

  it('returns nothing without a config', () => {
    const empty = makeRepo();
    try {
      expect(precommitTools(empty.root)).toEqual([]);
    } finally {
      empty.remove();
    }
  });
});
