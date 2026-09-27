/**
 * A POSIX-ish shell lexer, enough to find the commands a CI step runs. It does not expand
 * anything: `$VAR`, `$(...)` and friends stay in the word text, and the word is marked dynamic.
 * Command substitution bodies are returned so the parser can look inside them.
 */

export interface RawWord {
  /** Text with quotes removed and escapes decoded; expansions are kept verbatim. */
  value: string;
  raw: string;
  dynamic: boolean;
  /** Bodies of `$(...)` and backtick substitutions, with their offset in the original text. */
  subs: { text: string; offset: number }[];
  start: number;
  end: number;
}

export type Op = '&&' | '||' | '|' | '|&' | ';' | ';;' | '&' | '(' | ')' | '\n';

export type Token =
  | { kind: 'word'; word: RawWord }
  | { kind: 'op'; op: Op; start: number; end: number }
  | { kind: 'redir'; op: string; start: number; end: number };

const REDIRS = ['<<<', '<<-', '<<', '<&', '<>', '>>', '>&', '>|', '<', '>'];

const ANSI_C: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  a: '\x07',
  b: '\b',
  e: '\x1b',
  f: '\f',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
};

/** Index of the `)` matching the `(` at `open`, skipping quoted text; -1 when unterminated. */
function matchParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') {
      i++;
    } else if (c === "'") {
      const close = text.indexOf("'", i + 1);
      if (close < 0) return -1;
      i = close;
    } else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function matchBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) return i;
  }
  return -1;
}

export function lex(text: string, base = 0): { tokens: Token[]; errors: string[] } {
  const tokens: Token[] = [];
  const errors: string[] = [];
  const n = text.length;
  let i = 0;
  let cur: RawWord | null = null;
  let heredocNext: { strip: boolean } | null = null;
  const heredocs: { strip: boolean; delimiter: string }[] = [];

  const word = (at: number): RawWord => {
    cur ??= { value: '', raw: '', dynamic: false, subs: [], start: base + at, end: base + at };
    return cur;
  };

  const endWord = (at: number): void => {
    if (!cur) return;
    cur.end = base + at;
    cur.raw = text.slice(cur.start - base, at);
    tokens.push({ kind: 'word', word: cur });
    if (heredocNext) {
      heredocs.push({ strip: heredocNext.strip, delimiter: cur.value });
      heredocNext = null;
    }
    cur = null;
  };

  /** Consumes `$...` at i; returns the index after it. */
  const readDollar = (w: RawWord, at: number, inDouble: boolean): number => {
    const next = text[at + 1];
    if (next === "'" && !inDouble) {
      let j = at + 2;
      while (j < n && text[j] !== "'") {
        if (text[j] === '\\' && j + 1 < n) {
          const esc = text[j + 1]!;
          if (esc === 'x' && /^[0-9a-fA-F]{1,2}/.test(text.slice(j + 2))) {
            const hex = /^[0-9a-fA-F]{1,2}/.exec(text.slice(j + 2))![0];
            w.value += String.fromCharCode(parseInt(hex, 16));
            j += 2 + hex.length;
            continue;
          }
          w.value += ANSI_C[esc] ?? `\\${esc}`;
          j += 2;
        } else {
          w.value += text[j];
          j++;
        }
      }
      if (j >= n) errors.push("unterminated $'...' string");
      return j + 1;
    }
    if (next === '(') {
      const arithmetic = text[at + 2] === '(';
      const close = matchParen(text, at + 1);
      if (close < 0) {
        errors.push('unterminated $( substitution');
        w.value += text.slice(at);
        w.dynamic = true;
        return n;
      }
      if (!arithmetic) w.subs.push({ text: text.slice(at + 2, close), offset: base + at + 2 });
      w.value += text.slice(at, close + 1);
      w.dynamic = true;
      return close + 1;
    }
    if (next === '{') {
      const close = matchBrace(text, at + 1);
      const end = close < 0 ? n : close + 1;
      if (close < 0) errors.push('unterminated ${ expansion');
      w.value += text.slice(at, end);
      w.dynamic = true;
      return end;
    }
    const name = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9?#@*!$-])/.exec(text.slice(at + 1));
    if (name) {
      w.value += `$${name[0]}`;
      w.dynamic = true;
      return at + 1 + name[0].length;
    }
    w.value += '$';
    return at + 1;
  };

  const readBacktick = (w: RawWord, at: number): number => {
    let j = at + 1;
    let body = '';
    while (j < n && text[j] !== '`') {
      if (text[j] === '\\' && (text[j + 1] === '`' || text[j + 1] === '\\')) {
        body += text[j + 1];
        j += 2;
      } else {
        body += text[j];
        j++;
      }
    }
    if (j >= n) errors.push('unterminated backtick substitution');
    w.subs.push({ text: body, offset: base + at + 1 });
    w.value += text.slice(at, Math.min(j + 1, n));
    w.dynamic = true;
    return j + 1;
  };

  const readDouble = (w: RawWord, at: number): number => {
    let j = at + 1;
    while (j < n && text[j] !== '"') {
      const c = text[j];
      if (c === '\\') {
        const esc = text[j + 1];
        if (esc === '\n') j += 2;
        else if (esc === '"' || esc === '\\' || esc === '$' || esc === '`') {
          w.value += esc;
          j += 2;
        } else {
          w.value += '\\';
          j++;
        }
      } else if (c === '$') {
        j = readDollar(w, j, true);
      } else if (c === '`') {
        j = readBacktick(w, j);
      } else {
        w.value += c;
        j++;
      }
    }
    if (j >= n) {
      errors.push('unterminated double quote');
      return n;
    }
    return j + 1;
  };

  /** Skips the bodies of pending heredocs, starting at the line after `at`. */
  const skipHeredocs = (at: number): number => {
    let j = at;
    while (heredocs.length > 0) {
      const doc = heredocs.shift()!;
      for (;;) {
        if (j >= n) {
          errors.push(`unterminated heredoc (${doc.delimiter})`);
          return n;
        }
        const nl = text.indexOf('\n', j);
        const lineEnd = nl < 0 ? n : nl;
        let line = text.slice(j, lineEnd);
        if (doc.strip) line = line.replace(/^\t+/, '');
        j = nl < 0 ? n : nl + 1;
        if (line === doc.delimiter) break;
      }
    }
    return j;
  };

  const op = (o: Op, at: number): void => {
    tokens.push({ kind: 'op', op: o, start: base + at, end: base + at + o.length });
  };

  while (i < n) {
    const c = text[i]!;
    if (c === '\\') {
      if (text[i + 1] === '\n') {
        i += 2;
        continue;
      }
      word(i).value += text[i + 1] ?? '';
      i += 2;
    } else if (c === "'") {
      const w = word(i);
      const close = text.indexOf("'", i + 1);
      if (close < 0) {
        errors.push('unterminated single quote');
        w.value += text.slice(i + 1);
        i = n;
      } else {
        w.value += text.slice(i + 1, close);
        i = close + 1;
      }
    } else if (c === '"') {
      i = readDouble(word(i), i);
    } else if (c === '$') {
      i = readDollar(word(i), i, false);
    } else if (c === '`') {
      i = readBacktick(word(i), i);
    } else if (c === '#' && !cur) {
      const nl = text.indexOf('\n', i);
      i = nl < 0 ? n : nl;
    } else if (c === ' ' || c === '\t' || c === '\r') {
      endWord(i);
      i++;
    } else if (c === '\n') {
      endWord(i);
      op('\n', i);
      i = heredocs.length > 0 ? skipHeredocs(i + 1) : i + 1;
    } else if (c === '<' || c === '>') {
      // A word made only of digits right before the operator is a file descriptor.
      // `cur` is assigned inside closures, so TypeScript narrows it to null here without the cast.
      const fd = cur as RawWord | null;
      if (fd && /^\d+$/.test(text.slice(fd.start - base, i))) cur = null;
      else endWord(i);
      const r = REDIRS.find((candidate) => text.startsWith(candidate, i))!;
      tokens.push({ kind: 'redir', op: r, start: base + i, end: base + i + r.length });
      if (r === '<<' || r === '<<-') heredocNext = { strip: r === '<<-' };
      i += r.length;
    } else if (c === '&') {
      endWord(i);
      if (text[i + 1] === '>') {
        const r = text[i + 2] === '>' ? '&>>' : '&>';
        tokens.push({ kind: 'redir', op: r, start: base + i, end: base + i + r.length });
        i += r.length;
      } else if (text[i + 1] === '&') {
        op('&&', i);
        i += 2;
      } else {
        op('&', i);
        i++;
      }
    } else if (c === '|') {
      endWord(i);
      const o: Op = text[i + 1] === '|' ? '||' : text[i + 1] === '&' ? '|&' : '|';
      op(o, i);
      i += o.length;
    } else if (c === ';') {
      endWord(i);
      const o: Op = text[i + 1] === ';' ? ';;' : ';';
      op(o, i);
      i += o.length;
    } else if (c === '(' || c === ')') {
      endWord(i);
      op(c, i);
      i++;
    } else {
      word(i).value += c;
      i++;
    }
  }
  endWord(n);
  if (heredocs.length > 0) errors.push(`unterminated heredoc (${heredocs[0]!.delimiter})`);
  return { tokens, errors };
}
