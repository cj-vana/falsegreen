import { describe, expect, it, vi } from 'vitest';

import { buildProgram, runCli } from '../src/cli-program';
import { version } from '../src/version';

function runProgram(args: string[]): { out: string; code: number | undefined } {
  let out = '';
  const program = buildProgram()
    .exitOverride()
    .configureOutput({ writeOut: (s) => (out += s), writeErr: (s) => (out += s) });
  try {
    program.parse(['node', 'falsegreen', ...args]);
    return { out, code: undefined };
  } catch (err) {
    return { out, code: (err as { exitCode?: number }).exitCode };
  }
}

describe('cli', () => {
  it('prints the package version', () => {
    const result = runProgram(['--version']);
    expect(result.out.trim()).toBe(version);
    expect(result.code).toBe(0);
  });

  it('runCli parses the argv it is given', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(runCli(['node', 'falsegreen', '--version'])).rejects.toThrow('exit 0');
      expect(write).toHaveBeenCalledWith(`${version}\n`);
    } finally {
      exit.mockRestore();
      write.mockRestore();
    }
  });

  it('rejects an unknown option', () => {
    const result = runProgram(['--no-such-flag']);
    expect(result.out).toContain("unknown option '--no-such-flag'");
    expect(result.code).toBe(1);
  });
});
