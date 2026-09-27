/** Programmatic API. */
export { version } from './version';
export {
  EXIT,
  type Finding,
  type RuleId,
  type Severity,
  type Tier,
  type Verdict,
} from './core/types';
export { runCommand as run, type RunOptions, type RunOutcome } from './commands/run';
export { listCommand as list } from './commands/list';
export type { IO } from './commands/common';
export type { Report, GateReport, FaultReport } from './report/model';
export { loadWorkflows } from './workflow/parse';
export { resolveGates, type Gate } from './resolve/gates';
