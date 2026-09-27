import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderMarkdown } from './markdown';
import type { Report } from './model';
import { toSarif } from './sarif';

export type Format = 'json' | 'sarif' | 'md';

/** Writes the requested formats into outDir; returns the paths written. */
export function writeReports(report: Report, outDir: string, formats: Format[]): string[] {
  mkdirSync(outDir, { recursive: true });
  const files: Record<Format, [string, string]> = {
    json: ['results.json', JSON.stringify(report, null, 2)],
    sarif: ['results.sarif', JSON.stringify(toSarif(report), null, 2)],
    md: ['summary.md', renderMarkdown(report)],
  };
  return formats.map((format) => {
    const [name, content] = files[format];
    const path = join(outDir, name);
    writeFileSync(path, `${content}\n`);
    return path;
  });
}
