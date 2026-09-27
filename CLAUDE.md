# falsegreen: notes for coding agents

- `npm run check` is the gate: format, lint, typecheck, tests. Commit only when it passes, and read
  its exit status directly:
  `if npm run check > tmp/gate.out 2>&1; then git add ... && git commit ...; else tail -40 tmp/gate.out; fi`
- Scratch files, probes and test output go under `tmp/`. Run tools by hand with `TMPDIR=$PWD/tmp`.
- Planning documents (plans, handoffs, progress logs, summaries) are never committed. See
  `CONTRIBUTING.md`.
- Before asserting anything about a tool's exit code or output in a test or in `src/faults/`, run
  the tool on the fault once and read the real output.
- Fixture repositories under `test/fixtures/` contain deliberate faults and bad formatting. They are
  excluded from lint and prettier on purpose; do not "fix" them.
- No em dash or en dash in code, docs or output. No emoji in CLI output or reports.
- Files whose content includes a backslash are written with the editor tools, not shell heredocs.
