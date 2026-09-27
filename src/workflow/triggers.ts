/**
 * Whether a push to a branch starts a workflow, following the filter rules in
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
 * (`*` stays inside a path segment, `**` crosses segments, `?` and `+` quantify the previous
 * character, a leading `!` negates, and the last matching pattern wins).
 */
import type { WorkflowModel } from './model';

function toRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i++;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?' || c === '+') {
      re += c;
    } else if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close > i) {
        re += pattern.slice(i, close + 1);
        i = close;
      } else {
        re += '\\[';
      }
    } else {
      re += c.replace(/[.^$|(){}\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function globMatch(pattern: string, value: string): boolean {
  return toRegExp(pattern).test(value);
}

/** True when the last pattern that matches `value` is a positive one. */
function filterMatches(patterns: string[], value: string): boolean {
  let matched = false;
  for (const p of patterns) {
    if (p.startsWith('!')) {
      if (globMatch(p.slice(1), value)) matched = false;
    } else if (globMatch(p, value)) {
      matched = true;
    }
  }
  return matched;
}

export function pushStarts(wf: WorkflowModel, branch: string, changedPaths: string[]): boolean {
  const f = wf.triggers.push;
  if (!f) return false;
  const branchFilter = f.branches !== undefined || f.branchesIgnore !== undefined;
  const tagFilter = f.tags !== undefined || f.tagsIgnore !== undefined;
  // A filter on tags alone means branch pushes do not start the workflow.
  if (tagFilter && !branchFilter) return false;
  if (f.branches && !filterMatches(f.branches, branch)) return false;
  if (f.branchesIgnore && filterMatches(f.branchesIgnore, branch)) return false;
  if (f.paths && !changedPaths.some((p) => filterMatches(f.paths!, p))) return false;
  if (
    f.pathsIgnore &&
    changedPaths.length > 0 &&
    changedPaths.every((p) => filterMatches(f.pathsIgnore!, p))
  ) {
    return false;
  }
  return true;
}
