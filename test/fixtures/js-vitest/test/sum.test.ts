import { expect, test } from 'vitest';

import { sum } from '../src/sum';

test('sum', () => {
  expect(sum(1, 2)).toBe(3);
});
