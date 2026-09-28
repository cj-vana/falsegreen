/** `falsegreen list`: every gate and the faults it would get. Plants nothing. */
import { trackedFiles } from '../core/git';
import { newMarker } from '../core/marker';
import { TIERS } from '../core/types';
import { toolDef } from '../faults/registry';
import { faultContext, refusal } from '../local/replay';
import { load, type IO, type Selection } from './common';

export function listCommand(sel: Selection, io: IO): number {
  const { root, cfg, gates } = load(sel, io, { restore: false });
  const tracked = trackedFiles(root);
  if (gates.length === 0) io.out('no gates found\n');
  for (const gate of gates) {
    io.out(`${gate.workflow} > ${gate.checkName} > ${gate.stepName} (line ${gate.loc.line})\n`);
    const refused = refusal(gate);
    if (refused) io.out(`  not replayed locally: ${refused}\n`);
    for (const inv of gate.invocations) {
      io.out(`  ${inv.tool} via ${inv.via.join(' > ')}\n`);
      const def = toolDef(inv.tool);
      for (const tier of TIERS.filter((t) => !def?.tiers || def.tiers.includes(t))) {
        const fault = def?.faults(faultContext(root, tracked, inv, newMarker(), cfg), tier);
        const text = !fault
          ? `no faults for ${inv.tool}`
          : 'skip' in fault
            ? `skipped (${fault.skip})`
            : fault.description;
        io.out(`    ${tier}: ${text}\n`);
      }
    }
  }
  return 0;
}
