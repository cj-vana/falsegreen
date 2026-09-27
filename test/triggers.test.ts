import { describe, expect, it } from 'vitest';

import { parseWorkflow } from '../src/workflow/parse';
import { globMatch, pushStarts } from '../src/workflow/triggers';

const wf = (on: string) => parseWorkflow('wf.yml', `on:\n${on}\njobs: {}\n`, '/');
const BRANCH = 'falsegreen/abc123-reach';

// Filter rules: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#onpushbranchestagsbranches-ignoretags-ignore
describe('pushStarts', () => {
  it('starts on any branch without filters', () => {
    expect(pushStarts(wf('  push:'), BRANCH, ['a.ts'])).toBe(true);
  });

  it('respects branches and branches-ignore', () => {
    expect(pushStarts(wf('  push:\n    branches: [main]'), BRANCH, [])).toBe(false);
    expect(pushStarts(wf("  push:\n    branches: ['**']"), BRANCH, [])).toBe(true);
    expect(pushStarts(wf("  push:\n    branches-ignore: ['falsegreen/**']"), BRANCH, [])).toBe(
      false,
    );
    expect(pushStarts(wf("  push:\n    branches: ['**', '!falsegreen/**']"), BRANCH, [])).toBe(
      false,
    );
  });

  it('does not start a tags-only push filter for a branch', () => {
    expect(pushStarts(wf("  push:\n    tags: ['v*']"), BRANCH, [])).toBe(false);
  });

  it('respects paths and paths-ignore', () => {
    const paths = wf("  push:\n    paths: ['src/**']");
    expect(pushStarts(paths, BRANCH, ['src/a/b.ts'])).toBe(true);
    expect(pushStarts(paths, BRANCH, ['docs/x.md'])).toBe(false);
    const ignore = wf("  push:\n    paths-ignore: ['**.md']");
    expect(pushStarts(ignore, BRANCH, ['README.md'])).toBe(false);
    expect(pushStarts(ignore, BRANCH, ['README.md', 'src/a.ts'])).toBe(true);
  });

  it('does not start a workflow without a push trigger', () => {
    expect(pushStarts(wf('  pull_request:'), BRANCH, [])).toBe(false);
  });
});

describe('globMatch', () => {
  it('keeps * inside one path segment and lets ** cross them', () => {
    expect(globMatch('feature/*', 'feature/a')).toBe(true);
    expect(globMatch('feature/*', 'feature/a/b')).toBe(false);
    expect(globMatch('feature/**', 'feature/a/b')).toBe(true);
    expect(globMatch('src/**/test.ts', 'src/test.ts')).toBe(true);
    expect(globMatch('**.js', 'a/b/c.js')).toBe(true);
  });

  it('treats ? and + as quantifiers on the previous character', () => {
    expect(globMatch('v1?.0', 'v.0')).toBe(true);
    expect(globMatch('v1?.0', 'v1.0')).toBe(true);
    expect(globMatch('ab+c', 'abbbc')).toBe(true);
    expect(globMatch('[0-9]*', '42-release')).toBe(true);
  });
});
