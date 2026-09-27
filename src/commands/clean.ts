/** `falsegreen clean`: restore anything an interrupted run left behind. */
import { recoverJournal } from '../plant/planter';
import { findRoot, type IO } from './common';

export function cleanCommand(cwd: string, io: IO): number {
  const restored = recoverJournal(findRoot(cwd));
  io.out(restored ? `restored: ${restored.join(', ')}\n` : 'nothing to restore\n');
  return 0;
}
