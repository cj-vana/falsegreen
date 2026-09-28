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

sha256() {
  if command -v sha256sum > /dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi |
    cut -d' ' -f1
}

# golangci-lint documents `go install` as unsupported and recommends its release binaries
# (https://golangci-lint.run/docs/welcome/install/local/). The archive comes from the GitHub
# release and is checked against the release's checksums file before anything in it runs.
if ! "$GOBIN/golangci-lint" version 2>/dev/null | grep -q "version ${GOLANGCI_LINT#v} "; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) platform=darwin-arm64 ;;
    Darwin-x86_64) platform=darwin-amd64 ;;
    Linux-x86_64) platform=linux-amd64 ;;
    Linux-aarch64 | Linux-arm64) platform=linux-arm64 ;;
    *)
      echo "no golangci-lint release for $(uname -s) $(uname -m)" >&2
      exit 1
      ;;
  esac
  name="golangci-lint-${GOLANGCI_LINT#v}-$platform"
  base="https://github.com/golangci/golangci-lint/releases/download/$GOLANGCI_LINT"
  downloads="$FG_TMP/cache/downloads"
  mkdir -p "$downloads"
  curl -fsSL -o "$downloads/$name.tar.gz" "$base/$name.tar.gz"
  want=$(curl -fsSL "$base/golangci-lint-${GOLANGCI_LINT#v}-checksums.txt" |
    awk -v file="$name.tar.gz" '$2 == file { print $1 }')
  got=$(sha256 "$downloads/$name.tar.gz")
  if [ -z "$want" ] || [ "$got" != "$want" ]; then
    echo "checksum mismatch for $name.tar.gz: expected ${want:-nothing}, got $got" >&2
    exit 1
  fi
  tar -xzf "$downloads/$name.tar.gz" -C "$downloads"
  mv "$downloads/$name/golangci-lint" "$GOBIN/golangci-lint"
fi

go version
"$GOBIN/staticcheck" -version
"$GOBIN/gofumpt" -version
"$GOBIN/golangci-lint" version
