/**
 * Where a fault goes and what it is called. A planted file sits next to an existing file the tool
 * already handles and copies that file's naming, so the tool's own discovery rules pick it up the
 * same way they pick up the neighbor.
 */
import { posix } from 'node:path';

import type { Marker } from '../core/marker';
import type { FaultContext, Language } from './types';

export interface Shape {
  kind: 'test' | 'source';
  exts: string[];
  /** What a test file looks like for this tool; source placement excludes such files. */
  testPattern?: RegExp;
  /** Extra filter, for example "inside this tsconfig's include". */
  accept?: (path: string) => boolean;
}

/** Directories whose contents tools skip on purpose or that belong to someone else. */
const SKIP_DIRS =
  /(^|\/)(fixtures?|__fixtures__|testdata|vendor|third_party|node_modules|dist|build|target)(\/|$)/;

const dirOf = (path: string): string => {
  const d = posix.dirname(path);
  return d === '.' ? '' : d;
};

function matcher(shape: Shape): (path: string) => boolean {
  return (path) => {
    if (!shape.exts.some((e) => path.endsWith(e))) return false;
    const isTest = shape.testPattern?.test(path) ?? false;
    if (shape.kind === 'test' ? !isTest : isTest) return false;
    return shape.accept ? shape.accept(path) : true;
  };
}

export function candidateDir(
  ctx: FaultContext,
  shape: Shape,
): { dir: string; neighbor?: string } | undefined {
  const matches = matcher(shape);
  if (ctx.place !== undefined) {
    const dir = ctx.place.replace(/^\.?\/+|\/+$/g, '');
    const neighbor = ctx.tracked.filter((p) => dirOf(p) === dir && matches(p)).sort()[0];
    return neighbor === undefined ? { dir } : { dir, neighbor };
  }

  const roots =
    ctx.invocation.pathArgs.length > 0 ? ctx.invocation.pathArgs : [ctx.invocation.cwd || '.'];
  for (const r of roots) {
    if (ctx.tracked.includes(r) && matches(r)) return { dir: dirOf(r), neighbor: r };
  }
  const under = (path: string, root: string): boolean =>
    root === '.' || root === '' || path.startsWith(`${root}/`);

  const byDir = new Map<string, string[]>();
  for (const path of ctx.tracked) {
    if (!roots.some((r) => under(path, r)) || SKIP_DIRS.test(dirOf(path)) || !matches(path))
      continue;
    const dir = dirOf(path);
    byDir.set(dir, [...(byDir.get(dir) ?? []), path]);
  }
  let best: [string, string[]] | undefined;
  for (const entry of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (!best || entry[1].length > best[1].length) best = entry;
  }
  if (!best) return undefined;
  return { dir: best[0], neighbor: [...best[1]].sort()[0]! };
}

const EXT: Record<Language, RegExp> = {
  js: /\.[cm]?[jt]sx?$/,
  python: /\.py$/,
  go: /\.go$/,
  rust: /\.rs$/,
  jvm: /\.(java|kt|kts|groovy|scala)$/,
  any: /\.[^./]+$/,
};

const PREFIXES = ['test_', 'test-', 'Test'];
const SUFFIXES = ['.test', '.spec', '_test', '-test', 'Tests', 'Test', 'Spec', 'IT'];

/** The neighbor's path with its stem replaced by the marker, keeping test affixes and extension. */
export function markerName(neighbor: string, marker: Marker, lang: Language): string {
  const base = posix.basename(neighbor);
  const ext = EXT[lang].exec(base)?.[0] ?? '';
  const stem = base.slice(0, base.length - ext.length);
  const prefix =
    PREFIXES.find(
      (p) =>
        stem.startsWith(p) &&
        stem.length > p.length &&
        (p !== 'Test' || /[A-Z]/.test(stem[p.length]!)),
    ) ?? '';
  const suffix =
    SUFFIXES.find((s) => stem.endsWith(s) && stem.length > s.length + prefix.length) ?? '';
  const name = `${prefix}${lang === 'jvm' ? marker.pascal : marker.snake}${suffix}${ext}`;
  const dir = dirOf(neighbor);
  return dir === '' ? name : `${dir}/${name}`;
}
