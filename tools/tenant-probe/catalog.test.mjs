import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { CATALOG } from './catalog.mjs';

const DIR = new URL('./catalog.d/', import.meta.url);

test('every catalog.d family is part of CATALOG, in import order', async () => {
  const source = readFileSync(new URL('./catalog.mjs', import.meta.url), 'utf8');
  const imported = [...source.matchAll(/from '\.\/catalog\.d\/([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...imported].sort(), readdirSync(DIR).filter((name) => name.endsWith('.mjs')).sort(),
    'each catalog.d file is imported by catalog.mjs');
  const families = await Promise.all(imported.map(async (name) => (await import(new URL(name, DIR))).default));
  assert.deepEqual(CATALOG, families.flat());
});

test('catalogue types are unique across families', () => {
  const types = CATALOG.map((entry) => entry.type);
  assert.equal(new Set(types).size, types.length);
});
