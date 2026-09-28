/** `falsegreen run`, `static` and `local`: find the gates, check them, report. */
import { isAbsolute, join } from 'node:path';

import type { Finding, Severity, Tier } from '../core/types';
import { replayGates, type GateResult, type ProgressEvent } from '../local/replay';
import { installSignalRevert } from '../plant/planter';
import { emitActions } from '../report/github';
import { writeReports, type Format } from '../report/index';
import { buildReport, exitCodeFor, type Report } from '../report/model';
import { renderTerminal } from '../report/terminal';
import { createClient, type GitHubClient } from '../remote/github';
import { resolveToken } from '../remote/token';
import type { Gate } from '../resolve/gates';
import { fetchRequiredChecks, requiredFindings } from '../static/required';
import { staticFindings } from '../static/rules';
import type { WorkflowModel } from '../workflow/model';
import { load, repositorySlug, type IO, type Selection } from './common';

export interface RunOptions extends Selection {
  command: 'run' | 'static' | 'local';
  tiers: Tier[];
  assumeGreen: boolean;
  timeoutMs: number;
  failOn?: Severity;
  out: string;
  formats: Format[];
  quiet: boolean;
  /** Read branch protection and rulesets (needs the origin remote and a token). */
  requiredChecks: 'auto' | 'off';
  /** Branch whose required checks apply; the repository's default branch when unset. */
  branch?: string;
  tokenEnv?: string;
  /** A ready client, used by tests in place of a token. */
  github?: GitHubClient;
}

/** Required-check findings, or nothing when the repository has no GitHub origin. */
async function requiredCheckFindings(
  root: string,
  workflows: WorkflowModel[],
  gates: Gate[],
  opts: RunOptions,
  io: IO,
): Promise<Finding[]> {
  if (opts.requiredChecks === 'off') return [];
  const repo = repositorySlug(root, io.env);
  if (repo === undefined) return [];
  let gh = opts.github;
  if (!gh) {
    const token = resolveToken({
      env: io.env,
      ...(opts.tokenEnv ? { tokenEnv: opts.tokenEnv } : {}),
    });
    if (!token) {
      return [
        {
          rule: 'required-checks-unreadable',
          severity: 'info',
          message:
            'No GitHub token found (GITHUB_TOKEN, FALSEGREEN_TOKEN or gh auth), so required checks were not read.',
        },
      ];
    }
    gh = createClient(token.token);
  }
  try {
    const branch =
      opts.branch ??
      (await gh.request<{ default_branch: string }>('GET', `/repos/${repo}`)).data.default_branch;
    const gateJobs = new Set(gates.map((g) => `${g.workflow}#${g.jobId}`));
    return requiredFindings(
      await fetchRequiredChecks(gh, repo, branch),
      workflows,
      gateJobs,
      branch,
    );
  } catch (err) {
    return [
      {
        rule: 'required-checks-unreadable',
        severity: 'info',
        message: `Could not read required checks for ${repo}: ${err instanceof Error ? err.message : String(err)}.`,
      },
    ];
  }
}

export interface RunOutcome {
  report: Report;
  exitCode: number;
  written: string[];
}

function progress(io: IO, quiet: boolean): (e: ProgressEvent) => void {
  return (e) => {
    if (quiet) return;
    if (e.type === 'baseline') {
      const state =
        e.result.exitCode === 0
          ? 'baseline passed'
          : `baseline exited ${e.result.exitCode ?? 'without a status'}`;
      io.err(`${e.gate.stepName}: ${state} (${(e.result.durationMs / 1000).toFixed(1)}s)\n`);
    } else {
      io.err(
        `${e.gate.stepName}: ${e.run.tier} ${e.run.tool} ${e.run.verdict} (${(e.run.durationMs / 1000).toFixed(1)}s)\n`,
      );
    }
  };
}

export async function runCommand(opts: RunOptions, io: IO): Promise<RunOutcome> {
  const startedAt = new Date();
  const { root, cfg, workflows, gates, emptySteps, errors } = load(opts, io, {
    restore: opts.command !== 'static',
  });
  const found = staticFindings(workflows, gates, emptySteps);
  const required = await requiredCheckFindings(root, workflows, gates, opts, io);

  let results: GateResult[] = [];
  if (opts.command !== 'static') {
    if (!opts.quiet) io.err(`replaying ${gates.length} gates with planted faults\n`);
    const uninstall = installSignalRevert();
    try {
      results = await replayGates(root, gates, cfg, {
        tiers: opts.tiers,
        assumeGreen: opts.assumeGreen,
        timeoutMs: opts.timeoutMs,
        onProgress: progress(io, opts.quiet),
        // The token falsegreen reads the API with never reaches a replayed step.
        ...(opts.tokenEnv ? { stripEnv: [opts.tokenEnv] } : {}),
      });
    } finally {
      uninstall();
    }
  }

  const repository = repositorySlug(root, io.env);
  const report = buildReport({
    root,
    ...(repository === undefined ? {} : { repository }),
    modes: opts.command === 'static' ? ['static'] : ['static', 'local'],
    startedAt,
    gates,
    results,
    staticFindings: found,
    extraFindings: required,
    errors,
    cfg,
    ...(opts.failOn === undefined ? {} : { failOn: opts.failOn }),
  });

  const outDir = isAbsolute(opts.out) ? opts.out : join(root, opts.out);
  const written = writeReports(report, outDir, opts.formats);
  io.out(renderTerminal(report, io.color));
  if (io.env.GITHUB_ACTIONS === 'true') emitActions(report, io.env, (line) => io.out(`${line}\n`));
  return { report, exitCode: exitCodeFor(report.findings, report.failOn), written };
}
