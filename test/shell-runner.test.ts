import { describe, expect, it } from 'vitest';

import { allCommands, parseShell } from '../src/shell/parse';
import { skippedOnRunner, testOnRunner } from '../src/shell/runner';

const test = (text: string) => testOnRunner(allCommands(parseShell(text))[0]!);

/** The commands that run on a runner, by their first word. */
const kept = (text: string) =>
  allCommands(parseShell(text))
    .filter((c) => !skippedOnRunner(c))
    .map((c) => c.argv[0]!.value);

describe('testOnRunner', () => {
  it('decides tests on the variables a runner sets', () => {
    expect(test('[ -z "$GITHUB_ACTIONS" ]')).toBe(false);
    expect(test('[ -n "${CI}" ]')).toBe(true);
    expect(test('test -n "${CI:-}"')).toBe(true);
    expect(test('[ ! -z $CI ]')).toBe(true);
    expect(test('[ "$GITHUB_ACTIONS" = "true" ]')).toBe(true);
    expect(test('[[ $CI != true ]]')).toBe(false);
    expect(test('[ "$CI" ]')).toBe(true);
  });

  it('leaves everything else unknown', () => {
    expect(test('[ -d venv ]')).toBeUndefined();
    expect(test('[ "$RUNNER_OS" = Linux ]')).toBeUndefined();
    expect(test('[[ $CI == t* ]]')).toBeUndefined();
    expect(test('grep -q x file')).toBeUndefined();
  });
});

describe('skippedOnRunner', () => {
  it('drops the branch a runner never takes, including nested and elif branches', () => {
    const script = [
      'if [ -z "$CI" ]; then',
      '  local-only',
      '  if [ -d venv ]; then nested-local; fi',
      'elif [ -n "$GITHUB_ACTIONS" ]; then',
      '  on-runner',
      'else',
      '  never',
      'fi',
      'if [ -d venv ]; then maybe; else maybe-not; fi',
      'always',
    ].join('\n');
    // The first `[` is the -z test; the nested `[ -d venv ]` goes with its branch.
    expect(kept(script)).toEqual(['[', '[', 'on-runner', '[', 'maybe', 'maybe-not', 'always']);
  });

  it('drops commands inside a substitution in a dropped branch', () => {
    expect(kept('if [ -z "$CI" ]; then\n  out=$(ruff check .)\nfi\npytest')).toEqual([
      '[',
      'pytest',
    ]);
  });

  it('keeps the body of a condition with more than one command', () => {
    expect(kept('if [ -z "$CI" ] && [ -d venv ]; then\n  local\nfi')).toEqual(['[', '[', 'local']);
  });
});
