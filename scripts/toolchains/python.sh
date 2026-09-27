#!/usr/bin/env bash
# Python tools for the py-* fixtures, in a virtual environment at $FG_TMP/py. test/helpers/toolchains.ts
# puts $FG_TMP/py/bin first on PATH. Caches go under $FG_TMP/cache, matching the directories that
# helper sets for the tests, so installing and running leave nothing in the home directory.
set -euo pipefail

: "${FG_TMP:?run scripts/toolchains.sh, which sets FG_TMP}"

export UV_CACHE_DIR="$FG_TMP/cache/uv"
export UV_PYTHON_INSTALL_DIR="$FG_TMP/cache/uv-python"
export XDG_CACHE_HOME="$FG_TMP/cache/xdg"
export PRE_COMMIT_HOME="$FG_TMP/cache/pre-commit"
export PYRIGHT_PYTHON_CACHE_DIR="$FG_TMP/cache/pyright"
export npm_config_cache="$FG_TMP/cache/npm"

uv=$(command -v uv || true)
if [ -z "$uv" ]; then
  echo "uv is required: https://docs.astral.sh/uv/getting-started/installation/" >&2
  exit 1
fi

if [ ! -x "$FG_TMP/py/bin/python" ]; then
  "$uv" venv --python ">=3.10" "$FG_TMP/py"
fi
"$uv" pip install --python "$FG_TMP/py/bin/python" \
  pytest ruff flake8 pylint mypy pyright basedpyright black isort pre-commit

# pyright's PyPI wrapper fetches the pyright npm package on first use; do that now, not mid-test.
"$FG_TMP/py/bin/pyright" --version
"$FG_TMP/py/bin/basedpyright" --version
