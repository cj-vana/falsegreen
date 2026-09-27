import type { Marker } from '../core/marker';
import type { Tier } from '../core/types';

/** A new file; the path is repo-relative and must not exist yet. */
export interface PlantedFile {
  path: string;
  content: string;
}

/** Text appended to an existing file that must be unmodified relative to HEAD. */
export interface Append {
  path: string;
  text: string;
}

export interface Fault {
  tool: ToolId;
  tier: Tier;
  marker: Marker;
  files: PlantedFile[];
  appends: Append[];
  /** One line for reports: what was planted. */
  description: string;
  /** Known behavior that lets this fault survive, quoted in the finding when it does. */
  expectSurvival?: string;
}

/** Every tool falsegreen knows how to plant faults for. `generic` covers unrecognized checks. */
export const TOOL_IDS = [
  'vitest',
  'jest',
  'mocha',
  'node-test',
  'bun-test',
  'tsc',
  'vue-tsc',
  'eslint',
  'biome-lint',
  'biome-format',
  'oxlint',
  'prettier',
  'pytest',
  'unittest',
  'ruff-check',
  'flake8',
  'pylint',
  'mypy',
  'pyright',
  'basedpyright',
  'black',
  'ruff-format',
  'isort',
  'go-test',
  'go-vet',
  'golangci-lint',
  'staticcheck',
  'gofmt',
  'goimports',
  'gofumpt',
  'cargo-test',
  'cargo-nextest',
  'cargo-clippy',
  'cargo-fmt',
  'cargo-check',
  'gradle-test',
  'gradle-lint',
  'gradle-compile',
  'maven-test',
  'maven-lint',
  'maven-compile',
  'generic',
] as const;

export type ToolId = (typeof TOOL_IDS)[number];

export type Language = 'js' | 'python' | 'go' | 'rust' | 'jvm' | 'any';

export type Category = 'test' | 'types' | 'lint' | 'format' | 'compile';

export interface FaultContext {
  root: string;
  /** Tracked files, repo-relative; placement only ever picks from these. */
  tracked: string[];
  invocation: ToolInvocation;
  marker: Marker;
  /** Directory from `place:` in the config, when set for this tool. */
  place?: string;
  /** Reads a repo-relative file. */
  read(path: string): string;
}

export interface ToolDef {
  id: ToolId;
  language: Language;
  category: Category;
  /** The fault for one tier, or why none can be planted for this invocation. */
  faults(ctx: FaultContext, tier: Tier): Fault | { skip: string };
}

/** One recognized tool inside a step's command. */
export interface ToolInvocation {
  tool: ToolId;
  /** The tool's argv after wrappers (npx, uv run, python -m, ...) are stripped. */
  argv: string[];
  /** Repo-relative directory the tool runs in ('' is the repository root). */
  cwd: string;
  /** Existing paths the tool was pointed at, repo-relative. */
  pathArgs: string[];
  /** tsc and vue-tsc: the `-p`/`--project` file, repo-relative. */
  project?: string;
  /** How the step reached this tool, outermost first (`npm run check`, `tsc --noEmit`). */
  via: string[];
}
