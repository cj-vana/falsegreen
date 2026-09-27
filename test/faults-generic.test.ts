import { afterEach, describe, expect, it } from 'vitest';

import { trackedFiles } from '../src/core/git';
import type { Marker } from '../src/core/marker';
import { generic } from '../src/faults/generic';
import type { Fault, FaultContext } from '../src/faults/types';
import { makeRepo, type TempRepo } from './helpers/repo';

const m: Marker = { id: 'abc123', snake: 'falsegreen_abc123', pascal: 'Falsegreenabc123' };

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.remove();
  repo = undefined;
});

function ctx(files: Record<string, string>, cwd = ''): FaultContext {
  repo = makeRepo(files);
  return {
    root: repo.root,
    tracked: trackedFiles(repo.root),
    invocation: { tool: 'generic', argv: ['./check'], cwd, pathArgs: [], via: [] },
    marker: m,
    read: () => '',
  };
}

describe('generic fault', () => {
  it('supports only the reach tier', () => {
    expect(generic.tiers).toEqual(['reach']);
  });

  it('plants an unparseable file in the most common language under the working directory', () => {
    const f = generic.faults(
      ctx({ 'app/a.py': '', 'app/b.py': '', 'app/c.py': '', 'web/x.ts': '', 'README.md': '' }),
      'reach',
    ) as Fault;
    expect(f.files).toEqual([
      { path: 'app/falsegreen_abc123.py', content: 'def falsegreen_abc123(:\n' },
    ]);
  });

  it('stays inside the working directory', () => {
    const f = generic.faults(
      ctx({ 'app/a.py': '', 'app/b.py': '', 'web/x.ts': '' }, 'web'),
      'reach',
    ) as Fault;
    expect(f.files[0]!.path).toBe('web/falsegreen_abc123.ts');
  });

  it('names Java classes after the file', () => {
    const f = generic.faults(ctx({ 'src/main/java/a/App.java': '' }), 'reach') as Fault;
    expect(f.files[0]).toEqual({
      path: 'src/main/java/a/Falsegreenabc123.java',
      content: 'class Falsegreenabc123 {\n',
    });
  });

  it('skips when no source file it knows is tracked', () => {
    expect(generic.faults(ctx({ 'README.md': '', 'data.csv': '' }), 'reach')).toEqual({
      skip: 'no source files in a language falsegreen can break',
    });
  });
});
