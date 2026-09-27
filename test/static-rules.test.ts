import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/load';
import type { Finding } from '../src/core/types';
import { resolveAll } from '../src/resolve/gates';
import { staticFindings } from '../src/static/rules';
import { loadWorkflows } from '../src/workflow/parse';
import { makeRepo, type TempRepo } from './helpers/repo';

const WORKFLOW = `on:
  push:
  pull_request:
    paths: ['src/**']
jobs:
  a:
    steps:
      - name: masked
        run: npm test || true
      - name: reraised
        run: pytest || exit 1
      - name: subshell reraise
        run: pytest || (echo failed; exit 1)
      - name: pipe default
        run: go test ./... | tee out.txt
      - name: pipe bash
        shell: bash
        run: go test ./... | tee out.txt
      - name: coe
        continue-on-error: true
        run: cargo test
      - name: no tests
        run: npx vitest run --passWithNoTests
      - name: pytest five
        run: pytest || [ $? -eq 5 ]
      - name: if present
        run: npm run lint --if-present
      - name: if present missing
        run: npm run typecheck --if-present
      - name: and list
        run: |
          npm test && echo ok
          echo done
      - name: and list last
        run: |
          echo start
          npm test && echo ok
      - name: set plus e
        run: |
          set +e
          pytest
          echo finished
      - name: set plus e handled
        run: |
          set +e
          pytest
          status=$?
          exit $status
      - name: no errexit shell
        shell: bash {0}
        run: |
          ruff check .
          echo done
      - name: script masked
        run: npm run test:masked
      - name: script sequence
        run: npm run test:seq
      - name: event only
        if: github.event_name == 'push'
        run: mypy src
      - name: clean
        run: npx eslint .
  b:
    continue-on-error: \${{ matrix.experimental }}
    strategy:
      matrix:
        experimental: [false, true]
    steps:
      - run: cargo clippy
`;

const lineOf = (needle: string): number =>
  WORKFLOW.split('\n').findIndex((l) => l.includes(needle)) + 1;

let repo: TempRepo;
let findings: Finding[];

function forStep(step: string): [string, string, number | undefined][] {
  return findings.filter((f) => f.step === step).map((f) => [f.rule, f.severity, f.location?.line]);
}

beforeAll(() => {
  repo = makeRepo({
    '.github/workflows/ci.yml': WORKFLOW,
    'package.json': JSON.stringify({
      scripts: {
        test: 'vitest run',
        lint: 'eslint .',
        'test:masked': 'vitest run || true',
        'test:seq': 'vitest run; echo done',
      },
    }),
  });
  const workflows = loadWorkflows(repo.root);
  const { gates, emptySteps } = resolveAll(repo.root, workflows, loadConfig(repo.root), {
    matrix: 'all',
  });
  findings = staticFindings(workflows, gates, emptySteps);
});

afterAll(() => repo.remove());

describe('staticFindings', () => {
  it('flags || true after a gate', () => {
    expect(forStep('masked')).toEqual([['masked-exit', 'high', lineOf('npm test || true')]]);
  });

  it('accepts an || branch that exits nonzero, including after a subshell', () => {
    expect(forStep('reraised')).toEqual([]);
    expect(forStep('subshell reraise')).toEqual([]);
  });

  it('flags a gate piped into another command when the shell has no pipefail', () => {
    expect(forStep('pipe default')).toEqual([
      ['pipe-swallows-exit', 'medium', lineOf('run: go test ./... | tee out.txt')],
    ]);
    expect(forStep('pipe bash')).toEqual([]);
  });

  it('flags continue-on-error on a gate step and, once, on a job with gates', () => {
    expect(forStep('coe')).toEqual([['continue-on-error', 'high', lineOf('- name: coe')]]);
    const job = findings.filter((f) => f.rule === 'continue-on-error' && f.job === 'b');
    expect(job.map((f) => [f.severity, f.location?.line])).toEqual([['medium', lineOf('  b:')]]);
  });

  it('flags runs that pass when no tests exist', () => {
    expect(forStep('no tests')).toEqual([
      ['passes-with-no-tests', 'medium', lineOf('--passWithNoTests')],
    ]);
    expect(forStep('pytest five')).toEqual([
      ['passes-with-no-tests', 'medium', lineOf('[ $? -eq 5 ]')],
    ]);
  });

  it('flags --if-present, and a step that runs nothing because the script is missing', () => {
    expect(forStep('if present')).toEqual([['if-present', 'medium', lineOf('--if-present')]]);
    expect(forStep('if present missing')).toEqual([
      ['if-present', 'high', lineOf('npm run typecheck --if-present')],
    ]);
  });

  it('flags a gate inside an && list that is not the last command in the script', () => {
    expect(forStep('and list')).toEqual([['masked-exit', 'high', lineOf('npm test && echo ok')]]);
    expect(forStep('and list last')).toEqual([]);
  });

  it('flags set +e unless the status is re-raised', () => {
    expect(forStep('set plus e')).toEqual([['masked-exit', 'high', lineOf('set +e') + 1]]);
    expect(forStep('set plus e handled')).toEqual([]);
  });

  it('flags a gate that is not last in a shell without -e', () => {
    expect(forStep('no errexit shell')).toEqual([['masked-exit', 'high', lineOf('ruff check .')]]);
  });

  it('flags masking inside package.json scripts, which npm runs without -e', () => {
    const masked = findings.filter((f) => f.step === 'script masked');
    expect(masked.map((f) => [f.rule, f.severity])).toEqual([['masked-exit', 'high']]);
    expect(masked[0]!.message).toContain('package.json#test:masked');
    expect(forStep('script sequence').map((f) => f[0])).toEqual(['masked-exit']);
  });

  it('flags gates that only run for some events', () => {
    expect(forStep('event only')).toEqual([
      ['conditional-gate', 'low', lineOf('- name: event only')],
    ]);
  });

  it('flags a workflow whose pull_request trigger is path-filtered, once', () => {
    const path = findings.filter((f) => f.rule === 'path-filtered');
    expect(path.map((f) => [f.severity, f.location?.line])).toEqual([['low', 1]]);
  });

  it('reports nothing for a plain gate', () => {
    expect(forStep('clean')).toEqual([]);
  });
});
