/** package.json scripts behind `npm test`, `pnpm run lint`, `yarn check`, `bun run ci`. */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

export interface ScriptCall {
  runner: 'npm' | 'pnpm' | 'yarn' | 'bun';
  name: string;
  /** Repo-relative directory to look for package.json from. */
  dir: string;
  ifPresent: boolean;
  /** pnpm and yarn run a package binary when no script has the name. */
  fallback?: string[];
}

const NPM_BUILTINS = new Set([
  'install',
  'i',
  'ci',
  'add',
  'uninstall',
  'update',
  'publish',
  'pack',
  'exec',
  'init',
  'link',
  'audit',
  'outdated',
  'version',
  'config',
  'cache',
  'prune',
  'rebuild',
  'dedupe',
  'ls',
  'list',
  'view',
  'why',
  'login',
  'whoami',
  'dlx',
  'x',
  'create',
  'remove',
  'rm',
  'up',
  'upgrade',
  'store',
  'setup',
  'env',
  'import',
  'patch',
  'fetch',
  'deploy',
  'workspaces',
  'workspace',
  'constraints',
  'dedup',
  'node',
  'plugin',
  'set',
  'unplug',
  'info',
]);

const VALUE_FLAGS = new Set([
  '--prefix',
  '-w',
  '--workspace',
  '-C',
  '--dir',
  '--filter',
  '-F',
  '--cwd',
]);

function parse(argv: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') break;
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      if (eq > 0) flags.set(a.slice(0, eq), a.slice(eq + 1));
      else if (VALUE_FLAGS.has(a)) flags.set(a, argv[++i] ?? '');
      else flags.set(a, true);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function dirFlag(flags: Map<string, string | true>, cwd: string, names: string[]): string {
  for (const n of names) {
    const v = flags.get(n);
    if (typeof v === 'string' && v !== '') {
      return posix.normalize(posix.join(cwd, v)).replace(/\/$/, '').replace(/^\.$/, '');
    }
  }
  return cwd;
}

export function scriptCall(argv: string[], cwd: string): ScriptCall | undefined {
  const runner = argv[0];
  if (runner !== 'npm' && runner !== 'pnpm' && runner !== 'yarn' && runner !== 'bun')
    return undefined;
  const { positional, flags } = parse(argv);
  const [sub, next] = positional;
  if (sub === undefined) return undefined;
  const ifPresent = flags.has('--if-present');
  const subIndex = argv.indexOf(sub);

  if (runner === 'npm') {
    const dir = dirFlag(flags, cwd, ['--prefix', '-w', '--workspace']);
    if (['test', 't', 'tst', 'start', 'stop', 'restart'].includes(sub)) {
      return { runner, name: sub.startsWith('t') ? 'test' : sub, dir, ifPresent };
    }
    if (['run', 'run-script', 'rum', 'urn'].includes(sub) && next !== undefined) {
      return { runner, name: next, dir, ifPresent };
    }
    return undefined;
  }
  if (runner === 'bun') {
    return sub === 'run' && next !== undefined
      ? { runner, name: next, dir: cwd, ifPresent, fallback: argv.slice(argv.indexOf(next)) }
      : undefined;
  }
  const dir = dirFlag(flags, cwd, ['-C', '--dir', '--cwd']);
  if (sub === 'run' && next !== undefined) return { runner, name: next, dir, ifPresent };
  if (sub === 'test' || sub === 't') return { runner, name: 'test', dir, ifPresent };
  if (NPM_BUILTINS.has(sub)) return undefined;
  return { runner, name: sub, dir, ifPresent, fallback: argv.slice(subIndex) };
}

/** The script named `name` in the nearest package.json at or above `dir`. */
export function scriptFor(
  root: string,
  dir: string,
  name: string,
): { text: string; packageDir: string } | undefined {
  let current = dir;
  for (;;) {
    const file = join(root, current, 'package.json');
    if (existsSync(file)) {
      try {
        const scripts = (
          JSON.parse(readFileSync(file, 'utf8')) as { scripts?: Record<string, unknown> }
        ).scripts;
        const text = scripts?.[name];
        if (typeof text === 'string') return { text, packageDir: current };
      } catch {
        // An unreadable package.json has no usable scripts.
      }
      return undefined;
    }
    if (current === '') return undefined;
    const parent = posix.dirname(current);
    current = parent === '.' ? '' : parent;
  }
}
