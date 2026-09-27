/**
 * Required checks: a gate that goes red only matters if a red run blocks the merge. Reads classic
 * branch protection and rulesets (both readable with repository read access) and compares the
 * required check names with the check runs the workflows' jobs produce.
 */
import type { Finding } from '../core/types';
import { GitHubError, type GitHubClient } from '../remote/github';
import { checkName } from '../workflow/checks';
import { expandMatrix } from '../workflow/matrix';
import type { WorkflowModel } from '../workflow/model';

/** The GitHub Actions app, as returned by GET /apps/github-actions (2026-09-27). */
export const ACTIONS_APP_ID = 15368;

export interface RequiredContext {
  name: string;
  /** The app that must report the check; absent when any source is accepted. */
  appId?: number;
}

export interface RequiredChecks {
  readable: boolean;
  contexts: RequiredContext[];
  reason?: string;
}

interface Branch {
  protection?: {
    required_status_checks?: {
      checks?: { context: string; app_id: number | null }[];
      contexts?: string[];
    };
  };
}

interface Rule {
  type: string;
  parameters?: { required_status_checks?: { context: string; integration_id?: number | null }[] };
}

export async function fetchRequiredChecks(
  gh: GitHubClient,
  repo: string,
  branch: string,
): Promise<RequiredChecks> {
  const contexts: RequiredContext[] = [];
  const add = (name: string, appId: number | null | undefined): void => {
    if (contexts.some((c) => c.name === name)) return;
    contexts.push(appId === null || appId === undefined ? { name } : { name, appId });
  };
  try {
    const { data } = await gh.request<Branch>(
      'GET',
      `/repos/${repo}/branches/${encodeURIComponent(branch)}`,
    );
    const required = data.protection?.required_status_checks;
    if (required?.checks && required.checks.length > 0) {
      for (const c of required.checks) add(c.context, c.app_id);
    } else {
      for (const name of required?.contexts ?? []) add(name, undefined);
    }
    const { data: rules } = await gh.request<Rule[]>(
      'GET',
      `/repos/${repo}/rules/branches/${encodeURIComponent(branch)}`,
    );
    for (const rule of rules.filter((r) => r.type === 'required_status_checks')) {
      for (const c of rule.parameters?.required_status_checks ?? [])
        add(c.context, c.integration_id);
    }
  } catch (err) {
    if (err instanceof GitHubError)
      return { readable: false, contexts: [], reason: `HTTP ${err.status}` };
    throw err;
  }
  return { readable: true, contexts };
}

/**
 * Findings for one branch. `gateJobs` holds the ids of jobs that contain gates, as `jobId` or
 * `workflowFile#jobId`.
 */
export function requiredFindings(
  req: RequiredChecks,
  workflows: WorkflowModel[],
  gateJobs: Set<string>,
  branch: string,
): Finding[] {
  if (!req.readable) {
    return [
      {
        rule: 'required-checks-unreadable',
        severity: 'info',
        message: `Could not read the required checks for ${branch} (${req.reason ?? 'unknown error'}); the required-check rules were skipped.`,
      },
    ];
  }
  if (req.contexts.length === 0) {
    return [
      {
        rule: 'no-required-checks',
        severity: 'medium',
        message: `Nothing has to pass before merging into ${branch}, so no red check blocks a merge.`,
        hint: 'Require the gate jobs in branch protection or a ruleset.',
      },
    ];
  }

  const required = new Set(req.contexts.map((c) => c.name));
  const findings: Finding[] = [];
  const produced = new Set<string>();
  for (const wf of workflows) {
    for (const job of wf.jobs) {
      const names = expandMatrix(job.matrix).map((combo) => checkName(job, combo));
      for (const n of names) produced.add(n);
      if (!gateJobs.has(job.id) && !gateJobs.has(`${wf.file}#${job.id}`)) continue;
      const missing = names.filter((n) => !required.has(n));
      if (missing.length === 0) continue;
      const list = missing.map((n) => `\`${n}\``).join(', ');
      findings.push({
        rule: 'not-required',
        severity: 'medium',
        message: `${list} ${missing.length === 1 ? 'is not a required check' : 'are not required checks'} on ${branch}, so a red run does not block merging.`,
        location: job.loc,
        workflow: wf.file,
        job: job.id,
      });
    }
  }

  // Reusable workflows report as "caller / callee"; those names cannot be checked from here.
  const calls = workflows.some((wf) => wf.jobs.some((j) => j.usesWorkflow !== undefined));
  for (const c of req.contexts) {
    if (c.appId !== ACTIONS_APP_ID || produced.has(c.name)) continue;
    if (calls && c.name.includes(' / ')) continue;
    findings.push({
      rule: 'required-check-missing',
      severity: 'medium',
      message: `The required check \`${c.name}\` comes from GitHub Actions, but no job in these workflows reports that name; pull requests wait for it, unless another repository's workflow reports it.`,
    });
  }
  return findings;
}
