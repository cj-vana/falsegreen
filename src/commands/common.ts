/** What every command needs: the repository, its config and workflows, and the gates in them. */
import type { ResolvedConfig } from '../config/load';
import { loadConfig } from '../config/load';
import { GitError, repoRoot } from '../core/git';
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

/** Restores a tree left behind by an interrupted run before anything else happens. */
export function recover(root: string, io: IO): void {
  const restored = recoverJournal(root);
  if (restored)
    io.err(`restored files left by an interrupted falsegreen run: ${restored.join(', ')}\n`);
}

export function load(sel: Selection, io: IO): Loaded {
  const root = findRoot(sel.cwd);
  recover(root, io);
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
