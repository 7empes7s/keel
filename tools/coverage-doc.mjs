#!/usr/bin/env node
/**
 * Gap register P4: writes docs/coverage.md from the code (engine/coverage/coverageDoc.mjs).
 *
 *   node tools/coverage-doc.mjs           # rewrite docs/coverage.md
 *   node tools/coverage-doc.mjs --check   # exit 1 when the committed file is out of date
 *
 * Deterministic and offline: it reads no clock, no environment and no tenant.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { renderCoverageDoc } from '../engine/coverage/coverageDoc.mjs';

export const COVERAGE_DOC_PATH = fileURLToPath(new URL('../docs/coverage.md', import.meta.url));

function main(argv) {
  const expected = renderCoverageDoc();
  if (argv.includes('--check')) {
    let current = null;
    try { current = readFileSync(COVERAGE_DOC_PATH, 'utf8'); } catch { /* missing counts as stale */ }
    if (current !== expected) {
      console.error('docs/coverage.md is out of date. Run: node tools/coverage-doc.mjs');
      return 1;
    }
    console.log('docs/coverage.md is up to date.');
    return 0;
  }
  writeFileSync(COVERAGE_DOC_PATH, expected);
  console.log('Wrote docs/coverage.md.');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
