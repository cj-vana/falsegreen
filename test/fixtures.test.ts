/**
 * Every fixture repository under test/fixtures, run for real. Each fixture's expected.json states
 * the verdict for every gate and fault, recorded from the tools' real behavior.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { toolDef } from '../src/faults/registry';
import { TOOL_IDS } from '../src/faults/types';
import { expected, FIXTURES, fixtureNames, runFixture } from './helpers/fixture';
import { missing } from './helpers/toolchains';

describe('fixture registry', () => {
  it('every fixture directory has an expected.json', () => {
    const without = fixtureNames().filter((n) => !existsSync(join(FIXTURES, n, 'expected.json')));
    expect(without).toEqual([]);
  });

  it('every tool id has faults in the registry and at least one fixture', () => {
    expect([...TOOL_IDS].filter((id) => toolDef(id) === undefined)).toEqual([]);
    const covered = new Set(fixtureNames().flatMap((n) => expected(n).gates.map((g) => g.tool)));
    expect([...TOOL_IDS].filter((id) => !covered.has(id))).toEqual([]);
  });
});

describe.each(fixtureNames())('fixture %s', (name) => {
  const exp = expected(name);
  const absent = missing(...(exp.requires ?? []));

  it.skipIf(absent.length > 0)(
    'produces the recorded verdicts and leaves the tree clean',
    async () => {
      const run = await runFixture(name);

      // Tools come from the gate, not the runs, so a gate that was never judged still shows up.
      const actual = run.results.flatMap((r) =>
        [...new Set(r.gate.invocations.map((i) => i.tool))].map((tool) => {
          const verdict = (tier: string) =>
            r.runs.find((x) => x.tool === tool && x.tier === tier)?.verdict;
          return {
            job: r.gate.jobId,
            step: r.gate.stepName,
            tool,
            ...(verdict('reach') ? { reach: verdict('reach') } : {}),
            ...(verdict('semantic') ? { semantic: verdict('semantic') } : {}),
            ...(r.status !== 'judged' ? { status: r.status } : {}),
          };
        }),
      );
      expect(actual).toEqual(exp.gates);

      const rules = run.findings.map((f) => ({
        rule: f.rule,
        ...(f.step ? { step: f.step } : {}),
      }));
      expect(rules).toEqual(exp.static);
      expect(run.status).toBe('');
    },
  );
});
