/**
 * Which `if` branches of a script a GitHub Actions runner takes, as far as the runner's own
 * variables decide it: `if [ -z "$GITHUB_ACTIONS" ]; then scripts/check; fi` never runs the check
 * in CI. Conditions on anything else are unknown, and their branches stay in.
 */
import type { SimpleCommand, Word } from './parse';

/** Variables every GitHub-hosted and self-hosted runner sets, and their values. */
export const RUNNER_ENV: Record<string, string> = { GITHUB_ACTIONS: 'true', CI: 'true' };

const VARIABLE = /^"?\$(?:\{([A-Za-z_]\w*)(?::?-[^}]*)?\}|([A-Za-z_]\w*))"?$/;

function valueOnRunner(w: Word): string | undefined {
  if (!w.dynamic) return w.value;
  const m = VARIABLE.exec(w.raw);
  const name = m?.[1] ?? m?.[2];
  return name === undefined ? undefined : RUNNER_ENV[name];
}

/** Whether a `[ ... ]`, `[[ ... ]]` or `test ...` command succeeds on a runner. */
export function testOnRunner(cmd: SimpleCommand): boolean | undefined {
  const argv = cmd.argv;
  const head = argv[0]?.value;
  let args: Word[];
  if ((head === '[' || head === '[[') && argv.at(-1)?.value === (head === '[' ? ']' : ']]')) {
    args = argv.slice(1, -1);
  } else if (head === 'test') {
    args = argv.slice(1);
  } else {
    return undefined;
  }
  const negate = args[0]?.value === '!' && !args[0].dynamic;
  if (negate) args = args.slice(1);
  const values = args.map(valueOnRunner);
  const op = args.length > 1 && !args[args.length - 2]!.dynamic ? args[args.length - 2]!.value : '';

  let result: boolean | undefined;
  if (args.length === 1) {
    result = values[0] === undefined ? undefined : values[0] !== '';
  } else if (args.length === 2 && (op === '-z' || op === '-n')) {
    result = values[1] === undefined ? undefined : (values[1] === '') === (op === '-z');
  } else if (args.length === 3 && (op === '=' || op === '==' || op === '!=')) {
    const [a, , b] = values;
    // Inside [[ ]] the right side of == is a glob pattern.
    const pattern = head === '[[' && b !== undefined && /[*?[]/.test(b);
    result =
      a === undefined || b === undefined || pattern ? undefined : (a === b) === (op !== '!=');
  }
  return result === undefined ? undefined : result !== negate;
}

/** True when the command sits in an `if` branch that a runner never takes. */
export function skippedOnRunner(cmd: SimpleCommand): boolean {
  return (cmd.guards ?? []).some((g) => {
    // `if a && b; then` needs every command; only a single test is decided here.
    if (g.test.length !== 1) return false;
    const passes = testOnRunner(g.test[0]!);
    return passes !== undefined && passes !== (g.when === 'then');
  });
}
