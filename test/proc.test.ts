import { describe, expect, it } from 'vitest';

import { runProcess, stopLiveGroups } from '../src/core/proc';

const base = { cwd: process.cwd(), env: process.env, timeoutMs: 10_000 };

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('runProcess', () => {
  it('returns the exit code', async () => {
    const r = await runProcess('sh', ['-c', 'exit 3'], base);
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it('captures stdout and stderr together', async () => {
    const r = await runProcess('sh', ['-c', 'echo out; echo err >&2'], base);
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
  });

  it('kills the whole process group on timeout', async () => {
    const started = Date.now();
    const r = await runProcess('sh', ['-c', 'sleep 30 & echo "child $!"; wait'], {
      ...base,
      timeoutMs: 300,
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(/child (\d+)/.exec(r.output)?.[1]);
    expect(pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(pid)).toBe(false);
  });

  it('ends background processes a step leaves behind, as a runner does', async () => {
    // The background sleep holds stdout open; before, the run waited for it until the timeout.
    const started = Date.now();
    const r = await runProcess('sh', ['-c', 'sleep 30 & echo "child $!"'], base);
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(/child (\d+)/.exec(r.output)?.[1]);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(alive(pid)).toBe(false);
  });

  it('stops every running step when asked, for Ctrl-C and SIGTERM', async () => {
    const started = Date.now();
    const running = runProcess('sh', ['-c', 'sleep 30 & echo "child $!"; wait'], base);
    await new Promise((resolve) => setTimeout(resolve, 300));
    stopLiveGroups();
    const r = await running;
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(/child (\d+)/.exec(r.output)?.[1]);
    expect(alive(pid)).toBe(false);
  });

  it('reports a missing executable as a spawn error', async () => {
    const r = await runProcess('falsegreen-no-such-binary', [], base);
    expect(r.spawnError).toContain('ENOENT');
    expect(r.exitCode).toBeNull();
  });

  it('keeps the head and tail of oversized output', async () => {
    const r = await runProcess(
      'sh',
      [
        '-c',
        'echo FIRST; i=0; while [ $i -lt 5000 ]; do echo filler-line; i=$((i+1)); done; echo LAST',
      ],
      { ...base, maxOutputBytes: 2_000 },
    );
    expect(r.output.startsWith('FIRST')).toBe(true);
    expect(r.output.trimEnd().endsWith('LAST')).toBe(true);
    expect(r.output).toMatch(/\[\.\.\. \d+ bytes cut \.\.\.\]/);
    expect(r.output.length).toBeLessThan(2_200);
  });
});
