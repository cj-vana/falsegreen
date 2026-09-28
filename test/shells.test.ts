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

  it('keeps host credentials out of the step, as a runner does', async () => {
    // A runner gives a step secrets only through the workflow's env:, which is never rebuilt.
    process.env.FG_TEST_API_TOKEN = 'not-a-real-value';
    process.env.FG_TEST_CUSTOM = 'named by --token-env';
    try {
      const gate = fakeGate({
        run: 'echo "[${FG_TEST_API_TOKEN:-unset}] [${FG_TEST_CUSTOM:-unset}] [${HOME:+home}]"',
      });
      const r = await runStep(makeTempDir('step'), gate, {
        timeoutMs: 10_000,
        stripEnv: ['FG_TEST_CUSTOM'],
      });
      expect(r.output.trim()).toBe('[unset] [unset] [home]');
    } finally {
      delete process.env.FG_TEST_API_TOKEN;
      delete process.env.FG_TEST_CUSTOM;
    }
  });

  it("points the runner's variables at the repository and at files of the step's own", async () => {
    const root = makeTempDir('step');
    const gate = fakeGate({
      run: [
        'echo "workspace=$GITHUB_WORKSPACE"',
        'test -d "$RUNNER_TEMP" && echo temp-ok',
        'echo "X=1" >> "$GITHUB_ENV" && echo env-ok',
        'test "$GITHUB_OUTPUT" != "$HOST_GITHUB_OUTPUT" && echo output-ok',
      ].join('\n'),
      env: { HOST_GITHUB_OUTPUT: process.env.GITHUB_OUTPUT ?? 'none' },
    });
    const r = await runStep(root, gate, { timeoutMs: 10_000 });
    expect(r.output.trim().split('\n')).toEqual([
      `workspace=${root}`,
      'temp-ok',
      'env-ok',
      'output-ok',
    ]);
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
