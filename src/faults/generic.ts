/**
 * The fault for a check falsegreen does not recognize: a file that no parser for its language
 * accepts, in the language most common where the step runs. It proves the check reads that part
 * of the repository and fails on a broken file; there is no semantic tier, because what counts as
 * a real problem depends on the unknown tool.
 */
import { posix } from 'node:path';

import type { Marker } from '../core/marker';
import { candidateDir, markerName } from './placement';
import type { ToolDef } from './types';

type Content = (m: Marker) => string;

const UNPARSEABLE: Record<string, Content> = {
  '.py': (m) => `def ${m.snake}(:\n`,
  '.go': (m) => `package ${m.snake}\n\nfunc (\n`,
  '.rs': (m) => `fn ${m.snake}( {\n`,
  '.java': (m) => `class ${m.pascal} {\n`,
  '.kt': (m) => `fun ${m.snake}( {\n`,
  '.scala': (m) => `object ${m.pascal} {\n`,
  '.ts': (m) => `export const ${m.snake} = (\n`,
  '.tsx': (m) => `export const ${m.snake} = (\n`,
  '.js': (m) => `export const ${m.snake} = (\n`,
  '.mjs': (m) => `export const ${m.snake} = (\n`,
  '.cjs': (m) => `const ${m.snake} = (\n`,
  '.jsx': (m) => `export const ${m.snake} = (\n`,
  '.rb': (m) => `def ${m.snake}(\n`,
  '.php': (m) => `<?php\nfunction ${m.snake}( {\n`,
  '.swift': (m) => `func ${m.snake}( {\n`,
  '.cs': (m) => `class ${m.pascal} {\n`,
  '.c': (m) => `int ${m.snake}( {\n`,
  '.cc': (m) => `int ${m.snake}( {\n`,
  '.cpp': (m) => `int ${m.snake}( {\n`,
  '.h': (m) => `int ${m.snake}( {\n`,
  '.lua': (m) => `function ${m.snake}(\n`,
  '.sh': (m) => `${m.snake}() {\n`,
};

/** Languages whose file name must match the class it declares. */
const CLASS_NAMED = new Set(['.java', '.scala', '.cs']);

export const generic: ToolDef = {
  id: 'generic',
  language: 'any',
  category: 'compile',
  tiers: ['reach'],
  faults(ctx, tier) {
    if (tier !== 'reach') return { skip: 'the generic fault has only the reach tier' };
    const root = ctx.invocation.cwd;
    const counts = new Map<string, number>();
    for (const file of ctx.tracked) {
      if (root !== '' && !file.startsWith(`${root}/`)) continue;
      const ext = posix.extname(file);
      if (UNPARSEABLE[ext]) counts.set(ext, (counts.get(ext) ?? 0) + 1);
    }
    const ext = [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0];
    if (ext === undefined) return { skip: 'no source files in a language falsegreen can break' };

    const where = candidateDir(ctx, { kind: 'source', exts: [ext] });
    if (!where?.neighbor) return { skip: 'no source files in a language falsegreen can break' };
    const path = markerName(where.neighbor, ctx.marker, CLASS_NAMED.has(ext) ? 'jvm' : 'any');
    return {
      tool: 'generic',
      tier,
      marker: ctx.marker,
      files: [{ path, content: UNPARSEABLE[ext]!(ctx.marker) }],
      appends: [],
      description: `${ext.slice(1)} file that does not parse: ${path}`,
    };
  },
};
