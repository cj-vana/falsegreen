#!/usr/bin/env bash
# Installs the toolchains the fixture tests use, under tmp/ in this checkout, so nothing lands in
# your home directory. With no arguments it runs every script in scripts/toolchains/; name
# languages to run only those: scripts/toolchains.sh python go
set -euo pipefail

cd "$(dirname "$0")/.."
export FG_TMP="$PWD/tmp"
mkdir -p "$FG_TMP/bin" "$FG_TMP/tools"

if [ "$#" -eq 0 ]; then
  set -- $(cd scripts/toolchains && ls *.sh | sed 's/\.sh$//')
fi

for lang in "$@"; do
  echo "== $lang"
  bash "scripts/toolchains/$lang.sh"
done
