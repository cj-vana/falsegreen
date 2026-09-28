import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadWorkflows, parseWorkflow } from '../src/workflow/parse';
import { makeRepo, type TempRepo } from './helpers/repo';

const fixtures = join(import.meta.dirname, 'fixtures', 'workflows');
let repo: TempRepo | undefined;

afterEach(() => {
  repo?.remove();
  repo = undefined;
});

describe('parseWorkflow on buttonmash CI', () => {
  const text = readFileSync(join(fixtures, 'buttonmash-ci.yml'), 'utf8');
  const wf = parseWorkflow('.github/workflows/ci.yml', text, fixtures);

  it('reads triggers', () => {
    expect(wf.errors).toEqual([]);
    expect(wf.triggers.push).toEqual({ branches: ['main'] });
    expect(wf.triggers.pullRequest).toEqual({});
    expect(wf.triggers.workflowDispatch).toEqual({ inputs: {} });
  });

  it('reads jobs with their names, matrix and locations', () => {
    expect(wf.jobs.map((j) => j.id)).toEqual(['test', 'action-smoke']);
    const test = wf.jobs[0]!;
    expect(test.name).toBe('test (node ${{ matrix.node-version }})');
    expect(test.matrix?.axes).toEqual({ 'node-version': [20, 22, 24] });
    expect(test.loc).toEqual({ file: '.github/workflows/ci.yml', line: 18 });
    expect(test.timeoutMinutes).toBe(20);
  });

  it('reads steps with run text, if and the line of the run content', () => {
    const step = wf.jobs[0]!.steps.find((s) => s.name === 'Test with coverage gates')!;
    expect(step.run).toBe('npm run test:coverage');
    expect(step.if).toBe('${{ matrix.node-version == 20 }}');
    expect(step.env).toEqual({ CI: 'true' });
    expect(step.loc.line).toBe(52);
    expect(step.runLine).toBe(54);
    const uses = wf.jobs[0]!.steps[0]!;
    expect(uses.uses).toBe('actions/checkout@v5');
  });

  it('points runLine at the first content line of a block scalar', () => {
    const smoke = wf.jobs[1]!;
    const start = smoke.steps.find((s) => s.name === 'Start smoke target')!;
    const lines = text.split('\n');
    expect(lines[start.runLine! - 1]!.trim()).toBe('node test/fixtures/action-server.mjs &');
  });
});

describe('parseWorkflow edge cases', () => {
  it('resolves anchors, aliases and merge keys', () => {
    const wf = parseWorkflow(
      'wf.yml',
      [
        'on: push',
        'jobs:',
        '  a:',
        '    defaults: &d',
        '      run:',
        '        shell: bash',
        '    env: &e { A: "1" }',
        '    steps:',
        '      - run: npm test',
        '  b:',
        '    defaults: *d',
        '    env:',
        '      <<: *e',
        '      B: 2',
        '    steps:',
        '      - run: npm run lint',
      ].join('\n'),
      '/',
    );
    expect(wf.errors).toEqual([]);
    expect(wf.jobs[1]!.defaults).toEqual({ shell: 'bash' });
    expect(wf.jobs[1]!.env).toEqual({ A: '1', B: '2' });
  });

  it('accepts on as a string, a list and a map', () => {
    expect(parseWorkflow('a.yml', 'on: push\njobs: {}', '/').triggers.push).toEqual({});
    const list = parseWorkflow('b.yml', 'on: [pull_request, schedule]\njobs: {}', '/').triggers;
    expect(list.pullRequest).toEqual({});
    expect(list.push).toBeUndefined();
    const map = parseWorkflow(
      'c.yml',
      'on:\n  push:\n    branches-ignore: [wip]\n    paths: [src/**]\n  workflow_call:\n    inputs:\n      dir:\n        type: string\n        default: src\njobs: {}',
      '/',
    ).triggers;
    expect(map.push).toEqual({ branchesIgnore: ['wip'], paths: ['src/**'] });
    expect(map.workflowCall).toEqual({ inputs: { dir: { default: 'src' } } });
  });

  it('records a reusable-workflow job without steps', () => {
    const wf = parseWorkflow(
      'a.yml',
      'on: push\njobs:\n  call:\n    uses: ./.github/workflows/lint.yml\n',
      '/',
    );
    expect(wf.jobs[0]!.usesWorkflow).toBe('./.github/workflows/lint.yml');
    expect(wf.jobs[0]!.steps).toEqual([]);
  });

  it('reports invalid YAML instead of throwing', () => {
    const wf = parseWorkflow('bad.yml', 'on: push\njobs:\n  a: [unclosed', '/');
    expect(wf.errors.length).toBeGreaterThan(0);
    expect(wf.jobs).toEqual([]);
  });

  it('inlines local composite actions with inputs resolved', () => {
    repo = makeRepo({
      '.github/actions/lint/action.yml': [
        'name: lint',
        'inputs:',
        '  dir:',
        '    default: src',
        '  strict:',
        '    default: "no"',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: actions/setup-node@v7',
        '    - run: npx eslint ${{ inputs.dir }} --max-warnings 0',
        '      shell: bash',
        '    - run: echo ${{ inputs.strict }} ${{ github.action_path }}',
        '      shell: sh',
      ].join('\n'),
      '.github/workflows/ci.yml': [
        'on: push',
        'jobs:',
        '  lint:',
        '    steps:',
        '      - uses: actions/checkout@v7',
        '      - uses: ./.github/actions/lint',
        '        with:',
        '          dir: lib',
      ].join('\n'),
    });
    const [wf] = loadWorkflows(repo.root);
    const steps = wf!.jobs[0]!.steps;
    expect(steps.map((s) => s.run ?? s.uses)).toEqual([
      'actions/checkout@v7',
      'actions/setup-node@v7',
      'npx eslint lib --max-warnings 0',
      'echo no ./.github/actions/lint',
    ]);
    expect(steps[2]!.fromAction).toBe('./.github/actions/lint');
    expect(steps[2]!.shell).toBe('bash');
    expect(steps[2]!.loc.line).toBe(6);
    expect(steps.map((s) => s.index)).toEqual([0, 1, 2, 3]);
  });

  it("gives inlined steps the calling step's continue-on-error, if and env", () => {
    repo = makeRepo({
      '.github/actions/outer/action.yml': [
        'runs:',
        '  using: composite',
        '  steps:',
        '    - run: npm test',
        '      shell: bash',
        '      env:',
        '        B: inner',
        '    - uses: ./.github/actions/inner',
        '      if: runner.os == needs.x.outputs.os',
      ].join('\n'),
      '.github/actions/inner/action.yml': [
        'runs:',
        '  using: composite',
        '  steps:',
        '    - run: npm run lint',
        '      shell: bash',
        '      continue-on-error: ${{ inputs.lenient }}',
      ].join('\n'),
      '.github/workflows/ci.yml': [
        'on: push',
        'jobs:',
        '  test:',
        '    steps:',
        '      - uses: ./.github/actions/outer',
        '        continue-on-error: true',
        "        if: github.event_name == 'push'",
        '        env:',
        '          A: outer',
        '          B: outer',
        '      - uses: ./.github/actions/inner',
        '        continue-on-error: ${{ matrix.experimental }}',
      ].join('\n'),
    });
    const [wf] = loadWorkflows(repo.root);
    const [test, lint, lenient] = wf!.jobs[0]!.steps;
    expect(test).toMatchObject({
      run: 'npm test',
      continueOnError: true,
      if: "github.event_name == 'push'",
      env: { A: 'outer', B: 'inner' },
    });
    expect(lint).toMatchObject({
      run: 'npm run lint',
      continueOnError: true,
      if: "(github.event_name == 'push') && (runner.os == needs.x.outputs.os)",
      env: { A: 'outer', B: 'outer' },
    });
    // The inner step's own expression stays when the caller's is only an expression too.
    expect(lenient!.continueOnError).toBe('${{ inputs.lenient }}');
  });

  it('loads only the workflows asked for', () => {
    repo = makeRepo({
      '.github/workflows/ci.yml': 'on: push\njobs: {}\n',
      '.github/workflows/release.yaml': 'on: push\njobs: {}\n',
      '.github/workflows/notes.txt': 'not a workflow\n',
    });
    expect(loadWorkflows(repo.root).map((w) => w.file)).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/release.yaml',
    ]);
    expect(loadWorkflows(repo.root, ['release.yaml']).map((w) => w.file)).toEqual([
      '.github/workflows/release.yaml',
    ]);
  });
});
