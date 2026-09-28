import { describe, expect, it } from 'vitest';

import { allCommands, parseShell, words } from '../src/shell/parse';

/** argv of every command, depth-first, including commands inside substitutions. */
function argvs(text: string): string[][] {
  return allCommands(parseShell(text)).map(words);
}

describe('parseShell', () => {
  it('splits a simple command into words', () => {
    expect(argvs('npm test')).toEqual([['npm', 'test']]);
  });

  it('separates lines and joins && into one list', () => {
    const script = parseShell('npm ci\nnpm run lint && npm test');
    expect(script.lists).toHaveLength(2);
    expect(script.lists[1]!.rest[0]!.op).toBe('&&');
    expect(argvs('npm ci\nnpm run lint && npm test')).toEqual([
      ['npm', 'ci'],
      ['npm', 'run', 'lint'],
      ['npm', 'test'],
    ]);
  });

  it('keeps || as a list operator', () => {
    const list = parseShell('pytest || true').lists[0]!;
    expect(words(list.first.commands[0]!)).toEqual(['pytest']);
    expect(list.rest[0]!.op).toBe('||');
    expect(words(list.rest[0]!.pipeline.commands[0]!)).toEqual(['true']);
  });

  it('builds a pipeline and drops redirections', () => {
    const pipeline = parseShell('go test ./... 2>&1 | tee out.txt').lists[0]!.first;
    expect(pipeline.commands.map(words)).toEqual([
      ['go', 'test', './...'],
      ['tee', 'out.txt'],
    ]);
  });

  it('parses commands inside $(...) substitutions', () => {
    const all = argvs('test -z "$(gofmt -l .)"');
    expect(all[0]!.slice(0, 2)).toEqual(['test', '-z']);
    expect(all).toContainEqual(['gofmt', '-l', '.']);
  });

  it('parses commands inside backticks', () => {
    expect(argvs('echo `go vet ./...`')).toContainEqual(['go', 'vet', './...']);
  });

  it('separates leading assignments from argv', () => {
    const cmds = allCommands(parseShell('cd web && CI=1 npx vitest run'));
    expect(words(cmds[0]!)).toEqual(['cd', 'web']);
    expect(cmds[1]!.assignments).toEqual([{ name: 'CI', value: '1' }]);
    expect(words(cmds[1]!)).toEqual(['npx', 'vitest', 'run']);
  });

  it('records function definitions and keeps only their bodies as commands', () => {
    const text = [
      'fail() {',
      '  echo failed',
      '  exit 1',
      '}',
      'function warn { echo warned; }',
      'function note() { echo noted; }',
      'npm test || fail now',
    ].join('\n');
    expect(parseShell(text).functions).toEqual(['fail', 'warn', 'note']);
    expect(argvs(text)).toEqual([
      ['echo', 'failed'],
      ['exit', '1'],
      ['echo', 'warned'],
      ['echo', 'noted'],
      ['npm', 'test'],
      ['fail', 'now'],
    ]);
  });

  it('finds commands inside compound commands', () => {
    expect(argvs('if [ -f x ]; then\n  cargo test\nfi')).toEqual([
      ['[', '-f', 'x', ']'],
      ['cargo', 'test'],
    ]);
    expect(argvs('for d in a b; do\n  (cd "$d" && make test)\ndone')).toContainEqual([
      'make',
      'test',
    ]);
  });

  it('skips heredoc bodies', () => {
    expect(argvs("cat <<'EOF' > f\nnpm test\nEOF\nnpm run lint")).toEqual([
      ['cat'],
      ['npm', 'run', 'lint'],
    ]);
    expect(argvs('cat <<-END\n\tpytest\n\tEND\nruff check .')).toEqual([
      ['cat'],
      ['ruff', 'check', '.'],
    ]);
  });

  it('handles comments and line continuations', () => {
    expect(argvs('eslint \\\n  src # lint it')).toEqual([['eslint', 'src']]);
    expect(argvs('# only a comment\nnpm test')).toEqual([['npm', 'test']]);
    expect(argvs('echo a#b')).toEqual([['echo', 'a#b']]);
  });

  it('keeps operators inside quotes as text', () => {
    expect(argvs("echo 'a && b'")).toEqual([['echo', 'a && b']]);
    expect(argvs('echo "x | y; z"')).toEqual([['echo', 'x | y; z']]);
  });

  it('decodes escapes in double quotes and ANSI-C quotes', () => {
    expect(argvs('printf "say \\"hi\\""')).toEqual([['printf', 'say "hi"']]);
    expect(argvs("echo $'a\\tb'")).toEqual([['echo', 'a\tb']]);
  });

  it('keeps assignment-only commands in order', () => {
    const cmds = allCommands(parseShell('set +e\nnpm test\nstatus=$?\nset -e'));
    expect(cmds).toHaveLength(4);
    expect(cmds[2]!.assignments[0]!.name).toBe('status');
    expect(words(cmds[3]!)).toEqual(['set', '-e']);
  });

  it('marks words with expansions as dynamic', () => {
    const cmd = allCommands(parseShell('pytest "$TEST_DIR" plain ${X:-y}'))[0]!;
    expect(cmd.argv.map((w) => w.dynamic)).toEqual([false, true, false, true]);
  });

  it('marks a background list', () => {
    const script = parseShell('npm run serve &\nnpm test');
    expect(script.lists[0]!.background).toBe(true);
    expect(script.lists[1]!.background).toBe(false);
  });

  it('records negated pipelines', () => {
    expect(parseShell('! grep -q TODO src').lists[0]!.first.negated).toBe(true);
  });

  it('reports an unterminated quote without throwing', () => {
    const script = parseShell('echo "abc');
    expect(script.errors).toHaveLength(1);
    expect(script.errors[0]).toMatch(/unterminated/i);
  });

  it('does not treat arithmetic expansion as a command substitution', () => {
    expect(argvs('echo $((1 + 2))')).toEqual([['echo', '$((1 + 2))']]);
  });

  it('handles &>, |&, ;; and positional parameters', () => {
    expect(argvs('pytest &> log.txt')).toEqual([['pytest']]);
    const script = parseShell('cargo test |& tee log');
    expect(script.lists[0]!.first.commands.map(words)).toEqual([
      ['cargo', 'test'],
      ['tee', 'log'],
    ]);
    expect(argvs('case "$1" in\n  ci|all) npm test ;;\n  (lint) eslint . ;;\nesac\nmake')).toEqual([
      ['npm', 'test'],
      ['eslint', '.'],
      ['make'],
    ]);
  });

  it('decodes hex escapes in ANSI-C quotes and keeps escaped dollars literal', () => {
    expect(argvs("echo $'\\x41B'")).toEqual([['echo', 'AB']]);
    const cmd = allCommands(parseShell('echo "cost \\$5"'))[0]!;
    expect(words(cmd)).toEqual(['echo', 'cost $5']);
    expect(cmd.argv[1]!.dynamic).toBe(false);
  });

  it('reports unterminated substitutions and heredocs', () => {
    expect(parseShell('echo $(date').errors[0]).toMatch(/unterminated \$\(/);
    expect(parseShell('echo ${HOME').errors[0]).toMatch(/unterminated \$\{/);
    expect(parseShell('echo `date').errors[0]).toMatch(/unterminated backtick/);
    expect(parseShell("echo 'abc").errors[0]).toMatch(/unterminated single/);
    expect(parseShell('cat <<EOF\nbody').errors[0]).toMatch(/unterminated heredoc/);
  });

  it('keeps the substitution inside an assignment', () => {
    expect(argvs('out=$(gofmt -l .)')).toContainEqual(['gofmt', '-l', '.']);
  });

  it('records source offsets for commands', () => {
    const text = 'npm ci\n  npm test';
    const cmd = allCommands(parseShell(text))[1]!;
    expect(text.slice(cmd.start, cmd.end)).toBe('npm test');
  });
});
