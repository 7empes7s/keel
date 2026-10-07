#!/usr/bin/env node
/**
 * NIST SP 800-53 benchmark evidence capture (roadmap task-119, gate nist-benchmark-acceptance).
 *
 *   KEEL_QUALIFICATION_HMAC_KEY=... node tools/qualification/nistLive.mjs capture --live \
 *     --db-url <KEEL database URL> --principal-email <operator email> --tenant <tenant_ref> \
 *     [--build <rev>] --out docs/release/qualifications/nist-benchmark-acceptance.json
 *
 * At the build it runs on, it verifies the pinned 5.2.0 OSCAL catalog bytes, imports the NIST pack
 * through the authorized pack seam (the principal must hold `configuration`; evaluation needs
 * `read`), and evaluates each mapped original KEEL control against three fixed scenarios:
 * a compliant fixture (expects pass), a risky fixture (expects fail) and no observation
 * (expects unknown). The record binds the pin, profile, tenant and build, and is signed with
 * KEEL_QUALIFICATION_HMAC_KEY: as keel-release-runner with --live, otherwise only as
 * keel-fixture-runner (synthetic, fixture-tested).
 *
 * The database is only read (principal and role-grant lookups). No tenant API is called, and
 * nothing is written anywhere but --out. If any control does not give the expected verdict,
 * the run fails and no record is written.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { evaluatePack, importNistPack } from '../../engine/benchmarks/packs.mjs';
import { loadNistProfile, NIST_MAPPINGS } from './benchmarkLicense.mjs';
import { signEvidence, TRUSTED_RUNNERS } from '../release/qualification.mjs';

export const NIST_GATE = 'nist-benchmark-acceptance';
export const NIST_OPERATION = 'nist-benchmark-evaluate';
export const NIST_CREDENTIAL_MODE = 'collector';
export const NIST_PROFILE = 'AC-IA-AU-CM';
export const NIST_PREREQUISITE = 'task-86';

const GLOBAL_ADMIN_ROLE = '62e90394-69f5-4237-9190-012177145e10';

/** The compliant and risky resources for each mapped control (same shapes as the boundary test). */
function scenarioResources(risky) {
  return {
    roleAssignment: Array.from({ length: risky ? 6 : 1 }, () => ({ roleDefinitionId: GLOBAL_ADMIN_ROLE })),
    namedLocation: [{ isTrusted: true, includeUnknownCountriesAndRegions: risky }],
    group: [{ isAssignableToRole: true, onPremisesSyncEnabled: risky }],
  };
}

function observationsFor(resources, { tenantRef, now }) {
  const at = now.toISOString();
  return Object.fromEntries(Object.entries(resources).map(([resourceType, values]) => [resourceType, {
    resources: values,
    observation: { tenantRef, resourceType, completeness: 'complete', window: { startedAt: at, endedAt: at } },
  }]));
}

function verdicts(result) {
  return new Map(result.results.map((entry) => [entry.controlId, entry.verdict]));
}

/**
 * Runs the three scenarios through the real import and evaluation seam and returns the signed
 * record. Throws, without a record, when the runner is unknown, no key or build is given, the
 * principal is not authorized, or any mapped control gives an unexpected verdict.
 */
export async function captureNistAcceptance({
  client, principal, tenantRef, build, now = new Date(), runner = {}, trustedRunners = TRUSTED_RUNNERS,
}) {
  const trusted = trustedRunners[runner.identity];
  if (!trusted) throw new Error(`untrusted runner identity: ${runner.identity ?? 'missing'}`);
  if (!runner.key) throw new Error('no runner signing key supplied');
  if (!build) throw new Error('capture needs the build identity');
  if (!principal) throw new Error('capture needs an authorized KEEL principal');
  const { pin } = loadNistProfile();
  const context = { client, principal, tenantRef };
  const pack = await importNistPack(context);
  const pass = verdicts(await evaluatePack({ ...context, pack, now, observations: observationsFor(scenarioResources(false), { tenantRef, now }) }));
  const fail = verdicts(await evaluatePack({ ...context, pack, now, observations: observationsFor(scenarioResources(true), { tenantRef, now }) }));
  const missing = verdicts(await evaluatePack({ ...context, pack, now, observations: {} }));
  const fixtureResults = NIST_MAPPINGS.map(([controlId]) => ({
    controlId, pass: pass.get(controlId) ?? 'absent', fail: fail.get(controlId) ?? 'absent', missing: missing.get(controlId) ?? 'absent',
  }));
  const wrong = fixtureResults.filter((entry) => entry.pass !== 'pass' || entry.fail !== 'fail' || entry.missing !== 'unknown');
  if (wrong.length > 0) {
    throw new Error(`mapped controls gave unexpected verdicts: ${JSON.stringify(wrong)}`);
  }
  const unsigned = {
    contractVersion: 1,
    gate: NIST_GATE,
    tenantRef,
    build,
    operation: NIST_OPERATION,
    credentialMode: NIST_CREDENTIAL_MODE,
    observedAt: now.toISOString(),
    evidenceLevel: trusted.synthetic ? 'fixture-tested' : 'live-qualified',
    synthetic: trusted.synthetic,
    subject: {
      sourceUrl: pin.sourceUrl, sourceDigest: pin.sha256, catalogVersion: pin.catalogVersion,
      profile: NIST_PROFILE, prerequisite: NIST_PREREQUISITE, fixtureResults,
    },
  };
  return signEvidence(unsigned, runner.key, runner.identity);
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 ? process.argv[index + 1] : fallback;
}

async function main() {
  if (process.argv[2] !== 'capture' || process.argv.includes('--help')) {
    console.error('usage: nistLive.mjs capture [--live] --db-url <url> --principal-email <email> --tenant <ref> [--build <rev>] --out <file>');
    process.exit(2);
  }
  const out = arg('out');
  if (!out) throw new Error('missing --out <evidence file>');
  const tenantRef = arg('tenant', process.env.KEEL_QUALIFICATION_TENANT_REF);
  if (!tenantRef) throw new Error('missing --tenant <tenant_ref>');
  const email = arg('principal-email');
  if (!email) throw new Error('missing --principal-email <operator email>');
  const { connect } = await import('../../engine/store/db.mjs');
  const { findPrincipalByEmail } = await import('../../engine/authz/principals.mjs');
  const client = await connect(arg('db-url', process.env.KEEL_DB_URL));
  try {
    const evidence = await captureNistAcceptance({
      client,
      principal: await findPrincipalByEmail(client, email),
      tenantRef,
      build: arg('build', process.env.KEEL_QUALIFICATION_BUILD ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()),
      runner: {
        identity: process.argv.includes('--live') ? 'keel-release-runner' : 'keel-fixture-runner',
        key: process.env.KEEL_QUALIFICATION_HMAC_KEY,
      },
    });
    writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify({ captured: out, evidenceLevel: evidence.evidenceLevel, build: evidence.build }));
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
