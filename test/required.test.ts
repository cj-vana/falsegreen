import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createClient, GitHubError, type GitHubClient } from '../src/remote/github';
import { fetchRequiredChecks, requiredFindings } from '../src/static/required';
import { parseWorkflow } from '../src/workflow/parse';

const api = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'api', `${name}.json`), 'utf8'));

/** A client that answers from recorded responses keyed by path; anything else is a 404. */
function fake(routes: Record<string, unknown>): GitHubClient {
  return {
    async request<T>(_method: string, path: string) {
      if (!(path in routes)) throw new GitHubError(404, `Not Found: ${path}`);
      return { status: 200, data: routes[path] as T, headers: new Headers() };
    },
    async paginate<T>(path: string) {
      return (routes[path] ?? []) as T[];
    },
  };
}

describe('fetchRequiredChecks (recorded responses)', () => {
  it('reads an unprotected branch as readable with nothing required', async () => {
    const gh = fake({
      '/repos/o/r/branches/main': api('branch-unprotected'),
      '/repos/o/r/rules/branches/main': api('rules-empty'),
    });
    expect(await fetchRequiredChecks(gh, 'o/r', 'main')).toEqual({ readable: true, contexts: [] });
  });

  it('reads classic protection, keeping the app id when GitHub reports one', async () => {
    const vite = await fetchRequiredChecks(
      fake({
        '/repos/o/r/branches/main': api('branch-protected'),
        '/repos/o/r/rules/branches/main': [],
      }),
      'o/r',
      'main',
    );
    expect(vite.contexts).toEqual([
      { name: 'Semantic Pull Request', appId: 15368 },
      { name: 'Build & Test Passed or Skipped', appId: 15368 },
      { name: 'Lint: node-24, ubuntu-latest', appId: 15368 },
    ]);
    const cli = await fetchRequiredChecks(
      fake({
        '/repos/o/r/branches/main': api('branch-protected-null-app'),
        '/repos/o/r/rules/branches/main': [],
      }),
      'o/r',
      'main',
    );
    expect(cli.contexts[0]).toEqual({ name: 'build (macos-latest)' });
  });

  it('reads required checks from rulesets', async () => {
    const r = await fetchRequiredChecks(
      fake({
        '/repos/o/r/branches/main': api('branch-rules-only'),
        '/repos/o/r/rules/branches/main': api('rules-with-status-checks'),
      }),
      'o/r',
      'main',
    );
    expect(r.contexts).toEqual([
      { name: 'license/cla', appId: 95686 },
      { name: 'required', appId: 15368 },
    ]);
  });

  it('reports an unreadable branch', async () => {
    expect(await fetchRequiredChecks(fake({}), 'o/r', 'main')).toEqual({
      readable: false,
      contexts: [],
      reason: 'HTTP 404',
    });
  });
});

const WORKFLOW = `on: push
jobs:
  test:
    name: test (node \${{ matrix.node }})
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - run: npm test
  lint:
    steps:
      - run: npx eslint .
  deploy:
    steps:
      - run: echo deploy
`;

describe('requiredFindings', () => {
  const wf = parseWorkflow('.github/workflows/ci.yml', WORKFLOW, '/');
  const gateJobs = new Set(['test', 'lint']);
  const rules = (fs: ReturnType<typeof requiredFindings>) =>
    fs.map((f) => [f.rule, f.severity, f.job]);

  it('flags a branch that requires nothing', () => {
    expect(
      rules(requiredFindings({ readable: true, contexts: [] }, [wf], gateJobs, 'main')),
    ).toEqual([['no-required-checks', 'medium', undefined]]);
  });

  it('flags gate jobs, and matrix combinations, that are not required', () => {
    const f = requiredFindings(
      { readable: true, contexts: [{ name: 'test (node 20)', appId: 15368 }] },
      [wf],
      gateJobs,
      'main',
    );
    expect(rules(f)).toEqual([
      ['not-required', 'medium', 'test'],
      ['not-required', 'medium', 'lint'],
    ]);
    expect(f[0]!.message).toContain('test (node 22)');
    expect(f[0]!.message).not.toContain('test (node 20)');
  });

  it('flags an Actions check that no job produces, but not checks from other apps', () => {
    const f = requiredFindings(
      {
        readable: true,
        contexts: [
          { name: 'test (node 20)', appId: 15368 },
          { name: 'test (node 22)', appId: 15368 },
          { name: 'lint' },
          { name: 'typecheck', appId: 15368 },
          { name: 'license/cla', appId: 95686 },
        ],
      },
      [wf],
      gateJobs,
      'main',
    );
    expect(rules(f)).toEqual([['required-check-missing', 'medium', undefined]]);
    expect(f[0]!.message).toContain('typecheck');
  });

  it('says when the rules could not be read', () => {
    expect(
      rules(
        requiredFindings(
          { readable: false, contexts: [], reason: 'HTTP 403' },
          [wf],
          gateJobs,
          'main',
        ),
      ),
    ).toEqual([['required-checks-unreadable', 'info', undefined]]);
  });
});

describe('createClient', () => {
  it('sends the auth, version and agent headers, and follows pagination', async () => {
    const seen: { url: string; headers: Headers }[] = [];
    const pages = [
      new Response(JSON.stringify([1, 2]), {
        headers: {
          'content-type': 'application/json',
          link: '<https://api.example/items?page=2>; rel="next"',
        },
      }),
      new Response(JSON.stringify([3]), { headers: { 'content-type': 'application/json' } }),
    ];
    const gh = createClient('tok', 'https://api.example', async (url, init) => {
      seen.push({ url: String(url), headers: new Headers(init?.headers) });
      return pages.shift()!;
    });
    expect(await gh.paginate<number>('/items')).toEqual([1, 2, 3]);
    expect(seen.map((s) => s.url)).toEqual([
      'https://api.example/items',
      'https://api.example/items?page=2',
    ]);
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer tok');
    expect(seen[0]!.headers.get('x-github-api-version')).toBe('2022-11-28');
    expect(seen[0]!.headers.get('user-agent')).toMatch(/^falsegreen\//);
  });

  it('uses the current API version on github.com', async () => {
    let version: string | null = null;
    const gh = createClient('tok', undefined, async (_url, init) => {
      version = new Headers(init?.headers).get('x-github-api-version');
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    });
    await gh.request('GET', '/x');
    expect(version).toBe('2026-03-10');
  });

  it('turns an error status into a GitHubError with the message', async () => {
    const gh = createClient(
      'tok',
      undefined,
      async () =>
        new Response(JSON.stringify({ message: 'Bad credentials' }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(gh.request('GET', '/x')).rejects.toMatchObject({
      status: 401,
      message: 'GET /x: HTTP 401 Bad credentials',
    });
  });
});
