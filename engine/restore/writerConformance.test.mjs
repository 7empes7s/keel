import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { GraphWriter } from './graphWriter.mjs';

const applyEngine = readFileSync(new URL('./applyEngine.mjs', import.meta.url), 'utf8');
const calledMethods = [...new Set(
  [...applyEngine.matchAll(/\bwriter\.([A-Za-z_$][\w$]*)\s*\(/g)].map((match) => match[1]),
)];
const missingMethods = calledMethods.filter((method) => typeof GraphWriter.prototype[method] !== 'function');

assert.deepEqual(
  missingMethods,
  [],
  `GraphWriter is missing methods called by applyEngine: ${missingMethods.join(', ')}`,
);

console.log('writerConformance.test.mjs — all assertions passed');
