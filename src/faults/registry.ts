import { vitest } from './js';
import type { ToolDef, ToolId } from './types';

const DEFS: ToolDef[] = [vitest];

const BY_ID = new Map<ToolId, ToolDef>(DEFS.map((d) => [d.id, d]));

export function toolDef(id: ToolId): ToolDef | undefined {
  return BY_ID.get(id);
}

export function registeredTools(): ToolId[] {
  return [...BY_ID.keys()];
}
