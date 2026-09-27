/** Tools behind `pre-commit run`, from the hook ids in .pre-commit-config.yaml. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { ToolId } from '../faults/types';

const HOOKS: Record<string, ToolId[]> = {
  ruff: ['ruff-check'],
  'ruff-check': ['ruff-check'],
  'ruff-format': ['ruff-format'],
  black: ['black'],
  'black-jupyter': ['black'],
  isort: ['isort'],
  flake8: ['flake8'],
  mypy: ['mypy'],
  pylint: ['pylint'],
  pyright: ['pyright'],
  prettier: ['prettier'],
  eslint: ['eslint'],
  'biome-check': ['biome-lint', 'biome-format'],
  'biome-ci': ['biome-lint', 'biome-format'],
  'biome-lint': ['biome-lint'],
  'biome-format': ['biome-format'],
  'golangci-lint': ['golangci-lint'],
  'golangci-lint-full': ['golangci-lint'],
  'go-fmt': ['gofmt'],
  gofmt: ['gofmt'],
  'go-vet': ['go-vet'],
  clippy: ['cargo-clippy'],
  fmt: ['cargo-fmt'],
  'cargo-check': ['cargo-check'],
};

export const PRECOMMIT_CONFIG = '.pre-commit-config.yaml';

/** Tools run by every hook (or by `hookId` alone), in config order. */
export function precommitTools(root: string, hookId?: string): ToolId[] {
  const file = join(root, PRECOMMIT_CONFIG);
  if (!existsSync(file)) return [];
  let config: unknown;
  try {
    config = parseYaml(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const repos = (config as { repos?: { hooks?: { id?: unknown }[] }[] } | null)?.repos ?? [];
  const tools: ToolId[] = [];
  for (const repo of repos) {
    for (const hook of repo.hooks ?? []) {
      if (typeof hook.id !== 'string' || (hookId !== undefined && hook.id !== hookId)) continue;
      for (const tool of HOOKS[hook.id] ?? []) if (!tools.includes(tool)) tools.push(tool);
    }
  }
  return tools;
}
