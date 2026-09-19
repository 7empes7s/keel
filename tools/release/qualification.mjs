#!/usr/bin/env node
/**
 * Qualification evidence verifier (roadmap task-45).
 *
 *   node tools/release/qualification.mjs verify --gate <gate> --evidence <file>
 *     [--tenant <tenant_ref>] [--require-live] [--max-age-hours N]
 *
 * Verifies a versioned qualification evidence record: schema, gate match,
 * tenant match, build/operation/credential-mode fields, observation freshness
 * and proof. Proof is either a trusted runner identity with an HMAC signature
 * (key from KEEL_QUALIFICATION_HMAC_KEY, never from git) or an independently
 * verifiable artifact digest recomputed from the artifact bytes. Missing
 * proof exits nonzero. --require-live additionally rejects synthetic
 * fixtures, fixture-tested levels and synthetic runner identities.
 *
 * Gate-specific validators are registered additively in GATE_VALIDATORS by
 * later tasks; an unregistered gate is a verification failure, not a pass.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const QUALIFICATION_CONTRACT_VERSION = 1;
export const QUALIFICATION_EVIDENCE_LEVELS = Object.freeze(['fixture-tested', 'live-qualified']);
export const DEFAULT_MAX_AGE_HOURS = 24 * 30;

// Runner identities trusted to sign evidence, and whether that runner is a
// synthetic fixture harness. A synthetic runner can never prove a live claim.
export const TRUSTED_RUNNERS = Object.freeze({
  'keel-fixture-runner': Object.freeze({ synthetic: true }),
  'keel-release-runner': Object.freeze({ synthetic: false }),
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Sign an evidence record (minus any existing proof) with a runner identity. */
export function signEvidence(evidence, key, identity = 'keel-release-runner') {
  const { proof, ...unsigned } = evidence;
  const signature = createHmac('sha256', key).update(canonical(unsigned)).digest('hex');
  return { ...evidence, proof: { ...proof, runner: { identity, signature } } };
}

function verifyRunnerProof(evidence, runner, { hmacKey, trustedRunners }) {
  if (!runner || typeof runner.identity !== 'string' || typeof runner.signature !== 'string') {
    return { ok: false, reason: 'no runner identity/signature' };
  }
  const trusted = trustedRunners[runner.identity];
  if (!trusted) return { ok: false, reason: `untrusted runner identity: ${runner.identity}` };
  if (!hmacKey) return { ok: false, reason: 'no verification key configured' };
  const { proof, ...unsigned } = evidence;
  const expected = createHmac('sha256', hmacKey).update(canonical(unsigned)).digest();
  const actual = Buffer.from(runner.signature, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'runner signature mismatch' };
  }
  return { ok: true, synthetic: trusted.synthetic };
}

function verifyArtifactDigest(artifact, evidenceDir) {
  if (!artifact || typeof artifact.path !== 'string' || typeof artifact.sha256 !== 'string') {
    return { ok: false, reason: 'no artifact digest' };
  }
  let bytes;
  try {
    bytes = readFileSync(resolve(evidenceDir, artifact.path));
  } catch {
    return { ok: false, reason: `artifact unreadable: ${artifact.path}` };
  }
  const actual = createHash('sha256').update(bytes).digest();
  const expected = Buffer.from(artifact.sha256, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: 'artifact digest mismatch' };
  }
  return { ok: true };
}

/** Gate validator for the task-45 release-readiness record. */
function validateReleaseReadinessSubject(evidence) {
  const failures = [];
  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return ['subject is missing'];
  if (subject.verdict !== 'ready') failures.push(`readiness verdict is '${subject.verdict ?? 'missing'}', not 'ready'`);
  if (!subject.sourceRevision) failures.push('source revision missing');
  if (!subject.deployedRevision) failures.push('deployed revision missing');
  if (subject.sourceRevision && subject.deployedRevision && subject.sourceRevision !== subject.deployedRevision) {
    failures.push('source and deployed revisions differ');
  }
  if (!Array.isArray(subject.probes) || subject.probes.length === 0) {
    failures.push('no feature probes recorded');
  } else if (subject.probes.some((p) => p.outcome !== 'pass')) {
    failures.push('not every feature probe passed');
  }
  return failures;
}

// Later tasks register additional gates here; an absent gate fails closed.
const GATE_VALIDATORS = {
  'release-readiness': validateReleaseReadinessSubject,
};

export function verifyEvidence(evidence, {
  gate = null,
  tenantRef = null,
  requireLive = false,
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  hmacKey = process.env.KEEL_QUALIFICATION_HMAC_KEY ?? null,
  evidenceDir = process.cwd(),
  trustedRunners = TRUSTED_RUNNERS,
} = {}) {
  const failures = [];
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    return { ok: false, failures: ['evidence is not an object'] };
  }

  // Schema.
  if (evidence.contractVersion !== QUALIFICATION_CONTRACT_VERSION) {
    failures.push(`unsupported contractVersion: ${evidence.contractVersion ?? 'missing'}`);
  }
  for (const field of ['gate', 'tenantRef', 'build', 'operation', 'credentialMode', 'observedAt']) {
    if (typeof evidence[field] !== 'string' || evidence[field].length === 0) {
      failures.push(`missing or invalid field: ${field}`);
    }
  }
  if (!QUALIFICATION_EVIDENCE_LEVELS.includes(evidence.evidenceLevel)) {
    failures.push(`invalid evidenceLevel: ${evidence.evidenceLevel ?? 'missing'}`);
  }
  if (typeof evidence.synthetic !== 'boolean') failures.push('missing or invalid field: synthetic');

  // Gate and tenant binding — evidence for another gate or tenant never applies.
  if (gate && evidence.gate !== gate) failures.push(`gate mismatch: evidence is '${evidence.gate}', required '${gate}'`);
  if (tenantRef && evidence.tenantRef !== tenantRef) {
    failures.push(`cross-tenant evidence refused: evidence is '${evidence.tenantRef}', required '${tenantRef}'`);
  }

  // Observation freshness.
  const observedAt = Date.parse(evidence.observedAt);
  if (Number.isNaN(observedAt)) {
    failures.push('observedAt is not a valid timestamp');
  } else {
    if (observedAt > now.getTime() + 5 * 60 * 1000) failures.push('observedAt is in the future');
    if (now.getTime() - observedAt > maxAgeHours * 60 * 60 * 1000) {
      failures.push(`observation is stale (older than ${maxAgeHours}h)`);
    }
  }

  // Proof: trusted runner signature OR independently verifiable artifact digest.
  const runner = verifyRunnerProof(evidence, evidence.proof?.runner, { hmacKey, trustedRunners });
  const artifact = verifyArtifactDigest(evidence.proof?.artifact, evidenceDir);
  if (!runner.ok && !artifact.ok) {
    failures.push(`missing proof: runner (${runner.reason}); artifact (${artifact.reason})`);
  }

  // --require-live rejects synthetic fixtures and unproven live claims.
  if (requireLive) {
    if (evidence.synthetic) failures.push('--require-live rejects synthetic fixtures');
    if (evidence.evidenceLevel !== 'live-qualified') {
      failures.push(`--require-live needs evidenceLevel 'live-qualified', got '${evidence.evidenceLevel}'`);
    }
    if (!runner.ok) failures.push(`--require-live needs a trusted runner signature (${runner.reason})`);
    else if (runner.synthetic) failures.push('--require-live rejects synthetic runner identities');
  }

  // Gate-specific validation, additive per task.
  const validator = GATE_VALIDATORS[evidence.gate];
  if (!validator) failures.push(`no validator registered for gate '${evidence.gate}'`);
  else failures.push(...validator(evidence));

  return { ok: failures.length === 0, failures };
}

export function verifyEvidenceFile(evidencePath, options = {}) {
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  } catch (error) {
    return { ok: false, failures: [`evidence unreadable: ${error.message}`] };
  }
  return verifyEvidence(evidence, { ...options, evidenceDir: dirname(resolve(evidencePath)) });
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

function main() {
  const command = process.argv[2];
  if (command !== 'verify' || process.argv.includes('--help')) {
    console.error('usage: qualification.mjs verify --gate <gate> --evidence <file> [--tenant <ref>] [--require-live] [--max-age-hours N]');
    process.exit(command === 'verify' ? 0 : 2);
  }
  const evidencePath = arg('evidence');
  if (!evidencePath) {
    console.error('missing --evidence <file>');
    process.exit(2);
  }
  const result = verifyEvidenceFile(evidencePath, {
    gate: arg('gate'),
    tenantRef: arg('tenant'),
    requireLive: process.argv.includes('--require-live'),
    maxAgeHours: Number(arg('max-age-hours', DEFAULT_MAX_AGE_HOURS)),
  });
  // The result carries verdicts and failure reasons only — no key material.
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
