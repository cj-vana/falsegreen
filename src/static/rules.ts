/**
 * Rules that need no execution: settings and shell constructs that let a failing check pass.
 * The shell rules follow bash's errexit semantics: a failure stops a `-e` script only when it is the
 * last command of an && or || list, and a pipeline reports its last command unless pipefail is set.
 */
import type { Finding, RuleId, Severity, SourceLocation } from '../core/types';
import type { EmptyStep, Gate, ScriptTrace, StagedOnlyUse } from '../resolve/gates';
import { stripWrappers } from '../resolve/wrappers';
import {
  allCommands,
  words,
  type AndOrList,
  type Pipeline,
  type SimpleCommand,
} from '../shell/parse';
import type { WorkflowModel } from '../workflow/model';

interface ShellState {
  errexit: boolean;
  pipefail: boolean;
  /** Set when the script itself turned -e off. */
  disabled?: boolean;
}

/** Initial -e and pipefail for a trace, or undefined when it is not a POSIX shell script. */
function initialState(trace: ScriptTrace, shell: string | undefined): ShellState | undefined {
  if (trace.kind === 'file') {
    const flags = trace.flags ?? '';
    return {
      errexit: /(^|\s)-[a-z]*e[a-z]*(\s|$)|errexit/.test(flags),
      pipefail: /pipefail/.test(flags),
    };
  }
  if (trace.kind !== 'run') return { errexit: false, pipefail: false };
  if (shell === undefined) return { errexit: true, pipefail: false };
  if (shell === 'bash') return { errexit: true, pipefail: true };
  if (shell === 'sh') return { errexit: true, pipefail: false };
  if (!shell.includes('{0}') || !/\b(ba|z|da|k)?sh\b/.test(shell)) return undefined;
  return {
    errexit: /(^|\s)-[a-z]*e[a-z]*(\s|$)|errexit/.test(shell),
    pipefail: /pipefail/.test(shell),
  };
}

/** Applies a `set` command to the state. */
function applySet(argv: string[], state: ShellState): void {
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!;
    const on = arg.startsWith('-');
    if (!on && !arg.startsWith('+')) continue;
    const letters = arg.slice(1);
    if (letters.includes('e')) state.errexit = on;
    if (letters.includes('o')) {
      const option = argv[++i];
      if (option === 'errexit') state.errexit = on;
      if (option === 'pipefail') state.pipefail = on;
    }
    state.disabled = !state.errexit;
  }
}

function pipelines(list: AndOrList): Pipeline[] {
  return [list.first, ...list.rest.map((r) => r.pipeline)];
}

function hasGate(cmd: SimpleCommand, gates: Set<SimpleCommand>): boolean {
  if (gates.has(cmd)) return true;
  return [...cmd.prefix, ...cmd.argv].some((w) =>
    w.substitutions.some((sub) => allCommands(sub).some((c) => gates.has(c))),
  );
}

const pipelineHasGate = (p: Pipeline, gates: Set<SimpleCommand>): boolean =>
  p.commands.some((c) => hasGate(c, gates));

/** `exit 1`, `exit $status`, `false`, `return 2`: the branch hands a failure back. */
function reraises(cmds: SimpleCommand[]): boolean {
  return cmds.some((c) => {
    const [head, arg] = words(c);
    if (head === 'false') return true;
    if (head !== 'exit' && head !== 'return') return false;
    return arg !== undefined && (c.argv[1]!.dynamic || arg !== '0');
  });
}

/** `[ $? -eq 5 ]` and friends: pytest's "no tests collected" status treated as a pass. */
function acceptsNoTests(cmds: SimpleCommand[]): boolean {
  return cmds.some((c) => {
    const argv = words(c);
    return (
      ['[', '[[', 'test'].includes(argv[0] ?? '') &&
      argv.includes('$?') &&
      argv.some((a) => a === '5')
    );
  });
}

function listText(trace: ScriptTrace, list: AndOrList): string {
  const all = pipelines(list).flatMap((p) => p.commands);
  return trace.text.slice(all[0]!.start, all.at(-1)!.end).trim();
}

interface Context {
  gate: Pick<Gate, 'workflow' | 'jobId' | 'stepName' | 'loc' | 'runLine'>;
  add: (
    rule: RuleId,
    severity: Severity,
    message: string,
    at: SourceLocation,
    hint?: string,
  ) => void;
}

function locationOf(ctx: Context, trace: ScriptTrace, offset: number): SourceLocation {
  if (trace.kind === 'run' && ctx.gate.runLine !== undefined) {
    const line = ctx.gate.runLine + (trace.text.slice(0, offset).match(/\n/g)?.length ?? 0);
    return { file: ctx.gate.loc.file, line };
  }
  return ctx.gate.loc;
}

function where(trace: ScriptTrace): string {
  return trace.kind === 'run' ? '' : `${trace.source}: `;
}

function shellRules(ctx: Context, trace: ScriptTrace, shell: string | undefined): void {
  const state = initialState(trace, shell);
  if (!state) return;
  const gates = new Set(trace.gateCommands);
  const lists = trace.script.lists;
  lists.forEach((list, li) => {
    for (const cmd of pipelines(list).flatMap((p) => p.commands)) {
      if (words(cmd)[0] === 'set') applySet(words(cmd), state);
      // `test -z "$(gofmt -l .)"`: the check runs inside $(...) and its status is thrown away.
      // An assignment (`out=$(gofmt -l .)`) keeps the status, so only commands with argv count.
      if (cmd.argv.length > 0 && !gates.has(cmd) && hasGate(cmd, gates)) {
        ctx.add(
          'masked-exit',
          'medium',
          `${where(trace)}\`${trace.text.slice(cmd.start, cmd.end)}\` throws away the exit status of the check inside $(...), so a check that fails without printing anything passes.`,
          locationOf(ctx, trace, cmd.start),
          'Assign the output first (out=$(...)) so the step stops when the check fails, then test it.',
        );
      }
    }
    const ps = pipelines(list);
    const gateIndex = ps.findLastIndex((p) => pipelineHasGate(p, gates));
    if (gateIndex < 0) return;
    const text = listText(trace, list);
    const at = locationOf(ctx, trace, ps[gateIndex]!.commands[0]!.start);
    const isLast = li === lists.length - 1 || trace.kind === 'make';
    const later = lists.slice(li + 1).flatMap((l) => pipelines(l).flatMap((p) => p.commands));

    // Pipes: the pipeline's status is its last command's unless pipefail is on.
    const gatePipe = ps[gateIndex]!;
    const inner = gatePipe.commands.findIndex((c) => hasGate(c, gates));
    if (gatePipe.commands.length > 1 && inner < gatePipe.commands.length - 1 && !state.pipefail) {
      ctx.add(
        'pipe-swallows-exit',
        'medium',
        `${where(trace)}\`${text}\` reports the exit status of the last command in the pipe, not the check's.`,
        at,
        trace.kind === 'run'
          ? 'Set `shell: bash` on the step (GitHub adds -o pipefail) or start the script with `set -o pipefail`.'
          : 'Add `set -o pipefail`, or run the check outside the pipe.',
      );
    }

    // || after the gate: the list takes the branch's status.
    const orIndex = list.rest.findIndex((r, i) => i + 1 > gateIndex && r.op === '||');
    if (orIndex >= 0) {
      const branch = ps.slice(orIndex + 1);
      const branchCmds = branch.flatMap((p) => p.commands);
      const nextList = lists[li + 1];
      const nextCmds = nextList ? pipelines(nextList)[0]!.commands : [];
      if (!branch.some((p) => pipelineHasGate(p, gates))) {
        if (acceptsNoTests(branchCmds)) {
          ctx.add(
            'passes-with-no-tests',
            'medium',
            `${where(trace)}\`${text}\` treats "no tests collected" as a pass.`,
            at,
          );
        } else if (!reraises(branchCmds) && !reraises(nextCmds.slice(0, 1))) {
          ctx.add(
            'masked-exit',
            'high',
            `${where(trace)}\`${text}\` passes when the check fails.`,
            at,
            'Remove the || branch, or end it with `exit 1`.',
          );
        }
        return;
      }
    }

    if (isLast) return;
    if (later.length > 0 && reraises(later)) return;

    // bash -e ignores a failure anywhere in an && list except its last command.
    if (state.errexit && gateIndex < ps.length - 1 && list.rest[gateIndex]?.op === '&&') {
      ctx.add(
        'masked-exit',
        'high',
        `${where(trace)}\`${text}\`: -e does not stop the script when a command before && fails, so the script moves on and can still pass.`,
        at,
        'Put the check on its own line, or make this list the last command of the script.',
      );
      return;
    }
    if (!state.errexit) {
      const why = state.disabled
        ? 'set +e is in effect'
        : trace.kind === 'package-script'
          ? 'npm runs scripts with sh -c, without -e'
          : trace.kind === 'file'
            ? 'the script does not set -e'
            : 'the shell runs without -e';
      ctx.add(
        'masked-exit',
        'high',
        `${where(trace)}\`${text}\` is not the last command and ${why}, so only the last command's status counts.`,
        at,
        'Join the commands with &&, or add `set -e` at the top.',
      );
    }
  });
}

/** A flag that makes the check exit 0 whatever it finds, and how to fix it; undefined when none. */
function neverFails(raw: string[]): string | undefined {
  const argv = stripWrappers(raw).argv;
  const exe = argv[0];
  if ((exe === 'flake8' || exe === 'ruff' || exe === 'pylint') && argv.includes('--exit-zero')) {
    return 'Remove --exit-zero.';
  }
  if (exe === 'golangci-lint') {
    const at = argv.indexOf('--issues-exit-code');
    const value =
      at >= 0 ? argv[at + 1] : argv.find((a) => a.startsWith('--issues-exit-code='))?.split('=')[1];
    if (value === '0') return 'Remove --issues-exit-code=0.';
  }
  if (
    (exe === 'mvn' || exe === 'mvnw') &&
    argv.some((a) => /^-Dmaven\.test\.failure\.ignore(=true)?$/.test(a))
  ) {
    return 'Remove -Dmaven.test.failure.ignore=true.';
  }
  return undefined;
}

function stagedOnlyFindings(ctx: Context, uses: StagedOnlyUse[]): void {
  for (const use of uses) {
    const text = use.trace.text.slice(use.cmd.start, use.cmd.end);
    ctx.add(
      'no-files-checked',
      'high',
      `${where(use.trace)}\`${text}\` checks only staged files, and a CI checkout has nothing staged, so it checks nothing.`,
      locationOf(ctx, use.trace, use.cmd.start),
      use.runner === 'pre-commit' ? 'Add --all-files.' : 'Run the linters directly in CI.',
    );
  }
}

const EVENT_CONDITION = /github\.(event_name|ref|ref_name|actor|head_ref|base_ref)\b/;

export function staticFindings(
  workflows: WorkflowModel[],
  gates: Gate[],
  emptySteps: EmptyStep[] = [],
): Finding[] {
  const findings = new Map<string, Finding>();
  const addFor =
    (gate: Context['gate']): Context['add'] =>
    (rule, severity, message, at, hint) => {
      const key = `${rule}|${at.file}|${at.line}|${gate.jobId}|${gate.stepName}|${message}`;
      if (findings.has(key)) return;
      const f: Finding = {
        rule,
        severity,
        message,
        location: at,
        workflow: gate.workflow,
        job: gate.jobId,
      };
      if (gate.stepName !== '') f.step = gate.stepName;
      if (hint !== undefined) f.hint = hint;
      findings.set(key, f);
    };

  for (const gate of gates) {
    const ctx: Context = { gate, add: addFor(gate) };
    const jobCtx: Context = {
      gate: { ...gate, stepName: '' },
      add: addFor({ ...gate, stepName: '' }),
    };

    for (const [owner, value, at, c] of [
      ['step', gate.step.continueOnError, gate.step.loc, ctx],
      ['job', gate.job.continueOnError, gate.job.loc, jobCtx],
    ] as const) {
      if (value === true) {
        c.add(
          'continue-on-error',
          'high',
          `continue-on-error: true lets this ${owner} fail without failing the run.`,
          at,
        );
      } else if (typeof value === 'string') {
        c.add(
          'continue-on-error',
          'medium',
          `continue-on-error is set by an expression (${value}), so this ${owner} can fail without failing the run.`,
          at,
        );
      }
    }

    for (const [owner, cond, at, c] of [
      ['step', gate.step.if, gate.step.loc, ctx],
      ['job', gate.job.if, gate.job.loc, jobCtx],
    ] as const) {
      if (cond !== undefined && EVENT_CONDITION.test(cond)) {
        c.add('conditional-gate', 'low', `This ${owner} only runs when \`${cond}\` holds.`, at);
      }
    }

    for (const trace of gate.traces) {
      shellRules(ctx, trace, gate.shell);
      for (const cmd of trace.gateCommands) {
        const argv = words(cmd);
        if (argv.includes('--passWithNoTests') || argv.includes('--pass-with-no-tests')) {
          ctx.add(
            'passes-with-no-tests',
            'medium',
            `${where(trace)}\`${argv.join(' ')}\` passes when no test file matches.`,
            locationOf(ctx, trace, cmd.start),
          );
        }
        const fix = neverFails(argv);
        if (fix !== undefined) {
          ctx.add(
            'masked-exit',
            'high',
            `${where(trace)}\`${argv.join(' ')}\` exits 0 even when the check finds problems.`,
            locationOf(ctx, trace, cmd.start),
            fix,
          );
        }
      }
    }
    stagedOnlyFindings(ctx, gate.stagedOnly);

    for (const use of gate.ifPresent) {
      ctx.add(
        'if-present',
        'medium',
        `\`${words(use.cmd).join(' ')}\` passes without running anything if the script is ever renamed or removed.`,
        locationOf(ctx, use.trace, use.cmd.start),
      );
    }
  }

  for (const empty of emptySteps) {
    const ctx: Context = { gate: empty, add: addFor(empty) };
    stagedOnlyFindings(ctx, empty.stagedOnly);
    for (const use of empty.ifPresent.filter((u) => u.missing)) {
      ctx.add(
        'if-present',
        'high',
        `\`${words(use.cmd).join(' ')}\` runs nothing: the script does not exist, and --if-present turns that into a pass.`,
        locationOf(ctx, use.trace, use.cmd.start),
      );
    }
  }

  const gated = new Set(gates.map((g) => g.workflow));
  for (const wf of workflows) {
    const pr = wf.triggers.pullRequest;
    if (gated.has(wf.file) && pr && (pr.paths || pr.pathsIgnore)) {
      const key = `path-filtered|${wf.file}`;
      findings.set(key, {
        rule: 'path-filtered',
        severity: 'low',
        message:
          'Pull requests that touch none of the filtered paths skip this workflow, so its checks never report on them.',
        location: wf.loc,
        workflow: wf.file,
      });
    }
  }
  return [...findings.values()];
}
