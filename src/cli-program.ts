/** falsegreen command-line interface. */
import { Command } from 'commander';

import { version } from './version';

export function buildProgram(): Command {
  return new Command()
    .name('falsegreen')
    .description(
      'Proves your CI gates can fail: plants known faults, runs each gate the way your workflow does, and reports every check that stays green anyway.',
    )
    .version(version);
}

export async function runCli(argv: string[] = process.argv): Promise<void> {
  await buildProgram().parseAsync(argv);
}
