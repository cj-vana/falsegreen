/**
 * An in-memory GitHub API for remote-mode tests. Every body it returns is a response recorded
 * from cj-vana/falsegreen-fixture (test/fixtures/api/remote), with ids, shas and markers swapped
 * for the ones this run created. Pushing a branch or dispatching a workflow starts a run whose jobs
 * finish with the conclusions the test chose; a job log names the planted files when the job ran
 * them, as the recorded logs do.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GitHubError, type GitHubClient } from '../../src/remote/github';

const DIR = join(import.meta.dirname, '..', 'fixtures', 'api', 'remote');
const recorded = <T>(name: string): T => JSON.parse(readFileSync(join(DIR, name), 'utf8')) as T;
const recordedText = (name: string): string => readFileSync(join(DIR, name), 'utf8');

interface RecordedJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  [key: string]: unknown;
}
interface RecordedRun {
  id: number;
  path: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  html_url: string;
  [key: string]: unknown;
}

export interface FakeOptions {
  /** Conclusion per job name when a run finishes. */
  conclusions: Record<string, 'success' | 'failure' | 'skipped'>;
  /** Workflow files the push of a branch starts (the token decides whether pushes start runs). */
  pushStarts?: string[];
  /** Polls a run stays in progress before it completes; Infinity never completes. */
  pollsToComplete?: number;
  /** Paths answered with this status instead of the normal body. */
  failures?: Record<string, number>;
  /** Commits that exist on the remote; the base commit must be among them. */
  commits: string[];
  /** Base file contents, for building the planted commit's tree. */
  files?: Record<string, string>;
}

export interface FakeState {
  calls: { method: string; path: string; body?: unknown }[];
  refs: Map<string, string>;
  runs: (RecordedRun & { polls: number; markers: string[] })[];
  pulls: { number: number; state: string; head: string }[];
  deletedRuns: number[];
  cancelled: number[];
}

export function fakeGitHub(opts: FakeOptions): { client: GitHubClient; state: FakeState } {
  const state: FakeState = {
    calls: [],
    refs: new Map(),
    runs: [],
    pulls: [],
    deletedRuns: [],
    cancelled: [],
  };
  const trees = new Map<string, string[]>();
  const commits = new Map<string, string>();
  const blobs = new Map<string, string>();
  let nextId = 5000;
  const baseRun = recorded<{ workflow_runs: RecordedRun[] }>('runs-by-sha.json').workflow_runs[0]!;
  const baseJobs = recorded<{ jobs: RecordedJob[] }>('jobs.json').jobs;

  function startRun(path: string, event: string, sha: string, branch: string): RecordedRun {
    const id = nextId++;
    const markers = [
      ...new Set(
        (trees.get(commits.get(sha) ?? '') ?? []).flatMap(
          (p) => /falsegreen_?[0-9a-f]{6}/i.exec(p)?.[0] ?? [],
        ),
      ),
    ];
    const run = {
      ...baseRun,
      id,
      path,
      event,
      head_sha: sha,
      head_branch: branch,
      status: 'queued',
      conclusion: null,
      html_url: `https://github.com/o/r/actions/runs/${id}`,
      polls: 0,
      markers,
    };
    state.runs.push(run);
    return run;
  }

  function tick(): void {
    for (const run of state.runs) {
      if (run.status === 'completed') continue;
      run.polls++;
      run.status = 'in_progress';
      if (run.polls >= (opts.pollsToComplete ?? 1)) {
        run.status = 'completed';
        run.conclusion = Object.values(opts.conclusions).includes('failure')
          ? 'failure'
          : 'success';
      }
    }
  }

  const routes: [string, RegExp, (m: RegExpExecArray, body: Record<string, unknown>) => unknown][] =
    [
      ['GET', /^\/repos\/o\/r$/, () => ({ default_branch: 'main' })],
      [
        'GET',
        /^\/repos\/o\/r\/commits\/(\w+)$/,
        (m) => {
          if (!opts.commits.includes(m[1]!)) throw new GitHubError(422, 'No commit found for SHA');
          return { sha: m[1] };
        },
      ],
      [
        'GET',
        /^\/repos\/o\/r\/git\/commits\/(\w+)$/,
        (m) => ({
          ...recorded<object>('git-commit-get.json'),
          sha: m[1],
          tree: { sha: `tree-of-${m[1]}` },
        }),
      ],
      [
        'POST',
        /^\/repos\/o\/r\/git\/blobs$/,
        (_m, body) => {
          const sha = `blob${nextId++}`;
          blobs.set(sha, Buffer.from(body.content as string, 'base64').toString('utf8'));
          return { ...recorded<object>('git-blob-create.json'), sha };
        },
      ],
      [
        'POST',
        /^\/repos\/o\/r\/git\/trees$/,
        (_m, body) => {
          const sha = `tree${nextId++}`;
          trees.set(
            sha,
            (body.tree as { path: string }[]).map((t) => t.path),
          );
          return { ...recorded<object>('git-tree-create.json'), sha };
        },
      ],
      [
        'POST',
        /^\/repos\/o\/r\/git\/commits$/,
        (_m, body) => {
          const sha = `commit${nextId++}`;
          commits.set(sha, body.tree as string);
          return { ...recorded<object>('git-commit-create.json'), sha };
        },
      ],
      [
        'POST',
        /^\/repos\/o\/r\/git\/refs$/,
        (_m, body) => {
          const branch = (body.ref as string).replace('refs/heads/', '');
          state.refs.set(branch, body.sha as string);
          for (const path of opts.pushStarts ?? [])
            startRun(path, 'push', body.sha as string, branch);
          return {
            ...recorded<object>('git-ref-create.json'),
            ref: body.ref,
            object: { sha: body.sha },
          };
        },
      ],
      [
        'POST',
        /^\/repos\/o\/r\/actions\/workflows\/([^/]+)\/dispatches$/,
        (m, body) => {
          const sha = state.refs.get(body.ref as string);
          if (!sha) throw new GitHubError(422, 'No ref found');
          const run = startRun(
            `.github/workflows/${m[1]}`,
            'workflow_dispatch',
            sha,
            body.ref as string,
          );
          return {
            workflow_run_id: run.id,
            run_url: `https://api.github.com/repos/o/r/actions/runs/${run.id}`,
            html_url: run.html_url,
          };
        },
      ],
      [
        'GET',
        /^\/repos\/o\/r\/actions\/runs\?head_sha=(\w+)/,
        (m) => {
          tick();
          return { total_count: 0, workflow_runs: state.runs.filter((r) => r.head_sha === m[1]) };
        },
      ],
      [
        'GET',
        /^\/repos\/o\/r\/actions\/runs\/(\d+)$/,
        (m) => {
          tick();
          return state.runs.find((r) => r.id === Number(m[1]));
        },
      ],
      [
        'GET',
        /^\/repos\/o\/r\/actions\/runs\/(\d+)\/jobs/,
        (m) => {
          const run = state.runs.find((r) => r.id === Number(m[1]))!;
          return {
            total_count: baseJobs.length,
            jobs: Object.entries(opts.conclusions).map(([name, conclusion], i) => ({
              ...baseJobs[0],
              id: run.id * 100 + i,
              run_id: run.id,
              name,
              status: 'completed',
              conclusion,
              html_url: `https://github.com/o/r/actions/runs/${run.id}/job/${run.id * 100 + i}`,
            })),
          };
        },
      ],
      [
        'GET',
        /^\/repos\/o\/r\/actions\/jobs\/(\d+)\/logs$/,
        (m) => {
          const run = state.runs.find((r) => r.id === Math.floor(Number(m[1]) / 100))!;
          const name = Object.keys(opts.conclusions)[Number(m[1]) % 100]!;
          // Both recorded jobs ran the planted test, so both logs name it; skipped jobs have none.
          if (opts.conclusions[name] === 'skipped') return '';
          return run.markers.reduce(
            (log, marker) => `${log}\n${marker}`,
            recordedText('log-test.txt').replace(/falsegreen_rec001/g, run.markers[0] ?? 'none'),
          );
        },
      ],
      [
        'POST',
        /^\/repos\/o\/r\/actions\/runs\/(\d+)\/cancel$/,
        (m) => {
          const run = state.runs.find((r) => r.id === Number(m[1]));
          if (!run || run.status === 'queued')
            throw new GitHubError(
              409,
              'Cannot cancel a workflow run that has not been queued yet.',
            );
          state.cancelled.push(run.id);
          run.status = 'completed';
          run.conclusion = 'cancelled';
          return {};
        },
      ],
      [
        'DELETE',
        /^\/repos\/o\/r\/actions\/runs\/(\d+)$/,
        (m) => {
          state.deletedRuns.push(Number(m[1]));
          return '';
        },
      ],
      [
        'POST',
        /^\/repos\/o\/r\/pulls$/,
        (_m, body) => {
          const pr = { number: state.pulls.length + 1, state: 'open', head: body.head as string };
          state.pulls.push(pr);
          const sha = state.refs.get(pr.head)!;
          startRun('.github/workflows/pr.yml', 'pull_request', sha, pr.head);
          return { number: pr.number, html_url: `https://github.com/o/r/pull/${pr.number}` };
        },
      ],
      [
        'PATCH',
        /^\/repos\/o\/r\/pulls\/(\d+)$/,
        (m, body) => {
          state.pulls.find((p) => p.number === Number(m[1]))!.state = body.state as string;
          return {};
        },
      ],
      [
        'DELETE',
        /^\/repos\/o\/r\/git\/refs\/heads\/(.+)$/,
        (m) => {
          state.refs.delete(decodeURIComponent(m[1]!));
          return '';
        },
      ],
      [
        'GET',
        /^\/repos\/o\/r\/git\/ref\/heads\/(.+)$/,
        (m) => {
          if (!state.refs.has(decodeURIComponent(m[1]!))) throw new GitHubError(404, 'Not Found');
          return { ref: `refs/heads/${m[1]}` };
        },
      ],
    ];

  const client: GitHubClient = {
    async request<T>(method: string, path: string, body?: unknown) {
      state.calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      const failure = Object.entries(opts.failures ?? {}).find(([p]) => path.startsWith(p));
      if (failure) throw new GitHubError(failure[1], `${method} ${path}: HTTP ${failure[1]}`);
      for (const [m, re, handler] of routes) {
        const match = m === method ? re.exec(path) : null;
        if (match)
          return {
            status: 200,
            data: handler(match, (body ?? {}) as Record<string, unknown>) as T,
            headers: new Headers(),
          };
      }
      throw new GitHubError(404, `${method} ${path}: no fake route`);
    },
    async paginate<T>(path: string, key?: string) {
      const { data } = await client.request<T[] | Record<string, T[]>>('GET', path);
      return key === undefined ? (data as T[]) : (data as Record<string, T[]>)[key]!;
    },
  };
  return { client, state };
}
