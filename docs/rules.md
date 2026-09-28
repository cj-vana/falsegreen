# Rules

Every finding falsegreen reports has one of the rule ids below. The SARIF report links each result
here, and `ignore` in `falsegreen.config.yml` takes the same ids:

```yaml
ignore:
  - rule: conditional-gate
  - { rule: continue-on-error, job: experimental }
```

Severities decide the exit code. With the default `failOn: high`, only high findings fail the run.

| Rule                                                        | Severity          | Found by        |
| ----------------------------------------------------------- | ----------------- | --------------- |
| [dead-gate](#dead-gate)                                     | high              | local, remote   |
| [weak-gate](#weak-gate)                                     | medium or high    | local, remote   |
| [unattributed](#unattributed)                               | low               | local, remote   |
| [already-red](#already-red)                                 | info              | local           |
| [unjudged](#unjudged)                                       | info or high      | local, remote   |
| [masked-exit](#masked-exit)                                 | high or medium    | static          |
| [pipe-swallows-exit](#pipe-swallows-exit)                   | medium            | static          |
| [continue-on-error](#continue-on-error)                     | high or medium    | static          |
| [passes-with-no-tests](#passes-with-no-tests)               | medium            | static          |
| [if-present](#if-present)                                   | high or medium    | static          |
| [no-files-checked](#no-files-checked)                       | high              | static          |
| [path-filtered](#path-filtered)                             | low               | static          |
| [conditional-gate](#conditional-gate)                       | low               | static          |
| [not-required](#not-required)                               | medium            | static (API)    |
| [no-required-checks](#no-required-checks)                   | medium            | static (API)    |
| [required-check-missing](#required-check-missing)           | medium            | static (API)    |
| [required-checks-unreadable](#required-checks-unreadable)   | info              | static (API)    |
| [skipped-job](#skipped-job)                                 | medium            | remote          |
| [required-gate-passed](#required-gate-passed)               | high              | remote          |

## Replay findings

These come from running a gate with a fault planted. Each gate gets up to two faults per tool it
runs: a **reach** fault, a file in the tool's language that no parser accepts, and a **semantic**
fault, a well-formed file with a problem the tool exists to catch (a failing test, a type error, an
unused variable, a misformatted line).

### dead-gate

The step stayed green with a file that does not parse, placed where the tool should read it. Either
the tool never looks there (a config `include` or `exclude`, a narrow path argument, a test runner
that collects a different directory) or its failure never reaches the step's exit code.

When a static finding on the same step explains it, such as `masked-exit` for `pytest || true`,
the hint says so. Otherwise, check what the tool is pointed at. If the location is excluded on
purpose, tell falsegreen where the tool does look with `place`:

```yaml
place:
  - { tool: vitest, dir: packages/web/src }
```

### weak-gate

The step failed on a file that does not parse but stayed green with a real problem: the tool runs
and reads the file, yet does not fail on what it found. The cases falsegreen knows about come with
a hint:

- `oxlint` and `biome lint` exit 0 on warnings, and unused variables are warnings by default. Add
  `--deny-warnings` or `--error-on-warnings`.
- `cargo clippy` exits 0 when lints only warn. Run `cargo clippy -- -D warnings`.
- `gofmt -l` and `goimports -l` list unformatted files and exit 0. Fail the step on their output.
- Checkstyle reports only the rules the project enables.

Otherwise, look for a rule that is turned off or a config that downgrades it.

It is medium when the reach fault was caught, which shows the tool reads that location. When the
reach fault was not run (`--tier semantic`) or not judged, the gate may just as well be dead, so the
finding is high; run with both tiers to tell the two apart.

### unattributed

The step failed with the fault in place, but its output never named the planted file (every
planted file carries a `falsegreen_<hex>` marker in its name). It may have failed for another
reason, such as a flaky test, so falsegreen does not count it as caught. Run it again; if it
persists, look at the excerpt in `results.json`.

### already-red

The step fails before anything is planted, so there is nothing to compare against. The hint
shows the last line of its output. Usually a missing toolchain, dependencies that were never
installed, or a test that depends on the environment. Fix the step locally, or pass
`--assume-green` when running as the last step of a job that already passed.

### unjudged

falsegreen could not judge a gate or a fault. The message says why: the step uses a GitHub Action
(judge it with `falsegreen remote`), a shell that is not installed here, an expression it cannot
rebuild such as a secret, a step that publishes, deploys or rewrites the repository, a step in a
release or deploy job (neither is ever replayed), a timeout, a step that changed tracked files or
your uncommitted work (falsegreen puts them back), a tool with only one kind of fault, or a
location where a file already exists.

These are info on their own. When a replay tried gates and not one fault got a verdict, one more
`unjudged` finding says so at high, because a run that judged nothing proves nothing and should not
pass. The usual cause is a workflow that runs falsegreen without setting up the toolchains the
checks need.

## Shell and workflow findings

These come from reading the workflow and the scripts it runs, without executing anything. The
shell rules follow GitHub's shell templates: the default `bash -e {0}` has no pipefail,
`shell: bash` adds `-o pipefail`, and `shell: sh` is `sh -e {0}`.

### masked-exit

A check's failure turns into a pass before the step ends. falsegreen reports it as high for:

- an `||` branch after the check that does not fail again: `npm test || true`, `pytest || echo
  failed`. A branch ending in `exit 1` or `false` is fine.
- a check before `&&` that is not the last list in the script, since `-e` ignores a failure there:
  `npm test && echo done` followed by more commands.
- a check that is not the last command of a script running without `-e`: an npm script
  (`sh -c`, no `-e`), a script file without `set -e` or a `-e` shebang, or after `set +e`.
- a flag that makes the check exit 0: `--exit-zero` (ruff, flake8, pylint),
  `--issues-exit-code=0` (golangci-lint), `-Dmaven.test.failure.ignore=true`.

It reports medium when the check's status is discarded by a command substitution, as in
`test -z "$(gofmt -l .)"`, which passes when gofmt itself fails without printing. Assigning first
(`out=$(gofmt -l .)`) keeps the status.

### pipe-swallows-exit

The check is piped into another command (`go test ./... | tee out.txt`) and the shell has no
pipefail, so the pipeline reports the last command's status. Set `shell: bash` on the step, or
add `set -o pipefail` to the script.

### continue-on-error

`continue-on-error: true` on a step or job with a check lets it fail without failing the run
(high). Set by an expression, such as `${{ matrix.experimental }}`, it is medium. A local
composite action called with `continue-on-error` passes it to every step inside it.

### passes-with-no-tests

The test run passes when it collects nothing: `--passWithNoTests` (jest, vitest), or
`pytest || [ $? -eq 5 ]`, which accepts pytest's "no tests collected" code. A renamed test
directory then turns the gate off.

### if-present

`npm run <script> --if-present` passes without running anything when the script is missing. High
when the script is already missing, medium while it exists.

### no-files-checked

The check runs on staged files only, and a CI checkout has nothing staged: `pre-commit run`
without `--all-files`, or `lint-staged`. Use `pre-commit run --all-files`, or call the linters
directly.

### path-filtered

The workflow that holds the checks has `paths` or `paths-ignore` on `pull_request`, so pull
requests that touch none of those paths never run it. If the checks are required, those pull
requests wait on a check that never reports.

### conditional-gate

A step or job with a check has an `if:` on the event or branch (`github.event_name`,
`github.ref` and similar), so it does not run for every change. Often deliberate; listed so the
choice is visible.

## Required checks

falsegreen reads branch protection and rulesets through the GitHub API when the repository has a
GitHub remote and a token is available: `FALSEGREEN_TOKEN`, `GITHUB_TOKEN` or `GH_TOKEN`, then
`gh auth token`. `--token-env NAME` reads another variable first. Turn this off with
`--required-checks off`.

### not-required

A job with a check is not a required status check on the branch, so a red run does not block a
merge. The check names are the ones GitHub shows, including matrix suffixes such as
`test (22)`.

### no-required-checks

The branch requires no status checks at all.

### required-check-missing

A required check comes from GitHub Actions, but no job in the workflows reports that name, so
pull requests wait for a check that never arrives. A renamed job or matrix value is the usual
cause.

### required-checks-unreadable

The required checks could not be read (no token, no access, or an API error), and the three rules
above were skipped.

## Remote mode

`falsegreen remote` pushes the faults to throwaway branches and judges each job by its
conclusion on GitHub. It also reports `dead-gate`, `weak-gate`, `unattributed` and `unjudged`, per
job instead of per step.

### skipped-job

The job was skipped on the throwaway branch, by its `if:` or by a job it needs, so its checks
never ran.

### required-gate-passed

A required check passed with faults planted. A pull request with the same problems can merge.
