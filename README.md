# falsegreen

Your CI is green. Can it go red?

falsegreen plants known faults in your repository, runs each CI gate the way your workflow runs it,
and reports every check that stays green anyway: tests that never collect the new file, lint
pointed at the wrong directory, `|| true`, a pipe that swallows the exit code, a job nobody
requires.

Work in progress. Not yet published to npm.

## License

MIT
