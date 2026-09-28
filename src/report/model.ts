/** The report every output format is rendered from, and the findings that come from replays. */
import { isIgnored, type ResolvedConfig } from '../config/load';
import {
  SEVERITY_ORDER,
  atLeast,
  type Finding,
  type Severity,
  type Tier,
  type Verdict,
} from '../core/types';
import type { ToolId } from '../faults/types';
import type { FaultRun, GateResult } from '../local/replay';
import type { RemoteResult } from '../remote/run';
import type { Gate } from '../resolve/gates';
import { version } from '../version';

export interface FaultReport {
  tier: Tier;
  tool: ToolId;
  files: string[];
  description?: string;
  verdict: Verdict;
  exitCode: number | null;
  durationMs: number;
  excerpt: string;
  reason?: string;
}

export interface GateReport {
  workflow: string;
  job: string;
  checkName: string;
  step: string;
  line: number;
  command?: string;
  tools: ToolId[];
  /** `listed` in static mode, where gates are found but not replayed. */
  status: GateResult['status'] | 'listed';
  reason?: string;
  notes: string[];
  faults: FaultReport[];
}

export interface Report {
  tool: 'falsegreen';
  version: string;
  repository?: string;
  startedAt: string;
  finishedAt: string;
  modes: ('static' | 'local' | 'remote')[];
  failOn: Severity;
  gates: GateReport[];
  findings: Finding[];
  /** Remote mode: the plan, each job's verdicts, and cleanup notes. */
  remote?: RemoteResult;
  /** Problems reading the repository that did not stop the run (unparseable workflows). */
  errors: string[];
  summary: {
    gates: number;
    judged: number;
    caught: number;
    survived: number;
    deadGates: number;
    weakGates: number;
    unjudged: number;
    bySeverity: Record<Severity, number>;
  };
}

const quote = (step: string): string => `\`${step}\``;

function where(gate: Gate): Pick<Finding, 'workflow' | 'job' | 'step' | 'location'> {
  return { workflow: gate.workflow, job: gate.jobId, step: gate.stepName, location: gate.loc };
}

function plantedPaths(run: FaultRun): string[] {
  return [
    ...(run.fault?.files.map((f) => f.path) ?? []),
    ...(run.fault?.appends.map((a) => a.path) ?? []),
  ];
}

/** Findings from local replays: dead, weak and unattributed gates, and what could not be judged. */
export function dynamicFindings(results: GateResult[]): Finding[] {
  const findings: Finding[] = [];
  for (const r of results) {
    const g = r.gate;
    const step = quote(g.stepName);
    if (r.status === 'already-red') {
      findings.push({
        rule: 'already-red',
        severity: 'info',
        message: `${step} fails before any fault is planted (${r.reason ?? 'nonzero exit'}), so falsegreen cannot judge it.`,
        ...where(g),
      });
      continue;
    }
    if (r.status === 'unjudged') {
      findings.push({
        rule: 'unjudged',
        severity: 'info',
        message: `${step} was not judged: ${r.reason ?? 'unknown reason'}.`,
        ...where(g),
      });
      continue;
    }

    for (const tool of [...new Set(r.runs.map((x) => x.tool))]) {
      const reach = r.runs.find((x) => x.tool === tool && x.tier === 'reach');
      const semantic = r.runs.find((x) => x.tool === tool && x.tier === 'semantic');
      if (reach?.verdict === 'survived') {
        findings.push({
          rule: 'dead-gate',
          severity: 'high',
          message: `${step} stayed green with a ${tool} file that does not parse: ${tool} never reads that location, or its failure is swallowed.`,
          hint: `falsegreen planted ${plantedPaths(reach).join(', ')}. If that location is excluded on purpose, set place for ${tool} in falsegreen.config.yml.`,
          ...where(g),
        });
        continue;
      }
      if (semantic?.verdict === 'survived') {
        const f: Finding = {
          rule: 'weak-gate',
          severity: 'medium',
          message: `${step} fails on a file that does not parse, but stayed green with a ${semantic.fault?.description ?? 'planted problem'}: ${tool} runs, but does not fail on real problems.`,
          ...where(g),
        };
        if (semantic.fault?.expectSurvival !== undefined) f.hint = semantic.fault.expectSurvival;
        findings.push(f);
      }
      for (const run of [reach, semantic]) {
        if (run?.verdict === 'unattributed') {
          findings.push({
            rule: 'unattributed',
            severity: 'low',
            message: `${step} failed with the ${tool} ${run.tier} fault in place, but its output never named the planted file, so it may have failed for another reason.`,
            ...where(g),
          });
        } else if (run?.verdict === 'unjudged') {
          findings.push({
            rule: 'unjudged',
            severity: 'info',
            message: `${step}: the ${tool} ${run.tier} fault was not judged: ${run.reason ?? 'unknown reason'}.`,
            ...where(g),
          });
        }
      }
    }
  }
  return findings;
}

function gateReport(r: GateResult): GateReport {
  const g = r.gate;
  const report: GateReport = {
    workflow: g.workflow,
    job: g.jobId,
    checkName: g.checkName,
    step: g.stepName,
    line: g.loc.line,
    tools: [...new Set(g.invocations.map((i) => i.tool))],
    status: r.status,
    notes: g.notes,
    faults: r.runs.map((run) => {
      const f: FaultReport = {
        tier: run.tier,
        tool: run.tool,
        files: plantedPaths(run),
        verdict: run.verdict,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        excerpt: run.excerpt,
      };
      if (run.fault?.description !== undefined) f.description = run.fault.description;
      if (run.reason !== undefined) f.reason = run.reason;
      return f;
    }),
  };
  if (g.run !== undefined) report.command = g.run;
  if (r.reason !== undefined) report.reason = r.reason;
  return report;
}

/** Static rules that, when present on a step, are the reason its faults survive. */
const EXPLAINS: Finding['rule'][] = [
  'masked-exit',
  'pipe-swallows-exit',
  'passes-with-no-tests',
  'if-present',
  'no-files-checked',
];

/** Points dead and weak gates at the static finding on the same step that explains them. */
function explain(dynamic: Finding[], found: Finding[]): Finding[] {
  return dynamic.map((f) => {
    if (f.rule !== 'dead-gate' && f.rule !== 'weak-gate') return f;
    const cause = found.find(
      (s) =>
        EXPLAINS.includes(s.rule) &&
        s.workflow === f.workflow &&
        s.job === f.job &&
        s.step === f.step,
    );
    return cause
      ? {
          ...f,
          hint: `The ${cause.rule} finding on this step explains why: fix it and this gate can fail.`,
        }
      : f;
  });
}

const bySeverityDesc = (a: Finding, b: Finding): number =>
  SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity);

export function buildReport(input: {
  root: string;
  repository?: string;
  modes: Report['modes'];
  startedAt: Date;
  gates: Gate[];
  results: GateResult[];
  staticFindings: Finding[];
  extraFindings?: Finding[];
  errors?: string[];
  cfg: ResolvedConfig;
  failOn?: Severity;
  remote?: RemoteResult;
}): Report {
  const findings = [
    ...explain(dynamicFindings(input.results), input.staticFindings),
    ...input.staticFindings,
    ...(input.extraFindings ?? []),
  ]
    .filter((f) => !isIgnored(input.cfg, f))
    .sort(bySeverityDesc);
  const runs = input.results.flatMap((r) => r.runs);
  // Remote results are per job and tier; a job counts as judged when no tier is left unjudged.
  const remote = input.remote?.jobs ?? [];
  const byJob = new Map<string, boolean>();
  for (const r of remote) {
    const key = `${r.workflow}#${r.job}`;
    byJob.set(key, (byJob.get(key) ?? true) && r.verdict !== 'unjudged');
  }
  const remoteJobs = {
    judged: [...byJob.values()].filter(Boolean).length,
    unjudged: [...byJob.values()].filter((v) => !v).length,
  };
  const bySeverity: Record<Severity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of findings) bySeverity[f.severity]++;

  const report: Report = {
    tool: 'falsegreen',
    version,
    startedAt: input.startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    modes: input.modes,
    failOn: input.failOn ?? input.cfg.failOn,
    gates:
      input.results.length > 0
        ? input.results.map(gateReport)
        : input.gates.map((gate) => ({
            ...gateReport({ gate, status: 'judged', runs: [] }),
            status: 'listed',
          })),
    findings,
    errors: input.errors ?? [],
    summary: {
      gates: input.results.length > 0 ? input.results.length : input.gates.length,
      judged: input.results.filter((r) => r.status === 'judged').length + remoteJobs.judged,
      caught: [...runs, ...remote].filter((r) => r.verdict === 'caught').length,
      survived: [...runs, ...remote].filter((r) => r.verdict === 'survived').length,
      deadGates: findings.filter((f) => f.rule === 'dead-gate').length,
      weakGates: findings.filter((f) => f.rule === 'weak-gate').length,
      unjudged: input.results.filter((r) => r.status !== 'judged').length + remoteJobs.unjudged,
      bySeverity,
    },
  };
  if (input.repository !== undefined) report.repository = input.repository;
  if (input.remote !== undefined) report.remote = input.remote;
  return report;
}

export function exitCodeFor(findings: Finding[], failOn: Severity): 0 | 1 {
  return findings.some((f) => atLeast(f.severity, failOn)) ? 1 : 0;
}
