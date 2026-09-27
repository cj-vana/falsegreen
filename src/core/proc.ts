/** Runs a command in its own process group so a timeout can take down everything it started. */
import { spawn } from 'node:child_process';

export interface ProcResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  /** Set when the executable could not be started at all (for example ENOENT). */
  spawnError?: string;
  /** stdout and stderr interleaved in arrival order, capped at maxOutputBytes. */
  output: string;
  durationMs: number;
}

export interface ProcOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT = 2 * 1024 * 1024;
const KILL_GRACE_MS = 2_000;

/** Keeps the first and last halves of a stream once it outgrows the cap. */
class CappedOutput {
  private head = '';
  private tail: string[] = [];
  private tailLength = 0;
  private cut = 0;
  private readonly half: number;

  constructor(max: number) {
    this.half = Math.floor(max / 2);
  }

  push(chunk: string): void {
    if (this.head.length < this.half) {
      const room = this.half - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      if (chunk === '') return;
    }
    this.tail.push(chunk);
    this.tailLength += chunk.length;
    while (this.tailLength > this.half && this.tail.length > 0) {
      const first = this.tail[0]!;
      const excess = this.tailLength - this.half;
      if (first.length <= excess) {
        this.tail.shift();
        this.tailLength -= first.length;
        this.cut += first.length;
      } else {
        this.tail[0] = first.slice(excess);
        this.tailLength -= excess;
        this.cut += excess;
      }
    }
  }

  toString(): string {
    const marker = this.cut > 0 ? `\n[... ${this.cut} bytes cut ...]\n` : '';
    return this.head + marker + this.tail.join('');
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The group is already gone.
  }
}

export function runProcess(cmd: string, args: string[], opts: ProcOptions): Promise<ProcResult> {
  const started = Date.now();
  const output = new CappedOutput(opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT);

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let spawnError: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const finish = (exitCode: number | null, signal: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        exitCode: spawnError ? null : exitCode,
        signal,
        timedOut,
        ...(spawnError ? { spawnError } : {}),
        output: output.toString(),
        durationMs: Date.now() - started,
      });
    };

    const timer = setTimeout(() => {
      if (child.pid === undefined) return;
      timedOut = true;
      killGroup(child.pid, 'SIGTERM');
      killTimer = setTimeout(() => killGroup(child.pid!, 'SIGKILL'), KILL_GRACE_MS);
    }, opts.timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (s: string) => output.push(s));
    child.stderr.setEncoding('utf8').on('data', (s: string) => output.push(s));
    child.on('error', (err: NodeJS.ErrnoException) => {
      spawnError = `${err.code ?? 'ERROR'}: ${err.message}`;
      finish(null, null);
    });
    child.on('close', (code, signal) => {
      // A timed-out shell can exit before the children it started; make sure they go too.
      if (timedOut && child.pid !== undefined) killGroup(child.pid, 'SIGKILL');
      finish(code, signal);
    });
  });
}
