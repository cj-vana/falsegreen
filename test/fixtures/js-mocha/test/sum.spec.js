import assert from 'node:assert';

import { sum } from '../src/sum.js';

it('sum', () => {
  assert.strictEqual(sum(1, 2), 3);
});
