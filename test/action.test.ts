/**
 * The composite action's shell steps, run under bash the way a `shell: bash` step runs on a
 * runner, with stub executables in place of npm and a real falsegreen.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { makeTempDir } from './helpers/repo';

const root = join(import.meta.dirname, '..');
const actionYml = readFileSync(join(root, 'action.yml'), 'utf8');

/** The `run: |` block of the step with this id, dedented. */
function stepScript(id: string): string {
  const lines = actionYml.split('\n');
  const step = lines.indexOf(`    - id: ${id}`);
  const run = lines.findIndex((line, i) => i > step && line.trim() === 'run: |');
  if (step < 0 || run < 0) throw new Error(`action.yml has no run block for step ${id}`);
  const indent = lines[run]!.indexOf('run:') + 2;
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== '' && !line.startsWith(' '.repeat(indent))) break;
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

/** The quoted `default:` of an input, or undefined when it has none. */
function inputDefault(name: string): string | undefined {
  const block = new RegExp(`^ {2}${name}:\\n((?: {4}.*\\n)+)`, 'm').exec(actionYml)?.[1];
  return block === undefined ? undefined : /^ {4}default: '(.*)'$/m.exec(block)?.[1];
}

let sandbox: string;
beforeEach(() => {
  sandbox = makeTempDir('action');
});
afterEach(() => {
  // makeTempDir lives under tmp/, which the suite leaves for inspection.
});

function writeExecutable(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

interface StepResult {
  status: number | null;
  stdout: string;
  outputs: Record<string, string>;
}

function runStep(id: string, env: Record<string, string>, cwd: string): StepResult {
  const script = join(sandbox, `${id}.sh`);
  writeFileSync(script, stepScript(id));
  const outputFile = join(sandbox, 'github-output');
  writeFileSync(outputFile, '');
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: [join(sandbox, 'stubs'), dirname(process.execPath), process.env.PATH].join(delimiter),
      RUNNER_TEMP: sandbox,
      GITHUB_OUTPUT: outputFile,
      ...env,
    },
  });
  const outputs: Record<string, string> = {};
  for (const line of readFileSync(outputFile, 'utf8').split('\n').filter(Boolean)) {
    const eq = line.indexOf('=');
    outputs[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return { status: run.status, stdout: run.stdout, outputs };
}

/** Runs the `run` step against a stub falsegreen that prints its argv and writes a report. */
function runFalsegreen(inputs: {
  mode?: string;
  args?: string;
  failOn?: string;
  kind?: string;
  stubExit?: number;
}) {
  const fgDir = join(sandbox, 'falsegreen');
  writeExecutable(
    join(fgDir, 'node_modules', '.bin', 'falsegreen'),
    [
      `printf '%s\\n' "$@"`,
      'printf "token=%s kind=%s\\n" "$FALSEGREEN_TOKEN" "$FALSEGREEN_TOKEN_KIND"',
      'mkdir -p "$GITHUB_WORKSPACE/falsegreen-report"',
      `printf '{"findings":[{"rule":"dead-gate"},{"rule":"masked-exit"}],"summary":{"deadGates":1}}' > "$GITHUB_WORKSPACE/falsegreen-report/results.json"`,
      `exit ${inputs.stubExit ?? 0}`,
    ].join('\n'),
  );
  const workspace = join(sandbox, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const step = runStep(
    'run',
    {
      FG_DIR: fgDir,
      FG_MODE: inputs.mode ?? inputDefault('mode') ?? '',
      FG_ARGS: inputs.args ?? '',
      FG_FAIL_ON: inputs.failOn ?? inputDefault('fail-on') ?? '',
      FG_TOKEN: 'tok',
      FG_TOKEN_KIND: inputs.kind ?? 'github-token',
      GITHUB_WORKSPACE: workspace,
    },
    workspace,
  );
  const lines = step.stdout.split('\n').slice(0, -1);
  return { ...step, argv: lines.slice(0, -1), tokenLine: lines.at(-1), workspace };
}

const base = (workspace: string, mode = 'run') => [
  mode,
  '--out',
  `${workspace}/falsegreen-report`,
  '--formats',
  'json,sarif,md',
];

describe('action inputs', () => {
  it('defaults to the run command, the config fail-on, and Node 24', () => {
    expect(inputDefault('mode')).toBe('run');
    expect(inputDefault('fail-on')).toBe('');
    expect(inputDefault('node-version')).toBe('24');
    expect(actionYml).toMatch(
      /^ {2}token:\n {4}description: '.*'\n {4}required: false\n {4}default: \$\{\{ github\.token \}\}$/m,
    );
  });

  it("leaves the caller's npm cache alone when it sets up Node", () => {
    // setup-node caches the repository's dependencies when package.json names npm, and fails
    // when that repository has no lockfile. The action installs its own copy and needs neither.
    expect(actionYml).toMatch(
      / {6}uses: actions\/setup-node@v\d+\n {6}with:\n(?: {8}.*\n)* {8}package-manager-cache: false\n/,
    );
  });

  it('marks the token as the workflow token only when it is github.token', () => {
    expect(actionYml).toContain(
      "FG_TOKEN_KIND: ${{ inputs.token == github.token && 'github-token' || 'personal-or-app' }}",
    );
  });
});

describe('action install step', () => {
  function install(version: string) {
    const log = join(sandbox, 'stub.log');
    writeExecutable(join(sandbox, 'stubs', 'npm'), `printf 'npm %s\\n' "$*" >> "$STUB_LOG"`);
    const step = runStep(
      'install',
      { FG_VERSION: version, GITHUB_ACTION_PATH: root, STUB_LOG: log },
      sandbox,
    );
    return { ...step, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  }

  it("installs the version in the action's own package.json when version is empty", () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const step = install('');
    expect(step.status).toBe(0);
    expect(step.calls).toContain(`npm i falsegreen@${pkg.version}`);
    expect(step.outputs.dir).toBe(join(sandbox, 'falsegreen'));
  });

  it.each(['latest', '0.1.0', 'file:/runner/falsegreen-0.1.0.tgz'])(
    'installs %s as given',
    (version) => {
      expect(install(version).calls).toContain(`npm i falsegreen@${version}`);
    },
  );
});

describe('action run step', () => {
  it('runs the mode with the fixed report location and formats, and reads the outputs', () => {
    const step = runFalsegreen({});
    expect(step.status).toBe(0);
    expect(step.argv).toEqual(base(step.workspace));
    expect(step.outputs).toMatchObject({
      'exit-code': '0',
      findings: '2',
      'dead-gates': '1',
      'report-path': `${step.workspace}/falsegreen-report`,
      'sarif-path': `${step.workspace}/falsegreen-report/results.sarif`,
    });
  });

  it('passes the token and its kind through the environment, never the command line', () => {
    const step = runFalsegreen({ kind: 'personal-or-app' });
    expect(step.tokenLine).toBe('token=tok kind=personal-or-app');
    expect(step.argv.join(' ')).not.toContain('tok');
  });

  it('adds --yes in remote mode and --fail-on when set', () => {
    const step = runFalsegreen({ mode: 'remote', failOn: 'medium' });
    expect(step.argv).toEqual([...base(step.workspace, 'remote'), '--fail-on', 'medium', '--yes']);
  });

  it('splits args like a shell, keeping quoted words together and globbing nothing', () => {
    const step = runFalsegreen({ args: '--job test --step "Run npm test" --workflow ci.*' });
    expect(step.argv).toEqual([
      ...base(step.workspace),
      '--job',
      'test',
      '--step',
      'Run npm test',
      '--workflow',
      'ci.*',
    ]);
  });

  it.each([['--out elsewhere'], ['--out=elsewhere'], ['--formats json']])(
    'rejects %s in args',
    (args) => {
      const step = runFalsegreen({ args });
      expect(step.status).toBe(2);
      expect(step.outputs).toEqual({ 'exit-code': '2' });
      expect(step.stdout).toMatch(/^::error::/);
    },
  );

  it('rejects an unknown mode and an unmatched quote', () => {
    expect(runFalsegreen({ mode: 'deploy' }).status).toBe(2);
    expect(runFalsegreen({ args: '--step "Run' }).status).toBe(2);
  });

  it('reports the exit code of falsegreen', () => {
    const step = runFalsegreen({ stubExit: 1 });
    expect(step.status).toBe(1);
    expect(step.outputs['exit-code']).toBe('1');
  });
});
