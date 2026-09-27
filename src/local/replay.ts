/**
 * Local mode: for each gate, run the step clean (the baseline), then once per fault with the fault
 * planted, and decide from the exit code and the output whether the gate caught it.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ResolvedConfig } from '../config/load';
import { modifiedTracked, restoreFromHead, trackedFiles } from '../core/git';
import { newMarker, outputMentions, type Marker } from '../core/marker';
import type { ProcResult } from '../core/proc';
import type { Tier, Verdict } from '../core/types';
import { toolDef } from '../faults/registry';
import type { Fault, FaultContext, ToolId, ToolInvocation } from '../faults/types';
import { checkPlantable, plant } from '../plant/planter';
import type { Gate } from '../resolve/gates';
import { runStep } from './runner';

export interface FaultRun {
  tool: ToolId;
  tier: Tier;
  /** Absent when no fault could be built or planted for this tool and tier. */
  fault?: Fault;
  verdict: Verdict;
  exitCode: number | null;
  durationMs: number;
  excerpt: string;
  reason?: string;
}

export interface GateResult {
  gate: Gate;
  status: 'judged' | 'already-red' | 'unjudged';
  reason?: string;
  baseline?: { exitCode: number | null; durationMs: number; excerpt: string };
  runs: FaultRun[];
}

export type ProgressEvent =
  | { type: 'baseline'; gate: Gate; result: ProcResult }
  | { type: 'fault'; gate: Gate; run: FaultRun };

export interface ReplayOptions {
  tiers: Tier[];
  assumeGreen: boolean;
  timeoutMs: number;
  onProgress?: (e: ProgressEvent) => void;
  marker?: () => Marker;
}

// eslint-disable-next-line no-control-regex -- terminal color codes start with ESC (0x1b)
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
const EXCERPT_LINES = 12;

/** Lines around the first mention of the marker, or the tail of the output. */
export function excerpt(output: string, marker?: Marker): string {
  const lines = output.replace(ANSI, '').split('\n');
  const hit = marker ? lines.findIndex((l) => outputMentions(l, marker)) : -1;
  const slice =
    hit >= 0
      ? lines.slice(Math.max(0, hit - 3), hit + EXCERPT_LINES - 3)
      : lines.slice(-EXCERPT_LINES);
  return slice.join('\n').trim().slice(0, 2_000);
}

/** Why a finished run cannot be judged: timeout, a shell that would not start, a missing command. */
function unjudgedReason(r: ProcResult, timeoutMs: number): string | undefined {
  if (r.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)} s`;
  if (r.spawnError !== undefined) return r.spawnError;
  if (r.exitCode === 127) {
    const name = /([^\s:'"]+): (?:command )?not found/.exec(r.output.replace(ANSI, ''))?.[1];
    return `a command the step runs is not installed: ${name ?? 'unknown'}`;
  }
  return undefined;
}

/** Why the step must not be replayed at all, checked before anything runs. */
export function faultContext(
  root: string,
  tracked: string[],
  invocation: ToolInvocation,
  marker: Marker,
  cfg: ResolvedConfig,
): FaultContext {
  const place = cfg.place.find((p) => p.tool === invocation.tool)?.dir;
  return {
    root,
    tracked,
    invocation,
    marker,
    ...(place === undefined ? {} : { place }),
    read: (p) => readFileSync(join(root, p), 'utf8'),
  };
}

export function refusal(gate: Gate): string | undefined {
  if (gate.kind === 'uses') return 'runs a GitHub Action; use falsegreen remote to judge it';
  if (gate.unsafe !== undefined)
    return `the step also runs \`${gate.unsafe}\`, which falsegreen never replays`;
  if (gate.unresolved.length > 0) {
    return `the command uses ${gate.unresolved.map((e) => `\${{ ${e} }}`).join(', ')}, which cannot be rebuilt locally`;
  }
  return undefined;
}

function stepTimeout(gate: Gate, fallback: number): number {
  return gate.step.timeoutMinutes !== undefined ? gate.step.timeoutMinutes * 60_000 : fallback;
}

/** Restores tracked files the step changed; returns their paths. */
function undoTrackedChanges(root: string, before: Set<string>): string[] {
  const changed = modifiedTracked(root).filter((p) => !before.has(p));
  restoreFromHead(root, changed);
  return changed;
}

function faultRun(inv: ToolInvocation, tier: Tier, verdict: Verdict, reason: string): FaultRun {
  return { tool: inv.tool, tier, verdict, exitCode: null, durationMs: 0, excerpt: '', reason };
}

async function replayGate(
  root: string,
  gate: Gate,
  cfg: ResolvedConfig,
  opts: ReplayOptions,
): Promise<GateResult> {
  const refused = refusal(gate);
  if (refused) return { gate, status: 'unjudged', reason: refused, runs: [] };
  const timeoutMs = stepTimeout(gate, opts.timeoutMs);
  const dirtyBefore = new Set(modifiedTracked(root));
  const result: GateResult = { gate, status: 'judged', runs: [] };

  if (!opts.assumeGreen) {
    const base = await runStep(root, gate, { timeoutMs });
    opts.onProgress?.({ type: 'baseline', gate, result: base });
    result.baseline = {
      exitCode: base.exitCode,
      durationMs: base.durationMs,
      excerpt: excerpt(base.output),
    };
    const changed = undoTrackedChanges(root, dirtyBefore);
    if (changed.length > 0) {
      return {
        ...result,
        status: 'unjudged',
        reason: `the step changed tracked files: ${changed.join(', ')} (restored)`,
      };
    }
    const why = unjudgedReason(base, timeoutMs);
    if (why) return { ...result, status: 'unjudged', reason: why };
    if (base.exitCode !== 0)
      return {
        ...result,
        status: 'already-red',
        reason: `the step exits ${base.exitCode} without any fault`,
      };
  }

  const tracked = trackedFiles(root);
  for (const inv of gate.invocations) {
    const def = toolDef(inv.tool);
    // A tool without a semantic fault (compile-only checks, the generic fault) skips that tier.
    for (const tier of opts.tiers.filter((t) => !def?.tiers || def.tiers.includes(t))) {
      if (!def) {
        result.runs.push(faultRun(inv, tier, 'unjudged', `no faults for ${inv.tool} yet`));
        continue;
      }
      const marker = (opts.marker ?? newMarker)();
      const fault = def.faults(faultContext(root, tracked, inv, marker, cfg), tier);
      if ('skip' in fault) {
        result.runs.push(faultRun(inv, tier, 'unjudged', fault.skip));
        continue;
      }
      const blocked = checkPlantable(root, fault);
      if (blocked) {
        result.runs.push({ ...faultRun(inv, tier, 'unjudged', `cannot plant: ${blocked}`), fault });
        continue;
      }

      const planted = plant(root, fault);
      let r: ProcResult;
      try {
        r = await runStep(root, gate, { timeoutMs });
      } finally {
        planted.revert();
      }
      const why = unjudgedReason(r, timeoutMs);
      const verdict: Verdict = why
        ? 'unjudged'
        : r.exitCode === 0
          ? 'survived'
          : outputMentions(r.output, marker)
            ? 'caught'
            : 'unattributed';
      const run: FaultRun = {
        tool: inv.tool,
        tier,
        fault,
        verdict,
        exitCode: r.exitCode,
        durationMs: r.durationMs,
        excerpt: excerpt(r.output, marker),
        ...(why ? { reason: why } : {}),
      };
      result.runs.push(run);
      opts.onProgress?.({ type: 'fault', gate, run });

      const changed = undoTrackedChanges(root, dirtyBefore);
      if (changed.length > 0) {
        return {
          ...result,
          status: 'unjudged',
          reason: `the step changed tracked files: ${changed.join(', ')} (restored)`,
        };
      }
    }
  }
  return result;
}

export async function replayGates(
  root: string,
  gates: Gate[],
  cfg: ResolvedConfig,
  opts: ReplayOptions,
): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of gates) results.push(await replayGate(root, gate, cfg, opts));
  return results;
}
