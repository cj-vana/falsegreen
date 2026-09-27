/** Hand-built gates and results for report tests, without resolving a real repository. */
import type { Marker } from '../../src/core/marker';
import type { Tier, Verdict } from '../../src/core/types';
import type { ToolId } from '../../src/faults/types';
import type { FaultRun, GateResult } from '../../src/local/replay';
import type { Gate } from '../../src/resolve/gates';

const marker: Marker = { id: 'abc123', snake: 'falsegreen_abc123', pascal: 'Falsegreenabc123' };

export function fakeGate(over: Partial<Gate> = {}): Gate {
  const step = { index: 1, with: {}, env: {}, loc: { file: '.github/workflows/ci.yml', line: 12 } };
  const job = {
    id: 'test',
    needs: [],
    env: {},
    defaults: {},
    steps: [step],
    loc: { file: '.github/workflows/ci.yml', line: 4 },
  };
  return {
    key: '.github/workflows/ci.yml#test#1#0',
    workflow: '.github/workflows/ci.yml',
    jobId: 'test',
    jobName: 'test',
    checkName: 'test',
    stepIndex: 1,
    stepName: 'Run npm test',
    loc: step.loc,
    runLine: 13,
    kind: 'run',
    run: 'npm test',
    workingDirectory: '',
    env: {},
    combo: {},
    invocations: [
      {
        tool: 'vitest',
        argv: ['vitest', 'run'],
        cwd: '',
        pathArgs: [],
        via: ['npm test', 'vitest run'],
      },
    ],
    traces: [],
    unresolved: [],
    notes: [],
    ifPresent: [],
    job,
    step,
    ...over,
  };
}

export function fakeRun(tier: Tier, verdict: Verdict, over: Partial<FaultRun> = {}): FaultRun {
  const tool: ToolId = over.tool ?? 'vitest';
  const path = `test/${marker.snake}.test.ts`;
  return {
    tool,
    tier,
    fault: {
      tool,
      tier,
      marker,
      files: [{ path, content: '' }],
      appends: [],
      description:
        tier === 'reach' ? `test file that does not parse: ${path}` : `failing test: ${path}`,
    },
    verdict,
    exitCode: verdict === 'survived' ? 0 : 1,
    durationMs: 1200,
    excerpt: verdict === 'caught' ? `FAIL ${path}` : '',
    ...over,
  };
}

export function fakeResult(runs: FaultRun[], over: Partial<GateResult> = {}): GateResult {
  return {
    gate: fakeGate(),
    status: 'judged',
    baseline: { exitCode: 0, durationMs: 900, excerpt: '' },
    runs,
    ...over,
  };
}
