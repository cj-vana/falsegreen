/**
 * Tests that need a real toolchain call `needs('go', ...)`. Locally a missing tool skips the test;
 * with FALSEGREEN_REQUIRE_TOOLCHAINS=1 (set in CI) it fails instead, so the suite can never pass by
 * quietly running less.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const tools = join(repoRoot, 'tmp', 'tools');

/**
 * Toolchains installed by scripts/toolchains.sh live under tmp/ and go first on PATH: a Python
 * venv at tmp/py, single binaries in tmp/bin, and unpacked distributions in tmp/tools/<name>/bin.
 */
const EXTRA_PATH = [
  join(repoRoot, 'tmp', 'py', 'bin'),
  join(repoRoot, 'tmp', 'bin'),
  ...(existsSync(tools) ? readdirSync(tools).map((d) => join(tools, d, 'bin')) : []),
].filter(existsSync);
if (EXTRA_PATH.length > 0) {
  process.env.PATH = [...EXTRA_PATH, process.env.PATH ?? ''].join(delimiter);
}

/** How to ask each tool whether it works (a present but unusable tool counts as missing). */
const PROBES: Record<string, string[]> = {
  make: ['make', '--version'],
  go: ['go', 'version'],
  staticcheck: ['staticcheck', '-version'],
  cargo: ['cargo', '--version'],
  'cargo-clippy': ['cargo', 'clippy', '--version'],
  'cargo-fmt': ['cargo', 'fmt', '--version'],
  'cargo-nextest': ['cargo', 'nextest', '--version'],
  bun: ['bun', '--version'],
  java: ['java', '-version'],
  gradle: ['gradle', '--version'],
  mvn: ['mvn', '--version'],
};

const cache = new Map<string, boolean>();

function works(probe: string[]): boolean {
  const [cmd, ...args] = probe;
  return spawnSync(cmd!, args, { stdio: 'ignore', timeout: 60_000 }).status === 0;
}

export function available(tool: string): boolean {
  if (!cache.has(tool)) {
    // falsegreen prefers gmake, so a working gmake is enough when make is Apple's shim.
    const ok =
      tool === 'make'
        ? works(['gmake', '--version']) || works(PROBES.make!)
        : works(PROBES[tool] ?? [tool, '--version']);
    cache.set(tool, ok);
  }
  return cache.get(tool)!;
}

export const requireToolchains = process.env.FALSEGREEN_REQUIRE_TOOLCHAINS === '1';

/**
 * Returns the tools that are missing. In CI a missing tool throws, failing the test that asked;
 * locally the caller skips.
 */
export function missing(...tools: string[]): string[] {
  const absent = tools.filter((t) => !available(t));
  if (absent.length > 0 && requireToolchains) {
    throw new Error(`required toolchain not available: ${absent.join(', ')}`);
  }
  return absent;
}
