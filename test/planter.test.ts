import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { statusPorcelain, trackedFiles } from '../src/core/git';
import type { Marker } from '../src/core/marker';
import type { Fault } from '../src/faults/types';
import {
  PlantError,
  checkPlantable,
  installSignalRevert,
  plant,
  recoverJournal,
} from '../src/plant/planter';
import { makeRepo, type TempRepo } from './helpers/repo';

const marker: Marker = { id: 'abc123', snake: 'falsegreen_abc123', pascal: 'Falsegreenabc123' };

function fault(over: Partial<Fault> = {}): Fault {
  return {
    tool: 'pytest',
    tier: 'semantic',
    marker,
    files: [
      { path: 'tests/test_falsegreen_abc123.py', content: 'def test_x():\n    assert False\n' },
      { path: 'src/falsegreen_abc123.py', content: 'import os\n' },
    ],
    appends: [{ path: 'src/lib.rs', text: '\nmod falsegreen_abc123;\n' }],
    description: 'planted',
    ...over,
  };
}

let repo: TempRepo | undefined;
afterEach(() => {
  repo?.remove();
  repo = undefined;
});

function newRepo(): TempRepo {
  repo = makeRepo({
    'tests/test_a.py': 'def test_a():\n    pass\n',
    'src/app.py': 'x = 1\n',
    'src/lib.rs': 'pub fn f() {}\n',
  });
  return repo;
}

describe('plant and revert', () => {
  it('plants files and appends, then restores the tree byte for byte', () => {
    const r = newRepo();
    const before = readFileSync(join(r.root, 'src/lib.rs'));
    const planted = plant(r.root, fault());
    expect(readFileSync(join(r.root, 'src/lib.rs'), 'utf8')).toContain('mod falsegreen_abc123;');
    expect(existsSync(join(r.root, 'src/falsegreen_abc123.py'))).toBe(true);
    planted.revert();
    expect(statusPorcelain(r.root)).toBe('');
    expect(readFileSync(join(r.root, 'src/lib.rs')).equals(before)).toBe(true);
  });

  it('adds planted files to the index for the run and takes them out again', () => {
    const r = newRepo();
    const planted = plant(r.root, fault());
    expect(trackedFiles(r.root)).toContain('src/falsegreen_abc123.py');
    planted.revert();
    expect(trackedFiles(r.root)).not.toContain('src/falsegreen_abc123.py');
  });

  it('can plant without touching the index', () => {
    const r = newRepo();
    const planted = plant(r.root, fault(), { intentToAdd: false });
    expect(trackedFiles(r.root)).not.toContain('src/falsegreen_abc123.py');
    planted.revert();
    expect(statusPorcelain(r.root)).toBe('');
  });

  it('creates missing directories and removes them afterwards', () => {
    const r = newRepo();
    const planted = plant(
      r.root,
      fault({ files: [{ path: 'crate/tests/falsegreen_abc123.rs', content: 'x' }], appends: [] }),
    );
    expect(existsSync(join(r.root, 'crate/tests'))).toBe(true);
    planted.revert();
    expect(existsSync(join(r.root, 'crate'))).toBe(false);
  });

  it('removes derivative files named after the marker', () => {
    const r = newRepo();
    const planted = plant(r.root, fault());
    mkdirSync(join(r.root, 'tests/__pycache__'), { recursive: true });
    writeFileSync(
      join(r.root, 'tests/__pycache__/test_falsegreen_abc123.cpython-314-pytest-9.0.pyc'),
      '',
    );
    writeFileSync(join(r.root, 'src/Falsegreenabc123.class'), '');
    planted.revert();
    expect(statusPorcelain(r.root)).toBe('');
    expect(
      existsSync(
        join(r.root, 'tests/__pycache__/test_falsegreen_abc123.cpython-314-pytest-9.0.pyc'),
      ),
    ).toBe(false);
  });

  it('fails loudly when something it created cannot be removed', () => {
    const r = newRepo();
    const planted = plant(
      r.root,
      fault({ files: [{ path: 'gen/falsegreen_abc123.py', content: 'x' }], appends: [] }),
    );
    writeFileSync(join(r.root, 'gen/output.log'), 'tool output');
    expect(() => planted.revert()).toThrow(PlantError);
    expect(() => planted.revert()).toThrow(/gen/);
  });
});

describe('checkPlantable', () => {
  it('rejects a path that already exists', () => {
    const r = newRepo();
    expect(
      checkPlantable(r.root, fault({ files: [{ path: 'src/app.py', content: '' }], appends: [] })),
    ).toMatch(/already exists/);
  });

  it('rejects appending to a file with uncommitted changes', () => {
    const r = newRepo();
    r.write('src/lib.rs', 'pub fn g() {}\n');
    expect(checkPlantable(r.root, fault())).toMatch(/src\/lib\.rs has uncommitted changes/);
  });

  it('rejects appending to a file that does not exist, and paths outside the repository', () => {
    const r = newRepo();
    expect(checkPlantable(r.root, fault({ appends: [{ path: 'nope.rs', text: 'x' }] }))).toMatch(
      /nope\.rs/,
    );
    expect(
      checkPlantable(r.root, fault({ files: [{ path: '../escape.py', content: '' }] })),
    ).toMatch(/outside/);
  });

  it('accepts a clean plan', () => {
    expect(checkPlantable(newRepo().root, fault())).toBeUndefined();
  });
});

describe('journal recovery', () => {
  it('restores a run that was killed before it could revert', () => {
    const r = newRepo();
    plant(r.root, fault());
    // No revert: the process "died". The next run finds the journal.
    expect(recoverJournal(r.root)?.sort()).toEqual([
      'src/falsegreen_abc123.py',
      'src/lib.rs',
      'tests/test_falsegreen_abc123.py',
    ]);
    expect(statusPorcelain(r.root)).toBe('');
    expect(recoverJournal(r.root)).toBeUndefined();
  });

  it('refuses to plant while a journal from another run exists', () => {
    const r = newRepo();
    plant(r.root, fault());
    expect(
      checkPlantable(r.root, fault({ files: [{ path: 'b.py', content: '' }], appends: [] })),
    ).toMatch(/journal/);
    recoverJournal(r.root);
  });
});

describe('signal handling', () => {
  it('reverts live plantings on SIGTERM and exits with 143', () => {
    const r = newRepo();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    const uninstall = installSignalRevert();
    try {
      plant(r.root, fault());
      expect(() => process.emit('SIGTERM')).toThrow('exit 143');
      expect(statusPorcelain(r.root)).toBe('');
    } finally {
      uninstall();
      exit.mockRestore();
    }
  });
});
