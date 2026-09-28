/**
 * Turns workflow steps into gates: steps that run at least one recognized check tool, found by
 * following the step's shell text through package scripts, make targets, shell scripts and
 * pre-commit hooks. Every script level visited is kept as a trace, so static rules can look for a
 * masked exit wherever it hides (`"test": "jest || true"` counts as much as `run: jest || true`).
 */
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';

import type { ResolvedConfig } from '../config/load';
import { currentBranch, originSlug, trackedFiles } from '../core/git';
import type { SourceLocation } from '../core/types';
import type { ToolId, ToolInvocation } from '../faults/types';
import {
  allCommands,
  parseShell,
  words,
  type ShellScript,
  type SimpleCommand,
} from '../shell/parse';
import { skippedOnRunner } from '../shell/runner';
import { checkName } from '../workflow/checks';
import {
  conditionHolds,
  emptyContext,
  substitute,
  type ExprContext,
} from '../workflow/expressions';
import { expandMatrix } from '../workflow/matrix';
import type { JobModel, StepModel, WorkflowModel } from '../workflow/model';
import { makeCall, makeDryRun } from './make';
import { PRECOMMIT_CONFIG, precommitTools } from './precommit';
import { scriptCall, scriptFor } from './scripts';
import { identify } from './tools';
import { stripWrappers } from './wrappers';

export interface ScriptTrace {
  /** `run`, `package.json#test`, `web/package.json#lint`, `Makefile:test`, `scripts/ci.sh`. */
  source: string;
  /**
   * How the text is executed, which decides whether a failure stops it: `run` under the step's
   * shell, `package-script` under `sh -c` (no -e), `make` one shell per line with make checking
   * each, `file` a script run by bash or sh (no -e unless it sets it).
   */
  kind: 'run' | 'package-script' | 'make' | 'file';
  text: string;
  script: ShellScript;
  /** Commands in this script that run a check tool, directly or through another script. */
  gateCommands: SimpleCommand[];
}

export interface Gate {
  /** `${workflow}#${jobId}#${stepIndex}#${comboIndex}` */
  key: string;
  workflow: string;
  jobId: string;
  jobName: string;
  checkName: string;
  stepIndex: number;
  stepName: string;
  loc: SourceLocation;
  runLine?: number;
  kind: 'run' | 'uses';
  /** The step's shell text with expressions substituted. */
  run?: string;
  shell?: string;
  /** Repo-relative, '' for the repository root. */
  workingDirectory: string;
  env: Record<string, string>;
  combo: Record<string, string>;
  invocations: ToolInvocation[];
  traces: ScriptTrace[];
  /** Expressions in the command that could not be rebuilt; replay is refused while any remain. */
  unresolved: string[];
  notes: string[];
  ifPresent: IfPresentUse[];
  stagedOnly: StagedOnlyUse[];
  /** A command that must never be replayed (`npm publish`, `git push`, ...). */
  unsafe?: string;
  fromAction?: string;
  job: JobModel;
  step: StepModel;
}

/** A `run --if-present` call; `missing` when no such script exists, so the call does nothing. */
export interface IfPresentUse {
  trace: ScriptTrace;
  cmd: SimpleCommand;
  missing: boolean;
}

/** `pre-commit run` without --all-files, or lint-staged: both check only staged files. */
export interface StagedOnlyUse {
  trace: ScriptTrace;
  cmd: SimpleCommand;
  runner: 'pre-commit' | 'lint-staged';
}

/** A step that looks like a check but runs none: its scripts are missing, or it checks staged files. */
export interface EmptyStep {
  workflow: string;
  jobId: string;
  stepName: string;
  loc: SourceLocation;
  runLine?: number;
  ifPresent: IfPresentUse[];
  stagedOnly: StagedOnlyUse[];
  job: JobModel;
  step: StepModel;
}

const MAX_DEPTH = 8;

const CHECK_ACTIONS: Record<string, ToolId> = {
  'golangci/golangci-lint-action': 'golangci-lint',
  'astral-sh/ruff-action': 'ruff-check',
  'chartboost/ruff-action': 'ruff-check',
  'psf/black': 'black',
  'reviewdog/action-eslint': 'eslint',
  'reviewdog/action-golangci-lint': 'golangci-lint',
  'super-linter/super-linter': 'generic',
  'github/super-linter': 'generic',
};

const CHECK_NAMED = /\b(tests?|lint|checks?|verify|typecheck|type-check|fmt|format|vet|clippy)\b/i;

/** Commands that are never the check itself; skipped when picking a generic gate command. */
const UTILITIES = new Set([
  'echo',
  'printf',
  'cd',
  'pushd',
  'popd',
  'export',
  'set',
  'unset',
  'mkdir',
  'cp',
  'mv',
  'rm',
  'cat',
  'ls',
  'true',
  'false',
  'test',
  '[',
  '[[',
  'source',
  '.',
  'exit',
  'sleep',
  'curl',
  'wget',
  'tee',
  'grep',
  'sed',
  'awk',
  'chmod',
  'touch',
  'pwd',
  'which',
  'env',
  'git',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'pip',
  'pip3',
  'apt-get',
  'apt',
  'brew',
  'sudo',
  'tar',
  'unzip',
  'docker',
  'eval',
  'read',
  'shift',
  'wait',
  'trap',
  'command',
  'node',
  'python',
  'python3',
  'uv',
  'poetry',
  'go',
  'cargo',
  'rustup',
  'corepack',
  'nvm',
]);

export function unsafeCommand(raw: string[]): string | undefined {
  const argv = stripWrappers(raw).argv;
  const [a, b] = argv;
  if (a === undefined) return undefined;
  const pair = `${a} ${b ?? ''}`.trim();
  const publishers = [
    'npm',
    'pnpm',
    'yarn',
    'bun',
    'cargo',
    'poetry',
    'uv',
    'twine',
    'flit',
    'hatch',
    'gem',
    'dotnet',
  ];
  if (publishers.includes(a) && (b === 'publish' || b === 'upload' || b === 'push')) return pair;
  const exact = [
    'git push',
    'docker push',
    'gh release',
    'kubectl apply',
    'kubectl delete',
    'terraform apply',
    'terraform destroy',
    'helm install',
    'helm upgrade',
    'netlify deploy',
    'firebase deploy',
    'wrangler deploy',
    'wrangler publish',
    'fly deploy',
    'flyctl deploy',
    'vercel deploy',
  ];
  if (exact.includes(pair)) return pair;
  if (a === 'vercel' && argv.includes('--prod')) return 'vercel --prod';
  if ((a === 'mvn' || a === 'mvnw') && argv.includes('deploy')) return 'mvn deploy';
  if ((a === 'gradle' || a === 'gradlew') && argv.some((t) => /(^|:)publish/.test(t)))
    return 'gradle publish';
  return undefined;
}

interface Walk {
  root: string;
  tracked: Set<string>;
  invocations: ToolInvocation[];
  traces: ScriptTrace[];
  notes: string[];
  ifPresent: IfPresentUse[];
  stagedOnly: StagedOnlyUse[];
  unsafe?: string;
}

const STAGED_ALL = ['--all-files', '-a', '--files', '--from-ref', '--source'];

function stagedOnlyRunner(argv: string[]): StagedOnlyUse['runner'] | undefined {
  const [head, sub] = stripWrappers(argv).argv;
  if (head === 'lint-staged') return 'lint-staged';
  if (head === 'pre-commit' && sub === 'run' && !argv.some((a) => STAGED_ALL.includes(a))) {
    return 'pre-commit';
  }
  return undefined;
}

function normalizeDir(cwd: string, target: string): string {
  const joined = posix.normalize(posix.join(cwd, target)).replace(/\/$/, '');
  return joined === '.' ? '' : joined;
}

/** Walks one script level; returns true when any command in it leads to a gate. */
function walkScript(
  text: string,
  source: string,
  kind: ScriptTrace['kind'],
  cwd: string,
  via: string[],
  w: Walk,
  depth: number,
): boolean {
  const script = parseShell(text);
  const trace: ScriptTrace = { source, kind, text, script, gateCommands: [] };
  w.traces.push(trace);
  let dir = cwd;
  const stack: string[] = [];
  for (const cmd of allCommands(script)) {
    const argv = words(cmd);
    if (argv.length === 0 || skippedOnRunner(cmd)) continue;
    const [head, target] = argv;
    if (head === 'cd' || head === 'pushd') {
      const dynamic = cmd.argv[1]?.dynamic ?? true;
      if (
        target !== undefined &&
        !dynamic &&
        target !== '-' &&
        !target.startsWith('~') &&
        !target.startsWith('/')
      ) {
        if (head === 'pushd') stack.push(dir);
        dir = normalizeDir(dir, target);
      }
      continue;
    }
    if (head === 'popd') {
      dir = stack.pop() ?? dir;
      continue;
    }
    w.unsafe ??= unsafeCommand(argv);
    const call = scriptCall(argv, dir);
    if (call?.ifPresent) {
      w.ifPresent.push({ trace, cmd, missing: !scriptFor(w.root, call.dir, call.name) });
    }
    const runner = stagedOnlyRunner(argv);
    if (runner) w.stagedOnly.push({ trace, cmd, runner });
    if (resolveCommand(argv, dir, via, w, depth)) trace.gateCommands.push(cmd);
  }
  return trace.gateCommands.length > 0;
}

function resolveCommand(
  argv: string[],
  dir: string,
  via: string[],
  w: Walk,
  depth: number,
): boolean {
  if (depth > MAX_DEPTH) return false;
  const label = argv.join(' ');
  const direct = identify(argv, dir, w.root);
  if (direct.length > 0) {
    for (const inv of direct) w.invocations.push({ ...inv, via: [...via, label] });
    return true;
  }

  const call = scriptCall(argv, dir);
  if (call) {
    const found = scriptFor(w.root, call.dir, call.name);
    if (!found) {
      if (call.ifPresent)
        w.notes.push(`${label}: no ${call.name} script, and --if-present makes that a pass`);
      return call.fallback ? resolveCommand(call.fallback, dir, via, w, depth + 1) : false;
    }
    if (call.ifPresent) w.notes.push(`${label} uses --if-present`);
    const pkg = found.packageDir === '' ? 'package.json' : `${found.packageDir}/package.json`;
    let any = false;
    const names =
      call.runner === 'npm' ? [`pre${call.name}`, call.name, `post${call.name}`] : [call.name];
    for (const name of names) {
      const script = name === call.name ? found : scriptFor(w.root, call.dir, name);
      if (!script) continue;
      any =
        walkScript(
          script.text,
          `${pkg}#${name}`,
          'package-script',
          found.packageDir,
          [...via, label],
          w,
          depth + 1,
        ) || any;
    }
    return any;
  }

  const make = makeCall(argv, dir);
  if (make) {
    const dry = makeDryRun(w.root, make);
    if ('error' in dry) {
      w.notes.push(`make -n ${make.args.join(' ')} failed: ${dry.error}`);
      return false;
    }
    return walkScript(dry.output, make.label, 'make', make.dir, [...via, label], w, depth + 1);
  }

  const [head] = argv;
  // `bash -e scripts/ci.sh`, `./ci.sh`, or `scripts/check` with no extension, as httpx does.
  const scriptPath =
    head === 'bash' || head === 'sh' || head === 'zsh'
      ? argv.slice(1).find((a) => !a.startsWith('-'))
      : head?.includes('/') && !head.startsWith('/')
        ? head
        : undefined;
  if (scriptPath !== undefined) {
    const file = normalizeDir(dir, scriptPath);
    if (w.tracked.has(file)) {
      return walkScript(
        readFileSync(join(w.root, file), 'utf8'),
        file,
        'file',
        dir,
        [...via, label],
        w,
        depth + 1,
      );
    }
  }

  if (head === 'pre-commit' && argv[1] === 'run') {
    const hook = argv.slice(2).find((a) => !a.startsWith('-'));
    const tools = precommitTools(w.root, hook);
    if (!argv.includes('--all-files') && !argv.includes('-a')) {
      w.notes.push(
        `${label} checks staged files only, and a CI checkout has none staged, so it checks nothing; add --all-files`,
      );
    }
    for (const tool of tools) {
      w.invocations.push({
        tool,
        argv,
        cwd: '',
        pathArgs: [],
        via: [...via, label, `${PRECOMMIT_CONFIG} hook`],
      });
    }
    return tools.length > 0;
  }
  return false;
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]!.trim();
}

function displayName(step: StepModel, run: string | undefined, ctx: ExprContext): string {
  if (step.name !== undefined) return substitute(step.name, ctx).text;
  if (run !== undefined) return `Run ${firstLine(run)}`;
  return step.uses ?? `step ${step.index + 1}`;
}

/** Substitutes env maps level by level, dropping values that cannot be rebuilt. */
function buildEnv(
  levels: Record<string, string>[],
  base: ExprContext,
  notes: string[],
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const level of levels) {
    for (const [k, v] of Object.entries(level)) {
      const s = substitute(v, { ...base, env });
      if (s.unresolved.length > 0) {
        delete env[k];
        notes.push(`env ${k} left unset: ${s.unresolved.join(', ')} cannot be rebuilt locally`);
      } else {
        env[k] = s.text;
      }
    }
  }
  return env;
}

function inputsOf(wf: WorkflowModel): Record<string, string> {
  const out: Record<string, string> = {};
  for (const source of [wf.triggers.workflowCall, wf.triggers.workflowDispatch]) {
    for (const [name, spec] of Object.entries(source?.inputs ?? {})) {
      if (spec.default !== undefined) out[name] = spec.default;
    }
  }
  return out;
}

export function resolveGates(
  root: string,
  workflows: WorkflowModel[],
  cfg: ResolvedConfig,
  opts: { matrix: 'first' | 'all' },
): Gate[] {
  return resolveAll(root, workflows, cfg, opts).gates;
}

/** Gates, plus steps that look like checks but run nothing. */
export function resolveAll(
  root: string,
  workflows: WorkflowModel[],
  cfg: ResolvedConfig,
  opts: { matrix: 'first' | 'all' },
): { gates: Gate[]; emptySteps: EmptyStep[] } {
  const tracked = new Set(trackedFiles(root));
  const github: Record<string, string> = { workspace: root };
  const slug = originSlug(root);
  if (slug) github.repository = slug;
  const branch = currentBranch(root);
  if (branch) github.ref_name = branch;
  const runner = {
    os:
      process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
    temp: tmpdir(),
  };

  const gates: Gate[] = [];
  const emptySteps: EmptyStep[] = [];
  for (const wf of workflows) {
    const inputs = inputsOf(wf);
    for (const job of wf.jobs) {
      if (job.usesWorkflow !== undefined) continue;
      const combos = expandMatrix(job.matrix);
      // A step whose `if` is false for a leg does not run there. Only a definite false skips it:
      // a condition on the event or the branch leaves the step in.
      const runsIn = (step: StepModel, combo: Record<string, string>): boolean =>
        step.if === undefined || conditionHolds(step.if, combo) !== false;
      // `first` judges each step once, in the first leg that runs it; `all` judges every leg.
      const legs: [StepModel, number][] =
        opts.matrix === 'first'
          ? job.steps.flatMap((step): [StepModel, number][] => {
              const i = combos.findIndex((combo) => runsIn(step, combo));
              return i < 0 ? [] : [[step, i]];
            })
          : combos
              .slice(0, cfg.matrix.max)
              .flatMap((combo, i) =>
                job.steps
                  .filter((step) => runsIn(step, combo))
                  .map((s): [StepModel, number] => [s, i]),
              );
      const reported = new Set<StepModel>();
      for (const [step, comboIndex] of legs) {
        const resolved = resolveStep(
          root,
          tracked,
          wf,
          job,
          step,
          combos[comboIndex]!,
          comboIndex,
          { github, runner, inputs },
          cfg,
        );
        if (resolved && 'key' in resolved) gates.push(resolved);
        // Matrix combinations repeat the same empty step; report it once.
        else if (resolved && !reported.has(step)) {
          reported.add(step);
          emptySteps.push(resolved);
        }
      }
    }
  }
  return { gates, emptySteps };
}

function resolveStep(
  root: string,
  tracked: Set<string>,
  wf: WorkflowModel,
  job: JobModel,
  step: StepModel,
  combo: Record<string, string>,
  comboIndex: number,
  base: {
    github: Record<string, string>;
    runner: Record<string, string>;
    inputs: Record<string, string>;
  },
  cfg: ResolvedConfig,
): Gate | EmptyStep | undefined {
  const notes: string[] = [];
  const ctx: ExprContext = { ...emptyContext(), ...base, matrix: combo };
  const env = buildEnv([wf.env, job.env, step.env], ctx, notes);
  const full: ExprContext = { ...ctx, env };

  const wdRaw =
    step.workingDirectory ?? job.defaults.workingDirectory ?? wf.defaults.workingDirectory ?? '';
  let wd = substitute(wdRaw, full).text;
  if (wd.startsWith(root)) wd = wd.slice(root.length).replace(/^\//, '');
  const workingDirectory = normalizeDir('', wd || '.');
  const shellRaw = step.shell ?? job.defaults.shell ?? wf.defaults.shell;
  const shell = shellRaw === undefined ? undefined : substitute(shellRaw, full).text;

  const run = step.run === undefined ? undefined : substitute(step.run, full);
  const stepName = displayName(step, run?.text, full);
  const w: Walk = {
    root,
    tracked,
    invocations: [],
    traces: [],
    notes,
    ifPresent: [],
    stagedOnly: [],
  };
  let kind: Gate['kind'] = 'run';

  if (run) {
    walkScript(run.text, 'run', 'run', workingDirectory, [], w, 0);
    if (w.invocations.length === 0) {
      const trace = w.traces[0]!;
      // Utilities and the script's own functions are never the check. `python3 -m compileall`
      // is one; `python3` alone is only a launcher, so wrappers are stripped first.
      const candidates = allCommands(trace.script).filter((c) => {
        const head = stripWrappers(words(c)).argv[0];
        return (
          head !== undefined &&
          !UTILITIES.has(head) &&
          !trace.script.functions.includes(head) &&
          !skippedOnRunner(c)
        );
      });
      // A check-named step runs its first candidate; otherwise a candidate has to name a check
      // itself in its name or arguments. Comments, echo text and flags such as `--verify-tag`
      // say nothing about what runs.
      const namesCheck = (c: SimpleCommand): boolean =>
        CHECK_NAMED.test(
          words(c)
            .filter((w) => !w.startsWith('-'))
            .join(' '),
        );
      const cmd = CHECK_NAMED.test(step.name ?? '') ? candidates[0] : candidates.find(namesCheck);
      if (cmd) {
        // The static shell rules look for masking around this command, like any other gate.
        trace.gateCommands.push(cmd);
        const argv = words(cmd);
        w.invocations.push({
          tool: 'generic',
          argv,
          cwd: workingDirectory,
          pathArgs: [],
          via: [argv.join(' ')],
        });
      }
    }
  } else if (step.uses !== undefined) {
    const action = step.uses.split('@')[0]!.split('/').slice(0, 2).join('/');
    const tool = CHECK_ACTIONS[action];
    if (tool) {
      kind = 'uses';
      w.invocations.push({
        tool,
        argv: [step.uses],
        cwd: workingDirectory,
        pathArgs: [],
        via: [step.uses],
      });
    }
  }

  for (const extra of cfg.gates.filter((g) => g.job === job.id && g.step === stepName)) {
    w.invocations.push({
      tool: extra.tool,
      argv: run ? [firstLine(run.text)] : [],
      cwd: extra.cwd ?? workingDirectory,
      pathArgs: [],
      via: [cfg.source ?? 'falsegreen.config.yml'],
    });
  }
  if (w.invocations.length === 0) {
    if (!w.ifPresent.some((u) => u.missing) && w.stagedOnly.length === 0) return undefined;
    const empty: EmptyStep = {
      workflow: wf.file,
      jobId: job.id,
      stepName,
      loc: step.loc,
      ifPresent: w.ifPresent,
      stagedOnly: w.stagedOnly,
      job,
      step,
    };
    if (step.runLine !== undefined) empty.runLine = step.runLine;
    return empty;
  }

  const gate: Gate = {
    key: `${wf.file}#${job.id}#${step.index}#${comboIndex}`,
    workflow: wf.file,
    jobId: job.id,
    jobName: job.name === undefined ? job.id : substitute(job.name, full).text,
    checkName: checkName(job, combo),
    stepIndex: step.index,
    stepName,
    loc: step.loc,
    kind,
    workingDirectory,
    env,
    combo,
    invocations: w.invocations,
    traces: w.traces,
    unresolved: run?.unresolved ?? [],
    notes: w.notes,
    ifPresent: w.ifPresent,
    stagedOnly: w.stagedOnly,
    job,
    step,
  };
  if (step.runLine !== undefined) gate.runLine = step.runLine;
  if (run) gate.run = run.text;
  if (shell !== undefined) gate.shell = shell;
  if (w.unsafe !== undefined) gate.unsafe = w.unsafe;
  if (step.fromAction !== undefined) gate.fromAction = step.fromAction;
  return gate;
}
