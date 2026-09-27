import { describe, expect, it } from 'vitest';

import type { ResolvedConfig } from '../src/config/load';
import type { Finding } from '../src/core/types';
import { buildReport, dynamicFindings, exitCodeFor } from '../src/report/model';
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
