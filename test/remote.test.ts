import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { load } from '../src/commands/common';
import { headSha } from '../src/core/git';
import { remoteFindings, runRemote, type RemoteOptions } from '../src/remote/run';
import { fakeGitHub, type FakeOptions } from './helpers/fake-github';
import { makeRepo, type TempRepo } from './helpers/repo';

const CI = readFileSync(
  join(import.meta.dirname, 'fixtures', 'api', 'remote', 'fixture-ci.yml'),
  'utf8',
);

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.remove();
  repo = undefined;
});

const quiet = { out: () => {}, err: () => {}, env: {}, color: false };

function setup(extra: Record<string, string> = {}) {
  repo = makeRepo({
    'package.json': '{ "name": "fx", "private": true, "type": "module" }\n',
    'src/sum.js': 'export const sum = (a, b) => a + b;\n',
    'test/sum.test.js':
      "import assert from 'node:assert';\nimport test from 'node:test';\nimport { sum } from '../src/sum.js';\n\ntest('sum', () => {\n  assert.strictEqual(sum(1, 2), 3);\n});\n",
    '.github/workflows/ci.yml': CI,
    ...extra,
  });
  repo.git('remote', 'add', 'origin', 'https://github.com/o/r.git');
  return { loaded: load({ cwd: repo.root, matrix: 'first' }, quiet), sha: headSha(repo.root) };
}

function options(over: Partial<RemoteOptions> = {}): RemoteOptions {
  return {
    yes: true,
    pr: false,
    deleteRuns: false,
    keepBranch: false,
    timeoutMs: 60_000,
    pollMs: 1,
    runId: 'run1',
    tokenKind: 'personal-or-app',
    ...over,
  };
}

function fake(sha: string, over: Partial<FakeOptions> = {}) {
  return fakeGitHub({
    conclusions: { test: 'failure', lenient: 'success' },
    pushStarts: ['.github/workflows/ci.yml'],
    commits: [sha],
    ...over,
  });
}

const writes = (calls: { method: string }[]) => calls.filter((c) => c.method !== 'GET');

describe('runRemote', () => {
  it('prints the plan and writes nothing without --yes', async () => {
    const { loaded, sha } = setup();
    const { client, state } = fake(sha);
    const result = await runRemote(loaded, client, 'o/r', options({ yes: false }), quiet);
    expect(result.ran).toBe(false);
    expect(result.plan.branches).toEqual({
      reach: 'falsegreen/run1-reach',
      semantic: 'falsegreen/run1-semantic',
    });
    expect(result.plan.entries).toEqual([
      {
        workflow: '.github/workflows/ci.yml',
        start: 'push',
        reason: 'pushing the branch starts it',
      },
    ]);
    expect(writes(state.calls)).toEqual([]);
  });

  it('runs both tiers on throwaway branches, judges each gate job by its conclusion, and deletes the branches', async () => {
    const { loaded, sha } = setup();
    const { client, state } = fake(sha);
    const result = await runRemote(loaded, client, 'o/r', options(), quiet);
    expect(result.jobs.map((j) => [j.job, j.tier, j.verdict])).toEqual([
      ['test', 'reach', 'caught'],
      ['lenient', 'reach', 'survived'],
      ['test', 'semantic', 'caught'],
      ['lenient', 'semantic', 'survived'],
    ]);
    const planted = state.calls.find((c) => c.path === '/repos/o/r/git/trees')!.body as {
      tree: { path: string }[];
    };
    expect(planted.tree.map((t) => t.path)).toEqual([
      expect.stringMatching(/^test\/falsegreen_[0-9a-f]{6}\.test\.js$/),
    ]);
    expect([...state.refs.keys()]).toEqual([]);
    expect(
      state.calls.filter(
        (c) => c.method === 'GET' && c.path.startsWith('/repos/o/r/git/ref/heads/'),
      ),
    ).toHaveLength(2);
    expect(
      remoteFindings(result, loaded.workflows).map((f) => [f.rule, f.severity, f.job]),
    ).toEqual([['dead-gate', 'high', 'lenient']]);
  });

  it('does not call a job weak when its reach run was not judged', async () => {
    const { loaded, sha } = setup();
    const { client } = fake(sha);
    const result = await runRemote(loaded, client, 'o/r', options(), quiet);
    const job = (tier: 'reach' | 'semantic', verdict: 'survived' | 'unjudged') => ({
      workflow: '.github/workflows/ci.yml',
      job: 'lenient',
      tier,
      conclusion: null,
      verdict,
    });
    const findings = remoteFindings(
      { ...result, jobs: [job('reach', 'unjudged'), job('semantic', 'survived')] },
      loaded.workflows,
    );
    const weak = findings.find((f) => f.rule === 'weak-gate')!;
    expect(weak.severity).toBe('high');
    expect(weak.message).toContain('its reach run was not judged');
  });

  it('dispatches the workflow when the token is the workflow token, whose pushes start nothing', async () => {
    const { loaded, sha } = setup();
    const { client, state } = fake(sha, { pushStarts: [] });
    const result = await runRemote(
      loaded,
      client,
      'o/r',
      options({ tokenKind: 'github-token' }),
      quiet,
    );
    expect(result.plan.entries[0]).toMatchObject({ start: 'dispatch' });
    const dispatches = state.calls.filter((c) => c.path.endsWith('/dispatches'));
    expect(dispatches.map((c) => c.body)).toEqual([
      { ref: 'falsegreen/run1-reach' },
      { ref: 'falsegreen/run1-semantic' },
    ]);
    expect(result.jobs.map((j) => j.verdict)).toEqual(['caught', 'survived', 'caught', 'survived']);
  });

  it('refuses before writing anything when the push would start a deploy', async () => {
    const deploy =
      'on: push\njobs:\n  ship:\n    environment: production\n    steps:\n      - run: ./deploy.sh\n';
    const { loaded, sha } = setup({ '.github/workflows/deploy.yml': deploy });
    const { client, state } = fake(sha);
    const result = await runRemote(loaded, client, 'o/r', options(), quiet);
    expect(result.plan.refused).toMatch(/deploy\.yml.*environment production.*remote\.allow/);
    expect(result.ran).toBe(false);
    expect(writes(state.calls)).toEqual([]);
  });

  it('runs a deploy-looking workflow that is allowlisted', async () => {
    const deploy =
      'on: push\njobs:\n  ship:\n    environment: staging\n    steps:\n      - run: npm test\n';
    const { loaded, sha } = setup({
      '.github/workflows/deploy.yml': deploy,
      'falsegreen.config.yml': 'remote:\n  allow: [deploy.yml]\n',
    });
    const { client } = fake(sha, {
      pushStarts: ['.github/workflows/ci.yml', '.github/workflows/deploy.yml'],
    });
    const result = await runRemote(loaded, client, 'o/r', options({ yes: false }), quiet);
    expect(result.plan.refused).toBeUndefined();
  });

  it('opens and closes a draft pull request for workflows that run only on pull_request, with --pr', async () => {
    const pr = 'on: pull_request\njobs:\n  test:\n    steps:\n      - run: node --test\n';
    const { loaded, sha } = setup({ '.github/workflows/pr.yml': pr });
    const without = await runRemote(
      loaded,
      fake(sha).client,
      'o/r',
      options({ yes: false }),
      quiet,
    );
    expect(without.plan.entries.find((e) => e.workflow.endsWith('pr.yml'))?.reason).toMatch(/--pr/);
    const { client, state } = fake(sha);
    const withPr = await runRemote(loaded, client, 'o/r', options({ pr: true }), quiet);
    expect(withPr.plan.entries.find((e) => e.workflow.endsWith('pr.yml'))?.start).toBe('pr');
    expect(state.pulls.map((p) => p.state)).toEqual(['closed', 'closed']);
  });

  it('still deletes the branches when judging fails', async () => {
    const { loaded, sha } = setup();
    const { client, state } = fake(sha, { failures: { '/repos/o/r/actions/runs/': 500 } });
    await expect(runRemote(loaded, client, 'o/r', options(), quiet)).rejects.toThrow(/HTTP 500/);
    expect([...state.refs.keys()]).toEqual([]);
  });

  it('cancels runs that do not finish in time and leaves them unjudged', async () => {
    const { loaded, sha } = setup();
    const { client, state } = fake(sha, { pollsToComplete: Number.POSITIVE_INFINITY });
    const result = await runRemote(loaded, client, 'o/r', options({ timeoutMs: 30 }), quiet);
    expect(result.jobs.every((j) => j.verdict === 'unjudged')).toBe(true);
    expect(state.cancelled.length).toBeGreaterThan(0);
    expect([...state.refs.keys()]).toEqual([]);
  });

  it('stops before writing when the base commit is not on the remote', async () => {
    const { loaded } = setup();
    const { client, state } = fake('some-other-sha');
    await expect(runRemote(loaded, client, 'o/r', options(), quiet)).rejects.toThrow(/push/);
    expect(writes(state.calls)).toEqual([]);
  });

  it('deletes the runs it started, with --delete-runs', async () => {
    const { loaded, sha } = setup();
    const { client, state } = fake(sha);
    await runRemote(loaded, client, 'o/r', options({ deleteRuns: true }), quiet);
    expect(state.deletedRuns).toHaveLength(2);
  });
});
