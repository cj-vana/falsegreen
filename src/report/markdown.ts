/** The report as Markdown, used for summary.md and the GitHub job summary. */
import type { Report } from './model';

/** Pipes would end a table cell; newlines would end the row. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function renderMarkdown(report: Report): string {
  const s = report.summary;
  const lines = [
    '## falsegreen',
    '',
    `${s.gates} gates, ${s.judged} judged: **${s.deadGates} dead**, ${s.weakGates} weak, ${s.unjudged} not judged. ` +
      `${report.findings.length} findings.`,
    '',
  ];

  const jobs = new Map<string, Report['gates']>();
  for (const g of report.gates) {
    const key = `${g.workflow}, job ${g.checkName}`;
    jobs.set(key, [...(jobs.get(key) ?? []), g]);
  }
  for (const [title, gates] of jobs) {
    lines.push(
      `### ${cell(title)}`,
      '',
      '| Step | Tool | Reach | Semantic |',
      '| --- | --- | --- | --- |',
    );
    for (const g of gates) {
      if (g.status !== 'judged') {
        lines.push(
          `| ${cell(g.step)} | ${g.tools.join(', ')} | ${g.status}: ${cell(g.reason ?? '')} | |`,
        );
        continue;
      }
      for (const tool of g.tools) {
        const tier = (t: string): string =>
          g.faults.find((f) => f.tool === tool && f.tier === t)?.verdict ?? '';
        lines.push(`| ${cell(g.step)} | ${tool} | ${tier('reach')} | ${tier('semantic')} |`);
      }
    }
    lines.push('');
  }

  if (report.findings.length > 0) {
    lines.push(
      '### Findings',
      '',
      '| Severity | Rule | Location | Message |',
      '| --- | --- | --- | --- |',
    );
    for (const f of report.findings) {
      const at = f.location ? `\`${f.location.file}:${f.location.line}\`` : '';
      const text = f.hint === undefined ? f.message : `${f.message} ${f.hint}`;
      lines.push(`| ${f.severity} | ${f.rule} | ${at} | ${cell(text)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
