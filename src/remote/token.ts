/** Where the GitHub token comes from, and whether it is the workflow's own GITHUB_TOKEN. */
import { spawnSync } from 'node:child_process';

/**
 * `github-token` is the token GitHub Actions gives a workflow. Pushes made with it start no
 * workflow runs, so remote mode can only dispatch; any other token can also start runs by pushing.
 */
export type TokenKind = 'github-token' | 'personal-or-app';

export interface Token {
  token: string;
  kind: TokenKind;
  source: string;
}

function ghAuthToken(): string | undefined {
  const r = spawnSync('gh', ['auth', 'token'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const token = r.status === 0 ? r.stdout.trim() : '';
  return token === '' ? undefined : token;
}

export function resolveToken(
  opts: { tokenEnv?: string; env?: NodeJS.ProcessEnv; gh?: () => string | undefined } = {},
): Token | undefined {
  const env = opts.env ?? process.env;
  const names = [opts.tokenEnv, 'FALSEGREEN_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN'].filter(
    (n): n is string => n !== undefined,
  );
  let found: { token: string; source: string } | undefined;
  for (const name of names) {
    const value = env[name];
    if (value) {
      found = { token: value, source: name };
      break;
    }
  }
  if (!found) {
    const token = (opts.gh ?? ghAuthToken)();
    if (token) found = { token, source: 'gh auth token' };
  }
  if (!found) return undefined;
  const isWorkflowToken =
    env.FALSEGREEN_TOKEN_KIND === 'github-token' ||
    (found.source === 'GITHUB_TOKEN' && env.GITHUB_ACTIONS === 'true');
  return { ...found, kind: isWorkflowToken ? 'github-token' : 'personal-or-app' };
}
