/** `falsegreen run`, `static` and `local`: find the gates, check them, report. */
import { isAbsolute, join } from 'node:path';

import { originSlug } from '../core/git';
import type { Severity, Tier } from '../core/types';
import { replayGates, type GateResult, type ProgressEvent } from '../local/replay';
import { installSignalRevert } from '../plant/planter';
import { emitActions } from '../report/github';
import { writeReports, type Format } from '../report/index';
import { buildReport, exitCodeFor, type Report } from '../report/model';
import { renderTerminal } from '../report/terminal';
import { staticFindings } from '../static/rules';
import { load, type IO, type Selection } from './common';

export interface RunOptions extends Selection {
  command: 'run' | 'static' | 'local';
  tiers: Tier[];
  assumeGreen: boolean;
  timeoutMs: number;
  failOn?: Severity;
  out: string;
  formats: Format[];
  quiet: boolean;
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
  const { root, cfg, workflows, gates, emptySteps, errors } = load(opts, io);
  const found = staticFindings(workflows, gates, emptySteps);

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
      });
    } finally {
      uninstall();
    }
  }

  const repository = originSlug(root);
  const report = buildReport({
    root,
    ...(repository === undefined ? {} : { repository }),
    modes: opts.command === 'static' ? ['static'] : ['static', 'local'],
    startedAt,
    gates,
    results,
    staticFindings: found,
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
