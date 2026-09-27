import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import * as api from '../src/index';
import { version } from '../src/version';

describe('package entry', () => {
  it('exports the version and the documented exit codes', () => {
    expect(api.version).toBe(version);
    expect(api.EXIT).toEqual({ OK: 0, FINDINGS: 1, ERROR: 2 });
  });
});

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(version).toBe(pkg.version);
  });
});
