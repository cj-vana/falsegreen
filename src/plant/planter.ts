/**
 * Plants a fault in the working tree and guarantees it comes out again. Only additive changes are
 * made (new files, and text appended to unmodified tracked files), every change is journaled first,
 * and a revert that cannot restore the tree exactly throws instead of reporting success.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';

import { addIntentToAdd, isModified, resetPaths, statusPorcelain } from '../core/git';
import type { Fault } from '../faults/types';
import { journalPath, readJournal, removeJournal, writeJournal, type Journal } from './journal';

export class PlantError extends Error {}

export interface Planted {
  revert(): void;
}

const live = new Set<Planted>();

function outside(path: string): boolean {
  return isAbsolute(path) || posix.normalize(path).startsWith('..');
}

/** Why the fault cannot be planted in this tree, or undefined when it can. */
export function checkPlantable(root: string, fault: Fault): string | undefined {
  if (existsSync(journalPath(root))) {
    return 'a journal from an earlier falsegreen run is still in .git; run `falsegreen clean` first';
  }
  for (const file of fault.files) {
    if (outside(file.path)) return `${file.path} is outside the repository`;
    if (existsSync(join(root, file.path))) return `${file.path} already exists`;
  }
  for (const append of fault.appends) {
    if (outside(append.path)) return `${append.path} is outside the repository`;
    if (!existsSync(join(root, append.path))) return `${append.path} does not exist`;
    if (isModified(root, append.path)) return `${append.path} has uncommitted changes`;
  }
  return undefined;
}

/** Directories that do not exist yet on the way to each file, shallowest first. */
function missingDirs(root: string, files: string[]): string[] {
  const dirs: string[] = [];
  for (const file of files) {
    const parts = posix
      .dirname(file)
      .split('/')
      .filter((p) => p !== '.' && p !== '');
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!dirs.includes(dir) && !existsSync(join(root, dir))) dirs.push(dir);
    }
  }
  return dirs;
}

function removeDerivatives(root: string, journal: Journal): void {
  const named = new RegExp(`falsegreen_?${journal.markerId}`, 'i');
  const dirs = new Set(
    [...journal.created, ...journal.appended.map((a) => a.path)].map((p) => posix.dirname(p)),
  );
  for (const dir of dirs) {
    for (const base of [join(root, dir), join(root, dir, '__pycache__')]) {
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) {
        const path = join(base, entry);
        if (named.test(entry) && statSync(path).isFile()) rmSync(path, { force: true });
      }
    }
  }
}

function restore(root: string, journal: Journal): void {
  const problems: string[] = [];
  try {
    resetPaths(root, journal.intentToAdd);
  } catch (err) {
    problems.push((err as Error).message);
  }
  for (const path of journal.created) rmSync(join(root, path), { force: true });
  for (const { path, original } of journal.appended) {
    writeFileSync(join(root, path), Buffer.from(original, 'base64'));
  }
  removeDerivatives(root, journal);
  for (const dir of [...journal.createdDirs].reverse()) {
    const full = join(root, dir);
    if (!existsSync(full)) continue;
    const left = readdirSync(full);
    if (left.length > 0)
      problems.push(`could not remove ${dir}/: it now contains ${left.join(', ')}`);
    else rmdirSync(full);
  }
  removeJournal(root);

  const touched = [
    ...journal.created,
    ...journal.appended.map((a) => a.path),
    ...journal.createdDirs,
  ];
  const status = statusPorcelain(root, touched).trim();
  if (status !== '') problems.push(`git status still shows: ${status.replace(/\n/g, ', ')}`);
  if (problems.length > 0) {
    throw new PlantError(`the tree was not fully restored: ${problems.join('; ')}`);
  }
}

export function plant(root: string, fault: Fault, opts: { intentToAdd?: boolean } = {}): Planted {
  const reason = checkPlantable(root, fault);
  if (reason) throw new PlantError(reason);

  const created = fault.files.map((f) => f.path);
  const journal: Journal = {
    version: 1,
    markerId: fault.marker.id,
    created,
    createdDirs: missingDirs(root, created),
    appended: fault.appends.map((a) => ({
      path: a.path,
      original: readFileSync(join(root, a.path)).toString('base64'),
    })),
    intentToAdd: (opts.intentToAdd ?? true) ? created : [],
  };
  writeJournal(root, journal);

  try {
    for (const dir of journal.createdDirs) mkdirSync(join(root, dir));
    for (const file of fault.files)
      writeFileSync(join(root, file.path), file.content, { flag: 'wx' });
    for (const append of fault.appends) appendFileSync(join(root, append.path), append.text);
    addIntentToAdd(root, journal.intentToAdd);
  } catch (err) {
    restore(root, journal);
    throw new PlantError(`planting failed and was undone: ${(err as Error).message}`);
  }

  const planted: Planted = {
    revert() {
      live.delete(planted);
      restore(root, journal);
    },
  };
  live.add(planted);
  return planted;
}

/** Restores the tree from a journal left by a run that died; the restored paths, if any. */
export function recoverJournal(root: string): string[] | undefined {
  const journal = readJournal(root);
  if (!journal) return undefined;
  restore(root, journal);
  return [...journal.created, ...journal.appended.map((a) => a.path)];
}

/** Reverts every live planting. Used by signal handlers; errors are swallowed so all get a try. */
export function revertAll(): void {
  for (const planted of [...live]) {
    try {
      planted.revert();
    } catch {
      // The journal is gone either way; the next run's status check reports what is left.
    }
  }
}

const SIGNAL_EXIT: Record<'SIGINT' | 'SIGTERM' | 'SIGHUP', number> = {
  SIGINT: 130,
  SIGTERM: 143,
  SIGHUP: 129,
};

/** Reverts live plantings when the process is interrupted; returns a function that uninstalls. */
export function installSignalRevert(): () => void {
  const offs = (Object.keys(SIGNAL_EXIT) as (keyof typeof SIGNAL_EXIT)[]).map((signal) => {
    const handler = (): void => {
      revertAll();
      process.exit(SIGNAL_EXIT[signal]);
    };
    process.on(signal, handler);
    return () => process.off(signal, handler);
  });
  return () => offs.forEach((off) => off());
}
