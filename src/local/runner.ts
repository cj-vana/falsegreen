/** Runs one gate step the way a runner would: its text in a script file, under its shell. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

export async function runStep(
  root: string,
  gate: Gate,
  opts: { timeoutMs: number },
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
      // What a runner sets comes first, so the workflow's own env can still override it.
      env: { ...process.env, ...RUNNER_ENV, ...gate.env },
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
