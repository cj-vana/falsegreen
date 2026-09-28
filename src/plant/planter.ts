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
import { hostname } from 'node:os';
import { isAbsolute, join, posix } from 'node:path';

import { addIntentToAdd, isModified, resetPaths, statusPorcelain } from '../core/git';
import { stopLiveGroups } from '../core/proc';
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

/**
 * Takes the appended text out of a file without touching anything else in it. The file was clean
 * when the text went in, but the user may have edited it since (after a crash, or during a long
 * run), so the original bytes are written back only when nothing but the text changed.
 */
function undoAppend(root: string, entry: Journal['appended'][number]): void {
  const full = join(root, entry.path);
  if (!existsSync(full)) return;
  const original = Buffer.from(entry.original, 'base64');
  // Journals written before the text was recorded can only be restored byte for byte.
  if (entry.text === undefined) return writeFileSync(full, original);
  const current = readFileSync(full);
  if (current.equals(Buffer.concat([original, Buffer.from(entry.text)]))) {
    return writeFileSync(full, original);
  }
  const text = current.toString('utf8');
  const at = text.lastIndexOf(entry.text);
  if (at >= 0) writeFileSync(full, text.slice(0, at) + text.slice(at + entry.text.length));
}

/** True once nothing falsegreen put in the tree is left: planted files gone, appended text gone. */
function undone(root: string, journal: Journal): boolean {
  return (
    journal.created.every((path) => !existsSync(join(root, path))) &&
    journal.appended.every(
      (a) =>
        a.text === undefined ||
        !existsSync(join(root, a.path)) ||
        !readFileSync(join(root, a.path), 'utf8').includes(a.text),
    )
  );
}

function restore(root: string, journal: Journal): void {
  const problems: string[] = [];
  try {
    resetPaths(root, journal.intentToAdd);
  } catch (err) {
    problems.push((err as Error).message);
  }
  for (const path of journal.created) rmSync(join(root, path), { force: true });
  for (const entry of journal.appended) undoAppend(root, entry);
  removeDerivatives(root, journal);
  for (const dir of [...journal.createdDirs].reverse()) {
    const full = join(root, dir);
    if (!existsSync(full)) continue;
    const left = readdirSync(full);
    if (left.length > 0)
      problems.push(`could not remove ${dir}/: it now contains ${left.join(', ')}`);
    else rmdirSync(full);
  }
  // The journal goes only once falsegreen's own changes are gone; otherwise it stays, so the
  // next run or `falsegreen clean` still knows what to take out.
  if (undone(root, journal)) removeJournal(root);
  else problems.push('the journal was kept in .git so `falsegreen clean` can try again');

  // An appended file the user edited since stays modified, with their edits; only files that are
  // back to their original bytes should look clean to git.
  const pristine = journal.appended.filter(
    (a) =>
      existsSync(join(root, a.path)) &&
      readFileSync(join(root, a.path)).equals(Buffer.from(a.original, 'base64')),
  );
  const touched = [...journal.created, ...pristine.map((a) => a.path), ...journal.createdDirs];
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
    version: 2,
    markerId: fault.marker.id,
    owner: { pid: process.pid, host: hostname() },
    created,
    createdDirs: missingDirs(root, created),
    appended: fault.appends.map((a) => ({
      path: a.path,
      original: readFileSync(join(root, a.path)).toString('base64'),
      text: a.text,
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

/** The pid of another falsegreen process on this machine that owns the journal and still runs. */
function liveOwner(journal: Journal): number | undefined {
  const owner = journal.owner;
  // A journal with this process's pid was left by an earlier process that had the same pid.
  if (!owner || owner.host !== hostname() || owner.pid === process.pid) return undefined;
  try {
    process.kill(owner.pid, 0);
    return owner.pid;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM' ? owner.pid : undefined;
  }
}

/**
 * Restores the tree from a journal left by a run that died; the restored paths, if any. A journal
 * whose run is still alive is left alone unless `force` is set.
 */
export function recoverJournal(root: string, opts: { force?: boolean } = {}): string[] | undefined {
  const journal = readJournal(root);
  if (!journal) return undefined;
  const owner = liveOwner(journal);
  if (owner !== undefined && opts.force !== true) {
    throw new PlantError(
      `another falsegreen run (pid ${owner}) is planting faults in this repository; wait for it to finish, or stop it and run \`falsegreen clean\``,
    );
  }
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
      // The step goes first: left running, it would carry on against the restored tree.
      stopLiveGroups();
      revertAll();
      process.exit(SIGNAL_EXIT[signal]);
    };
    process.on(signal, handler);
    return () => process.off(signal, handler);
  });
  return () => offs.forEach((off) => off());
}
