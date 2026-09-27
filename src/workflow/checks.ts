/**
 * The name of the check run a job produces. Observed on live check runs (2026-09-27): a job name
 * that references the matrix is used as is; otherwise GitHub appends the combination's values in
 * matrix order, as in `test (3.10, macOS-latest)`.
 */
import { emptyContext, substitute } from './expressions';
import type { JobModel } from './model';

export function checkName(job: JobModel, combo: Record<string, string>): string {
  const base = substitute(job.name ?? job.id, { ...emptyContext(), matrix: combo }).text;
  const referencesMatrix = job.name !== undefined && /\$\{\{[^}]*\bmatrix\./.test(job.name);
  const values = Object.values(combo);
  if (referencesMatrix || values.length === 0) return base;
  return `${base} (${values.join(', ')})`;
}
