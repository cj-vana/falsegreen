/**
 * Which files a tsconfig covers, so a type fault goes where `tsc` looks. Handles JSONC, relative
 * `extends` (string or list), `files`, `include` and `exclude`; package `extends` are ignored.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

interface Raw {
  extends?: string | string[];
  files?: string[];
  include?: string[];
  exclude?: string[];
  compilerOptions?: { outDir?: string };
}

/** Removes comments and trailing commas outside strings. */
function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) break;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function read(root: string, file: string): Raw | undefined {
  const full = join(root, file);
  if (!existsSync(full)) return undefined;
  try {
    return JSON.parse(stripJsonc(readFileSync(full, 'utf8'))) as Raw;
  } catch {
    return undefined;
  }
}

/** Resolved settings, with every pattern made repo-relative. */
interface Resolved {
  files?: string[];
  include?: string[];
  exclude?: string[];
}

function resolveConfig(root: string, file: string, depth = 0): Resolved {
  const raw = read(root, file);
  if (!raw || depth > 8) return {};
  const dir = posix.dirname(file);
  const rel = (patterns: string[] | undefined): string[] | undefined =>
    patterns?.map((p) => posix.normalize(posix.join(dir, p)));

  let base: Resolved = {};
  for (const parent of [raw.extends ?? []].flat()) {
    if (!parent.startsWith('.')) continue;
    const target = posix.normalize(
      posix.join(dir, parent.endsWith('.json') ? parent : `${parent}.json`),
    );
    base = { ...base, ...resolveConfig(root, target, depth + 1) };
  }
  const own: Resolved = {};
  if (raw.files) own.files = rel(raw.files)!;
  if (raw.include) own.include = rel(raw.include)!;
  if (raw.exclude) own.exclude = rel(raw.exclude)!;
  else if (raw.compilerOptions?.outDir) own.exclude = rel([raw.compilerOptions.outDir])!;
  return { ...base, ...own };
}

function toRegExp(pattern: string): RegExp {
  let p = pattern.replace(/^\.\//, '');
  // A pattern without wildcards and without an extension names a directory.
  if (!/[*?]/.test(p) && !/\.[a-z]+$/i.test(posix.basename(p))) p = `${p}/**/*`;
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*' && p[i + 1] === '*') {
      re += p[i + 2] === '/' ? '(?:.*/)?' : '.*';
      i += p[i + 2] === '/' ? 2 : 1;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.^$|()[\]{}+\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** A predicate telling whether a repo-relative path is part of the given tsconfig's program. */
export function tsconfigAccepts(root: string, projectPath: string): (path: string) => boolean {
  if (!existsSync(join(root, projectPath))) return () => true;
  const cfg = resolveConfig(root, projectPath);
  const dir = posix.dirname(projectPath);
  const files = new Set(cfg.files ?? []);
  const include = (cfg.include ?? (cfg.files ? [] : [posix.join(dir, '**/*')])).map(toRegExp);
  const exclude = (cfg.exclude ?? ['node_modules']).map(toRegExp);
  return (path) =>
    files.has(path) || (include.some((r) => r.test(path)) && !exclude.some((r) => r.test(path)));
}
