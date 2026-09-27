/** Read from package.json at runtime so it cannot drift. `../package.json` resolves from both
 *  src (tests) and dist (the published build). */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

const requireFromHere = createRequire(import.meta.url);
const pkg = requireFromHere('../package.json') as { version: string };

export const version: string = pkg.version;

/** Directory of the running falsegreen package (where its package.json is). */
export const packageRoot: string = dirname(requireFromHere.resolve('../package.json'));
