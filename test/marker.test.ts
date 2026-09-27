import { describe, expect, it } from 'vitest';

import { newMarker, outputMentions } from '../src/core/marker';

describe('newMarker', () => {
  it('builds a six-hex-digit id with snake and Pascal spellings', () => {
    const m = newMarker(() => 0.5);
    expect(m.id).toMatch(/^[0-9a-f]{6}$/);
    expect(m.snake).toBe(`falsegreen_${m.id}`);
    expect(m.pascal).toBe(`Falsegreen${m.id}`);
  });

  it('differs between calls with the default random source', () => {
    const ids = new Set(Array.from({ length: 20 }, () => newMarker().id));
    expect(ids.size).toBeGreaterThan(15);
  });
});

describe('outputMentions', () => {
  const m = { id: 'abc123', snake: 'falsegreen_abc123', pascal: 'Falsegreenabc123' };

  it('finds the snake spelling inside a path', () => {
    expect(outputMentions('ERROR collecting tests/test_falsegreen_abc123.py', m)).toBe(true);
  });

  it('finds the Pascal spelling in a class name', () => {
    expect(outputMentions('FalsegreenABC123Test > planted() FAILED', m)).toBe(true);
  });

  it('does not match a different id', () => {
    expect(outputMentions('falsegreen_abc124.test.ts', m)).toBe(false);
  });

  it('does not match the bare word', () => {
    expect(outputMentions('falsegreen found 3 gates', m)).toBe(false);
  });
});
