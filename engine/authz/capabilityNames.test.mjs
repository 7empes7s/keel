import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { CAPABILITIES, ROLE_CAPABILITIES, WAVE2_CAPABILITIES } from './permissions.mjs';

// Which role grants what is asserted in permissions.test.mjs; this checks the names.
test('every granted and every Wave 2 capability is a known name', () => {
  assert.deepEqual([...WAVE2_CAPABILITIES].sort(), [
    'automation', 'content-backup', 'content-restore', 'discover', 'export', 'template-apply',
  ]);
  for (const name of [...Object.values(ROLE_CAPABILITIES).flat(), ...WAVE2_CAPABILITIES]) {
    assert.ok(CAPABILITIES.includes(name), name);
  }
  assert.equal(new Set(CAPABILITIES).size, CAPABILITIES.length);
});
