/** The report as terminal text: each gate with its verdicts, then the findings, then a summary. */
import { createColors } from 'picocolors';

import { atLeast, type Severity, type Verdict } from '../core/types';
import type { Report } from './model';

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return map;
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

export function renderTerminal(report: Report, color: boolean): string {
  const c = createColors(color);
  const verdict = (v: Verdict): string =>
    (v === 'caught' ? c.green : v === 'survived' ? c.red : c.yellow)(v.padEnd(12));
  const severity = (s: Severity): string =>
    (s === 'high' ? c.red : s === 'medium' ? c.yellow : c.dim)(s.padEnd(8));

  const lines: string[] = [`falsegreen ${report.version}  modes: ${report.modes.join(', ')}`, ''];

  for (const [workflow, gates] of groupBy(report.gates, (g) => g.workflow)) {
    lines.push(c.bold(workflow));
    for (const [job, jobGates] of groupBy(gates, (g) => g.checkName)) {
      lines.push(`  job ${job}`);
      for (const g of jobGates) {
        lines.push(`    ${g.step} ${c.dim(`(line ${g.line})`)}`);
        if (g.status === 'already-red')
          lines.push(c.yellow(`      already red: ${g.reason ?? ''}`));
        else if (g.status === 'unjudged')
          lines.push(c.yellow(`      not judged: ${g.reason ?? ''}`));
        for (const f of g.faults) {
          const detail = f.reason === undefined ? seconds(f.durationMs) : f.reason;
          lines.push(
            `      ${f.tier.padEnd(10)}${f.tool.padEnd(15)}${verdict(f.verdict)}${detail}`,
          );
        }
      }
    }
    lines.push('');
  }

  for (const error of report.errors) lines.push(c.yellow(`error: ${error}`));

  if (report.findings.length > 0) {
    lines.push(c.bold('Findings'));
    for (const f of report.findings) {
      const at = f.location ? `${f.location.file}:${f.location.line}` : '';
      lines.push(`  ${severity(f.severity)}${f.rule.padEnd(24)}${at}`);
      lines.push(`  ${' '.repeat(8)}${f.message}`);
      if (f.hint !== undefined) lines.push(`  ${' '.repeat(8)}${c.dim(`hint: ${f.hint}`)}`);
    }
    lines.push('');
  }

  const s = report.summary;
  const failing = report.findings.filter((f) => atLeast(f.severity, report.failOn)).length;
  lines.push(
    `${s.gates} gates, ${s.judged} judged: ${s.deadGates} dead, ${s.weakGates} weak, ${s.unjudged} not judged. ` +
      `${failing} ${failing === 1 ? 'finding' : 'findings'} at ${report.failOn} or above.`,
  );
  return `${lines.join('\n')}\n`;
}
