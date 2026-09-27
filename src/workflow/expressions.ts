/**
 * Just enough of the GitHub Actions expression language to rebuild the command a step runs:
 * property reads on a few contexts, literals, and `||` fallbacks. Anything else is left in the
 * text and reported as unresolved, so callers can refuse to replay a command they cannot rebuild.
 */

export interface ExprContext {
  matrix: Record<string, string>;
  env: Record<string, string>;
  github: Record<string, string>;
  runner: Record<string, string>;
  inputs: Record<string, string>;
}

export interface Substituted {
  text: string;
  /** Expression bodies that could not be evaluated, in order of appearance. */
  unresolved: string[];
}

const EXPRESSION = /\$\{\{\s*([\s\S]*?)\s*\}\}/g;
const CONTEXT_READ = /^(matrix|env|github|runner|inputs)\.([A-Za-z0-9_-]+)$/;

export function expressionsIn(text: string): string[] {
  return [...text.matchAll(EXPRESSION)].map((m) => m[1]!);
}

function operand(source: string, ctx: ExprContext): string | undefined {
  const s = source.trim();
  const literal = /^'((?:[^']|'')*)'$/.exec(s);
  if (literal) return literal[1]!.replace(/''/g, "'");
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  if (s === 'true' || s === 'false') return s;
  if (s === 'null') return '';
  const read = CONTEXT_READ.exec(s);
  if (read) return ctx[read[1] as keyof ExprContext][read[2]!];
  return undefined;
}

/** Splits on `||` outside string literals. */
function alternatives(expr: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let last = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'") quoted = !quoted;
    else if (!quoted && c === '(') depth++;
    else if (!quoted && c === ')') depth--;
    else if (!quoted && depth === 0 && c === '|' && expr[i + 1] === '|') {
      parts.push(expr.slice(last, i));
      last = i + 2;
      i++;
    }
  }
  parts.push(expr.slice(last));
  return parts;
}

function evaluate(expr: string, ctx: ExprContext): string | undefined {
  const parts = alternatives(expr);
  let value: string | undefined;
  for (const part of parts) {
    value = operand(part, ctx);
    if (value === undefined) return undefined;
    if (value !== '' && value !== 'false' && value !== '0') return value;
  }
  return value;
}

export function substitute(text: string, ctx: ExprContext): Substituted {
  const unresolved: string[] = [];
  const out = text.replace(EXPRESSION, (whole, body: string) => {
    const value = evaluate(body, ctx);
    if (value === undefined) {
      unresolved.push(body);
      return whole;
    }
    return value;
  });
  return { text: out, unresolved };
}

export const emptyContext = (): ExprContext => ({
  matrix: {},
  env: {},
  github: {},
  runner: {},
  inputs: {},
});
