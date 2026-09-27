import { describe, expect, it } from 'vitest';

import { resolveToken } from '../src/remote/token';

const noGh = () => undefined;

describe('resolveToken', () => {
  it('prefers the named variable, then FALSEGREEN_TOKEN, GITHUB_TOKEN and GH_TOKEN', () => {
    const env = { MY: 'a', FALSEGREEN_TOKEN: 'b', GITHUB_TOKEN: 'c', GH_TOKEN: 'd' };
    expect(resolveToken({ tokenEnv: 'MY', env, gh: noGh })?.token).toBe('a');
    expect(resolveToken({ env, gh: noGh })?.token).toBe('b');
    expect(resolveToken({ env: { GH_TOKEN: 'd' }, gh: noGh })).toEqual({
      token: 'd',
      source: 'GH_TOKEN',
      kind: 'personal-or-app',
    });
  });

  it('falls back to gh auth token, and returns nothing without any token', () => {
    expect(resolveToken({ env: {}, gh: () => 'from-gh' })?.source).toBe('gh auth token');
    expect(resolveToken({ env: {}, gh: noGh })).toBeUndefined();
  });

  it('recognizes the workflow token inside Actions, or when the action says so', () => {
    expect(
      resolveToken({ env: { GITHUB_TOKEN: 't', GITHUB_ACTIONS: 'true' }, gh: noGh })?.kind,
    ).toBe('github-token');
    expect(resolveToken({ env: { GITHUB_TOKEN: 't' }, gh: noGh })?.kind).toBe('personal-or-app');
    expect(
      resolveToken({
        env: { FALSEGREEN_TOKEN: 't', FALSEGREEN_TOKEN_KIND: 'github-token' },
        gh: noGh,
      })?.kind,
    ).toBe('github-token');
  });
});
