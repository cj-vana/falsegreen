import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/load';
import { resolveGates, type Gate } from '../src/resolve/gates';
import { words } from '../src/shell/parse';
import { loadWorkflows } from '../src/workflow/parse';
import { makeRepo, type TempRepo } from './helpers/repo';
import { missing } from './helpers/toolchains';

const WORKFLOW = `
name: CI
on: push
env:
  GLOBAL: yes
defaults:
  run:
    working-directory: .
jobs:
  checks:
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v7
      - run: npm ci
      - name: Check
        run: npm run check
      - run: cd web && npm test
      - run: make test
      - run: bash scripts/ci.sh
      - run: pre-commit run --all-files
      - uses: golangci/golangci-lint-action@v8
      - name: Run checks
        run: ./tools/verify --strict
      - uses: ./.github/actions/lint
      - name: Upload
        run: curl -s --upload-file out.txt https://example.invalid
      - name: With secret
        run: pytest --token \${{ secrets.TOKEN }}
      - name: Test then publish
        run: npm test && npm publish
      - name: Pnpm bin
        run: pnpm vitest run
      - name: Masked in script
        run: npm run test:masked
      - name: Custom
        run: ./custom-runner
      - name: Lint via make
        run: make nosuch
  matrix:
    strategy:
      matrix:
        node: [20, 22, 24]
    env:
      NODE: \${{ matrix.node }}
    steps:
      - run: npm test
`;

let repo: TempRepo;
let gates: Gate[];

function gate(stepName: string, list: Gate[] = gates): Gate {
  const found = list.find((g) => g.stepName === stepName);
  if (!found)
    throw new Error(`no gate named ${stepName}: ${list.map((g) => g.stepName).join(', ')}`);
  return found;
}

beforeAll(() => {
  repo = makeRepo({
    '.github/workflows/ci.yml': WORKFLOW,
    'package.json': JSON.stringify({
      scripts: {
        test: 'vitest run',
        pretest: 'echo hi',
        lint: 'eslint . && prettier --check .',
        check: 'npm run lint && tsc --noEmit',
        'test:masked': 'vitest run || true',
      },
    }),
    'web/package.json': JSON.stringify({ scripts: { test: 'jest' } }),
    Makefile: 'test:\n\tgo test ./...\n',
    'scripts/ci.sh': '#!/bin/sh\nset -e\npytest -q\n',
    '.pre-commit-config.yaml':
      'repos:\n  - repo: https://github.com/astral-sh/ruff-pre-commit\n    rev: v0.9.0\n    hooks:\n      - id: ruff\n  - repo: https://github.com/psf/black\n    rev: 25.1.0\n    hooks:\n      - id: black\n',
    '.github/actions/lint/action.yml':
      'runs:\n  using: composite\n  steps:\n    - run: npx eslint src\n      shell: bash\n',
    'falsegreen.config.yml': 'gates:\n  - { job: checks, step: Custom, tool: pytest, cwd: web }\n',
  });
  const workflows = loadWorkflows(repo.root);
  gates = resolveGates(repo.root, workflows, loadConfig(repo.root), { matrix: 'first' });
});

afterAll(() => repo.remove());

describe('resolveGates', () => {
  it('follows package scripts in order and records the chain', () => {
    const g = gate('Check');
    expect(g.invocations.map((i) => i.tool)).toEqual(['eslint', 'prettier', 'tsc']);
    expect(g.invocations[0]!.via).toEqual(['npm run check', 'npm run lint', 'eslint .']);
    expect(g.invocations[2]!.via).toEqual(['npm run check', 'tsc --noEmit']);
    expect(g.shell).toBe('bash');
    expect(g.workingDirectory).toBe('');
    expect(g.env).toEqual({ GLOBAL: 'yes' });
  });

  it('tracks cd and resolves the nearest package.json', () => {
    const g = gate('Run cd web && npm test');
    expect(g.invocations.map((i) => [i.tool, i.cwd])).toEqual([['jest', 'web']]);
  });

  it.skipIf(missing('make').length > 0)('expands make targets with make -n', () => {
    expect(gate('Run make test').invocations.map((i) => i.tool)).toEqual(['go-test']);
  });

  it('notes why make -n failed and falls back to the generic fault', () => {
    const g = gate('Lint via make');
    expect(g.notes.join('\n')).toMatch(/make -n nosuch failed/);
    expect(g.invocations.map((i) => i.tool)).toEqual(['generic']);
  });

  it('expands shell scripts and pre-commit hooks', () => {
    expect(gate('Run bash scripts/ci.sh').invocations.map((i) => i.tool)).toEqual(['pytest']);
    expect(gate('Run pre-commit run --all-files').invocations.map((i) => i.tool)).toEqual([
      'ruff-check',
      'black',
    ]);
  });

  it('treats known check actions as uses gates', () => {
    const g = gate('golangci/golangci-lint-action@v8');
    expect(g.kind).toBe('uses');
    expect(g.invocations.map((i) => i.tool)).toEqual(['golangci-lint']);
  });

  it('gives an unrecognized command in a check-named step the generic fault', () => {
    const g = gate('Run checks');
    expect(g.invocations.map((i) => [i.tool, i.argv.join(' ')])).toEqual([
      ['generic', './tools/verify --strict'],
    ]);
  });

  it('skips steps that run no check', () => {
    expect(gates.find((g) => g.stepName === 'Run npm ci')).toBeUndefined();
    expect(gates.find((g) => g.stepName === 'Upload')).toBeUndefined();
    expect(gates.find((g) => g.stepName === 'actions/checkout@v7')).toBeUndefined();
  });

  it('keeps steps inlined from a local composite action', () => {
    const g = gates.find((x) => x.fromAction === './.github/actions/lint')!;
    expect(g.invocations.map((i) => i.tool)).toEqual(['eslint']);
    expect(g.stepName).toBe('Run npx eslint src');
  });

  it('lists expressions it could not rebuild', () => {
    expect(gate('With secret').unresolved).toEqual(['secrets.TOKEN']);
  });

  it('marks a step that also publishes as unsafe to replay', () => {
    expect(gate('Test then publish').unsafe).toBe('npm publish');
    expect(gate('Check').unsafe).toBeUndefined();
  });

  it('runs a package bin through pnpm when no script has that name', () => {
    expect(gate('Pnpm bin').invocations.map((i) => i.tool)).toEqual(['vitest']);
  });

  it('keeps a trace of every script level, with the commands that lead to gates', () => {
    const g = gate('Masked in script');
    const script = g.traces.find((t) => t.source === 'package.json#test:masked')!;
    expect(script.gateCommands.map(words)).toEqual([['vitest', 'run']]);
    expect(g.traces[0]!.source).toBe('run');
  });

  it('adds gates from the config file', () => {
    expect(gate('Custom').invocations.map((i) => [i.tool, i.cwd, i.via[0]])).toEqual([
      ['pytest', 'web', 'falsegreen.config.yml'],
    ]);
  });

  it('expands the first matrix combination by default and all of them on request', () => {
    const first = gates.filter((g) => g.jobId === 'matrix');
    expect(first).toHaveLength(1);
    expect(first[0]!.checkName).toBe('matrix (20)');
    expect(first[0]!.env).toEqual({ GLOBAL: 'yes', NODE: '20' });
    const all = resolveGates(repo.root, loadWorkflows(repo.root), loadConfig(repo.root), {
      matrix: 'all',
    }).filter((g) => g.jobId === 'matrix');
    expect(all.map((g) => g.combo)).toEqual([{ node: '20' }, { node: '22' }, { node: '24' }]);
    expect(new Set(all.map((g) => g.key)).size).toBe(3);
  });

  it('points every gate at its workflow line', () => {
    // WORKFLOW starts with a newline, so `- name: Check` is line 17.
    expect(gate('Check').loc).toEqual({ file: '.github/workflows/ci.yml', line: 17 });
    expect(gate('Check').runLine).toBe(18);
  });
});
