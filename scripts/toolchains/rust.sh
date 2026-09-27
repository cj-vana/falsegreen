#!/usr/bin/env bash
# Rust: checks that cargo, clippy and rustfmt work and installs cargo-nextest into $FG_TMP/bin.
# cargo itself comes from rustup (https://rustup.rs) or the CI runner's preinstalled toolchain.
set -euo pipefail

: "${FG_TMP:?run this through scripts/toolchains.sh}"
NEXTEST_VERSION=0.9.146

if ! command -v cargo > /dev/null; then
  echo "cargo is not installed; install Rust with rustup: https://rustup.rs" >&2
  exit 1
fi
cargo --version

for component in clippy rustfmt; do
  sub=$component
  [ "$component" = rustfmt ] && sub=fmt
  if ! cargo "$sub" --version > /dev/null 2>&1; then
    # Outside CI the component would land in the user's rustup home, so ask instead of doing it.
    if [ "${CI:-}" = true ] && command -v rustup > /dev/null; then
      rustup component add "$component"
    else
      echo "cargo $sub does not work; run: rustup component add $component" >&2
      exit 1
    fi
  fi
  cargo "$sub" --version
done

# `cargo nextest --version` prints "cargo-nextest 0.9.146 (8af696ddc 2026-09-21)".
installed=$(PATH="$FG_TMP/bin:$PATH" cargo nextest --version 2> /dev/null | head -n 1 || true)
if [ "${installed#"cargo-nextest $NEXTEST_VERSION "}" = "$installed" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-*) platform=mac ;;
    Linux-x86_64) platform=linux ;;
    Linux-aarch64 | Linux-arm64) platform=linux-arm ;;
    *)
      echo "no prebuilt cargo-nextest for $(uname -s) $(uname -m)" >&2
      exit 1
      ;;
  esac
  curl -LsSf "https://get.nexte.st/$NEXTEST_VERSION/$platform" | tar zxf - -C "$FG_TMP/bin"
fi
PATH="$FG_TMP/bin:$PATH" cargo nextest --version | head -n 1

# cargo test and nextest link test binaries with the system C compiler. The Rust fixtures list
# "cc" in their requirements and are skipped locally while it does not run.
if ! cc --version > /dev/null 2>&1; then
  echo "warning: cc does not run, so cargo cannot link test binaries." >&2
  echo "On macOS, accept the Xcode license (sudo xcodebuild -license) or select the Command" >&2
  echo "Line Tools: export DEVELOPER_DIR=/Library/Developer/CommandLineTools" >&2
fi
