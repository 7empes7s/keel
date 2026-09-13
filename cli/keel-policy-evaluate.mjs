#!/usr/bin/env node
// /opt/keel/cli/keel-policy-evaluate.mjs
//
// node keel-policy-evaluate.mjs --tenant-ref REF [--db-url $KEEL_DB_URL]
//
// Thin worker-dispatch wrapper around engine/policy/evaluate.mjs
// evaluateOpenDrifts(): all policy and remediation decisions remain on the same
// evaluation path used when drift is first recorded. This file only parses argv and
// connects.
import { evaluateOpenDrifts } from '../engine/policy/evaluate.mjs';
import { connect } from '../engine/store/db.mjs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function requireArg(name) {
  const value = arg(name);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`--${name} is required`);
  }
  return value;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('usage: keel-policy-evaluate.mjs --tenant-ref REF [--db-url $KEEL_DB_URL]');
    return;
  }

  const dbUrl = arg('db-url', process.env.KEEL_DB_URL);
  if (!dbUrl) throw new Error('KEEL_DB_URL not set (source /etc/keel/db.env or pass --db-url)');

  const client = await connect(dbUrl);
  try {
    const evaluations = await evaluateOpenDrifts(client, {
      tenantRef: requireArg('tenant-ref'),
    });
    console.log(`evaluated ${evaluations.length} open drift row(s)`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
