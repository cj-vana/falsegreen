/**
 * A commit on top of the base commit that holds every fault of one tier, made with the Git Data
 * API (blobs, a tree on the base tree, a commit). Nothing is pushed from the local checkout.
 */
import { execFileSync } from 'node:child_process';

import type { Fault } from '../faults/types';
import type { GitHubClient } from './github';

/** Merges faults into one set of file contents; later faults that collide on a path are dropped. */
export function mergeFaults(
  root: string,
  baseSha: string,
  faults: Fault[],
): { files: Map<string, string>; dropped: string[] } {
  const files = new Map<string, string>();
  const dropped: string[] = [];
  const appended = new Map<string, string[]>();
  for (const fault of faults) {
    if (fault.files.some((f) => files.has(f.path))) {
      dropped.push(
        `${fault.tool}: ${fault.files.map((f) => f.path).join(', ')} is already planted by another tool`,
      );
      continue;
    }
    for (const f of fault.files) files.set(f.path, f.content);
    for (const a of fault.appends) appended.set(a.path, [...(appended.get(a.path) ?? []), a.text]);
  }
  for (const [path, texts] of appended) {
    const original = execFileSync('git', ['show', `${baseSha}:${path}`], {
      cwd: root,
      encoding: 'utf8',
    });
    files.set(path, original + texts.join(''));
  }
  return { files, dropped };
}

export async function createFaultCommit(
  gh: GitHubClient,
  repo: string,
  baseSha: string,
  files: Map<string, string>,
  message: string,
): Promise<string> {
  const tree: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const [path, content] of files) {
    const { data } = await gh.request<{ sha: string }>('POST', `/repos/${repo}/git/blobs`, {
      content: Buffer.from(content, 'utf8').toString('base64'),
      encoding: 'base64',
    });
    tree.push({ path, mode: '100644', type: 'blob', sha: data.sha });
  }
  const { data: base } = await gh.request<{ tree: { sha: string } }>(
    'GET',
    `/repos/${repo}/git/commits/${baseSha}`,
  );
  const { data: newTree } = await gh.request<{ sha: string }>('POST', `/repos/${repo}/git/trees`, {
    base_tree: base.tree.sha,
    tree,
  });
  const { data: commit } = await gh.request<{ sha: string }>('POST', `/repos/${repo}/git/commits`, {
    message,
    tree: newTree.sha,
    parents: [baseSha],
  });
  return commit.sha;
}
