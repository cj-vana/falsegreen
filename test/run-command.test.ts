import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runCommand, type RunOptions } from '../src/commands/run';
import { GitHubError, type GitHubClient } from '../src/remote/github';
import { copyFixture } from './helpers/fixture';
import { makeTempDir, type TempRepo } from './helpers/repo';

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.remove();
  repo = undefined;
});

const api = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'api', `${name}.json`), 'utf8'));

function fake(routes: Record<string, unknown>): GitHubClient {
  return {
    async request<T>(_method: string, path: string) {
      if (!(path in routes)) throw new GitHubError(404, `Not Found: ${path}`);
      return { status: 200, data: routes[path] as T, headers: new Headers() };
    },
    async paginate<T>() {
      return [] as T[];
    },
  };
}

const io = { out: () => {}, err: () => {}, env: {}, color: false };

function options(root: string, over: Partial<RunOptions> = {}): RunOptions {
  return {
    cwd: root,
    matrix: 'first',
    command: 'static',
    tiers: ['reach', 'semantic'],
    assumeGreen: false,
    timeoutMs: 60_000,
    out: join(makeTempDir('report'), 'r'),
    formats: [],
    quiet: true,
    requiredChecks: 'auto',
    ...over,
  };
}

describe('runCommand required checks', () => {
  it('adds required-check findings for the default branch of the origin repository', async () => {
    repo = copyFixture('js-vitest');
    repo.git('remote', 'add', 'origin', 'https://github.com/o/r.git');
    const github = fake({
      '/repos/o/r': { default_branch: 'main' },
      '/repos/o/r/branches/main': api('branch-unprotected'),
      '/repos/o/r/rules/branches/main': api('rules-empty'),
    });
    const { report } = await runCommand(options(repo.root, { github }), io);
    expect(report.findings.map((f) => f.rule)).toContain('no-required-checks');
  });

  it('uses --branch instead of the default branch', async () => {
    repo = copyFixture('js-vitest');
    repo.git('remote', 'add', 'origin', 'git@github.com:o/r.git');
    const github = fake({
      '/repos/o/r/branches/release': api('branch-protected'),
      '/repos/o/r/rules/branches/release': [],
    });
    const { report } = await runCommand(options(repo.root, { github, branch: 'release' }), io);
    const rules = report.findings.map((f) => f.rule);
    expect(rules).toContain('not-required');
    expect(rules).toContain('required-check-missing');
  });

  it('skips the required-check rules when asked, or when there is no origin', async () => {
    repo = copyFixture('js-vitest');
    const off = await runCommand(options(repo.root, { requiredChecks: 'off' }), io);
    const none = await runCommand(options(repo.root), io);
    for (const { report } of [off, none]) {
      expect(report.findings.map((f) => f.rule)).not.toContain('required-checks-unreadable');
    }
  });

  it('falls back to GITHUB_REPOSITORY only for the checkout the workflow runs in', async () => {
    repo = copyFixture('js-vitest');
    const github = fake({
      '/repos/o/r': { default_branch: 'main' },
      '/repos/o/r/branches/main': api('branch-unprotected'),
      '/repos/o/r/rules/branches/main': api('rules-empty'),
    });
    const rulesWith = async (workspace: string) => {
      const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_WORKSPACE: workspace };
      const { report } = await runCommand(options(repo!.root, { github }), { ...io, env });
      return report.findings.map((f) => f.rule);
    };
    expect(await rulesWith(repo.root)).toContain('no-required-checks');
    // falsegreen -C another/repo inside a workflow: that repository's rules are not o/r's.
    expect(await rulesWith(makeTempDir('workspace'))).not.toContain('no-required-checks');
  });

  it('reports unreadable rules instead of failing the run', async () => {
    repo = copyFixture('js-vitest');
    repo.git('remote', 'add', 'origin', 'https://github.com/o/r.git');
    const { report } = await runCommand(
      options(repo.root, { github: fake({}), branch: 'main' }),
      io,
    );
    expect(report.findings.find((f) => f.rule === 'required-checks-unreadable')?.message).toMatch(
      /HTTP 404/,
    );
  });
});
