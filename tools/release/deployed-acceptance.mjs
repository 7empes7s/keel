#!/usr/bin/env node
/**
 * Deployed release acceptance capture (roadmap task-113). Read-only by
 * construction: it records the deployed checkout's revision and issues GET
 * probes against the deployed portal's coverage matrix, collection history,
 * schedules and restore review API contracts, each once with the operator's
 * authenticated session and once without it. It never executes a restore,
 * never writes through the portal and never redeploys or restarts anything.
 *
 *   node tools/release/deployed-acceptance.mjs capture
 *     [--portal-url https://keel.example] [--source /opt/keel] [--deployed /opt/keel-live]
 *     [--build <revision>] [--session-env KEEL_PORTAL_SESSION]
 *     [--out docs/release/qualifications/deployed-acceptance.json]
 *
 * The session assertion is read from the environment variable named by
 * --session-env and is sent only as the Access assertion header; it is never
 * written to the record, the transcript or stdout. Response bodies are reduced
 * to their status, content type, top-level keys, error code and a SHA-256
 * digest. The record is signed as 'keel-release-runner' with
 * KEEL_QUALIFICATION_HMAC_KEY. Missing session, tenant, deployed identity or
 * key yields a 'pending' record that can never verify.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  configuredTenantRef, DEPLOYED_ACCEPTANCE_CREDENTIAL_MODE, DEPLOYED_ACCEPTANCE_GATE,
  DEPLOYED_ACCEPTANCE_OPERATION, DEPLOYED_ACCEPTANCE_PROBES, QUALIFICATION_CONTRACT_VERSION, signEvidence,
} from './qualification.mjs';
import { ACCESS_ASSERTION_HEADER, gitRevision } from './readiness.mjs';

export const CAPTURE_TOOL = 'tools/release/deployed-acceptance.mjs';

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** One GET request reduced to its contract shape; the body itself is not kept. */
async function observe(fetchFn, url, headers, now) {
  let response;
  try {
    response = await fetchFn(url, { method: 'GET', headers, redirect: 'manual' });
  } catch {
    return { httpStatus: null, error: 'unreachable', observedAt: now().toISOString() };
  }
  const text = await response.text();
  const contentType = response.headers.get('content-type') ?? '';
  let body = null;
  if (/^application\/json\b/.test(contentType)) {
    try { body = JSON.parse(text); } catch { body = null; }
  }
  const isObject = body && typeof body === 'object' && !Array.isArray(body);
  return {
    httpStatus: response.status,
    contentType,
    keys: isObject ? Object.keys(body).sort() : [],
    errorCode: isObject && typeof body.error === 'string' ? body.error : null,
    bodySha256: sha256(text),
    observedAt: now().toISOString(),
  };
}

/** Probe every surface in the closed inventory, with and without the session. */
export async function captureProbes(fetchFn, portalUrl, sessionAssertion, { now = () => new Date() } = {}) {
  const probes = [];
  for (const spec of DEPLOYED_ACCEPTANCE_PROBES) {
    const url = new URL(spec.path, portalUrl);
    const authenticated = await observe(fetchFn, url, { [ACCESS_ASSERTION_HEADER]: sessionAssertion }, now);
    const { httpStatus, observedAt } = await observe(fetchFn, url, {}, now);
    probes.push({ surface: spec.surface, path: spec.path, authenticated, unauthenticated: { httpStatus, observedAt } });
  }
  return probes;
}

/**
 * Build the evidence record and its capture transcript. Live identity is
 * opt-in: without live=true the record is a synthetic fixture signed by the
 * fixture runner, which --require-live always rejects.
 */
export async function buildDeployedAcceptance({
  execFn, fetchFn, portalUrl, sourcePath, deployedPath, build = null, tenantRef,
  sessionAssertion = null, hmacKey = null, live = false, now = () => new Date(),
  artifactPath = 'deployed-acceptance.capture.json',
}) {
  const source = sourcePath ? gitRevision(execFn, sourcePath) : null;
  const deployed = deployedPath ? gitRevision(execFn, deployedPath) : null;
  const candidate = build ?? source?.revision ?? null;

  const pendingReasons = [];
  if (!sessionAssertion) pendingReasons.push('no authenticated operator session');
  if (!tenantRef) pendingReasons.push('no tenant identity (KEEL_TENANT_CONFIG_PATH)');
  if (!candidate) pendingReasons.push('no candidate build identity');
  if (!deployed?.revision) pendingReasons.push('no deployed revision identity');
  if (!hmacKey) pendingReasons.push('no runner signing key (KEEL_QUALIFICATION_HMAC_KEY)');
  if (pendingReasons.length) {
    return { evidence: pendingRecord({ tenantRef, build: candidate, pendingReasons, now }), transcript: null };
  }

  const deployment = { revision: deployed.revision, dirty: deployed.dirty };
  const probes = await captureProbes(fetchFn, portalUrl, sessionAssertion, { now });
  const transcript = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    tool: CAPTURE_TOOL,
    portalOrigin: new URL(portalUrl).origin,
    tenantRef,
    build: candidate,
    deployment,
    probes,
  };
  const transcriptText = `${JSON.stringify(transcript, null, 2)}\n`;
  const unsigned = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: DEPLOYED_ACCEPTANCE_GATE,
    tenantRef,
    build: candidate,
    operation: DEPLOYED_ACCEPTANCE_OPERATION,
    credentialMode: DEPLOYED_ACCEPTANCE_CREDENTIAL_MODE,
    observedAt: now().toISOString(),
    evidenceLevel: live ? 'live-qualified' : 'fixture-tested',
    synthetic: !live,
    subject: { deployment, probes },
    proof: { artifact: { path: artifactPath, sha256: sha256(transcriptText) } },
  };
  const evidence = signEvidence(unsigned, hmacKey, live ? 'keel-release-runner' : 'keel-fixture-runner');
  return { evidence, transcript: transcriptText };
}

function pendingRecord({ tenantRef, build, pendingReasons, now }) {
  return {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: DEPLOYED_ACCEPTANCE_GATE,
    status: 'pending',
    pendingReasons,
    tenantRef: tenantRef ?? null,
    build: build ?? null,
    operation: DEPLOYED_ACCEPTANCE_OPERATION,
    credentialMode: DEPLOYED_ACCEPTANCE_CREDENTIAL_MODE,
    evidenceLevel: 'fixture-tested',
    synthetic: true,
    recordedAt: now().toISOString(),
  };
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

async function main() {
  if (process.argv[2] !== 'capture' || process.argv.includes('--help')) {
    console.error('usage: deployed-acceptance.mjs capture [--portal-url URL] [--source PATH] [--deployed PATH] [--build REV] [--session-env NAME] [--out PATH]');
    process.exit(process.argv[2] === 'capture' ? 0 : 2);
  }
  const out = arg('out', 'docs/release/qualifications/deployed-acceptance.json');
  const artifactPath = `${basename(out, '.json')}.capture.json`;
  const { evidence, transcript } = await buildDeployedAcceptance({
    execFn: (args) => execFileSync('git', args, { encoding: 'utf8' }),
    fetchFn: fetch,
    portalUrl: arg('portal-url', process.env.KEEL_PORTAL_URL ?? 'http://localhost:3000'),
    sourcePath: arg('source', '/opt/keel'),
    deployedPath: arg('deployed', '/opt/keel-live'),
    build: arg('build', process.env.KEEL_QUALIFICATION_BUILD ?? null),
    tenantRef: configuredTenantRef(),
    sessionAssertion: process.env[arg('session-env', 'KEEL_PORTAL_SESSION')] ?? null,
    hmacKey: process.env.KEEL_QUALIFICATION_HMAC_KEY ?? null,
    live: true,
    artifactPath,
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  if (transcript) writeFileSync(join(dirname(out), artifactPath), transcript);

  // Outcomes only — never the session assertion or a response body.
  if (evidence.status) {
    console.log(`deployed acceptance: ${evidence.status}`);
    for (const reason of evidence.pendingReasons) console.log(`  - ${reason}`);
  } else {
    console.log(`deployed acceptance: captured for build ${evidence.build} (deployed ${evidence.subject.deployment.revision}${evidence.subject.deployment.dirty ? ', dirty' : ''})`);
    for (const probe of evidence.subject.probes) {
      console.log(`probe ${probe.surface}: authenticated ${probe.authenticated.httpStatus ?? 'unreachable'}, unauthenticated ${probe.unauthenticated.httpStatus ?? 'unreachable'}`);
    }
  }
  console.log(`written: ${out}${transcript ? ` and ${artifactPath}` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
