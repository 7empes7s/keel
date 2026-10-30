/**
 * The full ScubaGear v2.0.0 import: every rule of every product, read only from the
 * hash-checked pinned copy, plus the report of what each rule reads and whether Keel
 * reads it. No database and no tenant: everything here reads files in the repo.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WORKLOAD_DESCRIPTORS } from '../../collect/workloadContract.mjs';
import { CATALOG } from '../../../tools/tenant-probe/catalog.mjs';
import {
  DEFAULT_PIN_PATH, PRODUCT_ORDER, RULE_STATES, importScubaGearRules, openPinnedScubaGear, scubaCoverage,
} from './import.mjs';
import { INPUT_STATES, SCUBA_INPUT_SOURCES } from './inputs.mjs';
import { parseRegoFile, regoRuleInputs } from './rego.mjs';
import { renderCoverageMarkdown } from './report.mjs';
import { scubaRuleOutcomes } from './controls.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const imported = importScubaGearRules();
const coverage = scubaCoverage(imported);

// A copy of the pin and its files that a test may damage.
function copyPin() {
  const dir = mkdtempSync(join(tmpdir(), 'keel-scubagear-'));
  cpSync(join(HERE, 'v2.0.0'), join(dir, 'v2.0.0'), { recursive: true });
  cpSync(DEFAULT_PIN_PATH, join(dir, 'pin.json'));
  return { dir, pinPath: join(dir, 'pin.json') };
}
function withCopy(change, check) {
  const copy = copyPin();
  try { change(copy); check(copy); } finally { rmSync(copy.dir, { recursive: true, force: true }); }
}

// ------------------------------------------------------------------ the rule list
test('imports every v2.0.0 rule, counted per product', () => {
  assert.equal(imported.version, '2.0.0');
  assert.equal(imported.commitSha, '6e5a1a421b36c5a1fb3fd983b8c4bcd5b7a6c61d');
  const counts = Object.fromEntries(PRODUCT_ORDER.map((product) => [product, imported.counts[product].rules]));
  assert.deepEqual(counts, { aad: 34, exo: 12, securitysuite: 24, sharepoint: 8, teams: 14, powerplatform: 9, powerbi: 8 });
  assert.equal(imported.total, 109);
  assert.equal(imported.rules.length, 109);
  assert.equal(new Set(imported.rules.map((rule) => rule.id)).size, 109, 'rule ids are unique');
  const shall = imported.rules.filter((rule) => rule.criticality === 'SHALL').length;
  assert.equal(shall, 59);
  assert.equal(109 - shall, 50);
});

test('each rule carries its statement, level, section, NIST mapping and Rego file', () => {
  for (const rule of imported.rules) {
    assert.match(rule.id, new RegExp(`^MS\\.${rule.product === 'aad' ? 'AAD' : rule.product.toUpperCase()}\\.\\d+\\.\\d+v\\d+$`));
    assert.ok(rule.statement.length > 10, `${rule.id} has its statement`);
    assert.ok(rule.title.length > 10, `${rule.id} has its title`);
    assert.ok(['SHALL', 'SHOULD'].includes(rule.criticality));
    assert.ok(Number.isInteger(rule.section) && rule.sectionName, `${rule.id} has its section`);
    assert.ok(rule.nistControlIds.length > 0, `${rule.id} has a NIST mapping`);
    assert.ok(Object.isFrozen(rule));
  }
  const legacy = imported.rules.find((rule) => rule.id === 'MS.AAD.1.1v1');
  assert.equal(legacy.title, 'Legacy authentication SHALL be blocked.');
  assert.equal(legacy.sectionName, 'Legacy Authentication');
  assert.deepEqual(legacy.nistControlIds, ['CM-7']);
  assert.equal(legacy.regoFile, 'Rego/AADConfig.rego');
});

test('rules come in product order, then by number', () => {
  const order = imported.rules.map((rule) => PRODUCT_ORDER.indexOf(rule.product));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test('the eight rules CISA marks as manual are the ones its Rego does not implement', () => {
  assert.deepEqual(imported.rules.filter((rule) => rule.manual).map((rule) => rule.id), [
    'MS.AAD.2.2v1', 'MS.AAD.4.1v1', 'MS.AAD.8.3v1',
    'MS.SECURITYSUITE.3.5v1', 'MS.SECURITYSUITE.4.2v1', 'MS.SECURITYSUITE.5.2v1',
    'MS.POWERPLATFORM.3.2v1', 'MS.POWERPLATFORM.4.1v1',
  ]);
});

test('upstream inconsistencies are listed exactly, so a new one is noticed', () => {
  assert.deepEqual(imported.regoOnly, ['MS.POWERPLATFORM.2.3v1']);
  assert.deepEqual(imported.nistNotInCsv, ['MS.AAD.5.5v1', 'MS.AAD.5.6v1', 'MS.AAD.5.7v1', 'MS.POWERPLATFORM.6.1v1']);
  assert.deepEqual(imported.nistDiffers.map((d) => d.id), ['MS.SECURITYSUITE.1.4v1', 'MS.SECURITYSUITE.2.4v1', 'MS.SECURITYSUITE.3.3v1']);
});

// ------------------------------------------------------------------ the pin
test('every pinned file matches MANIFEST.sha256, and the manifest matches pin.json', () => {
  const source = openPinnedScubaGear();
  assert.equal(source.verifyAll(), 24);
  const pin = JSON.parse(readFileSync(DEFAULT_PIN_PATH, 'utf8'));
  assert.equal(pin.tag, 'v2.0.0');
  assert.match(pin.licensing.status, /public domain/i);
  for (const product of PRODUCT_ORDER) {
    assert.ok(source.files.includes(`./${pin.products[product].rego}`));
    assert.ok(source.files.includes(`./${pin.products[product].baseline}`));
  }
  assert.ok(source.files.includes('./LICENSE'));
});

test('refuses a pinned file whose bytes changed', () => {
  withCopy(({ dir }) => {
    const path = join(dir, 'v2.0.0', 'Rego', 'EXOConfig.rego');
    writeFileSync(path, `${readFileSync(path, 'utf8')}\n# changed\n`);
  }, ({ pinPath }) => assert.throws(() => importScubaGearRules({ pinPath }), /hash mismatch for \.\/Rego\/EXOConfig\.rego/));
});

test('refuses a manifest edited to match changed bytes', () => {
  withCopy(({ dir }) => {
    const path = join(dir, 'v2.0.0', 'MANIFEST.sha256');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^[0-9a-f]{64}/, '0'.repeat(64)));
  }, ({ pinPath }) => assert.throws(() => importScubaGearRules({ pinPath }), /does not match the hash in pin\.json/));
});

test('refuses a file the manifest does not list', () => {
  withCopy(({ dir }) => writeFileSync(join(dir, 'v2.0.0', 'Rego', 'Extra.rego'), 'package extra\n'),
    ({ pinPath }) => assert.throws(() => importScubaGearRules({ pinPath }), /not in MANIFEST\.sha256: \.\/Rego\/Extra\.rego/));
});

test('refuses a pin that is not the public-domain grant', () => {
  withCopy(({ pinPath }) => {
    const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
    writeFileSync(pinPath, JSON.stringify({ ...pin, licensing: { ...pin.licensing, status: 'proprietary' } }));
  }, ({ pinPath }) => assert.throws(() => importScubaGearRules({ pinPath }), /public-domain/));
});

// ------------------------------------------------------------------ reading the Rego
test('a rule reads the keys of the helpers it calls, through imports and object.get paths', () => {
  const util = {
    file: 'util.rego',
    source: [
      'package utils.lib',
      'import rego.v1',
      '',
      '# input.not_a_read in a comment does not count',
      'Licensed if {',
      '    some sku in input.service_plans',
      '    sku.Name == "P2"',
      '}',
      '',
      'Excluded(Id) := object.get(input, ["scuba_config", "Aad", Id], [])',
    ].join('\n'),
  };
  const product = {
    file: 'product.rego',
    source: [
      'package product',
      'import rego.v1',
      'import data.utils.lib.Licensed',
      'import data.utils.lib.Excluded',
      '',
      'Policies contains P if {',
      '    some P in input.conditional_access_policies',
      '    count(Excluded("x")) == 0',
      '}',
      '',
      'Unused contains D if { some D in input["dkim_config"] }',
      '',
      'tests contains {',
      '    "PolicyId" : PolicyId,',
      '    "Criticality": "Shall",',
      '    "ReportDetails": "input JSON text is not a read",',
      '    "RequirementMet": count(Policies) > 0',
      '} if {',
      '    PolicyId := "MS.TEST.1.1v1"',
      '    Licensed',
      '}',
      '',
      'tests contains {',
      '    "PolicyId": "MS.TEST.2.1v1",',
      '    "Criticality": "Should/Not-Implemented",',
      '    "RequirementMet": false',
      '} if {',
      '    true',
      '} else := {} if { false }',
    ].join('\n'),
  };
  const rules = regoRuleInputs([product, util]);
  assert.deepEqual([...rules.keys()], ['MS.TEST.1.1v1', 'MS.TEST.2.1v1']);
  assert.deepEqual([...rules.get('MS.TEST.1.1v1').inputs].sort(), ['conditional_access_policies', 'scuba_config', 'service_plans']);
  assert.deepEqual([...rules.get('MS.TEST.2.1v1').inputs], []);
  assert.deepEqual([...rules.get('MS.TEST.2.1v1').criticalities], ['Should/Not-Implemented']);
});

test('a body whose `if {` starts its own line still belongs to its rule', () => {
  const rules = regoRuleInputs([{ file: 'p.rego', source: [
    'package p',
    'tests contains {',
    '    "PolicyId": "MS.TEST.3.1v1",',
    '    "Criticality": "Shall"',
    '}',
    'if {',
    '    some x in input.split_body_key',
    '}',
  ].join('\n') }]);
  assert.deepEqual([...rules.get('MS.TEST.3.1v1').inputs], ['split_body_key']);
  assert.throws(() => parseRegoFile('package p\nsome := 1\n'), /starts with the keyword/);
});

test('a rule that reads the whole input document is refused, not under-reported', () => {
  assert.throws(() => parseRegoFile('package p\nAll := input\n'), /other than by a named key/);
  assert.throws(() => parseRegoFile('package p\nKeys := object.keys(input)\n'), /other than by a named key/);
});

test('a tests statement must name exactly one rule id and a criticality', () => {
  assert.throws(() => parseRegoFile('package p\ntests contains {"Criticality": "Shall"} if { true }\n'), /names 0 rule ids/);
  assert.throws(() => parseRegoFile('package p\ntests contains {"PolicyId": "MS.X.1.1v1"} if { true }\n'), /no Criticality/);
});

// ------------------------------------------------------------------ inputs and Keel's reads
test('every input a rule reads has a source entry, and every entry is read by some rule', () => {
  const read = new Set(imported.rules.flatMap((rule) => rule.inputs));
  assert.deepEqual([...read].filter((key) => !SCUBA_INPUT_SOURCES[key]), []);
  assert.deepEqual(Object.keys(SCUBA_INPUT_SOURCES).filter((key) => !read.has(key)), []);
});

test('every Keel read named in the source table exists', () => {
  const descriptorIds = new Set(WORKLOAD_DESCRIPTORS.map((descriptor) => descriptor.id));
  const graphTypes = new Set(CATALOG.map((entry) => entry.type));
  for (const [key, source] of Object.entries(SCUBA_INPUT_SOURCES)) {
    assert.ok(INPUT_STATES.includes(source.state), `${key} has a known state`);
    for (const read of source.keel) {
      if (read.startsWith('graph:')) assert.ok(graphTypes.has(read.slice(6)), `${key}: ${read} is a catalog type`);
      else assert.ok(descriptorIds.has(read), `${key}: ${read} is a workload descriptor`);
    }
    if (['read', 'partial'].includes(source.state)) assert.ok(source.keel.length > 0, `${key} names the Keel read`);
    if (source.state === 'not-read') {
      assert.equal(source.keel.length, 0, `${key} names no Keel read`);
      assert.ok(source.note, `${key} says why Keel does not read it`);
    }
  }
});

test('coverage gives every rule one state and the states add up', () => {
  assert.equal(coverage.total, 109);
  assert.equal(RULE_STATES.reduce((sum, state) => sum + coverage.summary[state], 0), 109);
  assert.deepEqual(coverage.summary, { ready: 73, partial: 8, 'missing-input': 20, manual: 8 });
  for (const product of PRODUCT_ORDER) {
    assert.equal(RULE_STATES.reduce((sum, state) => sum + coverage.perProduct[product][state], 0), imported.counts[product].rules);
  }
  const state = (id) => coverage.rules.find((rule) => rule.id === id).state;
  assert.equal(state('MS.AAD.1.1v1'), 'ready');
  assert.equal(state('MS.EXO.4.1v1'), 'missing-input');
  assert.equal(state('MS.SECURITYSUITE.4.1v1'), 'ready'); // the alert policies are read
  assert.equal(state('MS.SHAREPOINT.1.1v1'), 'partial');
  assert.equal(state('MS.AAD.4.1v1'), 'manual');
  // Run settings never block a rule: 1.1 reads scuba_config and is still ready.
  assert.ok(coverage.rules.find((rule) => rule.id === 'MS.AAD.1.1v1').inputs.some((input) => input.state === 'run-setting'));
});

test('the missing-input list names each input Keel lacks with the rules it blocks', () => {
  const dmarc = coverage.missingInputs.find((missing) => missing.key === 'dmarc_records');
  assert.deepEqual(dmarc.rules, ['MS.EXO.4.1v1', 'MS.EXO.4.2v1', 'MS.EXO.4.3v1', 'MS.EXO.4.4v1']);
  const blocked = new Set(coverage.missingInputs.flatMap((missing) => missing.rules));
  assert.equal(blocked.size, coverage.summary['missing-input']);
});

// ------------------------------------------------------------------ the report and the CLI
test('the checked-in coverage report matches the generator', () => {
  const path = join(ROOT, 'docs', 'roadmap', 'benchmark-content', 'scubagear-coverage.md');
  assert.equal(readFileSync(path, 'utf8'), renderCoverageMarkdown(imported, coverage, scubaRuleOutcomes({ imported })),
    'regenerate with: node tools/scubagear-rules.mjs report --write');
});

test('the CLI prints the count per product and refuses unknown arguments', () => {
  const cli = join(ROOT, 'tools', 'scubagear-rules.mjs');
  const summary = spawnSync(process.execPath, [cli], { encoding: 'utf8' });
  assert.equal(summary.status, 0, summary.stderr);
  assert.match(summary.stdout, /ScubaGear 2\.0\.0 \(6e5a1a4\): 109 rules/);
  assert.match(summary.stdout, /Entra ID\s+34 rules/);
  assert.match(summary.stdout, /Power BI\s+8 rules/);
  const json = spawnSync(process.execPath, [cli, 'json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(JSON.parse(json.stdout).rules.length, 109);
  assert.equal(spawnSync(process.execPath, [cli, 'summary', '--write'], { encoding: 'utf8' }).status, 2);
  assert.equal(spawnSync(process.execPath, [cli, 'nope'], { encoding: 'utf8' }).status, 2);
});
