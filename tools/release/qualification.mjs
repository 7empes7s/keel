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

import { loadNistProfile, NIST_MAPPINGS } from '../qualification/benchmarkLicense.mjs';
import { SHAREPOINT_LIVE_GATE, validateSharePointLiveSubject } from '../qualification/sharepointAcceptance.mjs';
import { TEAMS_LIVE_GATE, validateTeamsLiveSubject } from '../qualification/teamsAcceptance.mjs';
import { SENTINEL_LIVE_GATE, validateSentinelLiveSubject } from '../qualification/sentinelAcceptance.mjs';
import { NATIVE_LIVE_GATE, validateNativeLiveAcceptance } from '../../engine/restore/nativeRecoveryEvidence.mjs';
import { STORAGE_LIVE_GATE, validateStorageLiveAcceptance } from '../../engine/storage/storageLiveEvidence.mjs';
import { tenantRefFor } from '../../engine/store/tenantRef.mjs';
import { DRILL_LIMITS, DRILL_MANIFEST_KIND, DRILL_MANIFEST_VERSION } from '../rehearsal/qualification.mjs';
import { DISPOSABLE_PREFIX } from '../rehearsal/roundTrip.mjs';
import { RECOVERY_DRILL_EVIDENCE_KIND, classifyDrillRecord } from '../../engine/coverage/recoveryReadiness.mjs';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const SCUBAGEAR_PIN_PATH = new URL('../../docs/roadmap/benchmark-content/scubagear-pin.json', import.meta.url).pathname;
const SCUBAGEAR_REQUIRED_WORKLOADS = Object.freeze(['aad', 'exo']);
const SCUBAGEAR_WORKLOAD_REGO_FILE = Object.freeze({
  aad: 'AADConfig.rego', exo: 'EXOConfig.rego', defender: 'DefenderConfig.rego',
  powerbi: 'PowerBIConfig.rego', powerplatform: 'PowerPlatformConfig.rego',
  securitysuite: 'SecuritySuiteConfig.rego', sharepoint: 'SharepointConfig.rego', teams: 'TeamsConfig.rego',
});
export const SCUBAGEAR_BENCHMARK_OPERATION = 'scubagear.benchmark-acceptance';

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
  if (!/^[0-9a-f]{64}$/i.test(artifact.sha256)) return { ok: false, reason: 'artifact digest is not a sha256 hex string' };
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
  return { ok: true, bytes };
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

/** NIST gate never treats content admission as successful tenant qualification. */
function validateNistSubject(evidence, { tenantRef, build }) {
  const failures = [];
  if (!tenantRef || !build) failures.push('NIST expected tenant/build identity required');
  if (evidence.build !== build) failures.push('NIST build mismatch');
  if (evidence.operation !== 'nist-benchmark-evaluate') failures.push('NIST operation mismatch');
  if (evidence.credentialMode !== 'collector') failures.push('NIST requires collector credentials');
  try {
    const { pin } = loadNistProfile();
    const subject = evidence.subject;
    for (const [field, expected] of Object.entries({ sourceUrl: pin.sourceUrl, sourceDigest: pin.sha256,
      catalogVersion: pin.catalogVersion, profile: 'AC-IA-AU-CM', prerequisite: 'task-86' })) {
      if (subject?.[field] !== expected) failures.push(`NIST prerequisite/source mismatch: ${field}`);
    }
    const results = subject?.fixtureResults;
    if (!Array.isArray(results) || results.length !== NIST_MAPPINGS.length
      || NIST_MAPPINGS.some(([id]) => results.filter(r => r?.controlId === id
        && r.pass === 'pass' && r.fail === 'fail' && r.missing === 'unknown').length !== 1)) {
      failures.push('NIST expected control fixtures missing or failed');
    }
  } catch { failures.push('NIST pinned catalog prerequisite failed'); }
  return failures;
}

/**
 * Task-126: import a bounded, hash-verified profile of CISA ScubaGear Rego
 * policies (public-domain, CC0-1.0 — no purchased license applies, exactly
 * as task-119 reads NIST's public-domain status from its own pin) and cite
 * each imported check's mapped NIST SP 800-53 Rev 5 control id as an
 * evidence link. This never claims compliance certification and never
 * executes a policy against tenant data — it only proves which checks were
 * imported, from which byte-verified source, mapped to which control ids.
 */
function loadScubaGearPin(pinPath) {
  let pin;
  try {
    pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  } catch (error) {
    throw new Error(`ScubaGear pin unreadable: ${error.message}`);
  }
  if (!/public domain/i.test(pin?.licensing?.status ?? '')) {
    throw new Error(`ScubaGear pin licensing status is not public domain: ${pin?.licensing?.status ?? 'missing'}`);
  }
  if (pin.licensing.attributionRequired !== false || pin.licensing.commercialUseRestricted !== false) {
    throw new Error('ScubaGear pin licensing scope is not the expected unrestricted public-domain grant');
  }
  for (const field of ['commitSha', 'localPath', 'localManifest']) {
    if (typeof pin[field] !== 'string' || !pin[field].trim()) {
      throw new Error(`ScubaGear pin is missing required field: ${field}`);
    }
  }
  return pin;
}

function readScubaGearManifest(manifestPath) {
  const entries = new Map();
  for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
    const match = /^([0-9a-f]{64})\s+(\.\/.+?)\s*$/.exec(line);
    if (match) entries.set(match[2], match[1]);
  }
  return entries;
}

/** Refuses (throws on) any file whose bytes don't match MANIFEST.sha256 — never silently trusted. */
function verifyScubaGearFile(localPath, manifest, relativePath) {
  const expected = manifest.get(relativePath);
  if (!expected) throw new Error(`no MANIFEST.sha256 entry for ${relativePath}`);
  const bytes = readFileSync(resolve(localPath, relativePath));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`MANIFEST.sha256 hash mismatch for ${relativePath}`);
  return bytes;
}

function extractScubaGearPolicyIds(regoSource) {
  const ids = new Set();
  for (const match of regoSource.matchAll(/"PolicyId":\s*"([^"]+)"/g)) ids.add(match[1]);
  return [...ids].sort();
}

function parseScubaToNistMapping(csvText) {
  const map = new Map();
  const [, ...rows] = csvText.split(/\r?\n/).filter((line) => line.length > 0);
  for (const row of rows) {
    const match = /^([^,]+),(.+)$/.exec(row);
    if (!match) continue;
    const policyId = match[1].trim();
    const rawValue = match[2].trim().replace(/^"(.*)"$/, '$1');
    const controlIds = rawValue.split(',').map((v) => v.trim()).filter(Boolean);
    if (controlIds.length) map.set(policyId, controlIds);
  }
  return map;
}

/** Server/CLI integration seam: a fixture-tested import, never a live tenant evaluation. */
export function importScubaGearProfile({ pinPath = SCUBAGEAR_PIN_PATH, workloads = SCUBAGEAR_REQUIRED_WORKLOADS } = {}) {
  const pin = loadScubaGearPin(pinPath);
  const manifest = readScubaGearManifest(pin.localManifest);
  const mappingBytes = verifyScubaGearFile(pin.localPath, manifest, './mappings/scuba-to-nist-sp-800-53-r5-fedramp-high.csv');
  const mapping = parseScubaToNistMapping(mappingBytes.toString('utf8'));

  const policies = [];
  for (const workload of workloads) {
    const file = SCUBAGEAR_WORKLOAD_REGO_FILE[workload];
    if (!file) throw new Error(`unknown ScubaGear workload: ${workload}`);
    const relativePath = `./Rego/${file}`;
    const regoBytes = verifyScubaGearFile(pin.localPath, manifest, relativePath);
    for (const policyId of extractScubaGearPolicyIds(regoBytes.toString('utf8'))) {
      const nistControlIds = mapping.get(policyId);
      if (!nistControlIds) continue; // no NIST evidence link to surface; never surfaced as an unlinked claim
      policies.push({ policyId, workload, sourceFile: relativePath, nistControlIds });
    }
  }
  if (policies.length === 0) throw new Error('no ScubaGear policies were imported');
  return Object.freeze({
    commitSha: pin.commitSha,
    workloads: Object.freeze([...workloads]),
    policies: Object.freeze(policies.map((p) => Object.freeze({ ...p, nistControlIds: Object.freeze(p.nistControlIds) }))),
  });
}

/** Gate validator for the task-126 ScubaGear benchmark-acceptance record. */
function validateScubaGearBenchmarkAcceptanceSubject(evidence, { build } = {}) {
  const failures = [];
  if (evidence.operation !== SCUBAGEAR_BENCHMARK_OPERATION) {
    failures.push(`operation mismatch: expected '${SCUBAGEAR_BENCHMARK_OPERATION}', got '${evidence.operation ?? 'missing'}'`);
  }
  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];

  let profile;
  try {
    profile = importScubaGearProfile();
  } catch (error) {
    return [...failures, `ScubaGear profile import failed: ${error.message}`];
  }
  const importedIds = new Map(profile.policies.map((p) => [p.policyId, p]));
  if (build && evidence.build !== build) failures.push('ScubaGear build mismatch');
  if (evidence.credentialMode !== 'collector') failures.push('ScubaGear requires collector credential mode');

  if (subject.sourceCommitSha !== profile.commitSha) {
    failures.push(`ScubaGear source commit mismatch: expected '${profile.commitSha}', got '${subject.sourceCommitSha ?? 'missing'}'`);
  }
  if (subject.manifestVerified !== true) {
    failures.push('subject does not attest MANIFEST.sha256 verification of every imported policy file');
  }
  if (!Array.isArray(subject.workloadsImported)
    || !SCUBAGEAR_REQUIRED_WORKLOADS.every((w) => subject.workloadsImported.includes(w))) {
    failures.push(`subject must import at least the ${SCUBAGEAR_REQUIRED_WORKLOADS.join(', ')} workload baselines`);
  }
  if (!Array.isArray(subject.policiesEvaluated) || subject.policiesEvaluated.length === 0) {
    failures.push('no ScubaGear policies evaluated');
  } else {
    const evaluatedWorkloads = new Set();
    for (const entry of subject.policiesEvaluated) {
      const imported = importedIds.get(entry?.policyId);
      if (imported) evaluatedWorkloads.add(imported.workload);
      if (imported && canonical(entry.nistControlIds) !== canonical(imported.nistControlIds)) {
        failures.push(`policy '${entry.policyId}' NIST mapping mismatch`);
      }
      if (typeof entry?.policyId !== 'string' || !importedIds.has(entry.policyId)) {
        failures.push(`policy '${entry?.policyId ?? 'missing'}' is not part of the verified imported profile`);
      }
      if (!Array.isArray(entry?.nistControlIds) || entry.nistControlIds.length === 0) {
        failures.push(`policy '${entry?.policyId}' is missing its mapped NIST SP 800-53 control id(s)`);
      }
      if (!['pass', 'fail', 'not-applicable', 'unknown'].includes(entry?.verdict)) {
        failures.push(`policy '${entry?.policyId}' has an invalid verdict`);
      }
    }
    if (!SCUBAGEAR_REQUIRED_WORKLOADS.every(w => evaluatedWorkloads.has(w))) {
      failures.push('evaluated policies must cover aad and exo');
    }
  }
  return failures;
}

/**
 * Task-113: authenticated deployed release acceptance. The evidence is an
 * imported record from tools/release/deployed-acceptance.mjs, captured by the
 * operator against the deployed candidate with an authenticated session:
 * read-only GET probes of the coverage matrix, collection history, schedules
 * and restore review API contracts, each repeated without a session to record
 * the authorization behavior, plus the deployed checkout's revision. The
 * record must carry both a non-synthetic runner signature and the digest of
 * the raw capture transcript, and the transcript must agree with the signed
 * subject. Nothing here probes, restores or redeploys anything.
 */
export const DEPLOYED_ACCEPTANCE_GATE = 'deployed-acceptance';
export const DEPLOYED_ACCEPTANCE_OPERATION = 'deployed-acceptance.read-probe';
export const DEPLOYED_ACCEPTANCE_CREDENTIAL_MODE = 'operator-session';
export const DEPLOYED_ACCEPTANCE_MAX_AGE_HOURS = 24 * 7;
// Every probe must fall inside this window before the record's observedAt.
export const DEPLOYED_ACCEPTANCE_PROBE_WINDOW_MS = 60 * 60 * 1000;
// An unauthenticated request must be refused or redirected to sign-in.
export const DEPLOYED_ACCEPTANCE_REFUSAL_STATUSES = Object.freeze([301, 302, 303, 307, 308, 401, 403]);
// A nil-form id no dry run can carry: an authorized deployed route answers its
// JSON not_found contract without reading or changing any restore.
export const RESTORE_REVIEW_PROBE_ID = '00000000-0000-4000-8000-000000000000';

// Closed probe inventory. prerequisite names the roadmap task whose deployed
// surface the probe proves; a missing or failing probe is a missing prerequisite.
export const DEPLOYED_ACCEPTANCE_PROBES = Object.freeze([
  Object.freeze({ surface: 'coverage-matrix', prerequisite: 'task-54', path: '/api/coverage',
    expect: Object.freeze({ status: 200, keys: Object.freeze(['generatedAt', 'snapshot', 'summary', 'types']) }) }),
  Object.freeze({ surface: 'collection-history', prerequisite: 'task-46', path: '/api/jobs?limit=20',
    expect: Object.freeze({ status: 200, keys: Object.freeze(['generatedAt', 'jobs']) }) }),
  Object.freeze({ surface: 'schedules', prerequisite: 'task-44', path: '/api/schedules',
    expect: Object.freeze({ status: 200, keys: Object.freeze(['deferrals', 'forecasts', 'generatedAt', 'schedules']) }) }),
  Object.freeze({ surface: 'restore-review', prerequisite: null, path: `/api/actions/restore/dry-run/${RESTORE_REVIEW_PROBE_ID}`,
    expect: Object.freeze({ status: 404, keys: Object.freeze(['error']), errorCode: 'not_found' }) }),
]);
export const DEPLOYED_ACCEPTANCE_PREREQUISITES = Object.freeze(
  DEPLOYED_ACCEPTANCE_PROBES.filter((p) => p.prerequisite).map((p) => p.prerequisite),
);

/** Contract failures of one captured probe against its spec ([] = satisfied). */
export function deployedProbeFailures(spec, probe, { observedAt } = {}) {
  const failures = [];
  const name = spec.surface;
  if (probe?.path !== spec.path) failures.push(`${name}: probed path '${probe?.path ?? 'missing'}' is not '${spec.path}'`);
  const auth = probe?.authenticated;
  if (!auth || typeof auth !== 'object') return [...failures, `${name}: no authenticated probe recorded`];
  if (auth.httpStatus !== spec.expect.status) {
    failures.push(`${name}: authenticated status ${auth.httpStatus ?? 'missing'}, contract expects ${spec.expect.status}`);
  }
  if (!/^application\/json\b/.test(auth.contentType ?? '')) failures.push(`${name}: response is not JSON`);
  const keys = Array.isArray(auth.keys) ? auth.keys : [];
  const missing = spec.expect.keys.filter((key) => !keys.includes(key));
  if (missing.length) failures.push(`${name}: response contract missing ${missing.join(', ')}`);
  if (spec.expect.errorCode !== undefined && auth.errorCode !== spec.expect.errorCode) {
    failures.push(`${name}: error code '${auth.errorCode ?? 'missing'}', contract expects '${spec.expect.errorCode}'`);
  }
  if (typeof auth.bodySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(auth.bodySha256)) failures.push(`${name}: no body digest`);
  const unauth = probe.unauthenticated;
  if (!unauth || !DEPLOYED_ACCEPTANCE_REFUSAL_STATUSES.includes(unauth.httpStatus)) {
    failures.push(`${name}: unauthenticated request was not refused (status ${unauth?.httpStatus ?? 'missing'})`);
  }
  if (observedAt !== undefined) {
    for (const [label, at] of [['authenticated', auth.observedAt], ['unauthenticated', unauth?.observedAt]]) {
      const t = Date.parse(at);
      if (Number.isNaN(t) || t > observedAt + 5 * 60 * 1000 || observedAt - t > DEPLOYED_ACCEPTANCE_PROBE_WINDOW_MS) {
        failures.push(`${name}: ${label} probe time is outside the observation window`);
      }
    }
  }
  return failures;
}

function readCaptureArtifact(artifact, evidenceDir) {
  try {
    return JSON.parse(readFileSync(resolve(evidenceDir, artifact.path), 'utf8'));
  } catch {
    return null;
  }
}

/** Gate validator for the task-113 deployed-acceptance record. */
function validateDeployedAcceptanceSubject(evidence, {
  tenantRef, build, now = new Date(), hmacKey, evidenceDir = process.cwd(), trustedRunners = TRUSTED_RUNNERS,
} = {}) {
  const failures = [];
  if (!tenantRef) failures.push('deployed acceptance requires the expected tenant identity');
  if (!build) failures.push('deployed acceptance requires the expected candidate build');
  if (build && evidence.build !== build) failures.push(`build mismatch: evidence is '${evidence.build}', candidate is '${build}'`);
  if (evidence.operation !== DEPLOYED_ACCEPTANCE_OPERATION) {
    failures.push(`operation mismatch: expected '${DEPLOYED_ACCEPTANCE_OPERATION}', got '${evidence.operation ?? 'missing'}'`);
  }
  if (evidence.credentialMode !== DEPLOYED_ACCEPTANCE_CREDENTIAL_MODE) {
    failures.push(`deployed acceptance requires credential mode '${DEPLOYED_ACCEPTANCE_CREDENTIAL_MODE}'`);
  }

  const observedAt = Date.parse(evidence.observedAt);
  if (!Number.isNaN(observedAt) && now.getTime() - observedAt > DEPLOYED_ACCEPTANCE_MAX_AGE_HOURS * 60 * 60 * 1000) {
    failures.push(`deployed acceptance evidence is stale (older than ${DEPLOYED_ACCEPTANCE_MAX_AGE_HOURS}h)`);
  }

  // Both proofs are required: the runner signature binds the record, the
  // artifact digest binds the raw capture transcript the record summarizes.
  const runner = verifyRunnerProof(evidence, evidence.proof?.runner, { hmacKey, trustedRunners });
  if (!runner.ok) failures.push(`deployed acceptance runner proof required (${runner.reason})`);
  else if (runner.synthetic && evidence.evidenceLevel === 'live-qualified') {
    failures.push('fixture runner evidence cannot claim live qualification');
  }
  if (evidence.synthetic && evidence.evidenceLevel === 'live-qualified') {
    failures.push('synthetic evidence cannot claim live qualification');
  }
  const artifactProof = verifyArtifactDigest(evidence.proof?.artifact, evidenceDir);
  if (!artifactProof.ok) failures.push(`deployed acceptance capture transcript required (${artifactProof.reason})`);

  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];

  const deployment = subject.deployment;
  if (!deployment || typeof deployment.revision !== 'string' || !deployment.revision) {
    failures.push('missing prerequisite: deployed revision identity');
  } else {
    if (deployment.revision !== evidence.build) failures.push('deployed revision does not match the candidate build');
    if (deployment.dirty !== false) failures.push('deployed checkout is not clean (or unknown)');
  }

  const probes = Array.isArray(subject.probes) ? subject.probes : [];
  for (const probe of probes) {
    if (!DEPLOYED_ACCEPTANCE_PROBES.some((spec) => spec.surface === probe?.surface)) {
      failures.push(`probe surface '${probe?.surface ?? 'missing'}' is outside the closed inventory`);
    }
  }
  for (const spec of DEPLOYED_ACCEPTANCE_PROBES) {
    const matching = probes.filter((p) => p?.surface === spec.surface);
    const label = spec.prerequisite ? `missing prerequisite ${spec.prerequisite} (${spec.surface})` : `missing probe (${spec.surface})`;
    if (matching.length !== 1) {
      failures.push(`${label}: expected exactly one probe, found ${matching.length}`);
      continue;
    }
    const probeFailures = deployedProbeFailures(spec, matching[0],
      { observedAt: Number.isNaN(observedAt) ? undefined : observedAt });
    if (probeFailures.length) failures.push(`${label}: ${probeFailures.join('; ')}`);
  }

  if (artifactProof.ok) {
    const transcript = readCaptureArtifact(evidence.proof.artifact, evidenceDir);
    if (!transcript) failures.push('capture transcript is not JSON');
    else {
      if (transcript.build !== evidence.build) failures.push('capture transcript build differs from the record');
      if (transcript.tenantRef !== evidence.tenantRef) failures.push('capture transcript tenant differs from the record');
      if (canonical(transcript.deployment) !== canonical(subject.deployment)) failures.push('capture transcript deployment differs from the record');
      if (canonical(transcript.probes) !== canonical(subject.probes)) failures.push('capture transcript probes differ from the record');
    }
  }
  return failures;
}

/**
 * Task-116: bounded same-tenant drill and Keel recovery acceptance.
 *
 * The record binds three independently produced results to one tenant, build
 * and operation, signed by a trusted runner:
 *  - the task-72 live drill record (one disposable keel-rehearsal-* group,
 *    observed elapsed time inside its bound, every created object read back
 *    absent — the post-state), exactly as the rehearsal evidence row holds it;
 *  - the task-68 read-only Keel reconstruction from independent artifacts;
 *  - the task-76 onboarding confirmation that read and restore setup are done.
 * proof.artifact must be the raw captured drill evidence row and reconstruction
 * summary; the signed subject must equal it. An offline plan check, a failed or
 * unbounded drill, a residual, a foreign tenant or object, or a missing
 * prerequisite never verifies. Nothing here runs a drill or signs by itself.
 */
export const DRILL_LIVE_GATE = 'drill-live-acceptance';
export const DRILL_LIVE_OPERATION = 'recovery-drill.bounded-same-tenant';
export const DRILL_LIVE_CREDENTIAL_MODE = 'collector-restorer-separate';
const DRILL_CLEANUP_RESERVE = 4;

function sameInstantOrder(earlier, later) {
  const a = Date.parse(earlier);
  const b = Date.parse(later);
  return !Number.isNaN(a) && !Number.isNaN(b) && a <= b;
}

function readDrillCaptureArtifact(artifact, evidenceDir) {
  if (!artifact || typeof artifact.path !== 'string') return null;
  try {
    return JSON.parse(readFileSync(resolve(evidenceDir, artifact.path), 'utf8'));
  } catch {
    return null;
  }
}

/** Gate validator for the task-116 drill-live-acceptance record. */
function validateDrillLiveAcceptanceSubject(evidence, {
  tenantRef, build, evidenceDir = process.cwd(), now = new Date(), maxAgeHours = DEFAULT_MAX_AGE_HOURS,
} = {}) {
  const failures = [];
  if (!tenantRef || !build) failures.push('drill acceptance needs the expected tenant and build');
  if (build && evidence.build !== build) failures.push('drill acceptance build mismatch');
  if (evidence.operation !== DRILL_LIVE_OPERATION) {
    failures.push(`operation mismatch: expected '${DRILL_LIVE_OPERATION}', got '${evidence.operation ?? 'missing'}'`);
  }
  if (evidence.credentialMode !== DRILL_LIVE_CREDENTIAL_MODE) {
    failures.push(`drill acceptance needs credential mode '${DRILL_LIVE_CREDENTIAL_MODE}'`);
  }
  const subject = evidence.subject;
  if (!subject || typeof subject !== 'object') return [...failures, 'subject is missing'];
  if (subject.scope !== 'bounded-same-tenant') failures.push('drill acceptance scope must be bounded-same-tenant');

  // Prerequisites: the task-72 harness contract and the task-76 onboarding result.
  const harness = subject.prerequisites?.drillHarness;
  if (harness?.task !== 'task-72' || harness.manifestVersion !== DRILL_MANIFEST_VERSION
    || harness.manifestKind !== DRILL_MANIFEST_KIND) {
    failures.push('missing prerequisite: task-72 bounded drill harness identity');
  }
  const onboarding = subject.prerequisites?.onboarding;
  if (onboarding?.task !== 'task-76' || onboarding.readSetup !== 'complete' || onboarding.restoreSetup !== 'complete'
    || typeof onboarding.readSetupRunId !== 'string' || !onboarding.readSetupRunId
    || typeof onboarding.restoreSetupRunId !== 'string' || !onboarding.restoreSetupRunId) {
    failures.push('missing prerequisite: task-76 read and restore setup confirmed complete');
  }

  // The named disposable test object, and nothing else.
  const testObject = subject.testObject;
  if (testObject?.resourceType !== 'group' || typeof testObject.naturalKey !== 'string'
    || !testObject.naturalKey.startsWith(DISPOSABLE_PREFIX)) {
    failures.push(`the test object must be a named disposable ${DISPOSABLE_PREFIX}* group`);
  }

  // The live drill record itself.
  const drill = subject.drillRecord;
  if (!drill || typeof drill !== 'object') {
    failures.push('missing prerequisite: task-72 live drill record');
  } else {
    if (drill.tenantRef !== evidence.tenantRef || (tenantRef && drill.tenantRef !== tenantRef)) {
      failures.push('drill record tenant mismatch');
    }
    const verdict = classifyDrillRecord(drill, { tenantRef: evidence.tenantRef });
    if (!verdict.counts) failures.push(`drill record does not count as a recovery drill: ${verdict.reason}`);
    const objects = Array.isArray(drill.objects) ? drill.objects : [];
    if (objects.length !== 1 || objects[0] !== testObject?.naturalKey) {
      failures.push('drill record must name exactly the declared disposable test object');
    }
    if (objects.some((key) => typeof key !== 'string' || !key.startsWith(DISPOSABLE_PREFIX))) {
      failures.push('drill record names a non-disposable object (active users and tenant-wide policies are out of scope)');
    }
    const created = Array.isArray(drill.createdObjects) ? drill.createdObjects : [];
    if (created.length === 0) failures.push('drill record shows no created object: nothing was round-tripped');
    if (created.some((item) => !objects.includes(item?.naturalKey))) {
      failures.push('drill record created an object outside its allowlist');
    }
    const absent = new Set((drill.cleanup?.verifiedAbsent ?? []).map((item) => item?.objectId));
    if (created.some((item) => !absent.has(item?.objectId)) || (drill.cleanup?.residuals ?? []).length !== 0) {
      failures.push('post-state not verified: a created object was not read back absent');
    }
    const bounds = drill.bounds ?? {};
    if (!(bounds.maxElapsedMs <= DRILL_LIMITS.maxElapsedMs) || !(bounds.maxWrites <= DRILL_LIMITS.maxWrites)) {
      failures.push('drill bounds exceed the task-72 ceilings');
    }
    if (!Number.isInteger(drill.writes) || drill.writes > bounds.maxWrites + DRILL_CLEANUP_RESERVE) {
      failures.push('drill write count is missing or beyond its bound');
    }
    const started = Date.parse(drill.startedAt);
    if (Number.isNaN(started) || now.getTime() - started > maxAgeHours * 60 * 60 * 1000) {
      failures.push(`drill is stale (started more than ${maxAgeHours}h ago) or has no start`);
    }
    if (!sameInstantOrder(drill.finishedAt, evidence.observedAt)) {
      failures.push('evidence was observed before the drill finished');
    }
  }

  // Read-only Keel reconstruction from independent artifacts (task-68).
  const recon = subject.reconstruction;
  if (!recon || typeof recon !== 'object') {
    failures.push('missing prerequisite: task-68 read-only reconstruction result');
  } else {
    if (recon.task !== 'task-68' || recon.ok !== true || recon.stage !== 'recovered') {
      failures.push('reconstruction did not recover');
    }
    if (recon.readOnly !== true || recon.writersDisabled !== true) failures.push('reconstruction was not read-only');
    if (recon.tenantRef !== evidence.tenantRef) failures.push('reconstruction tenant mismatch');
    if (recon.buildRevision !== evidence.build) failures.push('reconstruction build mismatch');
    const checkpoint = recon.checkpoint;
    if (!Number.isInteger(checkpoint?.headSeq) || typeof checkpoint?.headHash !== 'string'
      || !Number.isInteger(checkpoint?.recordCount)) {
      failures.push('reconstruction carries no verified evidence checkpoint');
    }
    const completed = Date.parse(recon.completedAt);
    if (Number.isNaN(completed) || now.getTime() - completed > maxAgeHours * 60 * 60 * 1000) {
      failures.push(`reconstruction is stale (older than ${maxAgeHours}h) or has no completion time`);
    } else if (!sameInstantOrder(recon.completedAt, evidence.observedAt)) {
      failures.push('evidence was observed before the reconstruction completed');
    }
  }

  // Independently captured raw evidence: the signed subject must equal it.
  const capture = readDrillCaptureArtifact(evidence.proof?.artifact, evidenceDir);
  const artifactProof = verifyArtifactDigest(evidence.proof?.artifact, evidenceDir);
  if (!artifactProof.ok) {
    failures.push(`missing external evidence: captured drill artifact (${artifactProof.reason})`);
  } else if (!capture) {
    failures.push('missing external evidence: captured drill artifact is not JSON');
  } else {
    const row = capture.drillEvidence;
    if (row?.kind !== RECOVERY_DRILL_EVIDENCE_KIND || row.tenant_ref !== evidence.tenantRef
      || !Number.isInteger(row.seq) || typeof row.record_hash !== 'string') {
      failures.push('captured artifact is not this tenant\'s recovery-drill evidence row');
    }
    if (canonical(row?.subject) !== canonical(drill)) failures.push('signed drill record differs from the captured evidence row');
    if (canonical(capture.reconstruction) !== canonical(recon)) {
      failures.push('signed reconstruction differs from the captured reconstruction');
    }
  }
  return failures;
}

/**
 * Builds the task-116 record from a captured recovery-drill evidence row, the
 * task-68 reconstructRecovery() result (plus the tenantRef, buildRevision and
 * completedAt it ran with) and the task-76 onboarding result, writes the
 * raw capture artifact, and signs with the runner identity it is given. The
 * evidence level follows the runner: a synthetic runner yields a fixture-tested
 * record and can never yield a live one. Refuses anything that does not count.
 */
export function captureDrillLiveAcceptance({
  drillEvidence, reconstruction, onboarding, build, observedAt = new Date().toISOString(),
  artifactPath, artifactRef, runner = {}, trustedRunners = TRUSTED_RUNNERS,
}) {
  const trusted = trustedRunners[runner.identity];
  if (!trusted) throw new Error(`untrusted runner identity: ${runner.identity ?? 'missing'}`);
  if (!runner.key) throw new Error('no runner signing key supplied');
  if (!build) throw new Error('capture needs the build identity');
  const drill = drillEvidence?.subject;
  const tenantRef = drillEvidence?.tenant_ref;
  if (drillEvidence?.kind !== RECOVERY_DRILL_EVIDENCE_KIND || !tenantRef) {
    throw new Error('capture needs a recovery-drill evidence row');
  }
  const verdict = classifyDrillRecord(drill, { tenantRef });
  if (!verdict.counts) throw new Error(`the drill does not count as a recovery drill: ${verdict.reason}`);
  if (reconstruction?.ok !== true || reconstruction.stage !== 'recovered' || reconstruction.readOnly !== true
    || reconstruction.recovered?.evidence?.chainOk !== true) {
    throw new Error('the reconstruction did not recover read-only with a verified evidence chain');
  }
  const head = reconstruction.recovered.evidence;
  const recon = {
    task: 'task-68',
    ok: true,
    stage: reconstruction.stage,
    readOnly: reconstruction.readOnly,
    writersDisabled: reconstruction.writersDisabled,
    tenantRef: reconstruction.tenantRef,
    buildRevision: reconstruction.buildRevision,
    checkpoint: { headSeq: head.headSeq, headHash: head.headHash, recordCount: head.recordCount },
    recoveryComplete: reconstruction.recoveryComplete ?? false,
    incomplete: reconstruction.incomplete ?? [],
    completedAt: reconstruction.completedAt,
  };
  const row = {
    seq: Number(drillEvidence.seq), record_hash: drillEvidence.record_hash, kind: drillEvidence.kind,
    tenant_ref: tenantRef, occurred_at: new Date(drillEvidence.occurred_at).toISOString(), subject: drill,
  };
  const bytes = Buffer.from(`${JSON.stringify({ drillEvidence: row, reconstruction: recon }, null, 2)}\n`);
  if (artifactPath) writeFileSync(artifactPath, bytes);
  const unsigned = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: DRILL_LIVE_GATE,
    tenantRef,
    build,
    operation: DRILL_LIVE_OPERATION,
    credentialMode: DRILL_LIVE_CREDENTIAL_MODE,
    observedAt,
    evidenceLevel: trusted.synthetic ? 'fixture-tested' : 'live-qualified',
    synthetic: trusted.synthetic,
    subject: {
      scope: 'bounded-same-tenant',
      prerequisites: {
        drillHarness: { task: 'task-72', manifestVersion: DRILL_MANIFEST_VERSION, manifestKind: DRILL_MANIFEST_KIND },
        onboarding: {
          task: 'task-76',
          readSetup: onboarding?.readSetup ?? 'missing',
          restoreSetup: onboarding?.restoreSetup ?? 'missing',
          readSetupRunId: onboarding?.readSetupRunId ?? null,
          restoreSetupRunId: onboarding?.restoreSetupRunId ?? null,
        },
      },
      testObject: { resourceType: 'group', naturalKey: drill.objects?.[0] ?? null },
      drillRecord: drill,
      reconstruction: recon,
    },
    proof: {
      artifact: { path: artifactRef ?? artifactPath, sha256: createHash('sha256').update(bytes).digest('hex') },
    },
  };
  return { evidence: signEvidence(unsigned, runner.key, runner.identity), artifact: bytes };
}

// Later tasks register additional gates here; an absent gate fails closed.
const GATE_VALIDATORS = {
  'release-readiness': validateReleaseReadinessSubject,
  'nist-benchmark-acceptance': validateNistSubject,
  'scubagear-benchmark-acceptance': validateScubaGearBenchmarkAcceptanceSubject,
  // Task-115: the raw capture artifact is passed only after its digest verified.
  [NATIVE_LIVE_GATE]: (evidence, { tenantRef, build, artifact }) =>
    validateNativeLiveAcceptance(evidence, { tenantRef, build, artifactBytes: artifact.ok ? artifact.bytes : null }),
  [DEPLOYED_ACCEPTANCE_GATE]: validateDeployedAcceptanceSubject,
  // Task-114: needs the runner signature AND the digest-verified raw capture.
  [STORAGE_LIVE_GATE]: (evidence, { tenantRef, build, artifact, hmacKey, trustedRunners }) =>
    validateStorageLiveAcceptance(evidence, { tenantRef, build, artifactBytes: artifact.ok ? artifact.bytes : null, artifactReason: artifact.reason,
      runner: verifyRunnerProof(evidence, evidence.proof?.runner, { hmacKey, trustedRunners }) }),
  [DRILL_LIVE_GATE]: validateDrillLiveAcceptanceSubject,
  // Task-120: SharePoint configuration workload live acceptance.
  [SHAREPOINT_LIVE_GATE]: validateSharePointLiveSubject,
  // Task-121: Teams live acceptance; needs both proofs and a verified task-120 record.
  [TEAMS_LIVE_GATE]: (evidence, context) => validateTeamsLiveSubject(evidence, {
    ...context, runner: verifyRunnerProof(evidence, evidence.proof?.runner, context), verifyEvidence }),
  // Task-117: Sentinel workspace ingestion; needs both proofs (runner signature and capture log).
  [SENTINEL_LIVE_GATE]: (evidence, context) => validateSentinelLiveSubject(evidence, {
    ...context, runner: verifyRunnerProof(evidence, evidence.proof?.runner, context) }),
};

export function verifyEvidence(evidence, {
  gate = null,
  tenantRef = null,
  build = null,
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

  if (evidence.gate === 'nist-benchmark-acceptance' && evidence.status === 'pending') {
    return { ok: false, failures: ['NIST external runner evidence pending'] };
  }
  if (evidence.gate === SHAREPOINT_LIVE_GATE && evidence.status === 'pending') {
    return { ok: false, failures: ['SharePoint live evidence pending: no record has been captured'] };
  }
  if (evidence.gate === DRILL_LIVE_GATE && evidence.status === 'pending') {
    return { ok: false, failures: ['drill-live-acceptance external execution/cleanup evidence pending'] };
  }
  if (evidence.gate === DEPLOYED_ACCEPTANCE_GATE && evidence.status !== undefined) {
    const reasons = Array.isArray(evidence.pendingReasons) ? evidence.pendingReasons : [];
    return { ok: false, failures: [`deployed acceptance external evidence ${evidence.status}`, ...reasons] };
  }
  // A pending placeholder records that external evidence does not exist yet; it never verifies.
  if (evidence.status === 'pending') {
    return { ok: false, failures: [`${evidence.gate ?? 'qualification'} external runner evidence pending`] };
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

  if (evidence.gate === DRILL_LIVE_GATE) {
    if (!runner.ok) failures.push(`drill acceptance runner proof required (${runner.reason})`);
    if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic || runner.synthetic)) {
      failures.push('fixture drill evidence cannot claim live qualification');
    }
  }

  if (evidence.gate === 'nist-benchmark-acceptance') {
    if (evidence.proof?.artifact && !artifact.ok) failures.push(artifact.reason);
    if (!runner.ok) failures.push(`NIST runner proof required (${runner.reason})`);
    if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic || runner.synthetic)) {
      failures.push('NIST fixture evidence cannot claim live qualification');
    }
  }

  // Task-115: a native recovery claim needs BOTH an independently signed runner
  // record and its raw capture artifact, and fixture evidence never claims live.
  if (evidence.gate === NATIVE_LIVE_GATE) {
    if (!runner.ok) failures.push(`native recovery runner proof required (${runner.reason})`);
    if (!artifact.ok) failures.push(`native recovery raw capture required (${artifact.reason})`);
    if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner.synthetic)) {
      failures.push('native recovery fixture evidence cannot claim live qualification');
    }
  }

  // Task-120: both proofs are required — the runner signature over the record and
  // the digest of the raw capture log it was built from.
  if (evidence.gate === SHAREPOINT_LIVE_GATE) {
    if (!runner.ok) failures.push(`SharePoint runner proof required (${runner.reason})`);
    if (!artifact.ok) failures.push(`SharePoint capture artifact required (${artifact.reason})`);
    if (evidence.evidenceLevel === 'live-qualified' && (evidence.synthetic !== false || runner.synthetic)) {
      failures.push('SharePoint fixture evidence cannot claim live qualification');
    }
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
  else failures.push(...validator(evidence, { tenantRef, build, artifact, now, maxAgeHours, hmacKey, evidenceDir, trustedRunners }));

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

/** The tenant reference of the host's tenant config, or null when absent. */
export function configuredTenantRef(path = process.env.KEEL_TENANT_CONFIG_PATH) {
  if (!path) return null;
  try {
    return tenantRefFor(JSON.parse(readFileSync(path, 'utf8')).tenantId);
  } catch {
    return null;
  }
}

function readJsonFile(path, label) {
  if (!path) throw new Error(`missing --${label} <file>`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** Latest recovery-drill evidence row for a tenant, read from the rehearsal database. */
export async function loadLatestDrillEvidence(client, { tenantRef }) {
  if (!tenantRef) throw new Error('loading drill evidence needs a tenantRef');
  const { rows } = await client.query(
    `SELECT seq, record_hash, kind, tenant_ref, occurred_at, subject
       FROM evidence
      WHERE tenant_ref = $1 AND kind = $2
      ORDER BY seq DESC
      LIMIT 1`,
    [tenantRef, RECOVERY_DRILL_EVIDENCE_KIND],
  );
  if (!rows[0]) throw new Error(`no recovery-drill evidence for ${tenantRef}`);
  return rows[0];
}

/**
 * capture-drill: the runner-side capture of task-116 evidence. Reads the drill
 * row (--drill-row file, or the latest row in --db-url for --tenant), the
 * reconstruction result (--reconstruction) and the onboarding result
 * (--onboarding), writes the raw capture artifact next to --out and the signed
 * record to --out. The key comes from KEEL_QUALIFICATION_HMAC_KEY only.
 */
async function captureCommand() {
  const out = arg('out');
  if (!out) throw new Error('missing --out <evidence file>');
  let drillEvidence;
  if (arg('drill-row')) {
    drillEvidence = readJsonFile(arg('drill-row'), 'drill-row');
  } else {
    const { connect } = await import('../../engine/store/db.mjs');
    const client = await connect(arg('db-url', process.env.KEEL_DB_TEST_URL));
    try {
      drillEvidence = await loadLatestDrillEvidence(client, {
        tenantRef: arg('tenant', process.env.KEEL_QUALIFICATION_TENANT_REF),
      });
    } finally {
      await client.end();
    }
  }
  const artifactRef = out.replace(/\.json$/, '') + '.capture.json';
  const { evidence } = captureDrillLiveAcceptance({
    drillEvidence,
    reconstruction: readJsonFile(arg('reconstruction'), 'reconstruction'),
    onboarding: readJsonFile(arg('onboarding'), 'onboarding'),
    build: arg('build', process.env.KEEL_QUALIFICATION_BUILD ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()),
    artifactPath: artifactRef,
    artifactRef: artifactRef.split('/').pop(),
    runner: { identity: arg('runner', 'keel-release-runner'), key: process.env.KEEL_QUALIFICATION_HMAC_KEY },
  });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ captured: out, artifact: artifactRef, evidenceLevel: evidence.evidenceLevel }));
}

function main() {
  const command = process.argv[2];
  if (command === 'capture-drill') {
    captureCommand().catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
    return;
  }
  if (command !== 'verify' || process.argv.includes('--help')) {
    console.error('usage: qualification.mjs verify --gate <gate> --evidence <file> [--tenant <ref>] [--require-live] [--max-age-hours N]\n'
      + '       qualification.mjs capture-drill --out <file> --reconstruction <file> --onboarding <file> (--drill-row <file> | --db-url <url> --tenant <ref>) [--build <rev>]');
    process.exit(command === 'verify' ? 0 : 2);
  }
  const evidencePath = arg('evidence');
  if (!evidencePath) {
    console.error('missing --evidence <file>');
    process.exit(2);
  }
  const gate = arg('gate');
  const result = verifyEvidenceFile(evidencePath, {
    gate,
    tenantRef: arg('tenant', process.env.KEEL_QUALIFICATION_TENANT_REF
      ?? ([DEPLOYED_ACCEPTANCE_GATE, STORAGE_LIVE_GATE].includes(gate) ? configuredTenantRef() : undefined)),
    build: arg('build', process.env.KEEL_QUALIFICATION_BUILD ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()),
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
