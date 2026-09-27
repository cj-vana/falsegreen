/**
 * A small GitHub REST client on fetch. github.com gets API version 2026-03-10, where workflow
 * dispatch answers 200 with the run id; other hosts (GitHub Enterprise Server) get 2022-11-28.
 * See https://docs.github.com/en/rest/about-the-rest-api/api-versions
 */
import { version } from '../version';

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface GitHubResponse<T> {
  status: number;
  data: T;
  headers: Headers;
}

export interface GitHubClient {
  request<T>(method: string, path: string, body?: unknown): Promise<GitHubResponse<T>>;
  paginate<T>(path: string): Promise<T[]>;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const PUBLIC_API = 'https://api.github.com';

function nextLink(headers: Headers): string | undefined {
  return /<([^>]+)>;\s*rel="next"/.exec(headers.get('link') ?? '')?.[1];
}

export function createClient(
  token: string,
  baseUrl?: string,
  fetchImpl: Fetch = fetch,
): GitHubClient {
  const base = (baseUrl ?? process.env.GITHUB_API_URL ?? PUBLIC_API).replace(/\/$/, '');
  const apiVersion = base === PUBLIC_API ? '2026-03-10' : '2022-11-28';

  async function call<T>(method: string, url: string, body?: unknown): Promise<GitHubResponse<T>> {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': apiVersion,
        'User-Agent': `falsegreen/${version}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const isJson = res.headers.get('content-type')?.includes('json') ?? false;
    const data = (res.status === 204 || !isJson ? await res.text() : await res.json()) as T;
    if (!res.ok) {
      const detail = (data as { message?: string } | undefined)?.message;
      const path = url.startsWith(base) ? url.slice(base.length) : url;
      throw new GitHubError(
        res.status,
        `${method} ${path}: HTTP ${res.status}${detail ? ` ${detail}` : ''}`,
      );
    }
    return { status: res.status, data, headers: res.headers };
  }

  return {
    request: (method, path, body) => call(method, `${base}${path}`, body),
    async paginate<T>(path: string) {
      const items: T[] = [];
      let url: string | undefined = `${base}${path}`;
      for (let page = 0; url !== undefined && page < 100; page++) {
        const res: GitHubResponse<T[]> = await call<T[]>('GET', url);
        items.push(...res.data);
        url = nextLink(res.headers);
      }
      return items;
    },
  };
}
