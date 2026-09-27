/** Runs one gate step the way a runner would: its text in a script file, under its shell. */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProcess, type ProcResult } from '../core/proc';
import type { Gate } from '../resolve/gates';
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
    return await runProcess(command.cmd, command.args, {
      cwd,
      env: { ...process.env, ...gate.env, CI: 'true' },
      timeoutMs: opts.timeoutMs,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
