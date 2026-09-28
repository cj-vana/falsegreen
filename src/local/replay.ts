/**
 * Local mode: for each gate, run the step clean (the baseline), then once per fault with the fault
 * planted, and decide from the exit code and the output whether the gate caught it.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { ResolvedConfig } from '../config/load';
import { modifiedTracked, restoreFromHead, trackedFiles, uncommittedPaths } from '../core/git';
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
  /** Host variables to keep from the step, on top of the ones named like credentials. */
  stripEnv?: string[];
}

// Color codes (ESC [ ... m) and character-set resets (ESC ( B, printed by rustfmt).
// eslint-disable-next-line no-control-regex -- terminal escape sequences start with ESC (0x1b)
const ANSI = /\x1b(\[[0-9;?]*[A-Za-z]|[()][A-Za-z0-9])/g;
const EXCERPT_LINES = 12;

/** Lines around the first mention of the marker, or the tail of the output. */
/**
 * Token shapes that must not reach a report, which the action uploads as an artifact: GitHub
 * tokens (ghp_, gho_, ghu_, ghs_, ghr_, github_pat_), npm tokens, Slack tokens, AWS key ids.
 */
const TOKEN =
  /\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g;

export function excerpt(output: string, marker?: Marker): string {
  const lines = output.replace(ANSI, '').replace(TOKEN, '[redacted]').split('\n');
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
  // A release job's own scripts may publish in ways no command list recognizes.
  if (gate.release !== undefined) {
    return `falsegreen does not replay steps of release or deploy jobs: ${gate.release}`;
  }
  if (gate.unresolved.length > 0) {
    return `the command uses ${gate.unresolved.map((e) => `\${{ ${e} }}`).join(', ')}, which cannot be rebuilt locally`;
  }
  return undefined;
}

function stepTimeout(gate: Gate, fallback: number): number {
  return gate.step.timeoutMinutes !== undefined ? gate.step.timeoutMinutes * 60_000 : fallback;
}

/** How much uncommitted work falsegreen keeps a copy of while it replays; beyond it, it refuses. */
const WORK_LIMIT = 64 * 1024 * 1024;

/**
 * A copy of the user's uncommitted work, taken before a gate runs: HEAD cannot give these bytes
 * back if a step overwrites or deletes them. A string says why no copy was taken.
 */
function snapshotWork(root: string): Map<string, Buffer> | string {
  const work = new Map<string, Buffer>();
  let size = 0;
  for (const path of uncommittedPaths(root)) {
    const full = join(root, path);
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    const bytes = readFileSync(full);
    size += bytes.length;
    if (size > WORK_LIMIT) {
      return `the tree holds more than ${WORK_LIMIT / 1024 / 1024} MB of uncommitted or untracked files; commit, stash or ignore them so a step cannot overwrite them`;
    }
    work.set(path, bytes);
  }
  return work;
}

/** Puts back every snapshotted file a step changed or deleted; returns their paths. */
function restoreWork(root: string, work: Map<string, Buffer>): string[] {
  const changed: string[] = [];
  for (const [path, bytes] of work) {
    const full = join(root, path);
    if (existsSync(full) && statSync(full).isFile() && readFileSync(full).equals(bytes)) continue;
    rmSync(full, { recursive: true, force: true });
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, bytes);
    changed.push(path);
  }
  return changed.sort();
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
  const step = { timeoutMs, ...(opts.stripEnv ? { stripEnv: opts.stripEnv } : {}) };
  const work = snapshotWork(root);
  if (typeof work === 'string') return { gate, status: 'unjudged', reason: work, runs: [] };
  const dirtyBefore = new Set(modifiedTracked(root));
  const result: GateResult = { gate, status: 'judged', runs: [] };
  /** Undoes what a run did to the tree; why the gate cannot be judged when it did anything. */
  const afterRun = (): string | undefined => {
    const lost = restoreWork(root, work);
    const changed = undoTrackedChanges(root, dirtyBefore);
    if (lost.length > 0) {
      return `the step changed files with uncommitted work: ${lost.join(', ')} (restored)`;
    }
    if (changed.length > 0)
      return `the step changed tracked files: ${changed.join(', ')} (restored)`;
    return undefined;
  };

  if (!opts.assumeGreen) {
    const base = await runStep(root, gate, step);
    opts.onProgress?.({ type: 'baseline', gate, result: base });
    result.baseline = {
      exitCode: base.exitCode,
      durationMs: base.durationMs,
      excerpt: excerpt(base.output),
    };
    const touched = afterRun();
    if (touched) return { ...result, status: 'unjudged', reason: touched };
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
        r = await runStep(root, gate, step);
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

      const touched = afterRun();
      if (touched) return { ...result, status: 'unjudged', reason: touched };
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
