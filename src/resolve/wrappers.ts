/** Strips the launchers that sit in front of a check tool: npx, uv run, python -m, env, ... */
import { basename } from 'node:path';

/** Flags that take a separate value, per wrapper, so the value is not mistaken for the command. */
const VALUE_FLAGS: Record<string, Set<string>> = {
  npx: new Set(['-p', '--package', '-c', '--call', '--cache', '--registry', '-w', '--workspace']),
  'uv run': new Set([
    '--with',
    '--with-requirements',
    '--with-editable',
    '--python',
    '-p',
    '--project',
    '--directory',
    '--package',
    '--group',
    '--extra',
    '--env-file',
    '--index',
    '--index-url',
  ]),
  'pdm run': new Set(['-p', '--project']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  sudo: new Set(['-u', '--user', '-g', '--group']),
  'xvfb-run': new Set(['-s', '--server-args', '-n', '--server-num', '-e', '--error-file']),
};

function skipFlags(argv: string[], from: number, wrapper: string): number {
  const values = VALUE_FLAGS[wrapper] ?? new Set<string>();
  let i = from;
  while (i < argv.length && argv[i]!.startsWith('-')) {
    const flag = argv[i]!;
    if (flag === '--') return i + 1;
    i += values.has(flag) ? 2 : 1;
  }
  return i;
}

const isPython = (name: string): boolean => /^python(\d+(\.\d+)?)?$/.test(name);

/** Applies one wrapper; undefined when argv does not start with one. */
function stripOne(argv: string[]): { argv: string[]; wrapper: string } | undefined {
  const [head, second] = argv;
  if (head === undefined) return undefined;
  const two = second === undefined ? '' : `${head} ${second}`;

  if (head === 'npx' || head === 'bunx') {
    return { argv: argv.slice(skipFlags(argv, 1, 'npx')), wrapper: head };
  }
  if (
    [
      'pnpm exec',
      'pnpm dlx',
      'yarn dlx',
      'yarn exec',
      'bun x',
      'poetry run',
      'pipenv run',
      'hatch run',
      'rye run',
    ].includes(two)
  ) {
    return { argv: argv.slice(skipFlags(argv, 2, two)), wrapper: two };
  }
  if (two === 'uv run' || two === 'pdm run') {
    return { argv: argv.slice(skipFlags(argv, 2, two)), wrapper: two };
  }
  if (isPython(head) && second === '-m' && argv[2] !== undefined) {
    return { argv: argv.slice(2), wrapper: 'python -m' };
  }
  if (head === 'env') {
    let i = skipFlags(argv, 1, 'env');
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
    return { argv: argv.slice(i), wrapper: 'env' };
  }
  if (head === 'time' || head === 'nice' || head === 'sudo' || head === 'xvfb-run') {
    return { argv: argv.slice(skipFlags(argv, 1, head)), wrapper: head };
  }
  if (head === 'timeout') {
    const i = skipFlags(argv, 1, 'timeout');
    return { argv: argv.slice(i + 1), wrapper: 'timeout' };
  }
  return undefined;
}

/** Strips every leading wrapper; `wrapper` names the outermost one. */
export function stripWrappers(argv: string[]): { argv: string[]; wrapper?: string } {
  let current = argv.map((a, i) => (i === 0 && a.includes('/') ? basename(a) : a));
  let wrapper: string | undefined;
  for (let depth = 0; depth < 8; depth++) {
    const next = stripOne(current);
    if (!next || next.argv.length === 0) break;
    wrapper ??= next.wrapper;
    current = next.argv.map((a, i) => (i === 0 && a.includes('/') ? basename(a) : a));
  }
  return wrapper === undefined ? { argv: current } : { argv: current, wrapper };
}
