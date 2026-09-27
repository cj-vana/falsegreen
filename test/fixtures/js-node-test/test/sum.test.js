import assert from 'node:assert';
import test from 'node:test';

import { sum } from '../src/sum.js';

test('sum', () => {
  assert.strictEqual(sum(1, 2), 3);
});
