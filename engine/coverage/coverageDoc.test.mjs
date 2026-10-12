import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { WORKLOAD_DESCRIPTORS } from '../collect/workloadContract.mjs';
import { TYPE_GUIDE, WORKLOAD_GUIDE, renderCoverageDoc } from './coverageDoc.mjs';
import { TYPE_DECISIONS, buildOperationLedger } from './qualification.mjs';

const DOC = fileURLToPath(new URL('../../docs/coverage.md', import.meta.url));
const TOOL = fileURLToPath(new URL('../../tools/coverage-doc.mjs', import.meta.url));

test('docs/coverage.md is the generator output for the current code (run node tools/coverage-doc.mjs)', () => {
  const committed = readFileSync(DOC, 'utf8');
  assert.equal(committed, renderCoverageDoc(),
    'docs/coverage.md is out of date with TYPE_DECISIONS, capabilities or the workload contract: run node tools/coverage-doc.mjs and commit the result');
});

test('the generator is deterministic', () => {
  assert.equal(renderCoverageDoc(), renderCoverageDoc());
});

test('the --check mode passes on the committed file', () => {
  const result = spawnSync(process.execPath, [TOOL, '--check'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('every configuration type has plain-English text written for its current decision', () => {
  const ledger = buildOperationLedger();
  for (const row of ledger.types) {
    const entry = TYPE_GUIDE[row.resourceType];
    assert.ok(entry, `${row.resourceType} has no entry`);
    assert.equal(entry.decision, row.decision, `${row.resourceType} text was written for another decision`);
    if (row.decision === 'automated') assert.ok(entry.keeps, `${row.resourceType} says what a restore covers`);
    else assert.ok(entry.why && entry.todo, `${row.resourceType} says why and what the reader does`);
  }
});

test('a changed decision or a missing entry stops generation', () => {
  const flipped = { ...TYPE_GUIDE, domain: { ...TYPE_GUIDE.domain, decision: 'automated', keeps: 'x' } };
  assert.throws(() => renderCoverageDoc({ typeGuide: flipped }), /domain.*written for 'automated'.*now says 'manual'/);
  const { domain, ...missing } = TYPE_GUIDE;
  assert.ok(domain);
  assert.throws(() => renderCoverageDoc({ typeGuide: missing }), /no plain-English entry for configuration type domain/);
  assert.throws(() => renderCoverageDoc({ typeGuide: { ...TYPE_GUIDE, gone: TYPE_GUIDE.domain } }), /no longer has: gone/);
  const { 'purview-labels': labels, ...noWorkload } = WORKLOAD_GUIDE;
  assert.ok(labels);
  assert.throws(() => renderCoverageDoc({ workloadGuide: noWorkload }), /no plain-English entry for workload purview-labels/);
});

test('every type and workload read appears, with live failures dated', () => {
  const doc = renderCoverageDoc();
  for (const entry of Object.values(TYPE_GUIDE)) assert.ok(doc.includes(`| ${entry.name} |`), `${entry.name} row`);
  for (const read of WORKLOAD_DESCRIPTORS) assert.ok(doc.includes(`- ${read.resource}`), `${read.resource} listed`);
  for (const [type, decision] of Object.entries(TYPE_DECISIONS)) {
    for (const failure of Object.values(decision.liveFailures ?? {})) {
      const line = doc.split('\n').find((candidate) => candidate.startsWith(`| ${TYPE_GUIDE[type].name} |`));
      assert.match(line, new RegExp(`failed on ${failure.failedAt}`), `${type} live failure shown`);
    }
  }
});

test('plain English: no raw type ids, task numbers or banned vocabulary', () => {
  const doc = renderCoverageDoc().replace(/<!--[\s\S]*?-->/g, '');
  for (const type of Object.keys(TYPE_DECISIONS)) {
    if (/[A-Z]/.test(type)) assert.ok(!new RegExp(`\\b${type}\\b`).test(doc), `raw type id ${type}`);
  }
  for (const pattern of [/\btask-\d+/i, /\bissue[- ]?#?\d+/i, /#\d+/, /\bHTTP \d{3}/, /\bGraph\b/, /\bPATCH\b|\bPOST\b/]) {
    assert.ok(!pattern.test(doc), `found ${pattern}`);
  }
  // docs/roadmap/portal-experience.md, Vocabulary.
  for (const word of ['natural key', 'fidelity', 'qualified', 'qualification', 'fixture-tested', 'catalog type', 'blast radius', 'descriptor', 'adapter', 'projection', 'tenant_ref']) {
    assert.ok(!new RegExp(`\\b${word}\\b`, 'i').test(doc), `banned word "${word}"`);
  }
});
