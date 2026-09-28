import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config/load';
import { statusPorcelain } from '../src/core/git';
import { excerpt, replayGates, type ProgressEvent, type ReplayOptions } from '../src/local/replay';
import { resolveAll, type Gate } from '../src/resolve/gates';
import { loadWorkflows } from '../src/workflow/parse';
import { makeRepo, type TempRepo } from './helpers/repo';

const PASSING =
  "import { expect, test } from 'vitest';\nimport { sum } from '../src/sum';\n\ntest('sum', () => {\n  expect(sum(1, 2)).toBe(3);\n});\n";
const FAILING = PASSING.replace('toBe(3)', 'toBe(4)');

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.remove();
  repo = undefined;
});

function setup(testFile = PASSING): { root: string; gate: Gate } {
  repo = makeRepo({
    '.github/workflows/ci.yml': 'on: push\njobs:\n  test:\n    steps:\n      - run: npm test\n',
    'package.json': JSON.stringify({
      type: 'module',
      private: true,
      scripts: { test: 'vitest run' },
    }),
    'src/sum.ts': 'export const sum = (a: number, b: number): number => a + b;\n',
    'test/sum.test.ts': testFile,
    // vitest writes its cache under node_modules/.vite, as in any real project.
    '.gitignore': 'node_modules/\n',
  });
  const root = repo.root;
  const { gates } = resolveAll(root, loadWorkflows(root), loadConfig(root), { matrix: 'first' });
  return { root, gate: gates[0]! };
}

const opts: ReplayOptions = {
  tiers: ['reach', 'semantic'],
  assumeGreen: false,
  timeoutMs: 120_000,
};

async function replay(root: string, gate: Gate, over: Partial<ReplayOptions> = {}) {
  const [result] = await replayGates(root, [gate], loadConfig(root), { ...opts, ...over });
  return result!;
}

describe('excerpt', () => {
  it('strips color codes and character-set resets', () => {
    expect(excerpt('\x1b[31mDiff in\x1b[0m src/a.rs\x1b(B')).toBe('Diff in src/a.rs');
  });
});

describe('replayGates', () => {
  it('judges a real gate: both faults caught, output names the planted file, tree clean', async () => {
    const { root, gate } = setup();
    const events: ProgressEvent[] = [];
    const r = await replay(root, gate, { onProgress: (e) => events.push(e) });
    expect(r.status).toBe('judged');
    expect(r.baseline?.exitCode).toBe(0);
    expect(r.runs.map((x) => [x.tool, x.tier, x.verdict])).toEqual([
      ['vitest', 'reach', 'caught'],
      ['vitest', 'semantic', 'caught'],
    ]);
    expect(r.runs[1]!.excerpt).toMatch(/falsegreen_[0-9a-f]{6}/);
    expect(r.runs[1]!.fault?.files[0]!.path).toMatch(/^test\/falsegreen_[0-9a-f]{6}\.test\.ts$/);
    expect(statusPorcelain(root)).toBe('');
    expect(events.map((e) => e.type)).toEqual(['baseline', 'fault', 'fault']);
  });

  it('reports a red baseline as already-red and plants nothing', async () => {
    const { root, gate } = setup(FAILING);
    const r = await replay(root, gate);
    expect(r.status).toBe('already-red');
    expect(r.runs).toEqual([]);
  });

  it('skips the baseline with assumeGreen', async () => {
    const { root, gate } = setup(FAILING);
    const r = await replay(root, gate, { assumeGreen: true });
    expect(r.status).toBe('judged');
    expect(r.baseline).toBeUndefined();
    expect(r.runs.map((x) => x.verdict)).toEqual(['caught', 'caught']);
  });

  it('calls a missing tool unjudged, never survived', async () => {
    const { root, gate } = setup();
    const r = await replay(root, { ...gate, run: 'definitely-not-a-tool --check' });
    expect(r.status).toBe('unjudged');
    expect(r.reason).toMatch(/not installed: definitely-not-a-tool/);
  });

  it('kills a gate that never exits, and still leaves the tree clean', async () => {
    const { root, gate } = setup();
    const hung = { ...gate, run: 'sleep 600' };
    const baseline = await replay(root, hung, { timeoutMs: 500 });
    expect(baseline.status).toBe('unjudged');
    expect(baseline.reason).toMatch(/timed out/);
    const faults = await replay(root, hung, { timeoutMs: 500, assumeGreen: true });
    expect(faults.runs.map((x) => x.verdict)).toEqual(['unjudged', 'unjudged']);
    expect(faults.runs[0]!.reason).toMatch(/timed out/);
    expect(statusPorcelain(root)).toBe('');
  });

  it('never runs a step that also publishes', async () => {
    const { root, gate } = setup();
    const r = await replay(root, {
      ...gate,
      run: 'touch ran.txt && npm publish',
      unsafe: 'npm publish',
    });
    expect(r.status).toBe('unjudged');
    expect(r.reason).toMatch(/npm publish/);
    expect(existsSync(join(root, 'ran.txt'))).toBe(false);
  });

  it('refuses a command it could not rebuild', async () => {
    const { root, gate } = setup();
    const r = await replay(root, { ...gate, unresolved: ['secrets.TOKEN'] });
    expect(r.status).toBe('unjudged');
    expect(r.reason).toMatch(/secrets\.TOKEN/);
  });

  it('leaves action steps to remote mode', async () => {
    const { root, gate } = setup();
    const { run: _run, ...rest } = gate;
    const r = await replay(root, { ...rest, kind: 'uses' });
    expect(r.status).toBe('unjudged');
    expect(r.reason).toMatch(/falsegreen remote/);
  });

  it('restores tracked files a step changes and stops replaying it', async () => {
    const { root, gate } = setup();
    const r = await replay(root, {
      ...gate,
      run: 'echo "// touched" >> src/sum.ts\nnpx vitest run',
    });
    expect(r.status).toBe('unjudged');
    expect(r.reason).toMatch(/changed tracked files: src\/sum\.ts/);
    expect(statusPorcelain(root)).toBe('');
  });
});
