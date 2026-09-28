/**
 * Which workflows a remote run starts, and how. Printed before anything is written, and refused
 * outright when pushing the throwaway branch would start a workflow that deploys or publishes.
 */
import { posix } from 'node:path';

import type { Tier } from '../core/types';
import { unsafeCommand, type Gate } from '../resolve/gates';
import { allCommands, parseShell, words } from '../shell/parse';
import type { WorkflowModel } from '../workflow/model';
import { pushStarts } from '../workflow/triggers';
import type { TokenKind } from './token';

export interface RemotePlanEntry {
  workflow: string;
  start: 'push' | 'dispatch' | 'pr' | 'skip';
  reason: string;
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

const DEPLOY_ACTION = /deploy|publish|release/i;

/** Why a workflow looks like it deploys or publishes; undefined when it does not. */
export function unsafeReason(wf: WorkflowModel): string | undefined {
  for (const job of wf.jobs) {
    if (job.environment !== undefined) return `job ${job.id} uses environment ${job.environment}`;
    for (const step of job.steps) {
      if (step.uses !== undefined && DEPLOY_ACTION.test(step.uses.split('@')[0]!)) {
        return `job ${job.id} uses ${step.uses}`;
      }
      if (step.run === undefined) continue;
      for (const cmd of allCommands(parseShell(step.run))) {
        const unsafe = unsafeCommand(words(cmd));
        if (unsafe) return `job ${job.id} runs ${unsafe}`;
      }
    }
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
  },
): Pick<RemotePlan, 'entries' | 'refused'> {
  const allowed = (wf: WorkflowModel): boolean =>
    opts.allow.includes(posix.basename(wf.file)) || opts.allow.includes(wf.file);
  const pushWorks = opts.tokenKind !== 'github-token';
  const branch = opts.branches.reach;

  // A push starts every matching workflow, gates or not, so check them all before pushing.
  if (pushWorks) {
    for (const wf of workflows) {
      const unsafe = unsafeReason(wf);
      if (unsafe && !allowed(wf) && pushStarts(wf, branch, opts.changedPaths)) {
        return {
          entries: [],
          refused: `pushing the branch would start ${wf.file}, where ${unsafe}; add ${posix.basename(wf.file)} to remote.allow in falsegreen.config.yml to run it anyway`,
        };
      }
    }
  }

  const gated = new Set(gates.map((g) => g.workflow));
  const entries: RemotePlanEntry[] = [];
  for (const wf of workflows.filter((w) => gated.has(w.file))) {
    const unsafe = allowed(wf) ? undefined : unsafeReason(wf);
    const entry = (start: RemotePlanEntry['start'], reason: string): void => {
      entries.push({ workflow: wf.file, start, reason });
    };
    if (pushWorks && pushStarts(wf, branch, opts.changedPaths)) {
      entry('push', 'pushing the branch starts it');
    } else if (unsafe) {
      entry('skip', `not started: ${unsafe}; add it to remote.allow to run it`);
    } else if (wf.triggers.workflowDispatch) {
      entry('dispatch', 'dispatched on the branch');
    } else if (wf.triggers.pullRequest) {
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
