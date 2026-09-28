import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { remoteCommand, type RemoteCommandOptions } from '../src/commands/remote';
import { headSha } from '../src/core/git';
import { fakeGitHub } from './helpers/fake-github';
import { makeRepo, makeTempDir, type TempRepo } from './helpers/repo';

const CI = readFileSync(
  join(import.meta.dirname, 'fixtures', 'api', 'remote', 'fixture-ci.yml'),
  'utf8',
);

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.remove();
  repo = undefined;
});

function setup(extra: Record<string, string> = {}) {
  repo = makeRepo({
    'package.json': '{ "name": "fx", "private": true, "type": "module" }\n',
    'src/sum.js': 'export const sum = (a, b) => a + b;\n',
    'test/sum.test.js': "import test from 'node:test';\n\ntest('sum', () => {});\n",
    '.github/workflows/ci.yml': CI,
    ...extra,
  });
  repo.git('remote', 'add', 'origin', 'https://github.com/o/r.git');
  const fake = fakeGitHub({
    conclusions: { test: 'failure', lenient: 'success' },
    pushStarts: ['.github/workflows/ci.yml'],
    commits: [headSha(repo.root)],
  });
  return { root: repo.root, fake };
}

let out = '';
const io = { out: (s: string) => void (out += s), err: () => {}, env: {}, color: false };

function options(
  root: string,
  fake: ReturnType<typeof fakeGitHub>,
  over: Partial<RemoteCommandOptions> = {},
): RemoteCommandOptions {
  return {
    cwd: root,
    matrix: 'first',
    yes: true,
    pr: false,
    deleteRuns: false,
    keepBranch: false,
    timeoutMs: 60_000,
    pollMs: 1,
    out: join(makeTempDir('report'), 'r'),
    formats: ['json'],
    github: { client: fake.client, kind: 'personal-or-app' },
    ...over,
  };
}

describe('remoteCommand', () => {
  it('prints the plan and exits 0 without --yes', async () => {
    const { root, fake } = setup();
    out = '';
    const { exitCode, report } = await remoteCommand(options(root, fake, { yes: false }), io);
    expect(exitCode).toBe(0);
    expect(report.remote?.ran).toBe(false);
    expect(out).toMatch(/plan only: pass --yes/);
  });

  it('reports the dead job, and a required check that passed with faults planted', async () => {
    const { root, fake } = setup();
    out = '';
    const { exitCode, report } = await remoteCommand(options(root, fake), io);
    expect(exitCode).toBe(1);
    expect(report.modes).toEqual(['static', 'remote']);
    expect(report.findings.map((f) => f.rule)).toContain('dead-gate');
    expect(out).toMatch(/job lenient\s+reach survived/);
  });

  it('fails with the reason when the plan is refused', async () => {
    const { root, fake } = setup({
      '.github/workflows/release.yml':
        'on: push\njobs:\n  build:\n    steps:\n      - run: npm publish\n',
    });
    await expect(remoteCommand(options(root, fake), io)).rejects.toThrow(/refused.*npm publish/);
  });
});
