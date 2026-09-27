/** Make targets, read with `make -n` so the Makefile's own logic decides the commands. */
import { execFileSync } from 'node:child_process';
import { join, posix } from 'node:path';

export interface MakeCall {
  dir: string;
  args: string[];
  label: string;
}

const VALUE_FLAGS = new Set([
  '-C',
  '--directory',
  '-f',
  '--file',
  '--makefile',
  '-j',
  '--jobs',
  '-l',
  '-o',
  '-W',
  '-I',
]);

export function makeCall(argv: string[], cwd: string): MakeCall | undefined {
  if (argv[0] !== 'make' && argv[0] !== 'gmake') return undefined;
  let dir = cwd;
  const args: string[] = [];
  const targets: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-C' || a === '--directory') {
      dir = posix.normalize(posix.join(dir, argv[++i] ?? '')).replace(/^\.$/, '');
    } else if (a.startsWith('-')) {
      args.push(a);
      if (VALUE_FLAGS.has(a) && argv[i + 1] !== undefined) args.push(argv[++i]!);
    } else {
      args.push(a);
      if (!a.includes('=')) targets.push(a);
    }
  }
  const makefile = dir === '' ? 'Makefile' : `${dir}/Makefile`;
  return { dir, args, label: `${makefile}:${targets.join(' ') || '(default)'}` };
}

/**
 * The commands `make -n` prints, or why it could not print them. GNU make (`gmake`) is tried first:
 * on macOS `make` can be Apple's shim, which refuses to run until the Xcode license is accepted.
 */
export function makeDryRun(root: string, call: MakeCall): { output: string } | { error: string } {
  let error = 'make is not installed';
  for (const exe of ['gmake', 'make']) {
    try {
      const output = execFileSync(exe, ['-n', ...call.args], {
        cwd: join(root, call.dir),
        encoding: 'utf8',
        timeout: 15_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { output };
    } catch (err) {
      const e = err as { code?: string; stderr?: string };
      if (e.code === 'ENOENT') continue;
      error = e.stderr?.trim().split('\n')[0] || `${exe} exited with an error`;
      break;
    }
  }
  return { error };
}
