/** Matrix expansion following GitHub's documented include and exclude rules. */
import type { MatrixSpec } from './model';

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

interface Combo {
  values: Record<string, string>;
  /** Keys that came from the matrix axes, which an include may never overwrite. */
  original: Set<string>;
  /** Combinations created by an include; later includes do not merge into them. */
  appended: boolean;
}

export function expandMatrix(spec: MatrixSpec | undefined): Record<string, string>[] {
  if (!spec || spec.expression !== undefined) return [{}];

  const keys = Object.keys(spec.axes);
  let combos: Combo[] =
    keys.length === 0 ? [] : [{ values: {}, original: new Set(), appended: false }];
  for (const key of keys) {
    combos = combos.flatMap((combo) =>
      spec.axes[key]!.map((value) => ({
        values: { ...combo.values, [key]: text(value) },
        original: new Set([...combo.original, key]),
        appended: false,
      })),
    );
  }

  combos = combos.filter(
    (combo) =>
      !spec.exclude.some((ex) => Object.entries(ex).every(([k, v]) => combo.values[k] === text(v))),
  );

  for (const inc of spec.include) {
    const entries = Object.entries(inc).map(([k, v]) => [k, text(v)] as const);
    let merged = false;
    for (const combo of combos) {
      if (combo.appended) continue;
      if (entries.every(([k, v]) => !combo.original.has(k) || combo.values[k] === v)) {
        for (const [k, v] of entries) combo.values[k] = v;
        merged = true;
      }
    }
    if (!merged) {
      combos.push({ values: Object.fromEntries(entries), original: new Set(), appended: true });
    }
  }

  return combos.length > 0 ? combos.map((c) => c.values) : [{}];
}
