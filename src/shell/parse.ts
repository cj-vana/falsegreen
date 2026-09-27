/**
 * Turns lexed shell text into lists, pipelines and simple commands. Compound commands (if, for,
 * while, case, subshells, brace groups) are flattened: their keywords are dropped and the commands
 * inside them are kept in order, which is all gate detection needs.
 */
import { lex, type RawWord } from './lexer';

export interface Word {
  value: string;
  raw: string;
  dynamic: boolean;
  substitutions: ShellScript[];
  start: number;
  end: number;
}

export interface SimpleCommand {
  argv: Word[];
  assignments: { name: string; value: string }[];
  /** The assignment words themselves, kept for the substitutions inside them. */
  prefix: Word[];
  start: number;
  end: number;
}

export interface Pipeline {
  commands: SimpleCommand[];
  negated: boolean;
}

export interface AndOrList {
  first: Pipeline;
  rest: { op: '&&' | '||'; pipeline: Pipeline }[];
  background: boolean;
}

export interface ShellScript {
  lists: AndOrList[];
  errors: string[];
}

const RESERVED = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'do',
  'done',
  'while',
  'until',
  'for',
  'select',
  'case',
  'esac',
  'in',
  'function',
  '{',
  '}',
  '!',
]);

const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

function toWord(raw: RawWord): Word {
  return {
    value: raw.value,
    raw: raw.raw,
    dynamic: raw.dynamic,
    substitutions: raw.subs.map((s) => parseShell(s.text, s.offset)),
    start: raw.start,
    end: raw.end,
  };
}

export function parseShell(text: string, base = 0): ShellScript {
  const { tokens, errors } = lex(text, base);
  const lists: AndOrList[] = [];

  let cmd: SimpleCommand | null = null;
  let pipeline: Pipeline = { commands: [], negated: false };
  let list: AndOrList | null = null;
  let pendingOp: '&&' | '||' | null = null;
  let skipTarget = false;
  let skipUntilSeparator = false;
  // `case WORD in` is the header; `pat | pat)` before each arm is the pattern.
  let casePhase: 'none' | 'header' | 'pattern' = 'none';
  let caseDepth = 0;

  const flushCommand = (): void => {
    if (cmd && (cmd.argv.length > 0 || cmd.assignments.length > 0)) pipeline.commands.push(cmd);
    cmd = null;
  };
  const flushPipeline = (): void => {
    flushCommand();
    if (pipeline.commands.length > 0) {
      if (!list) list = { first: pipeline, rest: [], background: false };
      else list.rest.push({ op: pendingOp ?? '&&', pipeline });
    }
    pipeline = { commands: [], negated: false };
    pendingOp = null;
  };
  const flushList = (background: boolean): void => {
    flushPipeline();
    if (list) {
      list.background = background;
      lists.push(list);
    }
    list = null;
  };

  for (const token of tokens) {
    if (token.kind === 'redir') {
      skipTarget = true;
      continue;
    }
    if (token.kind === 'word') {
      if (skipTarget) {
        skipTarget = false;
        continue;
      }
      const raw = token.word;
      if (casePhase === 'header') {
        if (raw.value === 'in') casePhase = 'pattern';
        continue;
      }
      if (casePhase === 'pattern') {
        if (raw.value === 'esac') {
          caseDepth--;
          casePhase = 'none';
        }
        continue;
      }
      const atStart = !cmd || (cmd.argv.length === 0 && cmd.assignments.length === 0);
      if (atStart && RESERVED.has(raw.value) && raw.raw === raw.value) {
        if (raw.value === '!') pipeline.negated = true;
        else if (raw.value === 'for' || raw.value === 'select') skipUntilSeparator = true;
        else if (raw.value === 'case') {
          caseDepth++;
          casePhase = 'header';
        } else if (raw.value === 'esac') caseDepth--;
        continue;
      }
      if (skipUntilSeparator) continue;
      const w = toWord(raw);
      cmd ??= { argv: [], assignments: [], prefix: [], start: w.start, end: w.end };
      const assignment = cmd.argv.length === 0 ? ASSIGNMENT.exec(raw.raw) : null;
      if (assignment) {
        cmd.assignments.push({
          name: assignment[1]!,
          value: raw.value.slice(assignment[0].length),
        });
        cmd.prefix.push(w);
      } else {
        cmd.argv.push(w);
      }
      cmd.end = w.end;
      continue;
    }
    if (casePhase === 'pattern') {
      // Alternatives, the optional leading paren and newlines belong to the pattern.
      if (token.op === ')') casePhase = 'none';
      continue;
    }
    switch (token.op) {
      case '|':
      case '|&':
        flushCommand();
        break;
      case '&&':
      case '||':
        flushPipeline();
        pendingOp = token.op;
        break;
      case '\n':
        // A newline right after `&&`, `||` or `|` continues the same list.
        if (!cmd && (pendingOp || pipeline.commands.length > 0)) break;
        flushList(false);
        skipUntilSeparator = false;
        break;
      case ';;':
        flushList(false);
        if (caseDepth > 0) casePhase = 'pattern';
        break;
      case ';':
      case ')':
        flushList(false);
        skipUntilSeparator = false;
        break;
      case '&':
        flushList(true);
        break;
      case '(':
        flushCommand();
        break;
    }
  }
  flushList(false);
  return { lists, errors };
}

export function words(cmd: SimpleCommand): string[] {
  return cmd.argv.map((w) => w.value);
}

/** Every simple command, depth-first, including those inside `$(...)` and backticks. */
export function allCommands(script: ShellScript): SimpleCommand[] {
  const out: SimpleCommand[] = [];
  for (const list of script.lists) {
    for (const pipeline of [list.first, ...list.rest.map((r) => r.pipeline)]) {
      for (const cmd of pipeline.commands) {
        out.push(cmd);
        for (const w of [...cmd.prefix, ...cmd.argv]) {
          for (const sub of w.substitutions) out.push(...allCommands(sub));
        }
      }
    }
  }
  return out;
}
