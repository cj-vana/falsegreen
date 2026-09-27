import { generic } from './generic';
import { GO_TOOLS } from './go';
import { JS_TOOLS } from './js';
import { JVM_TOOLS } from './jvm';
import { PYTHON_TOOLS } from './python';
import { RUST_TOOLS } from './rust';
import type { ToolDef, ToolId } from './types';

const DEFS: ToolDef[] = [
  ...JS_TOOLS,
  ...PYTHON_TOOLS,
  ...GO_TOOLS,
  ...RUST_TOOLS,
  ...JVM_TOOLS,
  generic,
];

const BY_ID = new Map<ToolId, ToolDef>(DEFS.map((d) => [d.id, d]));

export function toolDef(id: ToolId): ToolDef | undefined {
  return BY_ID.get(id);
}

export function registeredTools(): ToolId[] {
  return [...BY_ID.keys()];
}
