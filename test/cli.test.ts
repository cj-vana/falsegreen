import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildProgram, runCli, type CliIO } from '../src/cli-program';
import { statusPorcelain } from '../src/core/git';
import { journalPath } from '../src/plant/journal';
import { plant } from '../src/plant/planter';
import type { Report } from '../src/report/model';
import { version } from '../src/version';
import { copyFixture } from './helpers/fixture';
import { makeRepo, makeTempDir, type TempRepo } from './helpers/repo';

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.remove();
  repo = undefined;
});

interface Captured {
  out: string;
  err: string;
  code: number | undefined;
}

async function cli(args: string[]): Promise<Captured> {
  const captured: Captured = { out: '', err: '', code: undefined };
  const io: CliIO = {
    out: (s) => (captured.out += s),
    err: (s) => (captured.err += s),
    env: {},
    color: false,
    setExitCode: (c) => (captured.code = c),
  };
  const program = buildProgram(io);
  // Subcommands copy these settings when they are created, so set them on each one too.
  for (const cmd of [program, ...program.commands]) {
    cmd.exitOverride().configureOutput({ writeOut: io.out, writeErr: io.err });
  }
  try {
    await program.parseAsync(['node', 'falsegreen', ...args]);
  } catch (err) {
    const e = err as { exitCode?: number; message: string };
    captured.code = e.exitCode ?? 2;
    captured.err += e.message;
  }
  return captured;
}

describe('cli basics', () => {
  it('prints the package version', async () => {
    const r = await cli(['--version']);
    expect(r.out.trim()).toBe(version);
  });

  it.each(['run', 'list', 'clean', 'init'])(
    "%s --help names the default directory instead of printing this machine's path",
    async (command) => {
      const r = await cli([command, '--help']);
      // Help wraps long lines, so compare with the whitespace collapsed.
      expect(r.out.replace(/\s+/g, ' ')).toContain('(default: the current directory)');
      expect(r.out).not.toContain(process.cwd());
    },
  );

  it('runCli parses the argv it is given', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await expect(runCli(['node', 'falsegreen', '--version'])).rejects.toThrow('exit 0');
      expect(write).toHaveBeenCalledWith(`${version}\n`);
    } finally {
      exit.mockRestore();
      write.mockRestore();
    }
  });

  it('rejects an unknown option', async () => {
    const r = await cli(['static', '--no-such-flag']);
    expect(r.err).toContain("unknown option '--no-such-flag'");
    expect(r.code).toBe(1);
  });

  it.each([
    ['run', 'abc'],
    ['local', '0'],
    ['remote', '-5'],
  ])('%s rejects --timeout %s', async (command, value) => {
    // "abc" used to become NaN, and every run then "timed out after NaN s".
    // -C an empty directory: were the value accepted, nothing here could be replayed.
    const r = await cli([command, '-C', makeTempDir('timeout'), '--timeout', value]);
    expect(r.err).toContain('--timeout must be a positive number of minutes');
    expect(r.code).not.toBe(0);
  });

  it('list and static report a leftover journal instead of restoring it; clean restores it', async () => {
    // Commands that run nothing must not pull a fault out from under a run that is planting.
    repo = copyFixture('js-vitest');
    plant(repo.root, {
      tool: 'vitest',
      tier: 'reach',
      marker: { id: 'abc123', snake: 'falsegreen_abc123', pascal: 'Falsegreenabc123' },
      files: [{ path: 'test/falsegreen_abc123.test.ts', content: 'x' }],
      appends: [],
      description: 'planted',
    });
    for (const command of ['list', 'static']) {
      const r = await cli([command, '-C', repo.root]);
      expect(r.err).toContain('run `falsegreen clean`');
      expect(existsSync(journalPath(repo.root))).toBe(true);
    }
    const clean = await cli(['clean', '-C', repo.root]);
    expect(clean.out).toBe('restored: test/falsegreen_abc123.test.ts\n');
    expect(existsSync(journalPath(repo.root))).toBe(false);
  });

  it('accepts the required-check options and rejects a bad mode', async () => {
    repo = copyFixture('js-vitest');
    const out = join(makeTempDir('report'), 'r');
    const ok = await cli([
      'static',
      '--cwd',
      repo.root,
      '--out',
      out,
      '--required-checks',
      'off',
      '--branch',
      'main',
    ]);
    expect(ok.code).toBe(1);
    const bad = await cli(['static', '--cwd', repo.root, '--required-checks', 'sometimes']);
    expect(bad.err).toMatch(/sometimes/);
  });

  it('rejects an unknown report format', async () => {
    repo = copyFixture('js-vitest');
    const r = await cli(['static', '--cwd', repo.root, '--formats', 'json,xml']);
    expect(r.err).toMatch(/xml/);
    expect(r.code).toBe(2);
  });

  it('explains that it needs a git repository', async () => {
    const dir = makeTempDir('plain');
    const saved = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dirname(dir);
    try {
      const r = await cli(['static', '--cwd', dir]);
      expect(r.err).toMatch(/git repository/);
      expect(r.code).toBe(2);
    } finally {
      if (saved === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = saved;
    }
  });
});

describe('falsegreen list', () => {
  it('prints each gate and the faults it would plant, without planting them', async () => {
    repo = copyFixture('js-vitest');
    const r = await cli(['list', '--cwd', repo.root]);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Run npm test');
    expect(r.out).toMatch(/vitest via npm test > vitest run/);
    expect(r.out).toMatch(
      /reach: test file that does not parse: test\/falsegreen_[0-9a-f]{6}\.test\.ts/,
    );
    expect(r.out).toMatch(/semantic: failing test: test\/falsegreen_[0-9a-f]{6}\.test\.ts/);
    expect(statusPorcelain(repo.root)).toBe('');
  });
});

describe('falsegreen static', () => {
  it('reports static findings, plants nothing, and exits 1 on a high finding', async () => {
    repo = copyFixture('js-vitest');
    const out = join(makeTempDir('report'), 'r');
    const r = await cli(['static', '--cwd', repo.root, '--out', out, '--formats', 'json']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('masked-exit');
    const report = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as Report;
    expect(report.modes).toEqual(['static']);
    expect(report.gates.map((g) => g.status)).toEqual(['listed', 'listed']);
    expect(existsSync(join(repo.root, '.git', 'falsegreen-journal.json'))).toBe(false);
  });

  it('exits 0 when nothing reaches --fail-on', async () => {
    repo = copyFixture('js-vitest');
    const out = join(makeTempDir('report'), 'r');
    const r = await cli([
      'static',
      '--cwd',
      repo.root,
      '--out',
      out,
      '--fail-on',
      'high',
      '--job',
      'nothing',
    ]);
    expect(r.code).toBe(0);
  });
});

describe('falsegreen run', () => {
  it('replays gates, reports the dead one, writes reports and leaves the tree clean', async () => {
    repo = copyFixture('js-vitest');
    const out = join(makeTempDir('report'), 'r');
    const r = await cli([
      'run',
      '--cwd',
      repo.root,
      '--out',
      out,
      '--formats',
      'json,sarif,md',
      '--log-level',
      'silent',
    ]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/high\s+dead-gate/);
    const report = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as Report;
    expect(report.modes).toEqual(['static', 'local']);
    expect(report.summary).toMatchObject({ gates: 2, judged: 2, deadGates: 1 });
    expect(existsSync(join(out, 'results.sarif'))).toBe(true);
    expect(existsSync(join(out, 'summary.md'))).toBe(true);
    expect(statusPorcelain(repo.root)).toBe('');
  });

  it('is the default command, and --step limits the gates', async () => {
    repo = copyFixture('js-vitest');
    const out = join(makeTempDir('report'), 'r');
    const r = await cli([
      '--cwd',
      repo.root,
      '--out',
      out,
      '--step',
      'Run npm test',
      '--log-level',
      'silent',
    ]);
    expect(r.code).toBe(0);
    const report = JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')) as Report;
    expect(report.gates.map((g) => g.step)).toEqual(['Run npm test']);
  });

  it('prints progress unless silent', async () => {
    repo = copyFixture('js-vitest');
    const out = join(makeTempDir('report'), 'r');
    const r = await cli([
      'local',
      '--cwd',
      repo.root,
      '--out',
      out,
      '--step',
      'Run npm test',
      '--tier',
      'reach',
    ]);
    expect(r.err).toMatch(/Run npm test: baseline passed/);
    expect(r.err).toMatch(/Run npm test: reach vitest caught/);
  });
});

describe('falsegreen clean and init', () => {
  it('says when there is nothing to restore', async () => {
    repo = makeRepo();
    const r = await cli(['clean', '--cwd', repo.root]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/nothing to restore/);
  });

  it('writes a config and a workflow, and refuses to overwrite them', async () => {
    repo = makeRepo();
    const first = await cli(['init', '--cwd', repo.root]);
    expect(first.code).toBe(0);
    expect(readFileSync(join(repo.root, 'falsegreen.config.yml'), 'utf8')).toMatch(/failOn: high/);
    expect(readFileSync(join(repo.root, '.github/workflows/falsegreen.yml'), 'utf8')).toMatch(
      /uses: cj-vana\/falsegreen@v0/,
    );
    const second = await cli(['init', '--cwd', repo.root]);
    expect(second.code).toBe(2);
    expect(second.err).toMatch(/already exists/);
  });
});
