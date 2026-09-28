import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { emitActions } from '../src/report/github';
import { renderMarkdown } from '../src/report/markdown';
import { buildReport, type Report } from '../src/report/model';
import { toSarif } from '../src/report/sarif';
import { renderTerminal } from '../src/report/terminal';
import { writeReports } from '../src/report';
import { fakeGate, fakeResult, fakeRun } from './helpers/gate';
import { makeRepo, makeTempDir } from './helpers/repo';

function sample(): Report {
  const results = [
    fakeResult([fakeRun('reach', 'survived'), fakeRun('semantic', 'survived')]),
    fakeResult([fakeRun('reach', 'caught'), fakeRun('semantic', 'caught')], {
      gate: fakeGate({
        stepName: 'Lint',
        key: 'k2',
        loc: { file: '.github/workflows/ci.yml', line: 20 },
      }),
    }),
  ];
  return buildReport({
    root: '/repo',
    modes: ['static', 'local'],
    startedAt: new Date('2026-09-27T10:00:00Z'),
    gates: results.map((r) => r.gate),
    results,
    staticFindings: [
      {
        rule: 'masked-exit',
        severity: 'high',
        message: '`npm test || true` passes when the check fails.',
        hint: 'Remove the || branch.',
        location: { file: '.github/workflows/ci.yml', line: 13 },
        job: 'test',
        step: 'Run npm test',
      },
    ],
    cfg: {
      failOn: 'high',
      ignore: [],
      gates: [],
      place: [],
      matrix: { max: 4 },
      remote: { allow: [], timeoutMinutes: 30 },
    },
  });
}

/** Anything but printable ASCII, newline and tab: catches dashes, dots and emoji. */
const nonAscii = /[^ -~\n\t]/;

describe('SARIF', () => {
  it('produces one rule per rule id and one result per finding, with lines', () => {
    const sarif = toSarif(sample());
    expect(sarif.version).toBe('2.1.0');
    const run = sarif.runs[0]!;
    expect(run.tool.driver.name).toBe('falsegreen');
    expect(run.tool.driver.rules.map((r) => r.id)).toEqual(['dead-gate', 'masked-exit']);
    expect(run.results.map((r) => [r.ruleId, r.level])).toEqual([
      ['dead-gate', 'error'],
      ['masked-exit', 'error'],
    ]);
    expect(run.results[1]!.locations[0]!.physicalLocation).toEqual({
      artifactLocation: { uri: '.github/workflows/ci.yml' },
      region: { startLine: 13 },
    });
  });
});

describe('terminal and markdown', () => {
  it('lists every gate with its verdicts, then the findings, in plain ASCII', () => {
    const text = renderTerminal(sample(), false);
    expect(text).toContain('Run npm test');
    expect(text).toMatch(/reach\s+vitest\s+survived/);
    expect(text).toMatch(/semantic\s+vitest\s+caught/);
    expect(text).toMatch(/high\s+dead-gate\s+\.github\/workflows\/ci\.yml:12/);
    expect(text).toContain('Remove the || branch.');
    expect(text).not.toMatch(nonAscii);
  });

  it('renders the same content as Markdown tables', () => {
    const md = renderMarkdown(sample());
    expect(md).toContain('| Step | Tool | Reach | Semantic |');
    expect(md).toContain('| Run npm test | vitest | survived | survived |');
    expect(md).toContain('| high | dead-gate |');
    expect(md).not.toMatch(nonAscii);
  });
});

describe('GitHub Actions output', () => {
  it('annotates findings and appends the summary', () => {
    const dir = makeTempDir('actions');
    const summary = join(dir, 'summary.md');
    writeFileSync(summary, '');
    const lines: string[] = [];
    emitActions(sample(), { GITHUB_STEP_SUMMARY: summary }, (l) => lines.push(l));
    expect(lines[0]).toMatch(
      /^::error file=\.github\/workflows\/ci\.yml,line=12,title=dead-gate::/,
    );
    expect(readFileSync(summary, 'utf8')).toContain('| Step | Tool | Reach | Semantic |');
  });

  it('escapes characters Actions treats as syntax', () => {
    const report = sample();
    report.findings[0]!.message = 'a,b:c\nd 100%';
    const lines: string[] = [];
    emitActions(report, {}, (l) => lines.push(l));
    expect(lines[0]).toContain('::a,b:c%0Ad 100%25');
  });
});

describe('writeReports', () => {
  it('writes the requested formats and returns their paths', () => {
    const out = join(makeTempDir('out'), 'report');
    const written = writeReports(sample(), out, ['json', 'sarif', 'md']);
    expect(written.map((p) => p.slice(out.length + 1)).sort()).toEqual([
      'results.json',
      'results.sarif',
      'summary.md',
    ]);
    const json = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as Report;
    expect(json.tool).toBe('falsegreen');
    expect(existsSync(join(out, 'results.sarif'))).toBe(true);
  });

  it('keeps the report out of the next run: git and gitignore-aware tools skip it', () => {
    // A report under the repository made `prettier --check .` fail on the next run's baseline.
    const repo = makeRepo({ 'a.txt': 'a\n' });
    try {
      writeReports(sample(), join(repo.root, 'falsegreen-report'), ['json', 'md']);
      expect(readFileSync(join(repo.root, 'falsegreen-report', '.gitignore'), 'utf8')).toBe('*\n');
      expect(repo.git('status', '--porcelain')).toBe('');
    } finally {
      repo.remove();
    }
  });
});
