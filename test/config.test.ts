import { afterEach, describe, expect, it } from 'vitest';

import { ConfigError, isIgnored, loadConfig } from '../src/config/load';
import { makeRepo, type TempRepo } from './helpers/repo';

let repo: TempRepo | undefined;

afterEach(() => {
  repo?.remove();
  repo = undefined;
});

describe('loadConfig', () => {
  it('returns defaults when there is no config file', () => {
    repo = makeRepo();
    const cfg = loadConfig(repo.root);
    expect(cfg).toEqual({
      failOn: 'high',
      ignore: [],
      gates: [],
      place: [],
      matrix: { max: 4 },
      remote: { allow: [], timeoutMinutes: 30 },
    });
  });

  it('reads falsegreen.config.yml and records where it came from', () => {
    repo = makeRepo({
      'falsegreen.config.yml': [
        'failOn: medium',
        'ignore:',
        '  - rule: not-required',
        'gates:',
        '  - { job: test, step: Run suite, tool: pytest, cwd: backend }',
        'place:',
        '  - { tool: vitest, dir: src/__tests__ }',
        'remote:',
        '  allow: [ci.yml]',
      ].join('\n'),
    });
    const cfg = loadConfig(repo.root);
    expect(cfg.failOn).toBe('medium');
    expect(cfg.gates).toEqual([{ job: 'test', step: 'Run suite', tool: 'pytest', cwd: 'backend' }]);
    expect(cfg.place).toEqual([{ tool: 'vitest', dir: 'src/__tests__' }]);
    expect(cfg.remote).toEqual({ allow: ['ci.yml'], timeoutMinutes: 30 });
    expect(cfg.matrix).toEqual({ max: 4 });
    expect(cfg.source).toBe('falsegreen.config.yml');
  });

  it('also reads falsegreen.config.yaml', () => {
    repo = makeRepo({ 'falsegreen.config.yaml': 'failOn: low\n' });
    expect(loadConfig(repo.root).failOn).toBe('low');
  });

  it('reads an explicit path relative to the repository', () => {
    repo = makeRepo({ 'ci/fg.yml': 'failOn: info\n' });
    expect(loadConfig(repo.root, 'ci/fg.yml').failOn).toBe('info');
  });

  it('rejects an unknown key, naming the key and the file', () => {
    repo = makeRepo({ 'falsegreen.config.yml': 'failon: low\n' });
    expect(() => loadConfig(repo!.root)).toThrow(ConfigError);
    expect(() => loadConfig(repo!.root)).toThrow(/falsegreen\.config\.yml.*failon/s);
  });

  it('rejects an unknown tool id, listing valid ones', () => {
    repo = makeRepo({ 'falsegreen.config.yml': 'place:\n  - { tool: jasmine, dir: spec }\n' });
    expect(() => loadConfig(repo!.root)).toThrow(/place\.0\.tool.*vitest/s);
  });

  it('rejects an ignore entry that matches nothing in particular', () => {
    repo = makeRepo({ 'falsegreen.config.yml': 'ignore:\n  - {}\n' });
    expect(() => loadConfig(repo!.root)).toThrow(/ignore\.0/);
  });

  it('reports a missing explicit file and invalid YAML', () => {
    repo = makeRepo({ 'falsegreen.config.yml': 'failOn: [\n' });
    expect(() => loadConfig(repo!.root, 'nope.yml')).toThrow(/nope\.yml.*not found/);
    expect(() => loadConfig(repo!.root)).toThrow(ConfigError);
  });
});

describe('isIgnored', () => {
  const cfg = {
    failOn: 'high' as const,
    ignore: [
      { rule: 'no-required-checks' as const },
      { job: 'deploy' },
      { job: 'test', step: 'Flaky' },
    ],
    gates: [],
    place: [],
    matrix: { max: 4 },
    remote: { allow: [], timeoutMinutes: 30 },
  };

  it('matches on every field an entry sets', () => {
    expect(isIgnored(cfg, { rule: 'no-required-checks' })).toBe(true);
    expect(isIgnored(cfg, { rule: 'dead-gate', job: 'deploy', step: 'x' })).toBe(true);
    expect(isIgnored(cfg, { rule: 'dead-gate', job: 'test', step: 'Flaky' })).toBe(true);
    expect(isIgnored(cfg, { rule: 'dead-gate', job: 'test', step: 'Unit' })).toBe(false);
  });
});
