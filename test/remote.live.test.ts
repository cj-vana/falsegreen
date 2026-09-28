/**
 * Remote mode against the real cj-vana/falsegreen-fixture repository. It pushes two throwaway
 * branches and starts real workflow runs, so it runs only with FALSEGREEN_LIVE_REMOTE=1 and a
 * token that can push to that repository (FALSEGREEN_TOKEN, GITHUB_TOKEN or gh auth).
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { remoteCommand } from '../src/commands/remote';
import { makeTempDir } from './helpers/repo';

const REPO = 'https://github.com/cj-vana/falsegreen-fixture.git';

describe.skipIf(process.env.FALSEGREEN_LIVE_REMOTE !== '1')('remote mode, live', () => {
  it(
    'finds the dead job in the fixture repository and removes its branches',
    async () => {
      const dir = join(makeTempDir('live'), 'fixture');
      execFileSync('git', ['clone', '-q', REPO, dir]);
      const io = { out: () => {}, err: () => {}, env: process.env, color: false };
      const { report } = await remoteCommand(
        {
          cwd: dir,
          matrix: 'first',
          yes: true,
          pr: false,
          deleteRuns: true,
          keepBranch: false,
          timeoutMs: 10 * 60_000,
          pollMs: 10_000,
          out: join(dir, '..', 'report'),
          formats: ['json'],
        },
        io,
      );
      expect(report.remote?.jobs.map((j) => [j.job, j.tier, j.verdict]).sort()).toEqual([
        ['lenient', 'reach', 'survived'],
        ['lenient', 'semantic', 'survived'],
        ['test', 'reach', 'caught'],
        ['test', 'semantic', 'caught'],
      ]);
      expect(report.findings.find((f) => f.rule === 'dead-gate')?.job).toBe('lenient');
      const heads = execFileSync('git', ['ls-remote', '--heads', REPO], { encoding: 'utf8' });
      expect(heads).not.toContain('refs/heads/falsegreen/');
    },
    15 * 60_000,
  );
});
