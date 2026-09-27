/**
 * Recognizes check tools in a command's argv. A command that writes files (`eslint --fix`,
 * `prettier --write`, `black .`) is not a gate: replaying it would rewrite the user's code.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';

import { trackedFiles } from '../core/git';
import type { ToolId, ToolInvocation } from '../faults/types';
import { stripWrappers } from './wrappers';

/** Flags that take a separate value, per executable, so values are not read as paths. */
const VALUE_FLAGS: Record<string, string[]> = {
  vitest: [
    '-c',
    '--config',
    '--root',
    '--dir',
    '--reporter',
    '--shard',
    '--environment',
    '--project',
    '-t',
    '--testNamePattern',
  ],
  jest: [
    '-c',
    '--config',
    '-t',
    '--testNamePattern',
    '--testPathPattern',
    '--reporters',
    '--shard',
    '--selectProjects',
    '--rootDir',
  ],
  mocha: [
    '-r',
    '--require',
    '-R',
    '--reporter',
    '-t',
    '--timeout',
    '-g',
    '--grep',
    '--config',
    '--ui',
    '-u',
  ],
  node: [
    '--import',
    '-r',
    '--require',
    '--loader',
    '--experimental-loader',
    '--test-reporter',
    '--test-reporter-destination',
    '--test-name-pattern',
    '--test-concurrency',
  ],
  bun: ['-t', '--test-name-pattern', '--timeout', '--preload'],
  tsc: ['-p', '--project', '--target', '--module', '--outDir', '--rootDir'],
  'vue-tsc': ['-p', '--project'],
  eslint: [
    '-c',
    '--config',
    '--ext',
    '--ignore-path',
    '-f',
    '--format',
    '--max-warnings',
    '--rulesdir',
    '--resolve-plugins-relative-to',
    '--parser',
    '--plugin',
    '-o',
    '--output-file',
    '--cache-location',
  ],
  biome: [
    '--config-path',
    '--max-diagnostics',
    '--reporter',
    '--diagnostic-level',
    '--log-level',
    '--since',
    '--vcs-root',
  ],
  oxlint: [
    '-c',
    '--config',
    '--tsconfig',
    '-A',
    '--allow',
    '-W',
    '--warn',
    '-D',
    '--deny',
    '--max-warnings',
    '-f',
    '--format',
  ],
  prettier: ['--config', '--ignore-path', '--log-level', '--plugin', '--parser'],
  pytest: [
    '-k',
    '-m',
    '-c',
    '-p',
    '--deselect',
    '--ignore',
    '--junitxml',
    '-n',
    '--maxfail',
    '--tb',
    '--cov',
    '--cov-report',
    '-o',
    '--rootdir',
    '--durations',
  ],
  unittest: ['-s', '--start-directory', '-p', '--pattern', '-t', '--top-level-directory', '-k'],
  mypy: [
    '--config-file',
    '--python-version',
    '--exclude',
    '-p',
    '--package',
    '-m',
    '--module',
    '--cache-dir',
  ],
  ruff: [
    '--config',
    '--select',
    '--ignore',
    '--extend-select',
    '--extend-ignore',
    '--exclude',
    '--target-version',
    '--line-length',
    '--output-format',
  ],
  flake8: [
    '--config',
    '--select',
    '--ignore',
    '--extend-ignore',
    '--max-line-length',
    '--exclude',
    '--format',
  ],
  pylint: ['--rcfile', '--disable', '--enable', '-j', '--jobs', '--output-format', '--ignore'],
  pyright: ['-p', '--project', '--pythonversion', '--pythonplatform'],
  basedpyright: ['-p', '--project', '--pythonversion', '--pythonplatform'],
  black: [
    '--config',
    '-l',
    '--line-length',
    '-t',
    '--target-version',
    '--exclude',
    '--extend-exclude',
    '--include',
  ],
  isort: ['--settings-path', '--sp', '--profile', '-l', '--line-length', '--skip'],
  go: [
    '-run',
    '-timeout',
    '-count',
    '-p',
    '-parallel',
    '-coverprofile',
    '-tags',
    '-bench',
    '-covermode',
    '-coverpkg',
    '-o',
    '-exec',
    '-vettool',
  ],
  'golangci-lint': [
    '-c',
    '--config',
    '--timeout',
    '-E',
    '--enable',
    '-D',
    '--disable',
    '--out-format',
    '--new-from-rev',
    '--build-tags',
  ],
  staticcheck: ['-checks', '-tags', '-f', '-go'],
  gofmt: ['-r'],
  cargo: [
    '-p',
    '--package',
    '--manifest-path',
    '--features',
    '-F',
    '--target',
    '--target-dir',
    '-j',
    '--jobs',
    '--profile',
    '--bin',
    '--test',
    '--example',
    '--exclude',
  ],
  gradle: [
    '-p',
    '--project-dir',
    '-x',
    '--exclude-task',
    '-I',
    '--init-script',
    '-c',
    '--settings-file',
    '--max-workers',
  ],
  mvn: [
    '-pl',
    '--projects',
    '-f',
    '--file',
    '-P',
    '--activate-profiles',
    '-s',
    '--settings',
    '-T',
    '--threads',
    '-rf',
    '--resume-from',
  ],
};

/** Config files passed as arguments are not places to plant faults (`.eslintrc`, `setup.cfg`). */
const CONFIG_LIKE = /(\.(json|jsonc|ya?ml|toml|ini|cfg|xml)|(^|\/)\.[^/]*rc(\.[a-z]+)?)$/i;

interface Ctx {
  root: string;
  cwd: string;
  exe: string;
}

function positionals(argv: string[], exe: string, from = 1): string[] {
  const takesValue = new Set(VALUE_FLAGS[exe] ?? []);
  const out: string[] = [];
  for (let i = from; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (takesValue.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function flagValue(argv: string[], names: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (names.includes(a)) return argv[i + 1];
    for (const n of names) if (a.startsWith(`${n}=`)) return a.slice(n.length + 1);
  }
  return undefined;
}

const has = (argv: string[], ...flags: string[]): boolean =>
  argv.some(
    (a) => flags.includes(a) || flags.some((f) => f.startsWith('--') && a.startsWith(`${f}=`)),
  );

function repoPath(cwd: string, p: string): string {
  const joined = posix.normalize(posix.join(cwd, p)).replace(/\/$/, '');
  return joined === '' ? '.' : joined;
}

/** Positional arguments that name existing files or directories, repo-relative. */
function existingPaths(args: string[], ctx: Ctx): string[] {
  return args
    .map((a) => a.replace(/\/\.\.\.$/, '').replace(/^\.\.\.$/, '.'))
    .filter((a) => !CONFIG_LIKE.test(a) && existsSync(join(ctx.root, ctx.cwd, a)))
    .map((a) => repoPath(ctx.cwd, a));
}

function invocation(tool: ToolId, argv: string[], ctx: Ctx, paths: string[] = []): ToolInvocation {
  return { tool, argv, cwd: ctx.cwd, pathArgs: paths, via: [argv.join(' ')] };
}

function simple(tool: ToolId, argv: string[], ctx: Ctx, from = 1): ToolInvocation[] {
  return [invocation(tool, argv, ctx, existingPaths(positionals(argv, ctx.exe, from), ctx))];
}

function js(argv: string[], ctx: Ctx): ToolInvocation[] | undefined {
  const [exe, sub] = argv;
  switch (exe) {
    case 'vitest':
      if (
        ['watch', 'dev', 'bench', 'init', 'list'].includes(sub ?? '') ||
        has(argv, '--watch', '-w')
      )
        return [];
      return simple('vitest', argv, ctx, sub === 'run' || sub === 'related' ? 2 : 1);
    case 'jest':
      return has(argv, '--watch', '--watchAll') ? [] : simple('jest', argv, ctx);
    case 'mocha':
      return has(argv, '--watch', '-w') ? [] : simple('mocha', argv, ctx);
    case 'node':
      return has(argv, '--test') ? simple('node-test', argv, ctx) : [];
    case 'bun':
      return sub === 'test' ? simple('bun-test', argv, ctx, 2) : [];
    case 'tsc':
    case 'vue-tsc': {
      if (has(argv, '--init', '--showConfig', '--version', '-v', '--help', '-h', '--watch', '-w'))
        return [];
      if (has(argv, '--clean')) return [];
      const inv = invocation(exe, argv, ctx);
      const project = flagValue(argv, ['-p', '--project']);
      if (project !== undefined) inv.project = repoPath(ctx.cwd, project);
      return [inv];
    }
    case 'eslint':
      return has(argv, '--fix', '--init', '--print-config', '--version', '-v')
        ? []
        : simple('eslint', argv, ctx);
    case 'oxlint':
      return has(argv, '--fix', '--fix-suggestions', '--fix-dangerously')
        ? []
        : simple('oxlint', argv, ctx);
    case 'biome': {
      if (has(argv, '--write', '--fix', '--apply', '--apply-unsafe')) return [];
      const paths = existingPaths(positionals(argv, 'biome', 2), ctx);
      if (sub === 'lint') return [invocation('biome-lint', argv, ctx, paths)];
      if (sub === 'format') return [invocation('biome-format', argv, ctx, paths)];
      if (sub === 'check' || sub === 'ci') {
        return [
          invocation('biome-lint', argv, ctx, paths),
          invocation('biome-format', argv, ctx, paths),
        ];
      }
      return [];
    }
    case 'prettier':
      if (has(argv, '--write', '-w')) return [];
      return has(argv, '--check', '-c', '--list-different', '-l')
        ? simple('prettier', argv, ctx)
        : [];
  }
  return undefined;
}

function python(argv: string[], ctx: Ctx): ToolInvocation[] | undefined {
  const [exe, sub] = argv;
  switch (exe) {
    case 'pytest':
    case 'py.test':
      return simple('pytest', argv, { ...ctx, exe: 'pytest' });
    case 'unittest': {
      // `discover tests` names the start directory positionally, like `discover -s tests`.
      const start =
        flagValue(argv, ['-s', '--start-directory']) ??
        (sub === 'discover' ? positionals(argv, 'unittest', 2)[0] : undefined);
      return [
        invocation('unittest', argv, ctx, existingPaths(start === undefined ? [] : [start], ctx)),
      ];
    }
    case 'ruff': {
      if (sub === 'format') {
        return has(argv, '--check', '--diff') ? simple('ruff-format', argv, ctx, 2) : [];
      }
      if (
        ['rule', 'config', 'linter', 'clean', 'version', 'server', 'analyze', 'help'].includes(
          sub ?? '',
        )
      )
        return [];
      if (has(argv, '--fix') && !has(argv, '--exit-non-zero-on-fix')) return [];
      return simple('ruff-check', argv, ctx, sub === 'check' ? 2 : 1);
    }
    case 'flake8':
    case 'pylint':
    case 'mypy':
    case 'pyright':
    case 'basedpyright':
      return simple(exe, argv, ctx);
    case 'black':
      return has(argv, '--check', '--diff') ? simple('black', argv, ctx) : [];
    case 'isort':
      return has(argv, '--check', '--check-only', '-c', '--diff') ? simple('isort', argv, ctx) : [];
  }
  return undefined;
}

function go(argv: string[], ctx: Ctx): ToolInvocation[] | undefined {
  const [exe, sub] = argv;
  switch (exe) {
    case 'go':
      if (sub === 'test') return simple('go-test', argv, ctx, 2);
      if (sub === 'vet') return simple('go-vet', argv, ctx, 2);
      return [];
    case 'gotestsum': {
      const dash = argv.indexOf('--');
      const rest = dash < 0 ? [] : argv.slice(dash + 1);
      return [
        invocation('go-test', argv, ctx, existingPaths(positionals(['go', ...rest], 'go'), ctx)),
      ];
    }
    case 'golangci-lint':
      return sub === 'run' && !has(argv, '--fix') ? simple('golangci-lint', argv, ctx, 2) : [];
    case 'staticcheck':
      return simple('staticcheck', argv, ctx);
    case 'gofmt':
    case 'goimports':
    case 'gofumpt':
      if (has(argv, '-w')) return [];
      return has(argv, '-l', '-d') ? simple(exe, argv, { ...ctx, exe: 'gofmt' }) : [];
  }
  return undefined;
}

/** The directory of the workspace member whose package name is `name`. */
function cargoMemberDir(root: string, name: string): string | undefined {
  for (const file of trackedFiles(root).filter((f) => f.endsWith('Cargo.toml'))) {
    const text = readFileSync(join(root, file), 'utf8');
    if (new RegExp(`^name\\s*=\\s*"${name.replace(/[-.]/g, '\\$&')}"`, 'm').test(text)) {
      const dir = posix.dirname(file);
      return dir === '.' ? '.' : dir;
    }
  }
  return undefined;
}

function rust(argv: string[], ctx: Ctx): ToolInvocation[] | undefined {
  if (argv[0] !== 'cargo') return undefined;
  const rest = argv.slice(1).filter((a) => !a.startsWith('+'));
  // Options cargo takes before the subcommand whose value is a separate word (`cargo --help`).
  const globalValueFlags = ['--color', '--config', '--explain', '-C', '-Z'];
  let subIndex = -1;
  for (let i = 0; i < rest.length && subIndex < 0; i++) {
    if (globalValueFlags.includes(rest[i]!)) i++;
    else if (!rest[i]!.startsWith('-')) subIndex = i;
  }
  const sub = rest[subIndex];
  const dash = argv.indexOf('--');
  const own = dash < 0 ? argv : argv.slice(0, dash);

  const paths: string[] = [];
  const pkg = flagValue(own, ['-p', '--package']);
  if (pkg !== undefined) {
    const dir = cargoMemberDir(ctx.root, pkg);
    if (dir !== undefined) paths.push(dir);
  }
  const manifest = flagValue(own, ['-m', '--manifest-path']);
  if (manifest !== undefined) paths.push(repoPath(ctx.cwd, dirname(manifest)));

  const inv = (tool: ToolId): ToolInvocation[] => [invocation(tool, argv, ctx, paths)];
  switch (sub) {
    case 'test':
    case 't':
      return inv('cargo-test');
    case 'nextest':
      return rest[subIndex + 1] === 'run' ? inv('cargo-nextest') : [];
    case 'clippy':
      return has(own, '--fix') ? [] : inv('cargo-clippy');
    case 'fmt':
      return has(argv, '--check') ? inv('cargo-fmt') : [];
    case 'check':
    case 'c':
    case 'build':
    case 'b':
      return inv('cargo-check');
  }
  return [];
}

const LINT_PLUGIN = /checkstyle|spotless|ktlint|detekt|\bpmd\b|spotbugs/i;

function lintConfigured(root: string, dirs: string[], files: string[]): boolean {
  return dirs.some((dir) =>
    files.some((f) => {
      const p = join(root, dir, f);
      return existsSync(p) && LINT_PLUGIN.test(readFileSync(p, 'utf8'));
    }),
  );
}

function jvm(argv: string[], ctx: Ctx): ToolInvocation[] | undefined {
  const exe = argv[0];
  const gradle = exe === 'gradle' || exe === 'gradlew';
  const maven = exe === 'mvn' || exe === 'mvnw';
  if (!gradle && !maven) return undefined;

  const words = positionals(argv, gradle ? 'gradle' : 'mvn');
  const cats = new Set<'test' | 'lint' | 'compile'>();
  const projectDirs: string[] = [];
  let wantsLintIfConfigured = false;

  if (gradle) {
    const projectDir = flagValue(argv, ['-p', '--project-dir']);
    if (projectDir !== undefined) projectDirs.push(repoPath(ctx.cwd, projectDir));
    for (const task of words) {
      const parts = task.split(':').filter(Boolean);
      const name = parts.at(-1) ?? '';
      if (parts.length > 1) projectDirs.push(repoPath(ctx.cwd, parts.slice(0, -1).join('/')));
      if (name === 'check' || name === 'build') {
        cats.add('test');
        wantsLintIfConfigured = true;
      } else if (name === 'test' || /Test$/.test(name)) cats.add('test');
      else if (
        /^(spotlessCheck|ktlintCheck|detekt|checkstyle\w*|pmd\w*|spotbugs\w*|lint)$/.test(name)
      )
        cats.add('lint');
      else if (/^(compile\w*|classes|assemble|jar)$/.test(name)) cats.add('compile');
    }
  } else {
    const modules = flagValue(argv, ['-pl', '--projects']);
    if (modules !== undefined)
      projectDirs.push(...modules.split(',').map((m) => repoPath(ctx.cwd, m)));
    const file = flagValue(argv, ['-f', '--file']);
    if (file !== undefined) projectDirs.push(repoPath(ctx.cwd, dirname(file)));
    for (const goal of words) {
      if (['test', 'package'].includes(goal)) cats.add('test');
      else if (['verify', 'install', 'deploy'].includes(goal)) {
        cats.add('test');
        wantsLintIfConfigured = true;
      } else if (
        /^(checkstyle|spotless|pmd|spotbugs):(check|apply)$/.test(goal) &&
        !goal.endsWith(':apply')
      ) {
        cats.add('lint');
      } else if (goal === 'compile' || goal === 'test-compile') cats.add('compile');
    }
  }

  const buildFiles = gradle ? ['build.gradle', 'build.gradle.kts'] : ['pom.xml'];
  const dirs = [ctx.cwd || '.', ...projectDirs, '.'];
  if (wantsLintIfConfigured && lintConfigured(ctx.root, dirs, buildFiles)) cats.add('lint');
  if (cats.has('test')) cats.delete('compile');

  const prefix = gradle ? 'gradle' : 'maven';
  const order = ['test', 'lint', 'compile'] as const;
  return order
    .filter((c) => cats.has(c))
    .map((c) => invocation(`${prefix}-${c}` as ToolId, argv, ctx, projectDirs));
}

/** Tool invocations in one command's argv; [] when it runs no recognized check tool. */
export function identify(rawArgv: string[], cwd: string, root: string): ToolInvocation[] {
  const { argv } = stripWrappers(rawArgv);
  if (argv.length === 0) return [];
  const ctx: Ctx = { root, cwd, exe: argv[0]! };
  return (
    js(argv, ctx) ?? python(argv, ctx) ?? go(argv, ctx) ?? rust(argv, ctx) ?? jvm(argv, ctx) ?? []
  );
}
