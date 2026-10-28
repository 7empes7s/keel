import assert from 'node:assert/strict';
import { test } from 'node:test';

import { csvCell, csvLine } from './csv.mjs';

test('engine CSV cells neutralise text a spreadsheet would run as a formula', () => {
  for (const text of ['=1+1', '+1', '-1+1', '@SUM(1,1)', '\t=1', '\r=1']) assert.ok(csvCell(text).replace(/^"/, '').startsWith(`'${text[0]}`), JSON.stringify(text));
  assert.equal(csvCell(-2), '-2');
  assert.equal(csvCell(['a', 'b']), 'a b');
  assert.equal(csvLine(['outcome', '=x', 3]), "outcome,'=x,3");
});
