/** `falsegreen remote`: run the real workflows on throwaway branches with planted faults. */
import { isAbsolute, join } from 'node:path';

import { originSlug } from '../core/git';
import type { Severity } from '../core/types';
import { createClient, type GitHubClient } from '../remote/github';
import { remoteFindings, runRemote } from '../remote/run';
import { resolveToken, type TokenKind } from '../remote/token';
import { emitActions } from '../report/github';
import { writeReports, type Format } from '../report/index';
import { buildReport, exitCodeFor } from '../report/model';
import { renderTerminal } from '../report/terminal';
import { fetchRequiredChecks, type RequiredChecks } from '../static/required';
import { staticFindings } from '../static/rules';
import { FalsegreenError, load, type IO, type Selection } from './common';
import type { RunOutcome } from './run';

export interface RemoteCommandOptions extends Selection {
  yes: boolean;
  pr: boolean;
  deleteRuns: boolean;
  keepBranch: boolean;
  /** How long to wait for the runs; remote.timeoutMinutes from the config when unset. */
  timeoutMs?: number;
  failOn?: Severity;
  out: string;
  formats: Format[];
  tokenEnv?: string;
  branch?: string;
  /** Tests pass a client and the kind of token it stands for. */
  github?: { client: GitHubClient; kind: TokenKind };
  pollMs?: number;
}

export async function remoteCommand(opts: RemoteCommandOptions, io: IO): Promise<RunOutcome> {
  const startedAt = new Date();
  const loaded = load(opts, io);
  const repo = originSlug(loaded.root) ?? io.env.GITHUB_REPOSITORY;
  if (repo === undefined)
    throw new FalsegreenError('remote mode needs a GitHub origin remote (or GITHUB_REPOSITORY)');

  let gh = opts.github;
  if (!gh) {
    const token = resolveToken({
      env: io.env,
      ...(opts.tokenEnv ? { tokenEnv: opts.tokenEnv } : {}),
    });
    if (!token)
      throw new FalsegreenError(
        'remote mode needs a GitHub token: set GITHUB_TOKEN or FALSEGREEN_TOKEN, or log in with gh',
      );
    gh = { client: createClient(token.token), kind: token.kind };
  }

  const result = await runRemote(
    loaded,
    gh.client,
    repo,
    {
      yes: opts.yes,
      pr: opts.pr,
      deleteRuns: opts.deleteRuns,
      keepBranch: opts.keepBranch,
      timeoutMs: opts.timeoutMs ?? loaded.cfg.remote.timeoutMinutes * 60_000,
      pollMs: opts.pollMs ?? 15_000,
      tokenKind: gh.kind,
    },
    io,
  );

  let required: RequiredChecks | undefined;
  if (result.ran) {
    try {
      const branch =
        opts.branch ??
        (await gh.client.request<{ default_branch: string }>('GET', `/repos/${repo}`)).data
          .default_branch;
      required = await fetchRequiredChecks(gh.client, repo, branch);
    } catch {
      required = undefined;
    }
  }

  const report = buildReport({
    root: loaded.root,
    repository: repo,
    modes: ['static', 'remote'],
    startedAt,
    gates: loaded.gates,
    results: [],
    staticFindings: staticFindings(loaded.workflows, loaded.gates, loaded.emptySteps),
    extraFindings: remoteFindings(result, loaded.workflows, required),
    errors: loaded.errors,
    cfg: loaded.cfg,
    remote: result,
    ...(opts.failOn === undefined ? {} : { failOn: opts.failOn }),
  });
  const outDir = isAbsolute(opts.out) ? opts.out : join(loaded.root, opts.out);
  const written = writeReports(report, outDir, opts.formats);
  io.out(renderTerminal(report, io.color));
  if (io.env.GITHUB_ACTIONS === 'true') emitActions(report, io.env, (line) => io.out(`${line}\n`));

  if (result.plan.refused) throw new FalsegreenError(`remote run refused: ${result.plan.refused}`);
  if (!result.ran && !opts.yes) {
    io.err(
      'nothing was written: this was the plan. Run again with --yes to push the branches and start the runs.\n',
    );
    return { report, exitCode: 0, written };
  }
  return { report, exitCode: exitCodeFor(report.findings, report.failOn), written };
}
