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

type Value = string | number | boolean | null;
/** undefined stands for a value the matrix alone cannot decide. */
type Known = Value | undefined;

const TOKEN = /\s*('(?:[^']|'')*'|-?\d+(?:\.\d+)?\b|&&|\|\||[=!<>]=|[<>!(),]|[A-Za-z_][\w.-]*)/y;

function tokenize(expr: string): string[] | undefined {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < expr.length) {
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(expr);
    if (!m) return expr.slice(start).trim() === '' ? tokens : undefined;
    tokens.push(m[1]!);
  }
  return tokens;
}

const truthy = (v: Value): boolean => v !== false && v !== 0 && v !== '' && v !== null;

function toNumber(v: Value): number {
  if (typeof v === 'number') return v;
  if (v === null || v === false) return 0;
  if (v === true) return 1;
  return v.trim() === '' ? 0 : Number(v);
}

/** GitHub's loose comparison: strings compare case-insensitively, mixed types as numbers. */
function compare(op: string, a: Value, b: Value): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    const [x, y] = [a.toLowerCase(), b.toLowerCase()];
    if (op === '==') return x === y;
    if (op === '!=') return x !== y;
    return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
  }
  const [x, y] = [toNumber(a), toNumber(b)];
  if (op === '!=') return x !== y;
  if (op === '==') return x === y;
  return op === '<' ? x < y : op === '<=' ? x <= y : op === '>' ? x > y : x >= y;
}

/** A matrix value was a YAML scalar before it became text; give booleans and numbers back. */
function matrixValue(text: string | undefined): Value {
  if (text === undefined) return null;
  if (text === 'true' || text === 'false') return text === 'true';
  return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text;
}

const STRING_FUNCTIONS: Record<string, (a: string, b: string) => boolean> = {
  contains: (a, b) => a.includes(b),
  startswith: (a, b) => a.startsWith(b),
  endswith: (a, b) => a.endsWith(b),
};

/**
 * Whether a step's `if` holds for one matrix combination: true, false, or undefined when it
 * depends on anything but the matrix (the event, the branch, secrets, earlier steps). Status
 * functions assume the steps before it passed, as they do when a gate is replayed.
 */
export function conditionHolds(cond: string, matrix: Record<string, string>): boolean | undefined {
  const s = cond.trim();
  const body = s.startsWith('${{') && s.endsWith('}}') ? s.slice(3, -2) : s;
  const tokens = tokenize(body);
  if (!tokens || tokens.length === 0) return undefined;
  let i = 0;
  let failed = false;
  const peek = (): string | undefined => tokens[i];
  const next = (): string | undefined => tokens[i++];

  const primary = (): Known => {
    const t = next();
    if (t === undefined) return ((failed = true), undefined);
    if (t === '(') {
      const v = or();
      if (next() !== ')') failed = true;
      return v;
    }
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (/^-?\d/.test(t)) return Number(t);
    if (t === 'true' || t === 'false') return t === 'true';
    if (t === 'null') return null;
    if (!/^[A-Za-z_]/.test(t)) return ((failed = true), undefined);
    if (peek() === '(') {
      next();
      const args: Known[] = [];
      while (peek() !== ')' && peek() !== undefined) {
        args.push(or());
        if (peek() === ',') next();
      }
      if (next() !== ')') failed = true;
      const name = t.toLowerCase();
      if (name === 'always' || name === 'success') return true;
      if (name === 'failure' || name === 'cancelled') return false;
      const fn = STRING_FUNCTIONS[name];
      if (!fn || args.length !== 2 || args.some((a) => a === undefined)) return undefined;
      return fn(String(args[0]).toLowerCase(), String(args[1]).toLowerCase());
    }
    const [context, ...path] = t.split('.');
    if (context === 'matrix' && path.length === 1) return matrixValue(matrix[path[0]!]);
    return undefined;
  };

  const comparison = (): Known => {
    const left = primary();
    const op = peek();
    if (op !== '==' && op !== '!=' && op !== '<' && op !== '<=' && op !== '>' && op !== '>=')
      return left;
    next();
    const right = primary();
    return left === undefined || right === undefined ? undefined : compare(op, left, right);
  };

  const unary = (): Known => {
    if (peek() !== '!') return comparison();
    next();
    const v = unary();
    return v === undefined ? undefined : !truthy(v);
  };

  // Three-valued: one false operand decides `&&`, one true operand decides `||`.
  const and = (): Known => {
    const values = [unary()];
    while (peek() === '&&') {
      next();
      values.push(unary());
    }
    if (values.some((v) => v !== undefined && !truthy(v))) return false;
    return values.includes(undefined) ? undefined : values.at(-1);
  };

  function or(): Known {
    const values = [and()];
    while (peek() === '||') {
      next();
      values.push(and());
    }
    if (values.some((v) => v !== undefined && truthy(v))) return true;
    return values.includes(undefined) ? undefined : values.at(-1);
  }

  const result = or();
  if (failed || i !== tokens.length || result === undefined) return undefined;
  return truthy(result);
}

export const emptyContext = (): ExprContext => ({
  matrix: {},
  env: {},
  github: {},
  runner: {},
  inputs: {},
});
