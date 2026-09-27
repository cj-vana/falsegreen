import { describe, expect, it } from 'vitest';

import { checkName } from '../src/workflow/checks';
import type { JobModel } from '../src/workflow/model';

function job(id: string, name?: string): JobModel {
  return {
    id,
    ...(name === undefined ? {} : { name }),
    needs: [],
    env: {},
    defaults: {},
    steps: [],
    loc: { file: 'ci.yml', line: 1 },
  };
}

// Observed 2026-09-27 on live check runs:
// - cj-vana/buttonmash `name: test (node ${{ matrix.node-version }})` -> "test (node 20)"
// - psf/black job `test`, no name, matrix python-version x os -> "test (3.10, macOS-latest)"
// - tokio-rs/tokio `name: test tokio full`, matrix os -> "test tokio full (macos-latest)"
describe('checkName', () => {
  it('uses a name that references the matrix as is', () => {
    expect(
      checkName(job('test', 'test (node ${{ matrix.node-version }})'), { 'node-version': '20' }),
    ).toBe('test (node 20)');
  });

  it('uses the job id when there is no name and no matrix', () => {
    expect(checkName(job('build'), {})).toBe('build');
  });

  it('appends matrix values to a job without a name', () => {
    expect(checkName(job('test'), { 'python-version': '3.10', os: 'macOS-latest' })).toBe(
      'test (3.10, macOS-latest)',
    );
  });

  it('appends matrix values to a name without matrix references', () => {
    expect(checkName(job('t', 'test tokio full'), { os: 'macos-latest' })).toBe(
      'test tokio full (macos-latest)',
    );
  });
});
