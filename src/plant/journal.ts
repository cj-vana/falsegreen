/**
 * The journal records every change a planting is about to make, on disk and fsynced, before the
 * first change happens. A run that dies mid-planting (SIGKILL, a crash, a closed laptop) leaves
 * the journal behind, and the next run restores the tree from it before doing anything else.
 * It lives inside the git directory, where no check tool looks and nothing gets committed.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import { gitDir } from '../core/git';

export interface Journal {
  version: 1;
  markerId: string;
  /** Files the planting creates, repo-relative. */
  created: string[];
  /** Directories the planting creates, shallowest first. */
  createdDirs: string[];
  /** Files the planting appends to, with their original bytes (base64). */
  appended: { path: string; original: string }[];
  /** Paths added to the index with --intent-to-add. */
  intentToAdd: string[];
}

export function journalPath(root: string): string {
  return join(gitDir(root), 'falsegreen-journal.json');
}

export function writeJournal(root: string, journal: Journal): void {
  const fd = openSync(journalPath(root), 'w');
  try {
    writeSync(fd, JSON.stringify(journal));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function readJournal(root: string): Journal | undefined {
  const file = journalPath(root);
  if (!existsSync(file)) return undefined;
  return JSON.parse(readFileSync(file, 'utf8')) as Journal;
}

export function removeJournal(root: string): void {
  rmSync(journalPath(root), { force: true });
}
