# Contributing to falsegreen

## Setup

```bash
npm ci
npm run check        # format, lint, typecheck, tests
npm run build
```

Node 22.12 or later.

The fixture tests run real toolchains against planted faults: Python tools, Go, Rust, a JDK with
Gradle and Maven, and Bun. `scripts/toolchains.sh` installs the ones you are missing into `tmp/`
inside the checkout, so nothing lands in your home directory. Tests for a toolchain that is not
installed are skipped locally. CI sets `FALSEGREEN_REQUIRE_TOOLCHAINS=1`, which turns those skips
into failures, so a missing toolchain can never make the suite pass by running less.

## Where scratch files go

Everything a test or a probe writes goes under `tmp/` (gitignored). `vitest.config.ts` points
`TMPDIR` there, so `os.tmpdir()` in tests lands there too. When you run a tool by hand, set
`TMPDIR=$PWD/tmp` first.

## Adding a tool to the fault catalog

1. Run the tool by hand on the reach fault and the semantic fault in a scratch project under
   `tmp/`. Write down the exit code and the output line that names the planted file.
2. Add the tool to `src/faults/<language>.ts` and its id to `TOOL_IDS`.
3. Add or extend a fixture under `test/fixtures/` whose `expected.json` states the verdicts you
   recorded in step 1. `test/fixtures.test.ts` fails if a tool id has no fixture.

## Planning documents

Plans, handoff notes, progress logs and status summaries are not committed. Put them in the pull
request description, an issue, or a gitignored scratch directory. `.gitignore` blocks the common
file names. Architecture notes, runbooks and reference documentation that stay true after the
work ships are welcome under `docs/`.

## Commits

Conventional prefixes (`feat:`, `fix:`, `test:`, `docs:`, `ci:`, `chore:`). Commit only after
`npm run check` passes, and read its exit status directly rather than through a pipe.
