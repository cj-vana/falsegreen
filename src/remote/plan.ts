/**
 * Which workflows a remote run starts, and how. Printed before anything is written, and refused
 * outright when the push, or the draft pull request with --pr, would start a workflow that deploys
 * or publishes. Every workflow the run starts is listed, whether it has gates or not.
 */
import { posix } from 'node:path';

import type { Tier } from '../core/types';
import type { Gate } from '../resolve/gates';
import { releaseContext } from '../resolve/safety';
import type { WorkflowModel } from '../workflow/model';
import { pushStarts } from '../workflow/triggers';
import type { TokenKind } from './token';

export interface RemotePlanEntry {
  workflow: string;
  start: 'push' | 'dispatch' | 'pr' | 'skip';
  reason: string;
  /** false for a workflow the push or pull request starts that has no gates to judge. */
  judged?: false;
}

export interface RemotePlan {
  repo: string;
  baseSha: string;
  tokenKind: TokenKind;
  branches: Record<Tier, string>;
  entries: RemotePlanEntry[];
  /** Why the run must not start at all; nothing is written when set. */
  refused?: string;
}

/** Actions that deploy, publish, release or copy to a server. */
const DEPLOY_ACTION =
  /deploy|publish|release|pages|build-push|ssh-action|scp-action|wrangler|changesets\/action/i;

/**
 * Why a workflow deploys or publishes; undefined when nothing says so. `unsafeRuns` holds the
 * first publishing or repository-rewriting command in each job, found by walking its scripts.
 */
export function unsafeReason(
  wf: WorkflowModel,
  unsafeRuns: Map<string, string> = new Map(),
): string | undefined {
  for (const job of wf.jobs) {
    // Names, environments and tag-only triggers; a step named "Deploy" counts too.
    const named = [undefined, ...job.steps]
      .map((step) => releaseContext(wf, job, step))
      .find((r) => r !== undefined);
    if (named !== undefined) return named;
    if (job.usesWorkflow !== undefined) {
      return `job ${job.id} calls ${job.usesWorkflow}, which falsegreen does not inspect`;
    }
    for (const step of job.steps) {
      if (step.uses !== undefined && DEPLOY_ACTION.test(step.uses.split('@')[0]!)) {
        return `job ${job.id} uses ${step.uses}`;
      }
    }
    const run = unsafeRuns.get(`${wf.file}#${job.id}`);
    if (run !== undefined) return `job ${job.id} runs ${run}`;
  }
  return undefined;
}

export function planRemote(
  workflows: WorkflowModel[],
  gates: Gate[],
  opts: {
    tokenKind: TokenKind;
    allow: string[];
    pr: boolean;
    branches: Record<Tier, string>;
    changedPaths: string[];
    unsafeRuns?: Map<string, string>;
  },
): Pick<RemotePlan, 'entries' | 'refused'> {
  const allowed = (wf: WorkflowModel): boolean =>
    opts.allow.includes(posix.basename(wf.file)) || opts.allow.includes(wf.file);
  const unsafe = (wf: WorkflowModel): string | undefined =>
    allowed(wf) ? undefined : unsafeReason(wf, opts.unsafeRuns);
  const pushWorks = opts.tokenKind !== 'github-token';
  const branch = opts.branches.reach;

  // What the run sets off whether falsegreen wants it or not: pushing a branch (and creating it)
  // starts push and create workflows, and a draft pull request starts pull_request ones.
  const byPush = (wf: WorkflowModel): boolean =>
    pushWorks &&
    (pushStarts(wf, branch, opts.changedPaths) ||
      wf.triggers.other.includes('create') ||
      wf.triggers.other.includes('delete'));
  const byPr = (wf: WorkflowModel): boolean =>
    pushWorks &&
    opts.pr &&
    (wf.triggers.pullRequest !== undefined || wf.triggers.pullRequestTarget !== undefined);
  const gated = new Set(gates.map((g) => g.workflow));
  const opensPr = workflows.some((wf) => gated.has(wf.file) && byPr(wf) && !byPush(wf));

  for (const wf of workflows) {
    const reason = unsafe(wf);
    if (reason === undefined) continue;
    const how = byPush(wf)
      ? 'pushing the branch'
      : opensPr && byPr(wf)
        ? 'opening the pull request'
        : undefined;
    if (how !== undefined) {
      return {
        entries: [],
        refused: `${how} would start ${wf.file}, where ${reason}; add ${posix.basename(wf.file)} to remote.allow in falsegreen.config.yml to run it anyway`,
      };
    }
  }

  const entries: RemotePlanEntry[] = [];
  for (const wf of workflows) {
    const entry = (start: RemotePlanEntry['start'], reason: string): void => {
      entries.push({ workflow: wf.file, start, reason });
    };
    if (!gated.has(wf.file)) {
      const how = byPush(wf) ? 'push' : opensPr && byPr(wf) ? 'pr' : undefined;
      if (how !== undefined) {
        entries.push({
          workflow: wf.file,
          start: how,
          reason: `${how === 'push' ? 'pushing the branch' : 'the pull request'} starts it too; it has no gates to judge`,
          judged: false,
        });
      }
      continue;
    }
    const reason = unsafe(wf);
    if (byPush(wf)) {
      entry('push', 'pushing the branch starts it');
    } else if (reason !== undefined) {
      entry('skip', `not started: ${reason}; add it to remote.allow to run it`);
    } else if (wf.triggers.workflowDispatch) {
      entry('dispatch', 'dispatched on the branch');
    } else if (wf.triggers.pullRequest || wf.triggers.pullRequestTarget) {
      if (!pushWorks) {
        entry(
          'skip',
          'pull requests opened with the workflow token wait for approval; use a personal access token or a GitHub App token',
        );
      } else if (!opts.pr) {
        entry('skip', 'it runs only on pull_request; pass --pr to open a draft pull request');
      } else {
        entry('pr', 'a draft pull request starts it');
      }
    } else if (!pushWorks && wf.triggers.push) {
      entry(
        'skip',
        'pushes made with the workflow token start no runs; add workflow_dispatch to it or use another token',
      );
    } else {
      entry('skip', 'no trigger falsegreen can use (push, workflow_dispatch or pull_request)');
    }
  }
  return { entries };
}
