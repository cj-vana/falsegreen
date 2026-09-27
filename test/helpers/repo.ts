/** Throwaway git repositories for tests, created under TMPDIR (the checkout's tmp/). */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempRepo {
  root: string;
  git(...args: string[]): string;
  write(path: string, content: string): void;
  commitAll(message?: string): void;
  remove(): void;
}

export function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

export function makeRepo(files: Record<string, string> = {}): TempRepo {
  const root = makeTempDir('repo');
  const git = (...args: string[]): string =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'falsegreen-test',
        GIT_AUTHOR_EMAIL: 'test@falsegreen.invalid',
        GIT_COMMITTER_NAME: 'falsegreen-test',
        GIT_COMMITTER_EMAIL: 'test@falsegreen.invalid',
      },
    });
  const write = (path: string, content: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  git('init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) write(path, content);
  const commitAll = (message = 'commit'): void => {
    git('add', '-A');
    git('commit', '-q', '--allow-empty', '-m', message);
  };
  commitAll('init');
  return {
    root,
    git,
    write,
    commitAll,
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}
