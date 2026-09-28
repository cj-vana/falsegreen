# falsegreen

Your CI is green. Can it go red?

A green check tells you the step exited 0. It doesn't tell you the step would have failed if
something were wrong. Test runners collect from the wrong directory, linters get pointed at a
path that moved, somebody adds `|| true` to get a release out, a pipe into `tee` throws the exit
code away, and the job that runs it all isn't required for merging anyway. Every one of those
stays green forever, and nothing in your CI will ever tell you.

falsegreen finds them by trying. It plants a file your checks should reject, runs each gate the
way your workflow runs it, and reports every one that stays green. It also reads the workflows and
the scripts behind them for the settings that turn a failure into a pass, and asks GitHub which
checks actually block a merge.

```console
$ npx falsegreen
replaying 2 gates with planted faults
Run npm test: baseline passed (0.3s)
Run npm test: reach vitest caught (0.3s)
Run npm test: semantic vitest caught (0.3s)
Run npx vitest run || true: baseline passed (0.3s)
Run npx vitest run || true: reach vitest survived (0.3s)
Run npx vitest run || true: semantic vitest survived (0.3s)
falsegreen 0.1.0  modes: static, local

.github/workflows/ci.yml
  job test
    Run npm test (line 8)
      reach     vitest         caught      0.3s
      semantic  vitest         caught      0.3s
    Run npx vitest run || true (line 9)
      reach     vitest         survived    0.3s
      semantic  vitest         survived    0.3s

Findings
  high    dead-gate               .github/workflows/ci.yml:9
          `Run npx vitest run || true` stayed green with a vitest file that does not parse: vitest never reads that location, or its failure is swallowed.
          hint: The masked-exit finding on this step explains why: fix it and this gate can fail.
  high    masked-exit             .github/workflows/ci.yml:9
          `npx vitest run || true` passes when the check fails.
          hint: Remove the || branch, or end it with `exit 1`.

2 gates, 2 judged: 1 dead, 0 weak, 0 not judged. 2 findings at high or above.
```

That run is against one of the fixture repositories in `test/fixtures`: two steps run the same
vitest suite, and one of them can't fail.

## Install

falsegreen needs Node 22.12 or newer, git, and the toolchains your checks use.

```sh
npx falsegreen            # static checks, then every gate replayed with planted faults
npm i -D falsegreen       # or pin it in the project
```

Run it from anywhere inside a git repository with workflows under `.github/workflows`. It restores
every file it plants, but it runs your checks for real, so start from a tree where they pass.

```sh
npx falsegreen list             # every gate it found and the faults it would plant; runs nothing
npx falsegreen static           # workflow settings and shell code only; runs nothing
npx falsegreen local --job test # replay one job's gates
npx falsegreen init             # write falsegreen.config.yml and a workflow that runs falsegreen
```

## In CI

`falsegreen init` writes a workflow that runs weekly and on pull requests that change your
workflows. The action installs the falsegreen release that matches the tag you use and runs it
from the workspace:

```yaml
jobs:
  falsegreen:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      security-events: write # only for the SARIF upload
    steps:
      - uses: actions/checkout@v7
      # Set up the same toolchains and dependencies your CI job does.
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - run: npm ci
      - id: falsegreen
        uses: cj-vana/falsegreen@v0
      - if: ${{ always() && steps.falsegreen.outputs.sarif-path != '' }}
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: ${{ steps.falsegreen.outputs.sarif-path }}
          category: falsegreen
```

Local replay needs whatever your gates need, so set the job up the way your CI job is set up. The
other way to get that for free is to run falsegreen as the last step of the job it checks. By then
the gates have just passed, so `--assume-green` skips the baseline run:

```yaml
      # ... your setup and your checks ...
      - uses: cj-vana/falsegreen@v0
        with:
          node-version: '' # keep the job's Node
          args: --job ${{ github.job }} --assume-green
```

| Input           | Default               | Meaning                                                                                 |
| --------------- | --------------------- | --------------------------------------------------------------------------------------- |
| `mode`          | `run`                 | `run`, `static`, `local` or `remote`                                                    |
| `args`          | empty                 | extra CLI arguments, split like a shell command line; `--out` and `--formats` are fixed |
| `version`       | the action's own      | npm version or spec to install                                                          |
| `node-version`  | `24`                  | Node for actions/setup-node; empty keeps the Node on PATH                               |
| `fail-on`       | empty (config, high)  | lowest severity that fails the step                                                     |
| `token`         | `${{ github.token }}` | reads required checks; in remote mode, pushes and starts runs                           |
| `upload-report` | `true`                | upload `falsegreen-report/` as an artifact                                              |
| `report-name`   | `falsegreen-report`   | artifact name; give each job its own                                                    |

Outputs: `exit-code`, `findings`, `dead-gates`, `report-path` and `sarif-path`.

## How it works

falsegreen reads your workflows the way GitHub does: matrix legs and step conditions, `defaults`,
the shell templates (`bash -e {0}` by default, `-o pipefail` only with `shell: bash`), local
composite actions, and whatever the step calls. It follows `npm run`, `pnpm`, `yarn` and `bun`
scripts, Makefile targets (through `make -n`), shell scripts, `pre-commit` hooks, and launchers
like `npx`, `uv run`, `poetry run` and `python -m`. What's left is a list of gates: a step, and
the check tools it runs.

For each tool it plants two faults, one at a time:

- A **reach** fault is a file in the tool's language that no parser accepts. If the step stays
  green, the tool never read that location or its failure never reached the step's exit code.
  That's a dead gate.
- A **semantic** fault is a well-formed file with the problem the tool exists to catch: a failing
  test, a type error, an unused variable, a misformatted line. If only this one survives, the tool
  runs but doesn't fail on what it finds. That's a weak gate.

Faults go where the tool already looks. A planted file sits next to an existing file the tool
handles and copies its naming (`*.test.ts` beside a vitest test, `test_*.py` beside a pytest one),
so the tool's own discovery finds it the same way it finds the neighbor. The paths in the command,
the `tsconfig.json` a type check uses, and the Cargo workspace members a build covers narrow the
choice further; `place` in the config overrides it. Planted files are added to the git index with
`git add -N`, so tools that list files through git see them too.

A step is replayed as a script under its own shell, with its env and working directory, plus
`CI=true` and `GITHUB_ACTIONS=true` so scripts take the branch they take on a runner. It runs once
clean (the baseline), then once per fault. A fault counts as caught only when the step fails **and**
its output names the planted file: every planted file has a `falsegreen_<6 hex>` marker in its
name. A failure that doesn't mention it is reported as unattributed, not caught.

Nothing is left behind. Before touching a file, falsegreen writes a journal inside `.git` and
fsyncs it. Planted files are removed and edited files restored after each run, on Ctrl-C and
SIGTERM too, and a run that dies harder (SIGKILL, a crash, a closed laptop) is repaired by the next
run, or by `falsegreen clean`. Steps that also publish or deploy (`npm publish`, `git push`,
`gh release`, `terraform apply` and similar) are never replayed.

## What it reports

Each finding has a rule id and a severity. [docs/rules.md](docs/rules.md) explains every rule and
how to fix it.

| Rule                         | Severity       | Meaning                                                                |
| ---------------------------- | -------------- | ---------------------------------------------------------------------- |
| `dead-gate`                  | high           | stayed green with a file that does not parse                           |
| `weak-gate`                  | medium         | failed on a broken file, stayed green with a real problem              |
| `unattributed`               | low            | failed, but the output never named the planted file                    |
| `already-red`                | info           | fails before anything is planted                                       |
| `unjudged`                   | info           | could not be judged here, with the reason                              |
| `masked-exit`                | high or medium | `\|\| true`, `-e` pitfalls, `--exit-zero` and friends, `$(check)`      |
| `pipe-swallows-exit`         | medium         | check piped into another command without pipefail                      |
| `continue-on-error`          | high or medium | step or job can fail without failing the run                           |
| `passes-with-no-tests`       | medium         | `--passWithNoTests`, or pytest's exit code 5 accepted                  |
| `if-present`                 | high or medium | `npm run x --if-present` passes when the script is gone                |
| `no-files-checked`           | high           | `pre-commit run` without `--all-files`, or `lint-staged`, in CI        |
| `path-filtered`              | low            | pull requests can skip the workflow                                    |
| `conditional-gate`           | low            | the check runs only for some events                                    |
| `not-required`               | medium         | a red run of this job does not block merging                           |
| `no-required-checks`         | medium         | the branch requires no checks at all                                   |
| `required-check-missing`     | medium         | a required check that no job reports                                   |
| `required-checks-unreadable` | info           | the API would not say                                                  |
| `skipped-job`                | medium         | remote: the job was skipped on the throwaway branch                    |
| `required-gate-passed`       | high           | remote: a required check passed with faults planted                    |

Reports go to `falsegreen-report/`: `results.json` (everything, including each run's output
excerpt), `summary.md`, and with `--formats sarif`, `results.sarif` for code scanning. Inside
GitHub Actions, findings are also printed as annotations on the workflow file.

| Exit code | Meaning                                                  |
| --------- | -------------------------------------------------------- |
| 0         | no finding at or above `--fail-on` (default `high`)      |
| 1         | at least one finding at or above it                      |
| 2         | falsegreen could not finish: bad config, not a git repo  |

## Tools

These tools get both faults. Anything else in a step whose name or command says test, lint,
check, verify or format gets a generic reach fault.

| Language   | Tool                                                    | Reach fault                              | Semantic fault                           |
| ---------- | ------------------------------------------------------- | ---------------------------------------- | ---------------------------------------- |
| JS / TS    | vitest, jest, mocha, `node --test`, `bun test`          | test file that does not parse            | failing test                             |
| JS / TS    | tsc, vue-tsc                                            | source file that does not parse          | type error                               |
| JS / TS    | eslint, oxlint, biome lint                              | source file that does not parse          | unused variable                          |
| JS / TS    | prettier, biome format                                  | source file that does not parse          | misformatted file                        |
| Python     | pytest, unittest                                        | test file that does not parse            | failing test                             |
| Python     | mypy, pyright, basedpyright                             | file that does not parse                 | `str` assigned to an `int`               |
| Python     | ruff check, flake8, pylint                              | file that does not parse                 | unused import                            |
| Python     | black, ruff format                                      | file that does not parse                 | unformatted code                         |
| Python     | isort                                                   | file that does not parse                 | unsorted imports                         |
| Go         | `go test` (and gotestsum, richgo)                       | Go file that does not parse              | failing test                             |
| Go         | `go vet`, staticcheck, golangci-lint                    | Go file that does not parse              | Printf verb that does not match its argument |
| Go         | gofmt, goimports, gofumpt                               | Go file that does not parse              | badly formatted Go file                  |
| Rust       | `cargo test`, `cargo nextest`                           | test file that does not parse            | failing test                             |
| Rust       | `cargo clippy`                                          | module that does not parse               | `needless_return` lint                   |
| Rust       | `cargo fmt`                                             | module that does not parse               | badly formatted module                   |
| Java/Kotlin| Gradle and Maven test tasks                             | test class that does not compile         | failing test                             |
| Java/Kotlin| Checkstyle, Spotless, ktlint, detekt (Gradle and Maven) | source file that does not parse          | badly formatted source, unused import    |

`cargo check`, `cargo build` and the Gradle and Maven compile tasks get the reach fault only:
code that compiles passes them by design.

Some tools exit 0 on findings unless told otherwise, and falsegreen says so in the hint when it
sees one survive: oxlint and biome lint on warnings (unused variables are warnings by default),
`cargo clippy` without `-D warnings`, and `gofmt -l`, which lists files and exits 0.

## Remote mode

Local replay can't run a GitHub Action (`uses: golangci/golangci-lint-action`), a Windows or
macOS runner, a service container or a secret. Remote mode runs the real workflows instead:

```sh
npx falsegreen remote          # prints the plan and exits
npx falsegreen remote --yes    # pushes two throwaway branches and waits for the runs
```

It commits the reach faults to one branch and the semantic faults to another through the Git Data
API (nothing touches your working tree), starts the workflows, and judges each job by its
conclusion. A job that passes with faults in place is a dead or weak gate, and a required check
that passes that way is reported on its own. The branches are deleted afterwards; `--delete-runs`
removes the runs too.

What it can start depends on the token:

- With a personal access token or a GitHub App token in `FALSEGREEN_TOKEN` (contents and actions
  write, plus pull requests write for `--pr`), pushing the branches starts every workflow that
  runs on push. `--pr` opens draft pull requests for workflows that run only on `pull_request`.
- With the workflow's own `GITHUB_TOKEN`, pushes start no runs, so falsegreen dispatches the
  workflows that have `workflow_dispatch` and skips the rest, saying why. Pull requests it opens
  would wait for someone to approve their runs.

Remote mode refuses to push when that would start a workflow that deploys or publishes: one with
an `environment:`, a deploy or release action, or a publishing command. Name such workflows in
`remote.allow` if the push is safe anyway.

## Configuration

Everything is optional. `falsegreen init` writes this file with the defaults and a comment on
each key.

```yaml
# falsegreen.config.yml
failOn: high # lowest severity that fails the run
ignore: # findings to leave out, by rule, job id or step name
  - rule: conditional-gate
  - { rule: continue-on-error, job: experimental }
gates: # steps falsegreen can't resolve on its own, mapped to the tool they run
  - { job: test, step: Run suite, tool: pytest }
place: # where a tool's faults go, when the default is wrong for your layout
  - { tool: vitest, dir: packages/web/src }
matrix:
  max: 4 # legs per job with --matrix all
remote:
  allow: [] # workflows remote mode may start even though they look like deploys
  timeoutMinutes: 30
```

## Cost

Local replay runs each gate once clean and then once per fault, so a step with one tool runs three
times and a step with three tools runs seven. The clean run is skipped with `--assume-green`,
`--tier reach` halves the rest, and `--job`, `--step` and `--workflow` narrow it down. With
`--matrix first` (the default), each step is judged once, in the first matrix leg that runs it.

Remote mode costs two runs of every workflow it starts, one per branch.

For most projects that's cheap enough to run weekly and on changes to the workflows, which is what
`falsegreen init` sets up. falsegreen's own dogfood job replays its test job, where the full vitest
suite dominates, in about 14 minutes on a GitHub-hosted runner.

## How it differs from

- **Mutation testing** (Stryker, PIT, mutmut, cargo-mutants) changes your source code and asks
  whether the tests notice. It needs a working test step to start from. falsegreen asks the
  question before that one: whether the step can fail at all, as CI runs it, for linters,
  formatters and type checkers as well as tests. It needs a few runs per gate, not one per mutant,
  and the two work well together.
- **actionlint** checks that workflow files are valid: syntax, typed `${{ }}` expressions, and
  shellcheck and pyflakes on `run:` scripts. A valid workflow can still run `npm test || true`.
- **zizmor** looks for security problems in workflows, such as template injection and overly broad
  permissions. falsegreen doesn't look at security.
- **OpenSSF Scorecard** scores a repository's practices, including whether pull requests run CI
  and whether the branch is protected. It checks that CI runs; falsegreen checks that it can fail.
- **Coverage** measures which lines the tests execute. A suite at 95% coverage still passes if the
  step that runs it swallows the exit code.

## Limitations

- GitHub Actions only.
- Local replay runs on your machine, not on the runner. Tool versions, the OS, services and
  network access differ; a step that fails here for those reasons is reported as already red, not
  judged. Steps that use `uses:` actions, secrets, or a shell that isn't installed are judged only
  in remote mode.
- A reach fault is judged per step. When a step runs several tools, the first one to read the file
  may catch it for all of them. The semantic faults are specific to each tool.
- Step conditions are evaluated against the matrix only, and script branches only on
  `GITHUB_ACTIONS` and `CI`. Anything else counts as "might run", so the step or branch stays in.
- Tools outside the table above get a generic reach fault, and only when the step names a check.
  `gates` in the config maps a step to a known tool.

## Development

```sh
npm ci
npm run check              # format, lint, typecheck, tests with coverage
scripts/toolchains.sh      # Python, Go, Rust and JVM tools for the fixture tests, under tmp/
```

The fixture tests run falsegreen against small repositories in `test/fixtures`, one per tool, and
skip a fixture whose toolchain is missing. CI installs every toolchain and sets
`FALSEGREEN_REQUIRE_TOOLCHAINS=1`, so nothing skips there. `FALSEGREEN_LIVE_REMOTE=1` runs remote
mode against [falsegreen-fixture](https://github.com/cj-vana/falsegreen-fixture), which needs push
access to it. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
