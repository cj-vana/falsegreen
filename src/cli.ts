#!/usr/bin/env node
import { runCli } from './cli-program';
import { EXIT } from './core/types';

runCli(process.argv).catch((err: unknown) => {
  process.stderr.write(`falsegreen: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(EXIT.ERROR);
});
