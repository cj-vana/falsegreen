import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  GitError,
  addIntentToAdd,
  currentBranch,
  isModified,
  originSlug,
  repoRoot,
  resetPaths,
  statusPorcelain,
  trackedFiles,
  uncommittedPaths,
} from '../src/core/git';
import { makeRepo, makeTempDir, type TempRepo } from './helpers/repo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.remove();
  repo = undefined;
});

describe('git helpers', () => {
  it('finds the repository root from a subdirectory', () => {
    repo = makeRepo({ 'src/a.ts': 'export {};\n' });
    expect(repoRoot(join(repo.root, 'src'))).toBe(repoRoot(repo.root));
  });

  it('throws GitError outside a work tree', () => {
    // Temp dirs live inside this checkout's tmp/, so stop git's upward search there.
    const dir = makeTempDir('not-a-repo');
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
    try {
      expect(() => repoRoot(dir)).toThrow(GitError);
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = saved;
    }
  });

  it('lists tracked files only, with posix separators', () => {
    repo = makeRepo({ 'src/a.ts': 'x\n', 'README.md': 'y\n' });
    writeFileSync(join(repo.root, 'untracked.txt'), 'z\n');
    expect(trackedFiles(repo.root).sort()).toEqual(['README.md', 'src/a.ts']);
  });

  it('reports a file as modified after an edit and after staging', () => {
    repo = makeRepo({ 'a.txt': 'one\n' });
    expect(isModified(repo.root, 'a.txt')).toBe(false);
    repo.write('a.txt', 'two\n');
    expect(isModified(repo.root, 'a.txt')).toBe(true);
    repo.git('add', 'a.txt');
    expect(isModified(repo.root, 'a.txt')).toBe(true);
  });

  it('adds and removes intent-to-add entries', () => {
    repo = makeRepo({ 'a.txt': 'one\n' });
    repo.write('new.txt', 'planted\n');
    addIntentToAdd(repo.root, ['new.txt']);
    expect(trackedFiles(repo.root)).toContain('new.txt');
    resetPaths(repo.root, ['new.txt']);
    expect(trackedFiles(repo.root)).not.toContain('new.txt');
    expect(statusPorcelain(repo.root, ['new.txt'])).toBe('?? new.txt\n');
  });

  it('reads the current branch and the origin slug', () => {
    repo = makeRepo();
    expect(currentBranch(repo.root)).toBe('main');
    expect(originSlug(repo.root)).toBeUndefined();
    repo.git('remote', 'add', 'origin', 'git@github.com:cj-vana/falsegreen.git');
    expect(originSlug(repo.root)).toBe('cj-vana/falsegreen');
    repo.git('remote', 'set-url', 'origin', 'https://github.com/cj-vana/buttonmash.git');
    expect(originSlug(repo.root)).toBe('cj-vana/buttonmash');
    repo.git('remote', 'set-url', 'origin', 'ssh://git@ghe.example.com/team/app');
    expect(originSlug(repo.root)).toBe('team/app');
  });

  it('lists every path with uncommitted work, and nothing deleted or ignored', () => {
    repo = makeRepo({
      'edited.txt': 'a\n',
      'moved.txt': 'b\n',
      'gone.txt': 'c\n',
      '.gitignore': 'ignored.log\n',
    });
    repo.write('edited.txt', 'a2\n');
    repo.git('mv', 'moved.txt', 'renamed.txt');
    repo.git('rm', '-q', 'gone.txt');
    repo.write('new/untracked.txt', 'd\n');
    repo.write('staged.txt', 'e\n');
    repo.git('add', 'staged.txt');
    repo.write('ignored.log', 'f\n');
    expect(uncommittedPaths(repo.root).sort()).toEqual([
      'edited.txt',
      'new/untracked.txt',
      'renamed.txt',
      'staged.txt',
    ]);
  });

  it('has no slug when origin is a local clone', () => {
    repo = makeRepo();
    repo.git('remote', 'add', 'origin', 'https://github.com/o/r.git');
    for (const url of ['/Users/me/Documents/GitHub/chaos', '../chaos', 'file:///srv/git/app.git']) {
      repo.git('remote', 'set-url', 'origin', url);
      expect(originSlug(repo.root), url).toBeUndefined();
    }
  });
});
