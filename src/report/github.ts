/**
 * Output for a run inside GitHub Actions: one annotation per finding (workflow commands, see
 * https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-commands) and the
 * Markdown report appended to the job summary.
 */
import { appendFileSync } from 'node:fs';

import type { Severity } from '../core/types';
import { renderMarkdown } from './markdown';
import type { Report } from './model';

const COMMAND: Record<Severity, string> = {
  high: 'error',
  medium: 'warning',
  low: 'notice',
  info: 'notice',
};

// Same escaping as escapeData and escapeProperty in actions/toolkit packages/core/src/command.ts.
const escapeData = (s: string): string =>
  s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s: string): string =>
  escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function emitActions(
  report: Report,
  env: NodeJS.ProcessEnv,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): void {
  for (const f of report.findings) {
    const props = [
      ...(f.location ? [`file=${escapeProperty(f.location.file)}`, `line=${f.location.line}`] : []),
      `title=${escapeProperty(f.rule)}`,
    ].join(',');
    const text = f.hint === undefined ? f.message : `${f.message} ${f.hint}`;
    write(`::${COMMAND[f.severity]} ${props}::${escapeData(text)}`);
  }
  if (env.GITHUB_STEP_SUMMARY)
    appendFileSync(env.GITHUB_STEP_SUMMARY, `${renderMarkdown(report)}\n`);
}
