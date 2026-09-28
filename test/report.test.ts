import { describe, expect, it } from 'vitest';

import type { ResolvedConfig } from '../src/config/load';
import type { Finding } from '../src/core/types';
import { buildReport, dynamicFindings, exitCodeFor, type Report } from '../src/report/model';
import { fakeGate, fakeResult, fakeRun } from './helpers/gate';

const cfg: ResolvedConfig = {
  failOn: 'high',
  ignore: [],
  gates: [],
  place: [],
  matrix: { max: 4 },
  remote: { allow: [], timeoutMinutes: 30 },
};

const rules = (fs: Finding[]) => fs.map((f) => [f.rule, f.severity]);

describe('dynamicFindings', () => {
  it('reports a dead gate once when the reach fault survives', () => {
    const f = dynamicFindings([
      fakeResult([fakeRun('reach', 'survived'), fakeRun('semantic', 'survived')]),
    ]);
    expect(rules(f)).toEqual([['dead-gate', 'high']]);
    expect(f[0]!.message).toContain('Run npm test');
    expect(f[0]!.message).toContain('vitest');
    expect(f[0]!.location).toEqual({ file: '.github/workflows/ci.yml', line: 12 });
    expect(f[0]!.hint).toContain('test/falsegreen_abc123.test.ts');
  });

  it('reports a weak gate when only the semantic fault survives, with the known reason', () => {
    const f = dynamicFindings([
      fakeResult([
        fakeRun('reach', 'caught'),
        fakeRun('semantic', 'survived', {
          fault: {
            ...fakeRun('semantic', 'survived').fault!,
            expectSurvival: 'oxlint exits 0 on warnings.',
          },
        }),
      ]),
    ]);
    expect(rules(f)).toEqual([['weak-gate', 'medium']]);
    expect(f[0]!.hint).toBe('oxlint exits 0 on warnings.');
  });

  it('does not call a gate weak unless its reach fault was caught', () => {
    // --tier semantic: nothing shows the tool reads that location, so this may be a dead gate.
    const notRun = dynamicFindings([fakeResult([fakeRun('semantic', 'survived')])]);
    expect(rules(notRun)).toEqual([['weak-gate', 'high']]);
    expect(notRun[0]!.message).toContain('its reach fault was not run');
    const unjudged = dynamicFindings([
      fakeResult([
        fakeRun('reach', 'unjudged', { reason: 'timed out after 900 s' }),
        fakeRun('semantic', 'survived'),
      ]),
    ]);
    expect(rules(unjudged)).toEqual([
      ['weak-gate', 'high'],
      ['unjudged', 'info'],
    ]);
    expect(unjudged[0]!.message).toContain('its reach fault was not judged');
  });

  it('reports unattributed failures as low', () => {
    const f = dynamicFindings([
      fakeResult([fakeRun('reach', 'unattributed'), fakeRun('semantic', 'caught')]),
    ]);
    expect(rules(f)).toEqual([['unattributed', 'low']]);
  });

  it('reports gates it could not judge as info', () => {
    const f = dynamicFindings([
      fakeResult([], { status: 'already-red', reason: 'the step exits 1 without any fault' }),
      fakeResult([], {
        status: 'unjudged',
        reason: 'timed out after 900 s',
        gate: fakeGate({ stepName: 'Slow' }),
      }),
      fakeResult([
        fakeRun('reach', 'unjudged', { reason: 'cannot plant: src/x.ts already exists' }),
      ]),
    ]);
    expect(rules(f)).toEqual([
      ['already-red', 'info'],
      ['unjudged', 'info'],
      ['unjudged', 'info'],
    ]);
    expect(f[1]!.message).toContain('timed out');
  });

  it('shows why a gate was already red', () => {
    const results = [
      fakeResult([], {
        status: 'already-red',
        reason: 'the step exits 1 without any fault',
        baseline: {
          exitCode: 1,
          durationMs: 900,
          excerpt: ' RUN  v3\n\n FAIL  test/a.test.ts > adds\nTest Files  1 failed (1)\n\n',
        },
      }),
    ];
    const [f] = dynamicFindings(results);
    expect(f!.hint).toBe('Its output ended with: Test Files  1 failed (1)');
    const report = buildReport({
      root: '/repo',
      modes: ['static', 'local'],
      startedAt: new Date(),
      gates: results.map((r) => r.gate),
      results,
      staticFindings: [],
      cfg,
    });
    expect(report.gates[0]!.baseline).toEqual(results[0]!.baseline);
  });

  it('reports nothing for a gate that caught every fault', () => {
    expect(
      dynamicFindings([fakeResult([fakeRun('reach', 'caught'), fakeRun('semantic', 'caught')])]),
    ).toEqual([]);
  });
});

describe('buildReport', () => {
  it('summarizes gates, verdicts and severities, and drops ignored findings', () => {
    const results = [
      fakeResult([fakeRun('reach', 'survived'), fakeRun('semantic', 'survived')]),
      fakeResult([fakeRun('reach', 'caught'), fakeRun('semantic', 'caught')], {
        gate: fakeGate({ stepName: 'Lint', key: 'k2' }),
      }),
    ];
    const staticFindings: Finding[] = [
      { rule: 'masked-exit', severity: 'high', message: 'm', job: 'test', step: 'Run npm test' },
      { rule: 'path-filtered', severity: 'low', message: 'p' },
    ];
    const report = buildReport({
      root: '/repo',
      modes: ['static', 'local'],
      startedAt: new Date('2026-09-27T10:00:00Z'),
      gates: results.map((r) => r.gate),
      results,
      staticFindings,
      cfg: { ...cfg, ignore: [{ rule: 'path-filtered' }] },
    });
    expect(report.summary).toMatchObject({
      gates: 2,
      judged: 2,
      caught: 2,
      survived: 2,
      deadGates: 1,
      weakGates: 0,
      unjudged: 0,
      bySeverity: { high: 2, medium: 0, low: 0, info: 0 },
    });
    expect(report.findings.map((f) => f.rule)).toEqual(['dead-gate', 'masked-exit']);
    expect(report.gates[0]).toMatchObject({
      workflow: '.github/workflows/ci.yml',
      job: 'test',
      step: 'Run npm test',
      line: 12,
      tools: ['vitest'],
      status: 'judged',
    });
    expect(report.gates[0]!.faults[0]).toMatchObject({
      tier: 'reach',
      tool: 'vitest',
      files: ['test/falsegreen_abc123.test.ts'],
      verdict: 'survived',
    });
  });
});

describe('explained dead gates', () => {
  it('points a dead or weak gate at the static finding on the same step that explains it', () => {
    const results = [fakeResult([fakeRun('reach', 'survived'), fakeRun('semantic', 'survived')])];
    const report = buildReport({
      root: '/repo',
      modes: ['static', 'local'],
      startedAt: new Date(),
      gates: results.map((r) => r.gate),
      results,
      staticFindings: [
        {
          rule: 'masked-exit',
          severity: 'high',
          message: 'm',
          workflow: '.github/workflows/ci.yml',
          job: 'test',
          step: 'Run npm test',
        },
      ],
      cfg,
    });
    expect(report.findings[0]!.hint).toBe(
      'The masked-exit finding on this step explains why: fix it and this gate can fail.',
    );
  });
});

describe('remote summary', () => {
  it('counts remotely judged jobs and their verdicts', () => {
    const job = (
      name: string,
      tier: 'reach' | 'semantic',
      verdict: 'caught' | 'survived' | 'unjudged',
    ) => ({
      workflow: 'ci.yml',
      job: name,
      tier,
      conclusion: null,
      verdict,
    });
    const report = buildReport({
      root: '/repo',
      modes: ['static', 'remote'],
      startedAt: new Date(),
      gates: [fakeGate()],
      results: [],
      staticFindings: [],
      cfg,
      remote: {
        plan: {
          repo: 'o/r',
          baseSha: 'abc',
          tokenKind: 'personal-or-app',
          branches: { reach: 'a', semantic: 'b' },
          entries: [],
        },
        ran: true,
        notes: [],
        jobs: [
          job('test', 'reach', 'caught'),
          job('test', 'semantic', 'caught'),
          job('lenient', 'reach', 'survived'),
          job('lenient', 'semantic', 'survived'),
          job('slow', 'reach', 'unjudged'),
        ],
      },
    });
    expect(report.summary).toMatchObject({ judged: 2, caught: 2, survived: 2, unjudged: 1 });
  });
});

describe('a run that judges nothing', () => {
  const build = (results: ReturnType<typeof fakeResult>[], modes: Report['modes']) =>
    buildReport({
      root: '/repo',
      modes,
      startedAt: new Date(),
      gates: results.length > 0 ? results.map((r) => r.gate) : [fakeGate()],
      results,
      staticFindings: [],
      cfg,
    });

  it('fails when gates were replayed but no fault got a verdict', () => {
    // The falsegreen init workflow with no toolchains set up: every gate is already red.
    const report = build(
      [fakeResult([], { status: 'already-red', reason: 'the step exits 127 without any fault' })],
      ['static', 'local'],
    );
    const f = report.findings.find((x) => x.severity === 'high')!;
    expect(f.rule).toBe('unjudged');
    expect(f.message).toBe(
      'No fault got a verdict in the 1 gate falsegreen tried, so this run proves nothing about them.',
    );
    expect(exitCodeFor(report.findings, 'high')).toBe(1);
  });

  it('stays quiet when a fault got a verdict, and in static mode', () => {
    const judged = build([fakeResult([fakeRun('reach', 'caught')])], ['static', 'local']);
    expect(judged.findings).toEqual([]);
    expect(build([], ['static']).findings).toEqual([]);
  });
});

describe('exitCodeFor', () => {
  const at = (severity: Finding['severity']): Finding[] => [
    { rule: 'weak-gate', severity, message: '' },
  ];
  it('fails only for findings at or above the threshold', () => {
    expect(exitCodeFor(at('medium'), 'high')).toBe(0);
    expect(exitCodeFor(at('high'), 'high')).toBe(1);
    expect(exitCodeFor(at('medium'), 'medium')).toBe(1);
    expect(exitCodeFor([], 'info')).toBe(0);
  });
});
