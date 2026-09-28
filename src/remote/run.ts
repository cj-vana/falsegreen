/**
 * Remote mode: every fault of a tier goes into one commit on a throwaway branch, the workflows run
 * on GitHub, and each job that holds gates must end red. A job stops at its first failing step, so
 * remote results are per job; local mode judges steps.
 *
 * Recorded against cj-vana/falsegreen-fixture (2026-09-27): a job's conclusion decides the verdict,
 * not its log. The dead `node --test || true` job printed the planted test's name like the real
 * one did, and concluded success.
 */
import type { Loaded } from '../commands/common';
import { FalsegreenError, type IO } from '../commands/common';
import { headSha, trackedFiles } from '../core/git';
import { newMarker, outputMentions, type Marker } from '../core/marker';
import { TIERS, type Finding, type Tier, type Verdict } from '../core/types';
import { toolDef } from '../faults/registry';
import type { Fault } from '../faults/types';
import { faultContext } from '../local/replay';
import { unsafeSteps } from '../resolve/gates';
import { ACTIONS_APP_ID, type RequiredChecks } from '../static/required';
import { checkName } from '../workflow/checks';
import { expandMatrix } from '../workflow/matrix';
import type { WorkflowModel } from '../workflow/model';
import { createFaultCommit, mergeFaults } from './commit';
import { GitHubError, type GitHubClient } from './github';
import { planRemote, type RemotePlan } from './plan';
import type { TokenKind } from './token';

export interface RemoteOptions {
  yes: boolean;
  pr: boolean;
  deleteRuns: boolean;
  keepBranch: boolean;
  timeoutMs: number;
  pollMs: number;
  tokenKind: TokenKind;
  /** Part of the branch names; a timestamp when unset. */
  runId?: string;
}

export interface RemoteJobResult {
  workflow: string;
  job: string;
  tier: Tier;
  runId?: number;
  runUrl?: string;
  conclusion: string | null;
  verdict: Verdict | 'skipped';
  reason?: string;
}

export interface RemoteResult {
  plan: RemotePlan;
  /** False when nothing was written: the plan was refused, or --yes was not given. */
  ran: boolean;
  jobs: RemoteJobResult[];
  notes: string[];
}

interface Run {
  id: number;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
}

interface Job {
  id: number;
  name: string;
  conclusion: string | null;
}

const EVENT = { push: 'push', dispatch: 'workflow_dispatch', pr: 'pull_request' } as const;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One fault per tier for every distinct tool invocation, each with its own marker. */
function buildFaults(
  loaded: Loaded,
  tier: Tier,
  notes: string[],
): { faults: Fault[]; markers: Marker[] } {
  const tracked = trackedFiles(loaded.root);
  const seen = new Set<string>();
  const faults: Fault[] = [];
  for (const inv of loaded.gates.flatMap((g) => g.invocations)) {
    const key = `${inv.tool}|${inv.cwd}|${inv.pathArgs.join(',')}|${inv.project ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const def = toolDef(inv.tool);
    if (!def || (def.tiers && !def.tiers.includes(tier))) continue;
    const fault = def.faults(
      faultContext(loaded.root, tracked, inv, newMarker(), loaded.cfg),
      tier,
    );
    if ('skip' in fault) notes.push(`${inv.tool} ${tier}: ${fault.skip}`);
    else faults.push(fault);
  }
  return { faults, markers: faults.map((f) => f.marker) };
}

/** Check names of the jobs in a workflow that hold gates, for matching jobs in a run. */
function gateJobNames(loaded: Loaded, wf: WorkflowModel): Set<string> {
  const ids = new Set(loaded.gates.filter((g) => g.workflow === wf.file).map((g) => g.jobId));
  const names = new Set<string>();
  for (const job of wf.jobs.filter((j) => ids.has(j.id))) {
    for (const combo of expandMatrix(job.matrix)) names.add(checkName(job, combo));
  }
  return names;
}

export async function runRemote(
  loaded: Loaded,
  gh: GitHubClient,
  repo: string,
  opts: RemoteOptions,
  io: IO,
): Promise<RemoteResult> {
  const runId = opts.runId ?? Date.now().toString(36);
  const branches: Record<Tier, string> = {
    reach: `falsegreen/${runId}-reach`,
    semantic: `falsegreen/${runId}-semantic`,
  };
  const notes: string[] = [];
  const perTier = new Map(TIERS.map((t) => [t, buildFaults(loaded, t, notes)]));
  const baseSha = headSha(loaded.root);
  const changed = [...perTier.values()].flatMap((p) =>
    p.faults.flatMap((f) => [...f.files.map((x) => x.path), ...f.appends.map((a) => a.path)]),
  );
  const planned = planRemote(loaded.workflows, loaded.gates, {
    tokenKind: opts.tokenKind,
    allow: loaded.cfg.remote.allow,
    pr: opts.pr,
    branches,
    changedPaths: changed,
    unsafeRuns: unsafeSteps(loaded.root, loaded.workflows),
  });
  const plan: RemotePlan = { repo, baseSha, tokenKind: opts.tokenKind, branches, ...planned };
  const result: RemoteResult = { plan, ran: false, jobs: [], notes };
  if (plan.refused || !opts.yes) return result;

  // Workflows without gates start anyway; they are listed and cleaned up, but not waited for.
  const active = plan.entries.filter((e) => e.start !== 'skip' && e.judged !== false);
  if (active.length === 0) {
    notes.push('no workflow can be started; nothing was run');
    return result;
  }

  try {
    await gh.request('GET', `/repos/${repo}/commits/${baseSha}`);
  } catch (err) {
    if (err instanceof GitHubError && (err.status === 404 || err.status === 422)) {
      throw new FalsegreenError(
        `commit ${baseSha.slice(0, 7)} is not on ${repo}; push it before running remote mode`,
      );
    }
    throw err;
  }

  const created: string[] = [];
  const started = new Map<string, Run>();
  const pulls = new Map<Tier, number>();
  const shas = new Map<Tier, string>();
  result.ran = true;
  let failure: unknown;
  try {
    for (const tier of TIERS) {
      const { files, dropped } = mergeFaults(loaded.root, baseSha, perTier.get(tier)!.faults);
      notes.push(...dropped);
      const sha = await createFaultCommit(
        gh,
        repo,
        baseSha,
        files,
        `falsegreen: planted ${tier} faults`,
      );
      shas.set(tier, sha);
      await gh.request('POST', `/repos/${repo}/git/refs`, {
        ref: `refs/heads/${branches[tier]}`,
        sha,
      });
      created.push(branches[tier]);
      io.err(`pushed ${branches[tier]}\n`);
      for (const entry of active) {
        if (entry.start === 'dispatch') {
          const file = entry.workflow.split('/').at(-1)!;
          const { data } = await gh.request<{ workflow_run_id?: number }>(
            'POST',
            `/repos/${repo}/actions/workflows/${file}/dispatches`,
            { ref: branches[tier] },
          );
          if (data?.workflow_run_id !== undefined) {
            started.set(`${tier}|${entry.workflow}`, {
              id: data.workflow_run_id,
              path: entry.workflow,
              event: EVENT.dispatch,
              status: 'queued',
              conclusion: null,
              html_url: '',
            });
          }
        } else if (entry.start === 'pr' && !pulls.has(tier)) {
          // One pull request per branch starts every pull_request workflow at once.
          const { data } = await gh.request<{ number: number }>('POST', `/repos/${repo}/pulls`, {
            title: `falsegreen: planted ${tier} faults (closed automatically)`,
            head: branches[tier],
            base: (await gh.request<{ default_branch: string }>('GET', `/repos/${repo}`)).data
              .default_branch,
            body: 'Opened by falsegreen remote mode to run pull_request workflows with planted faults.',
            draft: true,
          });
          pulls.set(tier, data.number);
        }
      }
    }

    // Wait until every started workflow has a completed run on each branch, or time runs out.
    const deadline = Date.now() + opts.timeoutMs;
    const key = (tier: Tier, wf: string): string => `${tier}|${wf}`;
    for (;;) {
      for (const tier of TIERS) {
        const { data } = await gh.request<{ workflow_runs: Run[] }>(
          'GET',
          `/repos/${repo}/actions/runs?head_sha=${shas.get(tier)}&per_page=100`,
        );
        for (const entry of active) {
          const match = data.workflow_runs.find(
            (r) =>
              r.path === entry.workflow && r.event === EVENT[entry.start as keyof typeof EVENT],
          );
          if (match) started.set(key(tier, entry.workflow), match);
        }
      }
      const done = TIERS.every((t) =>
        active.every((e) => started.get(key(t, e.workflow))?.status === 'completed'),
      );
      if (done || Date.now() >= deadline) break;
      await sleep(opts.pollMs);
    }

    for (const tier of TIERS) {
      const markers = perTier.get(tier)!.markers;
      for (const entry of active) {
        const wf = loaded.workflows.find((w) => w.file === entry.workflow)!;
        const names = [...gateJobNames(loaded, wf)];
        const run = started.get(key(tier, entry.workflow));
        if (!run || run.status !== 'completed') {
          for (const job of names) {
            result.jobs.push({
              workflow: wf.file,
              job,
              tier,
              conclusion: null,
              verdict: 'unjudged',
              reason: run ? 'the run did not finish in time and was cancelled' : 'no run started',
              ...(run ? { runId: run.id, runUrl: run.html_url } : {}),
            });
          }
          continue;
        }
        const { data } = await gh.request<{ jobs: Job[] }>(
          'GET',
          `/repos/${repo}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`,
        );
        for (const job of data.jobs.filter((j) => names.includes(j.name))) {
          let verdict: RemoteJobResult['verdict'];
          if (job.conclusion === 'success') verdict = 'survived';
          else if (job.conclusion === 'skipped') verdict = 'skipped';
          else if (job.conclusion === 'failure') {
            const { data: log } = await gh.request<string>(
              'GET',
              `/repos/${repo}/actions/jobs/${job.id}/logs`,
            );
            verdict = markers.some((m) => outputMentions(String(log), m))
              ? 'caught'
              : 'unattributed';
          } else verdict = 'unjudged';
          result.jobs.push({
            workflow: wf.file,
            job: job.name,
            tier,
            runId: run.id,
            runUrl: run.html_url,
            conclusion: job.conclusion,
            verdict,
          });
        }
      }
    }
  } catch (err) {
    failure = err;
  } finally {
    notes.push(
      ...(await cleanup(gh, repo, [...started.values()], [...pulls.values()], created, opts)),
    );
  }
  if (failure !== undefined) throw failure;
  return result;
}

/** Cancels unfinished runs, closes pull requests, deletes and verifies the branches. */
async function cleanup(
  gh: GitHubClient,
  repo: string,
  runs: Run[],
  pulls: number[],
  branches: string[],
  opts: RemoteOptions,
): Promise<string[]> {
  const notes: string[] = [];
  for (const run of runs.filter((r) => r.status !== 'completed')) {
    try {
      await gh.request('POST', `/repos/${repo}/actions/runs/${run.id}/cancel`);
    } catch (err) {
      notes.push(`could not cancel run ${run.id}: ${(err as Error).message}`);
    }
  }
  for (const number of pulls) {
    await gh.request('PATCH', `/repos/${repo}/pulls/${number}`, { state: 'closed' });
  }
  if (opts.keepBranch) {
    notes.push(`kept ${branches.join(' and ')} (--keep-branch); delete them when you are done`);
  } else {
    for (const branch of branches) {
      await gh.request('DELETE', `/repos/${repo}/git/refs/heads/${branch}`);
      try {
        await gh.request('GET', `/repos/${repo}/git/ref/heads/${branch}`);
        throw new FalsegreenError(
          `${branch} still exists on ${repo} after deleting it; delete it by hand`,
        );
      } catch (err) {
        if (!(err instanceof GitHubError && err.status === 404)) throw err;
      }
    }
  }
  if (opts.deleteRuns) {
    for (const run of runs) {
      try {
        await gh.request('DELETE', `/repos/${repo}/actions/runs/${run.id}`);
      } catch (err) {
        notes.push(`could not delete run ${run.id}: ${(err as Error).message}`);
      }
    }
  }
  return notes;
}

/** Findings from a remote run: jobs that stayed green, were skipped, or could not be judged. */
export function remoteFindings(
  result: RemoteResult,
  workflows: WorkflowModel[],
  required?: RequiredChecks,
): Finding[] {
  const findings: Finding[] = [];
  const jobs = new Map<string, RemoteJobResult[]>();
  for (const j of result.jobs)
    jobs.set(`${j.workflow}#${j.job}`, [...(jobs.get(`${j.workflow}#${j.job}`) ?? []), j]);
  const requiredNames = new Set(
    (required?.contexts ?? [])
      .filter((c) => c.appId === undefined || c.appId === ACTIONS_APP_ID)
      .map((c) => c.name),
  );

  for (const results of jobs.values()) {
    const { workflow, job } = results[0]!;
    const wf = workflows.find((w) => w.file === workflow);
    const model = wf?.jobs.find(
      (j) =>
        j.id === job ||
        j.name === job ||
        expandMatrix(j.matrix).some((c) => checkName(j, c) === job),
    );
    const where = { workflow, job: model?.id ?? job, ...(model ? { location: model.loc } : {}) };
    const tier = (t: Tier) => results.find((r) => r.tier === t);
    const reach = tier('reach');
    const semantic = tier('semantic');
    const url = reach?.runUrl ?? semantic?.runUrl;
    const at = url ? ` (${url})` : '';
    if (reach?.verdict === 'survived') {
      findings.push({
        rule: 'dead-gate',
        severity: 'high',
        message: `Job \`${job}\` stayed green on the throwaway branch with files planted that no parser accepts${at}.`,
        ...where,
      });
    } else if (semantic?.verdict === 'survived') {
      findings.push(
        reach?.verdict === 'caught'
          ? {
              rule: 'weak-gate',
              severity: 'medium',
              message: `Job \`${job}\` fails on files that do not parse, but stayed green with real problems planted${at}.`,
              ...where,
            }
          : {
              rule: 'weak-gate',
              severity: 'high',
              message: `Job \`${job}\` stayed green with real problems planted, and its reach run was not judged, so it may not check those files at all${at}.`,
              ...where,
            },
      );
    }
    if (results.some((r) => r.verdict === 'survived') && requiredNames.has(job)) {
      findings.push({
        rule: 'required-gate-passed',
        severity: 'high',
        message: `\`${job}\` is a required check and passed with planted faults, so a pull request with the same problems can merge.`,
        ...where,
      });
    }
    if (results.some((r) => r.verdict === 'skipped')) {
      findings.push({
        rule: 'skipped-job',
        severity: 'medium',
        message: `Job \`${job}\` was skipped on the throwaway branch (its if: condition or a job it needs), so its checks never ran${at}.`,
        ...where,
      });
    }
    for (const r of results.filter(
      (x) => x.verdict === 'unattributed' || x.verdict === 'unjudged',
    )) {
      findings.push(
        r.verdict === 'unattributed'
          ? {
              rule: 'unattributed',
              severity: 'low',
              message: `Job \`${job}\` failed with the ${r.tier} faults planted, but its log never named a planted file${at}.`,
              ...where,
            }
          : {
              rule: 'unjudged',
              severity: 'info',
              message: `Job \`${job}\` was not judged for the ${r.tier} faults: ${r.reason ?? 'no conclusion'}.`,
              ...where,
            },
      );
    }
  }
  return findings;
}
