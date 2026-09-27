/**
 * Runs falsegreen against a fixture repository: the directory is copied under tmp/, committed to a
 * fresh git repository, and analyzed with the same steps the CLI takes.
 */
import { cpSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { loadConfig } from '../../src/config/load';
import { statusPorcelain } from '../../src/core/git';
import type { Finding, Tier, Verdict } from '../../src/core/types';
import type { ToolId } from '../../src/faults/types';
import { replayGates, type GateResult } from '../../src/local/replay';
import { resolveAll } from '../../src/resolve/gates';
import { staticFindings } from '../../src/static/rules';
import { loadWorkflows } from '../../src/workflow/parse';
import { makeRepo } from './repo';

export const FIXTURES = join(import.meta.dirname, '..', 'fixtures');

/** Directories under test/fixtures that hold data, not fixture repositories. */
export const DATA_DIRS = new Set(['workflows', 'api']);

export interface Expected {
  /** Toolchains the fixture needs (see helpers/toolchains.ts). */
  requires?: string[];
  gates: { job: string; step: string; tool: ToolId; reach?: Verdict; semantic?: Verdict }[];
  static: { rule: string; step?: string }[];
}

export function fixtureNames(): string[] {
  return readdirSync(FIXTURES, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !DATA_DIRS.has(d.name))
    .map((d) => d.name)
    .sort();
}

export function expected(name: string): Expected {
  return JSON.parse(readFileSync(join(FIXTURES, name, 'expected.json'), 'utf8')) as Expected;
}

export interface FixtureRun {
  results: GateResult[];
  findings: Finding[];
  status: string;
}

export async function runFixture(
  name: string,
  tiers: Tier[] = ['reach', 'semantic'],
): Promise<FixtureRun> {
  const repo = makeRepo();
  try {
    cpSync(join(FIXTURES, name), repo.root, {
      recursive: true,
      filter: (src) => !src.endsWith('expected.json'),
    });
    repo.commitAll('fixture');
    const root = repo.root;
    const workflows = loadWorkflows(root);
    const cfg = loadConfig(root);
    const { gates, emptySteps } = resolveAll(root, workflows, cfg, { matrix: 'first' });
    const findings = staticFindings(workflows, gates, emptySteps);
    const results = await replayGates(root, gates, cfg, {
      tiers,
      assumeGreen: false,
      timeoutMs: 280_000,
    });
    return { results, findings, status: statusPorcelain(root) };
  } finally {
    rmSync(repo.root, { recursive: true, force: true });
  }
}
