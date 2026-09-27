import type { SourceLocation } from '../core/types';

export interface Filter {
  branches?: string[];
  branchesIgnore?: string[];
  tags?: string[];
  tagsIgnore?: string[];
  paths?: string[];
  pathsIgnore?: string[];
}

export interface Inputs {
  inputs: Record<string, { default?: string }>;
}

export interface Triggers {
  push?: Filter;
  pullRequest?: Filter;
  pullRequestTarget?: Filter;
  workflowDispatch?: Inputs;
  workflowCall?: Inputs;
  schedule: boolean;
  other: string[];
}

export interface Defaults {
  shell?: string;
  workingDirectory?: string;
}

export interface StepModel {
  /** Position in the job after local composite actions are inlined. */
  index: number;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with: Record<string, string>;
  shell?: string;
  workingDirectory?: string;
  env: Record<string, string>;
  continueOnError?: boolean | string;
  if?: string;
  timeoutMinutes?: number;
  loc: SourceLocation;
  /** Line of the first line of `run` text, when it sits in this workflow file. */
  runLine?: number;
  /** Set on steps inlined from a local composite action (`uses: ./path`). */
  fromAction?: string;
}

export interface MatrixSpec {
  axes: Record<string, unknown[]>;
  include: Record<string, unknown>[];
  exclude: Record<string, unknown>[];
  /** Set when the matrix (or an axis) is computed by an expression and cannot be expanded. */
  expression?: string;
}

export interface JobModel {
  id: string;
  name?: string;
  if?: string;
  needs: string[];
  continueOnError?: boolean | string;
  matrix?: MatrixSpec;
  env: Record<string, string>;
  defaults: Defaults;
  environment?: string;
  /** `jobs.<id>.uses`: a reusable workflow call. Such a job has no steps of its own. */
  usesWorkflow?: string;
  steps: StepModel[];
  timeoutMinutes?: number;
  loc: SourceLocation;
}

export interface WorkflowModel {
  /** Repo-relative path, e.g. `.github/workflows/ci.yml`. */
  file: string;
  name?: string;
  triggers: Triggers;
  env: Record<string, string>;
  defaults: Defaults;
  jobs: JobModel[];
  loc: SourceLocation;
  errors: string[];
}
