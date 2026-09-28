import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runProcess } from '../src/core/proc';
import { runStep } from '../src/local/runner';
import { shellCommand } from '../src/local/shells';
import { fakeGate } from './helpers/gate';
import { makeTempDir } from './helpers/repo';

// Templates from https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
describe('shellCommand', () => {
  it.each([
    [undefined, { cmd: 'bash', args: ['-e', '/s.sh'] }],
    ['bash', { cmd: 'bash', args: ['--noprofile', '--norc', '-eo', 'pipefail', '/s.sh'] }],
    ['sh', { cmd: 'sh', args: ['-e', '/s.sh'] }],
    ['python', { cmd: 'python', args: ['/s.sh'] }],
    ['bash -x {0}', { cmd: 'bash', args: ['-x', '/s.sh'] }],
    ['pwsh', { cmd: 'pwsh', args: ['-command', ". '/s.sh'"] }],
  ])('%s', (shell, expected) => {
    expect(shellCommand(shell, '/s.sh')).toEqual(expected);
  });

  it('refuses shells it cannot run here', () => {
    expect(shellCommand('cmd', '/s.sh')).toEqual({ unsupported: 'cmd' });
    expect(shellCommand('powershell', '/s.sh')).toEqual({ unsupported: 'powershell' });
  });

  it('matches GitHub: the default shell ignores a failure inside a pipe, shell: bash does not', async () => {
    const dir = makeTempDir('shell');
    const script = join(dir, 'step.sh');
    writeFileSync(script, 'false | true\n');
    const run = async (shell: string | undefined) => {
      const c = shellCommand(shell, script);
      if ('unsupported' in c) throw new Error('unsupported');
      return (await runProcess(c.cmd, c.args, { cwd: dir, env: process.env, timeoutMs: 10_000 }))
        .exitCode;
    };
    expect(await run(undefined)).toBe(0);
    expect(await run('bash')).toBe(1);
  });
});

describe('runStep', () => {
  it('runs the step with the variables a runner sets, so scripts take their CI branches', async () => {
    const gate = fakeGate({
      run: 'test "$GITHUB_ACTIONS" = true && test "$CI" = true && echo "$FROM_STEP"',
      env: { FROM_STEP: 'step env' },
    });
    const r = await runStep(makeTempDir('step'), gate, { timeoutMs: 10_000 });
    expect(r.exitCode).toBe(0);
    expect(r.output.trim()).toBe('step env');
  });

  it('says which shell is missing when a custom shell is not installed', async () => {
    // spf13/cobra's Windows job runs its steps under `shell: msys2 {0}`.
    const gate = fakeGate({ run: 'make test', shell: 'falsegreen-no-such-shell {0}' });
    const r = await runStep(makeTempDir('step'), gate, { timeoutMs: 10_000 });
    expect(r.spawnError).toBe(
      'the step runs under falsegreen-no-such-shell, which is not installed here',
    );
  });
});
