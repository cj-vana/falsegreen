/** `falsegreen init`: a starter config and a workflow that runs falsegreen on a schedule. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { FalsegreenError, findRoot, type IO } from './common';

const CONFIG = `# falsegreen settings. Every key is optional; the values below are the defaults.
# Reference: https://github.com/cj-vana/falsegreen#configuration

# Lowest finding severity that fails the run: high, medium, low or info.
failOn: high

# Findings to leave out, by rule, job id or step name (any combination).
ignore: []
#  - rule: no-required-checks
#  - job: deploy

# Steps falsegreen cannot resolve on its own, mapped to the tool they run.
gates: []
#  - { job: test, step: Run suite, tool: pytest }

# Where to plant a tool's faults, when the default location is wrong for your layout.
place: []
#  - { tool: vitest, dir: src/__tests__ }

matrix:
  # Combinations per job when running with --matrix all.
  max: 4

remote:
  # Workflows remote mode may run even though they use environment: or look like deploys.
  allow: []
  timeoutMinutes: 30
`;

const WORKFLOW = `name: falsegreen

on:
  schedule:
    - cron: '23 5 * * 1'
  workflow_dispatch:
  pull_request:
    paths:
      - '.github/workflows/**'
      - 'falsegreen.config.yml'

permissions:
  contents: read

jobs:
  falsegreen:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      # Set up the toolchains your checks need and install dependencies here, the same way
      # your CI does, so falsegreen can run each check.
      - uses: cj-vana/falsegreen@v0
`;

export function initCommand(cwd: string, io: IO): number {
  const root = findRoot(cwd);
  const files: [string, string][] = [
    ['falsegreen.config.yml', CONFIG],
    ['.github/workflows/falsegreen.yml', WORKFLOW],
  ];
  const existing = files.filter(([p]) => existsSync(join(root, p))).map(([p]) => p);
  if (existing.length > 0)
    throw new FalsegreenError(`${existing.join(' and ')} already exists; nothing was written`);
  for (const [path, content] of files) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
    io.out(`wrote ${path}\n`);
  }
  return 0;
}
