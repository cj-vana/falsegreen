import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

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
    expect(result.plan.refused).toMatch(/deploy\.yml.*production environment.*remote\.allow/);
    expect(result.ran).toBe(false);
    expect(writes(state.calls)).toEqual([]);
  });

  it.each([
    [
      'a job named like a release',
      'on: push\njobs:\n  publish-npm:\n    steps:\n      - run: npm ci\n',
      /job publish-npm is named like a release or deploy job/,
    ],
    [
      'a publisher behind a package script',
      'on: push\njobs:\n  build:\n    steps:\n      - run: npm run ship\n',
      /job build runs changeset publish/,
    ],
    [
      'a deploy action',
      'on: push\njobs:\n  docs:\n    steps:\n      - uses: peaceiris/actions-gh-pages@v4\n',
      /job docs uses peaceiris\/actions-gh-pages@v4/,
    ],
    [
      'a reusable workflow',
      'on: push\njobs:\n  ship:\n    uses: ./.github/workflows/ship.yml\n',
      /job ship calls \.\/\.github\/workflows\/ship\.yml, which falsegreen does not inspect/,
    ],
  ])('refuses when the push would start %s', async (_what, workflow, reason) => {
    const { loaded, sha } = setup({
      '.github/workflows/other.yml': workflow,
      'package.json':
        '{ "name": "fx", "private": true, "scripts": { "ship": "changeset publish" } }\n',
    });
    const { client, state } = fake(sha);
    const result = await runRemote(loaded, client, 'o/r', options(), quiet);
    expect(result.plan.refused).toMatch(reason);
    expect(writes(state.calls)).toEqual([]);
  });

  it('refuses a deploy that the draft pull request would start, with --pr', async () => {
    const deploy =
      'on: pull_request\njobs:\n  preview:\n    environment: preview\n    steps:\n      - run: ./preview.sh\n';
    // pr.yml has a gate and runs only on pull_request, so --pr opens a pull request for it.
    const { loaded, sha } = setup({
      '.github/workflows/preview.yml': deploy,
      '.github/workflows/pr.yml':
        'on: pull_request\njobs:\n  test:\n    steps:\n      - run: node --test\n',
    });
    const withPr = await runRemote(loaded, fake(sha).client, 'o/r', options({ pr: true }), quiet);
    expect(withPr.plan.refused).toMatch(/opening the pull request would start .*preview\.yml/);
    // Without --pr no pull request is opened, so nothing starts it.
    const without = await runRemote(
      loaded,
      fake(sha).client,
      'o/r',
      options({ yes: false }),
      quiet,
    );
    expect(without.plan.refused).toBeUndefined();
  });

  it('shows every workflow the push starts in the plan, gates or not', async () => {
    const docs = 'on: push\njobs:\n  docs:\n    steps:\n      - run: echo building docs\n';
    const { loaded, sha } = setup({ '.github/workflows/docs.yml': docs });
    const result = await runRemote(loaded, fake(sha).client, 'o/r', options({ yes: false }), quiet);
    expect(result.plan.entries.find((e) => e.workflow.endsWith('docs.yml'))).toEqual({
      workflow: '.github/workflows/docs.yml',
      start: 'push',
      reason: 'pushing the branch starts it too; it has no gates to judge',
      judged: false,
    });
  });

  it('opens one draft pull request per branch, however many workflows it starts', async () => {
    const pr = (name: string) =>
      `on: pull_request\njobs:\n  ${name}:\n    steps:\n      - run: node --test\n`;
    const { loaded, sha } = setup({
      '.github/workflows/pr-a.yml': pr('a'),
      '.github/workflows/pr-b.yml': pr('b'),
    });
    const { client, state } = fake(sha);
    await runRemote(loaded, client, 'o/r', options({ pr: true }), quiet);
    expect(state.pulls).toHaveLength(2);
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

  it('tries every cleanup step even when one fails, and says what is left', async () => {
    const pr = 'on: pull_request\njobs:\n  test:\n    steps:\n      - run: node --test\n';
    const { loaded, sha } = setup({ '.github/workflows/pr.yml': pr });
    const { client, state } = fake(sha, {
      failures: {
        '/repos/o/r/pulls/1': 502,
        '/repos/o/r/git/refs/heads/falsegreen/run1-reach': 500,
      },
    });
    await expect(runRemote(loaded, client, 'o/r', options({ pr: true }), quiet)).rejects.toThrow(
      /cleanup did not finish: could not close pull request #1: .*HTTP 502; could not delete falsegreen\/run1-reach: .*HTTP 500/,
    );
    // The semantic branch and its pull request are gone all the same.
    expect([...state.refs.keys()]).toEqual(['falsegreen/run1-reach']);
    expect(state.pulls.find((p) => p.number === 2)?.state).toBe('closed');
  });

  it('cancels runs the push started that it never waited for', async () => {
    const docs = 'on: push\njobs:\n  docs:\n    steps:\n      - run: echo building docs\n';
    const { loaded, sha } = setup({ '.github/workflows/docs.yml': docs });
    const { client, state } = fake(sha, {
      pushStarts: ['.github/workflows/ci.yml', '.github/workflows/docs.yml'],
      pollsToComplete: Number.POSITIVE_INFINITY,
    });
    await runRemote(loaded, client, 'o/r', options({ timeoutMs: 30 }), quiet);
    const docsRuns = state.runs.filter((r) => r.path.endsWith('docs.yml')).map((r) => r.id);
    expect(docsRuns).toHaveLength(2);
    expect(state.cancelled).toEqual(expect.arrayContaining(docsRuns));
  });

  it('reports a gate job that no run reported as unjudged, instead of dropping it', async () => {
    const { loaded, sha } = setup();
    const { client } = fake(sha, { conclusions: { test: 'failure' } });
    const result = await runRemote(loaded, client, 'o/r', options(), quiet);
    const lenient = result.jobs.filter((j) => j.job === 'lenient');
    expect(lenient.map((j) => [j.tier, j.verdict, j.reason])).toEqual([
      ['reach', 'unjudged', 'no job with this name ran; check the job name and its matrix values'],
      [
        'semantic',
        'unjudged',
        'no job with this name ran; check the job name and its matrix values',
      ],
    ]);
  });

  it('cleans up when interrupted, before it exits', async () => {
    const { loaded, sha } = setup();
    const { client, state } = fake(sha, { pollsToComplete: Number.POSITIVE_INFINITY });
    let exitCode: number | undefined;
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCode = code;
    }) as never);
    try {
      const running = runRemote(
        loaded,
        client,
        'o/r',
        options({ timeoutMs: 3_000, pollMs: 20 }),
        quiet,
      );
      const until = async (done: () => boolean) => {
        const deadline = Date.now() + 10_000;
        while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      };
      await until(() => state.refs.size === 2);
      process.emit('SIGINT');
      await until(() => exitCode !== undefined);
      expect(exitCode).toBe(130);
      expect([...state.refs.keys()]).toEqual([]);
      expect(state.cancelled.length).toBeGreaterThan(0);
      await running.catch(() => undefined);
    } finally {
      exit.mockRestore();
    }
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
