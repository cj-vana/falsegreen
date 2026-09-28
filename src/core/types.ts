/** Process exit codes: 0 nothing at or above the fail-on severity, 1 findings, 2 falsegreen
 *  itself failed (bad input, interruption, or a cleanup it could not finish). */
export const EXIT = { OK: 0, FINDINGS: 1, ERROR: 2 } as const;

export type Severity = 'high' | 'medium' | 'low' | 'info';
export const SEVERITY_ORDER: readonly Severity[] = ['info', 'low', 'medium', 'high'];

export function atLeast(severity: Severity, threshold: Severity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(threshold);
}

/** reach: a file no parser accepts. semantic: a well-formed file with a real problem. */
export type Tier = 'reach' | 'semantic';
export const TIERS: readonly Tier[] = ['reach', 'semantic'];

/**
 * caught: the gate exited nonzero and named the planted file.
 * survived: the gate exited 0 with the fault in place.
 * unattributed: the gate failed, but its output never named the planted file.
 * unjudged: the run could not say either way (timeout, missing tool, blocked planting).
 */
export type Verdict = 'caught' | 'survived' | 'unattributed' | 'unjudged';

/** A place in a repository file; `file` is repo-relative with forward slashes. */
export interface SourceLocation {
  file: string;
  line: number;
}

export const RULE_IDS = [
  'continue-on-error',
  'masked-exit',
  'pipe-swallows-exit',
  'passes-with-no-tests',
  'if-present',
  'no-files-checked',
  'path-filtered',
  'conditional-gate',
  'not-required',
  'no-required-checks',
  'required-check-missing',
  'required-checks-unreadable',
  'dead-gate',
  'weak-gate',
  'unattributed',
  'already-red',
  'unjudged',
  'skipped-job',
  'required-gate-passed',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export interface Finding {
  rule: RuleId;
  severity: Severity;
  message: string;
  hint?: string;
  location?: SourceLocation;
  workflow?: string;
  job?: string;
  step?: string;
}
