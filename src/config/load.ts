import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { RuleId } from '../core/types';
import { ConfigSchema, type Config } from './schema';

export class ConfigError extends Error {}

export interface ResolvedConfig extends Config {
  /** Repo-relative path of the file that was read, if any. */
  source?: string;
}

const DEFAULT_FILES = ['falsegreen.config.yml', 'falsegreen.config.yaml'];

export function loadConfig(root: string, explicitPath?: string): ResolvedConfig {
  const source = explicitPath ?? DEFAULT_FILES.find((f) => existsSync(join(root, f)));
  if (source === undefined) return ConfigSchema.parse({});
  const file = join(root, source);
  if (!existsSync(file)) throw new ConfigError(`${source}: config file not found`);

  let data: unknown;
  try {
    data = parseYaml(readFileSync(file, 'utf8')) ?? {};
  } catch (err) {
    throw new ConfigError(`${source}: ${(err as Error).message.split('\n')[0]}`);
  }
  const result = ConfigSchema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `  ${issue.path.join('.') || '(top level)'}: ${issue.message}`,
    );
    throw new ConfigError(`${source} is not valid:\n${problems.join('\n')}`);
  }
  return { ...result.data, source };
}

export function isIgnored(
  cfg: Pick<ResolvedConfig, 'ignore'>,
  f: { rule: RuleId; job?: string; step?: string },
): boolean {
  return cfg.ignore.some(
    (entry) =>
      (entry.rule === undefined || entry.rule === f.rule) &&
      (entry.job === undefined || entry.job === f.job) &&
      (entry.step === undefined || entry.step === f.step),
  );
}
