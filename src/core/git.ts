/** The few git operations falsegreen needs, run through the git executable. */
import { execFileSync } from 'node:child_process';

export class GitError extends Error {}

const MAX_BUFFER = 256 * 1024 * 1024;

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr?.trim();
    throw new GitError(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`);
  }
}

export function repoRoot(cwd: string): string {
  return git(cwd, ['rev-parse', '--show-toplevel']).trim();
}

/** The repository's git directory (a file path inside worktrees resolves to the real one). */
export function gitDir(root: string): string {
  return git(root, ['rev-parse', '--absolute-git-dir']).trim();
}

export function hasHead(root: string): boolean {
  try {
    git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export function headSha(root: string): string {
  return git(root, ['rev-parse', 'HEAD']).trim();
}

/** Tracked paths (index entries, including intent-to-add ones), repo-relative with `/`. */
export function trackedFiles(root: string): string[] {
  return git(root, ['ls-files', '-z'])
    .split('\0')
    .filter((p) => p !== '');
}

export function statusPorcelain(root: string, paths?: string[]): string {
  const args = ['status', '--porcelain=v1', '--untracked-files=all'];
  if (paths) {
    if (paths.length === 0) return '';
    args.push('--', ...paths);
  }
  return git(root, args);
}

/** True when the file differs from HEAD, staged or not. */
export function isModified(root: string, path: string): boolean {
  try {
    git(root, ['diff', '--quiet', 'HEAD', '--', path]);
    return false;
  } catch {
    return true;
  }
}

export function addIntentToAdd(root: string, paths: string[]): void {
  if (paths.length > 0) git(root, ['add', '--intent-to-add', '--', ...paths]);
}

export function resetPaths(root: string, paths: string[]): void {
  if (paths.length > 0) git(root, ['reset', '-q', '--', ...paths]);
}

export function currentBranch(root: string): string | undefined {
  try {
    return git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** `owner/name` from the origin remote, for ssh and https URLs on any host. */
export function originSlug(root: string): string | undefined {
  let url: string;
  try {
    url = git(root, ['remote', 'get-url', 'origin']).trim();
  } catch {
    return undefined;
  }
  const match = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : undefined;
}
