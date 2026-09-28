/** Runs one gate step the way a runner would: its text in a script file, under its shell. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess, type ProcResult } from '../core/proc';
import type { Gate } from '../resolve/gates';
import { RUNNER_ENV } from '../shell/runner';
import { shellCommand } from './shells';

function refused(reason: string): ProcResult {
  return {
    exitCode: null,
    signal: null,
    timedOut: false,
    spawnError: reason,
    output: '',
    durationMs: 0,
  };
}

/**
 * Host variables that hold credentials. A runner hands a step secrets only through the workflow's
 * `env:`, which falsegreen never rebuilds, so a replayed step gets none of the host's either: a
 * step that publishes finds nothing to publish with, and nothing secret reaches its output.
 */
const CREDENTIAL = /TOKEN|SECRET|PASSW(OR)?D|API_?KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL|AUTH/i;

/** GitHub's file commands; the step appends to throwaway files, not to the caller's job. */
const FILE_COMMANDS = [
  'GITHUB_ENV',
  'GITHUB_OUTPUT',
  'GITHUB_PATH',
  'GITHUB_STATE',
  'GITHUB_STEP_SUMMARY',
];

function replayEnv(
  root: string,
  dir: string,
  gate: Gate,
  stripEnv: string[],
): Record<string, string | undefined> {
  const host = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !CREDENTIAL.test(k) && !stripEnv.includes(k)),
  );
  const runnerTemp = join(dir, 'runner-temp');
  mkdirSync(runnerTemp);
  const files = Object.fromEntries(
    FILE_COMMANDS.map((name) => {
      const path = join(dir, name.toLowerCase());
      writeFileSync(path, '');
      return [name, path];
    }),
  );
  return {
    ...host,
    ...RUNNER_ENV,
    GITHUB_WORKSPACE: root,
    RUNNER_TEMP: runnerTemp,
    RUNNER_OS:
      process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
    ...files,
    // The workflow's own env comes last, so it can still override any of the above.
    ...gate.env,
  };
}

export async function runStep(
  root: string,
  gate: Gate,
  opts: { timeoutMs: number; stripEnv?: string[] },
): Promise<ProcResult> {
  const cwd = join(root, gate.workingDirectory);
  if (!existsSync(cwd)) return refused(`working-directory ${gate.workingDirectory} does not exist`);
  const dir = mkdtempSync(join(tmpdir(), 'falsegreen-step-'));
  try {
    const script = join(dir, gate.shell === 'python' ? 'step.py' : 'step.sh');
    writeFileSync(script, `${gate.run ?? ''}\n`);
    const command = shellCommand(gate.shell, script);
    if ('unsupported' in command) return refused(`shell ${command.unsupported} cannot run here`);
    const result = await runProcess(command.cmd, command.args, {
      cwd,
      env: replayEnv(root, dir, gate, opts.stripEnv ?? []),
      timeoutMs: opts.timeoutMs,
    });
    if (result.spawnError?.includes('ENOENT')) {
      return refused(`the step runs under ${command.cmd}, which is not installed here`);
    }
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
