#!/usr/bin/env node
/**
 * The pinned CISA ScubaGear rule set and what Keel can check of it.
 *
 *   node tools/scubagear-rules.mjs                 # rule count per product, and coverage
 *   node tools/scubagear-rules.mjs json            # every rule with its inputs, as JSON
 *   node tools/scubagear-rules.mjs report          # the coverage report as Markdown
 *   node tools/scubagear-rules.mjs report --write  # rewrite docs/roadmap/benchmark-content/scubagear-coverage.md
 *
 * Every pinned file is checked against its SHA-256 first; a mismatch exits non-zero.
 * Read-only: nothing here touches a tenant.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PRODUCT_ORDER, importScubaGearRules, scubaCoverage } from '../engine/benchmarks/scubagear/import.mjs';
import { renderCoverageMarkdown } from '../engine/benchmarks/scubagear/report.mjs';

export const REPORT_PATH = fileURLToPath(new URL('../docs/roadmap/benchmark-content/scubagear-coverage.md', import.meta.url));

function main(argv) {
  const [command = 'summary', ...rest] = argv;
  const write = rest.includes('--write');
  const unknown = rest.filter((arg) => arg !== '--write');
  if (!['summary', 'json', 'report'].includes(command) || unknown.length || (write && command !== 'report')) {
    process.stderr.write('usage: scubagear-rules.mjs [summary | json | report [--write]]\n');
    return 2;
  }
  const imported = importScubaGearRules();
  const coverage = scubaCoverage(imported);
  if (command === 'json') {
    process.stdout.write(`${JSON.stringify({ ...imported, coverage }, null, 2)}\n`);
  } else if (command === 'report') {
    const markdown = renderCoverageMarkdown(imported, coverage);
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
