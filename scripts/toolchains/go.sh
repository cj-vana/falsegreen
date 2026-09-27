#!/usr/bin/env bash
# Go linters and formatters for the Go fixtures, installed into $FG_TMP/bin. Needs `go` on PATH
# (gofmt ships with it). Module and build caches stay under $FG_TMP/cache.
set -euo pipefail

: "${FG_TMP:?run through scripts/toolchains.sh}"
export GOBIN="$FG_TMP/bin"
export GOPATH="$FG_TMP/cache/gopath"
export GOCACHE="$FG_TMP/cache/go-build"
export GOMODCACHE="$FG_TMP/cache/gopath/pkg/mod"
export GOLANGCI_LINT_CACHE="$FG_TMP/cache/golangci-lint"
export TMPDIR="$FG_TMP"

STATICCHECK=v0.8.1 # staticcheck 2026.2.1
X_TOOLS=v0.50.0
GOFUMPT=v0.12.0
GOLANGCI_LINT=v2.14.0

go install "honnef.co/go/tools/cmd/staticcheck@$STATICCHECK"
go install "golang.org/x/tools/cmd/goimports@$X_TOOLS"
go install "mvdan.cc/gofumpt@$GOFUMPT"

# golangci-lint documents `go install` as unsupported and recommends its release binaries,
# fetched by its install script (https://golangci-lint.run/docs/welcome/install/local/).
if ! "$GOBIN/golangci-lint" version 2>/dev/null | grep -q "version ${GOLANGCI_LINT#v} "; then
  curl -sSfL https://golangci-lint.run/install.sh | sh -s -- -b "$GOBIN" "$GOLANGCI_LINT"
fi

go version
"$GOBIN/staticcheck" -version
"$GOBIN/gofumpt" -version
"$GOBIN/golangci-lint" version
