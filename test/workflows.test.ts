import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseWorkflow } from '../src/workflow/parse';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (file: string): string =>
  readFileSync(join(root, '.github', 'workflows', file), 'utf8');

describe('workflow token permissions', () => {
  it.each(['ci.yml', 'dogfood.yml', 'release.yml'])(
    '%s gives GITHUB_TOKEN read-only contents',
    (file) => {
      expect(read(file)).toMatch(/^permissions:\n {2}contents: read\n(?! )/m);
    },
  );
});

describe('release workflow', () => {
  const wf = parseWorkflow('.github/workflows/release.yml', read('release.yml'), root);
  const job = (id: string) => wf.jobs.find((j) => j.id === id)!;

  it('publishes only after every gate passes, and moves the major tag only after publishing', () => {
    // `uses: cj-vana/falsegreen@v0` installs the version in package.json, so the tag must not
    // reach a version npm does not have yet.
    expect(job('publish').needs).toEqual(['gate']);
    expect(job('release').needs).toEqual(['publish']);
  });

  it('runs on version tags only, never on the major tags it moves', () => {
    expect(wf.triggers.push).toEqual({ tags: ['v[0-9]+.[0-9]+.[0-9]+'] });
  });
});
