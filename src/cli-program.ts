/** falsegreen command-line interface. */
import { Command, Option } from 'commander';
import pc from 'picocolors';

import { cleanCommand } from './commands/clean';
import { FalsegreenError, type IO, type Selection } from './commands/common';
import { initCommand } from './commands/init';
import { listCommand } from './commands/list';
import { remoteCommand } from './commands/remote';
import { runCommand } from './commands/run';
import { SEVERITY_ORDER, TIERS, type Severity, type Tier } from './core/types';
import type { Format } from './report/index';
import { version } from './version';

export interface CliIO extends IO {
  setExitCode: (code: number) => void;
}

const FORMATS: Format[] = ['json', 'sarif', 'md'];

const defaultIO = (): CliIO => ({
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  env: process.env,
  color: pc.isColorSupported && process.stdout.isTTY === true,
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

interface CommonOpts {
  cwd: string;
  config?: string;
  workflow?: string[];
  job?: string[];
  step?: string[];
  matrix: 'first' | 'all';
}

function selection(o: CommonOpts): Selection {
  const sel: Selection = { cwd: o.cwd, matrix: o.matrix };
  if (o.config !== undefined) sel.config = o.config;
  if (o.workflow) sel.workflows = o.workflow;
  if (o.job) sel.jobs = o.job;
  if (o.step) sel.steps = o.step;
  return sel;
}

/** `-C`, with the default described in words so help never prints the machine's own path. */
const cwdOption = (): Option =>
  new Option('-C, --cwd <dir>', 'run as if started in <dir>').default(
    process.cwd(),
    'the current directory',
  );

function withSelection(cmd: Command): Command {
  return cmd
    .addOption(cwdOption())
    .option('--config <path>', 'config file (default: falsegreen.config.yml)')
    .option('--workflow <file...>', 'only these workflow files')
    .option('--job <id...>', 'only these jobs (id, name or check name)')
    .option('--step <name...>', 'only these steps (as named in the report)')
    .addOption(
      new Option(
        '--matrix <which>',
        'first: each step once, in the first matrix leg that runs it; all: every leg, up to matrix.max',
      )
        .choices(['first', 'all'])
        .default('first'),
    );
}

function withReports(cmd: Command): Command {
  return cmd
    .addOption(
      new Option('--fail-on <severity>', 'lowest severity that fails the run').choices([
        ...SEVERITY_ORDER,
      ]),
    )
    .option('--out <dir>', 'report directory', 'falsegreen-report')
    .option('--formats <list>', `report formats: ${FORMATS.join(', ')}`, 'json,md')
    .addOption(
      new Option('--log-level <level>', 'progress output')
        .choices(['silent', 'info'])
        .default('info'),
    )
    .addOption(
      new Option(
        '--required-checks <mode>',
        'read branch protection and rulesets through the GitHub API',
      )
        .choices(['auto', 'off'])
        .default('auto'),
    )
    .option('--branch <name>', 'branch whose required checks apply (default: the default branch)')
    .option('--token-env <name>', 'environment variable holding the GitHub token');
}

function withReplay(cmd: Command): Command {
  return cmd
    .addOption(
      new Option('--tier <tier>', 'fault tiers to plant')
        .choices(['reach', 'semantic', 'both'])
        .default('both'),
    )
    .option(
      '--assume-green',
      'skip the clean baseline run (use after the gates already passed in this job)',
    )
    .option(
      '--timeout <minutes>',
      'per-run timeout in minutes, unless the step sets timeout-minutes',
      '15',
    );
}

interface RunOpts extends CommonOpts {
  failOn?: Severity;
  out: string;
  formats: string;
  logLevel: 'silent' | 'info';
  requiredChecks: 'auto' | 'off';
  branch?: string;
  tokenEnv?: string;
  tier?: 'reach' | 'semantic' | 'both';
  assumeGreen?: boolean;
  timeout?: string;
}

function parseFormats(list: string): Format[] {
  const formats = list
    .split(',')
    .map((f) => f.trim())
    .filter((f) => f !== '');
  const bad = formats.filter((f) => !FORMATS.includes(f as Format));
  if (bad.length > 0)
    throw new FalsegreenError(`unknown report format ${bad.join(', ')}; use ${FORMATS.join(', ')}`);
  return formats as Format[];
}

export function buildProgram(io: CliIO = defaultIO()): Command {
  const program = new Command()
    .name('falsegreen')
    .description(
      'Proves your CI gates can fail: plants known faults, runs each gate the way your workflow does, and reports every check that stays green anyway.',
    )
    .version(version);

  /** Runs a command body; falsegreen's own errors become exit code 2 with a message. */
  const guarded = (body: () => Promise<number> | number) => async (): Promise<void> => {
    try {
      io.setExitCode(await body());
    } catch (err) {
      io.err(`falsegreen: ${err instanceof Error ? err.message : String(err)}\n`);
      io.setExitCode(2);
    }
  };

  const runAs = (command: 'run' | 'static' | 'local') => (o: RunOpts) =>
    guarded(async () => {
      const tiers: Tier[] = o.tier === undefined || o.tier === 'both' ? [...TIERS] : [o.tier];
      const outcome = await runCommand(
        {
          ...selection(o),
          command,
          tiers,
          assumeGreen: o.assumeGreen === true,
          timeoutMs: Number(o.timeout ?? '15') * 60_000,
          ...(o.failOn === undefined ? {} : { failOn: o.failOn }),
          out: o.out,
          formats: parseFormats(o.formats),
          quiet: o.logLevel === 'silent',
          requiredChecks: o.requiredChecks,
          ...(o.branch === undefined ? {} : { branch: o.branch }),
          ...(o.tokenEnv === undefined ? {} : { tokenEnv: o.tokenEnv }),
        },
        io,
      );
      return outcome.exitCode;
    })();

  withReplay(withReports(withSelection(program.command('run', { isDefault: true }))))
    .description('static checks, then replay every gate with planted faults (the default)')
    .action(runAs('run'));
  withReports(withSelection(program.command('static')))
    .description('check workflow settings and shell code only; runs nothing')
    .action(runAs('static'));
  withReplay(withReports(withSelection(program.command('local'))))
    .description('replay every gate with planted faults')
    .action(runAs('local'));
  withReports(withSelection(program.command('remote')))
    .description(
      'run the workflows on throwaway branches with planted faults (prints the plan unless --yes)',
    )
    .option('--yes', 'push the branches and start the runs; without it only the plan is printed')
    .option('--pr', 'open draft pull requests for workflows that run only on pull_request')
    .option('--delete-runs', 'delete the workflow runs afterwards')
    .option('--keep-branch', 'keep the throwaway branches, for debugging')
    .option('--timeout <minutes>', 'how long to wait for the runs (default: remote.timeoutMinutes)')
    .action(
      (o: RunOpts & { yes?: boolean; pr?: boolean; deleteRuns?: boolean; keepBranch?: boolean }) =>
        guarded(async () => {
          const outcome = await remoteCommand(
            {
              ...selection(o),
              yes: o.yes === true,
              pr: o.pr === true,
              deleteRuns: o.deleteRuns === true,
              keepBranch: o.keepBranch === true,
              ...(o.timeout === undefined ? {} : { timeoutMs: Number(o.timeout) * 60_000 }),
              ...(o.failOn === undefined ? {} : { failOn: o.failOn }),
              out: o.out,
              formats: parseFormats(o.formats),
              ...(o.tokenEnv === undefined ? {} : { tokenEnv: o.tokenEnv }),
              ...(o.branch === undefined ? {} : { branch: o.branch }),
            },
            io,
          );
          return outcome.exitCode;
        })(),
    );
  withSelection(program.command('list'))
    .description('print each gate and the faults it would get; plants nothing')
    .action((o: CommonOpts) => guarded(() => listCommand(selection(o), io))());
  program
    .command('clean')
    .description('restore files left behind by an interrupted run')
    .addOption(cwdOption())
    .action((o: { cwd: string }) => guarded(() => cleanCommand(o.cwd, io))());
  program
    .command('init')
    .description('write falsegreen.config.yml and a workflow that runs falsegreen')
    .addOption(cwdOption())
    .action((o: { cwd: string }) => guarded(() => initCommand(o.cwd, io))());
  return program;
}

export async function runCli(argv: string[]): Promise<void> {
  await buildProgram().parseAsync(argv);
}
