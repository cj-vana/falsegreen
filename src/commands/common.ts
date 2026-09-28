/** What every command needs: the repository, its config and workflows, and the gates in them. */
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

import type { ResolvedConfig } from '../config/load';
import { loadConfig } from '../config/load';
import { GitError, originSlug, repoRoot } from '../core/git';
import { journalPath } from '../plant/journal';
import { recoverJournal } from '../plant/planter';
import { resolveAll, type EmptyStep, type Gate } from '../resolve/gates';
import type { WorkflowModel } from '../workflow/model';
import { loadWorkflows } from '../workflow/parse';

export class FalsegreenError extends Error {}

export interface IO {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  color: boolean;
}

export interface Selection {
  cwd: string;
  config?: string;
  workflows?: string[];
  jobs?: string[];
  steps?: string[];
  matrix: 'first' | 'all';
}

export interface Loaded {
  root: string;
  cfg: ResolvedConfig;
  workflows: WorkflowModel[];
  gates: Gate[];
  emptySteps: EmptyStep[];
  errors: string[];
}

export function findRoot(cwd: string): string {
  try {
    return repoRoot(cwd);
  } catch (err) {
    if (err instanceof GitError) {
      throw new FalsegreenError(
        `${cwd} is not inside a git repository; falsegreen needs one to restore every file it plants`,
      );
    }
    throw err;
  }
}

function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/**
 * The repository's `owner/name`: its origin remote, else GITHUB_REPOSITORY. Inside a workflow the
 * fallback holds only for the checkout the workflow runs in, because `falsegreen -C other/repo`
 * there analyzes a repository whose rules are not GITHUB_REPOSITORY's.
 */
export function repositorySlug(root: string, env: NodeJS.ProcessEnv): string | undefined {
  const origin = originSlug(root);
  if (origin !== undefined || env.GITHUB_REPOSITORY === undefined) return origin;
  const workspace = env.GITHUB_WORKSPACE;
  if (workspace !== undefined && realDir(workspace) !== realDir(root)) return undefined;
  return env.GITHUB_REPOSITORY;
}

/** Restores a tree left behind by an interrupted run before anything else happens. */
export function recover(root: string, io: IO): void {
  const restored = recoverJournal(root);
  if (restored)
    io.err(`restored files left by an interrupted falsegreen run: ${restored.join(', ')}\n`);
}

/**
 * `restore: false` is for commands that plant nothing (list, static): a journal they find may
 * belong to a run that is planting right now, so they only say it is there.
 */
export function load(sel: Selection, io: IO, opts: { restore?: boolean } = {}): Loaded {
  const root = findRoot(sel.cwd);
  if (opts.restore === false) {
    if (existsSync(journalPath(root))) {
      io.err(
        'a falsegreen run is planting faults in this repository, or one was interrupted: its files may still be in the tree. Once it has stopped, run `falsegreen clean`.\n',
      );
    }
  } else {
    recover(root, io);
  }
  const cfg = loadConfig(root, sel.config);
  const workflows = loadWorkflows(root, sel.workflows);
  if (workflows.length === 0)
    throw new FalsegreenError('no workflow files found in .github/workflows');
  const { gates, emptySteps } = resolveAll(root, workflows, cfg, { matrix: sel.matrix });
  const matches = (list: string[] | undefined, ...names: string[]): boolean =>
    !list || list.length === 0 || names.some((n) => list.includes(n));
  return {
    root,
    cfg,
    workflows,
    gates: gates.filter(
      (g) => matches(sel.jobs, g.jobId, g.jobName, g.checkName) && matches(sel.steps, g.stepName),
    ),
    emptySteps,
    errors: workflows.flatMap((w) => w.errors),
  };
}
