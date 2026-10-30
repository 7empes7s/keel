#!/usr/bin/env node
/**
 * The pinned CISA ScubaGear rule set and what Keel can check of it.
 *
 *   node tools/scubagear-rules.mjs                 # rule count per product, and coverage
 *   node tools/scubagear-rules.mjs json            # every rule with its inputs, as JSON
 *   node tools/scubagear-rules.mjs report          # the coverage report as Markdown
 *   node tools/scubagear-rules.mjs report --write  # rewrite docs/roadmap/benchmark-content/scubagear-coverage.md
 *   node tools/scubagear-rules.mjs build-wasm      # recompile the Rego to engine/benchmarks/scubagear/build/
 *                                                 # and record OPA's own answers for the fixture tenant
 *
 * Every pinned file is checked against its SHA-256 first; a mismatch exits non-zero.
 * Read-only: nothing here touches a tenant.
 *
 * build-wasm downloads the OPA release ScubaGear v2.0.0 itself runs with (its
 * ScubaConfigDefaults.json OPAVersion), checks the binary against the SHA-256 pinned
 * below, and compiles the pinned Rego of the products in BUILD_PRODUCTS to one
 * WebAssembly module. The same OPA and the same files give the same bytes, so a
 * rebuild shows any difference as a git diff. It needs network access to GitHub.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_ORDER, importScubaGearRules, scubaCoverage } from '../engine/benchmarks/scubagear/import.mjs';
import { renderCoverageMarkdown } from '../engine/benchmarks/scubagear/report.mjs';
import { scubaRuleOutcomes } from '../engine/benchmarks/scubagear/controls.mjs';
import { BUILD_DIR, BUILD_MANIFEST } from '../engine/benchmarks/scubagear/opa.mjs';
import { openPinnedScubaGear } from '../engine/benchmarks/scubagear/import.mjs';
import { fixtureDocument } from '../engine/benchmarks/scubagear/fixtureTenant.mjs';

export const GOLDEN_PATH = join(BUILD_DIR, 'golden.json');

// The products whose rules Keel runs today. Adding one here, then rebuilding, compiles it in.
export const BUILD_PRODUCTS = Object.freeze(['aad', 'exo', 'securitysuite', 'sharepoint', 'teams', 'powerplatform', 'powerbi']);
export const OPA = Object.freeze({
  version: '1.20.2',
  url: 'https://github.com/open-policy-agent/opa/releases/download/v1.20.2/opa_linux_amd64_static',
  sha256: '69da5179ee403d10fa11bab6cfb4ffb0d23dba5f9b682fa977db772a1da5670f',
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function buildWasm() {
  const source = openPinnedScubaGear();
  source.verifyAll();
  const { pin } = source;
  const root = join(dirname(fileURLToPath(new URL('../engine/benchmarks/scubagear/pin.json', import.meta.url))), pin.localPath);
  const files = [...BUILD_PRODUCTS.map((product) => pin.products[product].rego), ...source.files
    .map((file) => file.slice(2)).filter((file) => file.startsWith('Rego/Utils/'))].sort();
  const work = mkdtempSync(join(tmpdir(), 'keel-opa-'));
  try {
    const opa = join(work, 'opa');
    execFileSync('curl', ['-fsSL', '-o', opa, OPA.url], { stdio: 'inherit' });
    if (sha256(readFileSync(opa)) !== OPA.sha256) throw new Error('the downloaded OPA binary does not match its pinned SHA-256');
    chmodSync(opa, 0o755);
    const bundle = join(work, 'bundle.tar.gz');
    execFileSync(opa, ['build', '-t', 'wasm', ...BUILD_PRODUCTS.flatMap((product) => ['-e', `${product}/tests`]), '-o', bundle, ...files], { cwd: root, stdio: 'inherit' });
    execFileSync('tar', ['xzf', bundle, '-C', work, '/policy.wasm'], { stdio: 'inherit' });
    const wasm = readFileSync(join(work, 'policy.wasm'));
    mkdirSync(BUILD_DIR, { recursive: true });
    writeFileSync(join(BUILD_DIR, 'rules.wasm'), wasm);
    const manifest = {
      scubaGearVersion: pin.version,
      scubaGearCommit: pin.commitSha,
      opa: OPA,
      products: BUILD_PRODUCTS,
      entrypoints: BUILD_PRODUCTS.map((product) => `${product}/tests`),
      sources: files.map((path) => ({ path, sha256: sha256(Buffer.from(source.read(path), 'utf8')) })),
      module: 'rules.wasm',
      moduleSha256: sha256(wasm),
    };
    writeFileSync(BUILD_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
    // OPA's own answers for the fixture tenant (engine/benchmarks/scubagear/fixtureTenant.mjs),
    // from the native binary: the module must give the same ones (opa.test.mjs).
    const golden = {};
    for (const product of BUILD_PRODUCTS) {
      const inputPath = join(work, `${product}.json`);
      writeFileSync(inputPath, JSON.stringify(fixtureDocument(product, { version: pin.version })));
      const answer = JSON.parse(execFileSync(opa, ['eval', '-f', 'json', '-i', inputPath, ...files.flatMap((file) => ['-d', file]), `data.${product}.tests`], { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString('utf8'));
      golden[product] = answer.result[0].expressions[0].value
        .map(({ PolicyId, Criticality, RequirementMet }) => ({ PolicyId, Criticality, RequirementMet }))
        .sort((a, b) => a.PolicyId.localeCompare(b.PolicyId, 'en', { numeric: true }) || a.Criticality.localeCompare(b.Criticality));
    }
    writeFileSync(GOLDEN_PATH, `${JSON.stringify({ opa: OPA.version, ...golden }, null, 2)}\n`);
    process.stdout.write(`built ${BUILD_PRODUCTS.join(', ')} with OPA ${OPA.version}: ${wasm.length} bytes, sha256 ${manifest.moduleSha256}\n`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export const REPORT_PATH = fileURLToPath(new URL('../docs/roadmap/benchmark-content/scubagear-coverage.md', import.meta.url));

function main(argv) {
  const [command = 'summary', ...rest] = argv;
  const write = rest.includes('--write');
  const unknown = rest.filter((arg) => arg !== '--write');
  if (!['summary', 'json', 'report', 'build-wasm'].includes(command) || unknown.length || (write && command !== 'report')) {
    process.stderr.write('usage: scubagear-rules.mjs [summary | json | report [--write] | build-wasm]\n');
    return 2;
  }
  if (command === 'build-wasm') {
    buildWasm();
    return 0;
  }
  const imported = importScubaGearRules();
  const coverage = scubaCoverage(imported);
  if (command === 'json') {
    process.stdout.write(`${JSON.stringify({ ...imported, coverage }, null, 2)}\n`);
  } else if (command === 'report') {
    const markdown = renderCoverageMarkdown(imported, coverage, scubaRuleOutcomes({ imported }));
    if (write) writeFileSync(REPORT_PATH, markdown);
    else process.stdout.write(markdown);
  } else {
    process.stdout.write(`ScubaGear ${imported.version} (${imported.commitSha.slice(0, 7)}): ${imported.total} rules, every file SHA-256 checked\n`);
    for (const product of PRODUCT_ORDER) {
      const count = imported.counts[product];
      const states = coverage.perProduct[product];
      process.stdout.write(`  ${count.name.padEnd(40)} ${String(count.rules).padStart(3)} rules  `
        + `ready ${states.ready}, partly read ${states.partial}, could not check ${states['missing-input']}, check by hand ${states.manual}\n`);
    }
    const s = coverage.summary;
    process.stdout.write(`  ${'All'.padEnd(40)} ${String(imported.total).padStart(3)} rules  `
      + `ready ${s.ready}, partly read ${s.partial}, could not check ${s['missing-input']}, check by hand ${s.manual}\n`);
  }
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
