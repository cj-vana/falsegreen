import type { RuleId } from '../core/types';

/** One line per rule, used for SARIF rule metadata and the rules reference in docs/rules.md. */
export const RULE_DESCRIPTIONS: Record<RuleId, string> = {
  'dead-gate': 'A gate stayed green with a planted file that no parser accepts.',
  'weak-gate': 'A gate stayed green with a planted file that has a real problem.',
  unattributed: 'A gate failed with a fault in place, but never named the planted file.',
  'already-red': 'A gate fails before any fault is planted.',
  unjudged: 'A gate or fault could not be judged.',
  'masked-exit': 'The failure of a check command is turned into a pass.',
  'pipe-swallows-exit': 'A check is piped into another command without pipefail.',
  'continue-on-error': 'A step or job can fail without failing the run.',
  'passes-with-no-tests': 'The test run passes when it finds no tests.',
  'if-present': 'The step passes when the script it names is missing.',
  'no-files-checked': 'The check looks only at staged files, and a CI checkout has none.',
  'path-filtered': 'Pull requests can skip the workflow that holds these checks.',
  'conditional-gate': 'A check only runs for some events.',
  'not-required': 'A red run of this check does not block merging.',
  'no-required-checks': 'The default branch requires no status checks.',
  'required-check-missing': 'A required check is produced by no job.',
  'required-checks-unreadable': 'Required checks could not be read.',
  'skipped-job': 'A job was skipped on the throwaway branch.',
  'required-gate-passed': 'A required check passed with planted faults.',
};

export const RULES_URL = 'https://github.com/cj-vana/falsegreen/blob/main/docs/rules.md';
