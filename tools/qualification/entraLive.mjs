#!/usr/bin/env node
/**
 * Issue #148: turn one production restore on the TEST tenant into live evidence
 * for one registered Entra write, promote it, or record a demotion.
 *
 *   # After `keel-restore --artifact A --enforce` on the test tenant:
 *   node tools/qualification/entraLive.mjs capture --restore-ref A --resource-type group --operation create \
 *     --fixture KEEL-RT-148-group --target-config /etc/keel/restorer.json --build B --out DIR \
 *     [--allow-tenant-setting] [--allow-by-reference] [--db-url URL]
 *
 *   # Offline: a synthetic record from the fixture harness (never promotable).
 *   node tools/qualification/entraLive.mjs capture --offline --resource-type group --operation create --build B --out DIR
 *
 *   node tools/qualification/entraLive.mjs promote --evidence DIR/group.create.json [--tenant REF]
 *   node tools/qualification/entraLive.mjs demote --resource-type group --operation create --restore-ref A \
 *     --reason 'what failed' --out DIR
 *
 * capture never writes to a tenant and never calls Graph: it reads the restore's
 * own rollback journal (what applyWave wrote, and whether its read-back
 * verified) from the KEEL database. It refuses, before writing any file:
 *  - a target config whose tenant is not the test tenant (TEST_TENANT_REFS);
 *  - a restore artifact from another tenant;
 *  - an operation that is not registered;
 *  - a fixture that is not a KEEL-RT-* / keel-rehearsal-* object, unless the
 *    reviewed guidance says it is a tenant-wide setting or an object that only
 *    points at fixtures and the operator passed the matching --allow flag;
 *  - output that still holds the raw tenant id or credential material.
 * Every id is pseudonymized (#138, pseudonymize.mjs) before it is written.
 *
 * promote runs the record through capabilities.mjs's qualifyLiveEvidence (the
 * policy family's own gate first, where one exists) after checking the runner
 * signature, the test tenant and the capture digest. It changes the claim of
 * this process only: the committed records are what make the ledger show
 * live-qualified (`operations.mjs --live-evidence DIR`).
 *
 * demote writes a demotion record. A builder then removes the registration in
 * capabilities.mjs and puts the reason into TYPE_DECISIONS; the test
 * engine/roadmap/entra-live-gate.test.mjs fails until both are done.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FIELD_PROJECTION_CONTRACT_VERSION } from '../../engine/contracts/fieldProjection.mjs';
import { capabilityFor, isSupportedClaim, qualifyLiveEvidence } from '../../engine/coverage/capabilities.mjs';
import { TYPE_DECISIONS } from '../../engine/coverage/qualification.mjs';
import { ENFORCEMENT_STEP } from '../../engine/restore/conditionalAccessEnforcement.mjs';
import { getDryRunArtifactById } from '../../engine/restore/dryRunArtifact.mjs';
import { isPolicyGoverned, policyProofFor, qualifyPolicyLiveEvidence } from '../../engine/restore/policyOperations.mjs';
import { listJournal } from '../../engine/restore/rollbackJournal.mjs';
import { tenantRefFor } from '../../engine/store/tenantRef.mjs';
import { signEvidence } from '../release/qualification.mjs';
import { ENTRA_LIVE_EVIDENCE_DIR, evidenceStem, guidanceFor } from './live-gate-plan.mjs';
import { runFixtureHarness } from './operations.mjs';
import { pseudonymizer } from './pseudonymize.mjs';

export const ENTRA_LIVE_GATE = 'entra-live-acceptance';
export const ENTRA_LIVE_KIND = 'entra-live-write-capture';
export const ENTRA_DEMOTION_KIND = 'entra-live-demotion';
export const ENTRA_LIVE_CONTRACT_VERSION = 1;
/**
 * The test tenant, by its derived reference (never its raw id). It is the tenant
 * every committed live gate record in docs/release/qualifications was captured
 * in; engine/roadmap/entra-live-gate.test.mjs checks that they still agree.
 */
export const TEST_TENANT_REFS = Object.freeze(['sha256:f7b3959300856957']);

const LIVE_RUNNER = 'keel-release-runner';
const FIXTURE_RUNNER = 'keel-fixture-runner';
const RUNNERS = Object.freeze({ [LIVE_RUNNER]: { synthetic: false }, [FIXTURE_RUNNER]: { synthetic: true } });
const DISPOSABLE = /(?:^|[^A-Za-z0-9])(?:KEEL-RT-|keel-rehearsal-)/i;
const NAME_FIELDS = Object.freeze(['displayName', 'name', 'mailNickname', 'userPrincipalName']);
const SECRET_PATTERNS = Object.freeze([
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /postgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]+@/,
  /"(?:secretText|password|clientSecret|privateKey)"\s*:\s*"[^"]+"/i,
]);

export class LiveGateRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'LiveGateRefusal';
  }
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Which ledger key and operation a journal entry is (edges are journaled under 'group'). */
function journalIdentity(entry, { enforcement }) {
  const operation = entry.operation ?? '';
  if (operation.startsWith('edge-')) return { key: `group#${entry.priorState?.family}`, operation };
  if (enforcement) return { key: entry.resourceType, operation: operation === 'update' ? ENFORCEMENT_STEP : operation };
  return { key: entry.resourceType, operation };
}

const matchesFixture = (entry, fixture) => entry.naturalKey === fixture || String(entry.naturalKey).startsWith(`edge:${fixture}|`);

function looksDisposable(entry) {
  if (DISPOSABLE.test(String(entry.naturalKey ?? ''))) return true;
  return [entry.intendedState, entry.priorState, entry.postState].some((state) => state && typeof state === 'object'
    && NAME_FIELDS.some((field) => typeof state[field] === 'string' && DISPOSABLE.test(state[field])));
}

/** Refuses unless the tenant reference is a test tenant. */
export function assertTestTenant(tenantRef, testTenantRefs = TEST_TENANT_REFS) {
  if (!testTenantRefs.includes(tenantRef)) {
    throw new LiveGateRefusal(`refusing: tenant ${tenantRef} is not the test tenant; live gate #148 runs on the test tenant only`);
  }
  return tenantRef;
}

function assertSafeText(text, { rawTenantId, label }) {
  if (rawTenantId && text.toLowerCase().includes(String(rawTenantId).toLowerCase())) {
    throw new LiveGateRefusal(`refusing: ${label} still holds the raw tenant id after pseudonymization`);
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new LiveGateRefusal(`refusing: ${label} holds credential material`);
  }
}

function policyFields(resourceType, operation) {
  if (!isPolicyGoverned(resourceType)) return {};
  const subtype = capabilityFor(resourceType, operation).subtype;
  const proof = policyProofFor(resourceType, operation, subtype);
  return { subtype, projectionDigest: proof.record?.projectionDigest ?? null };
}

/**
 * Builds the signed record and the pseudonymized capture log from one restore.
 * `client` is a KEEL database client (only read). Returns { status, record, captureLog }:
 * status 'captured' (the write succeeded and read back), 'failed' (a demotion
 * candidate) or 'not-exercised' (the restore made no such write; report as blocked).
 */
export async function captureLive({
  client, restoreRef, resourceType, operation, fixture, targetConfig, build, hmacKey,
  allowTenantSetting = false, allowByReference = false, testTenantRefs = TEST_TENANT_REFS,
  getArtifact = getDryRunArtifactById, getJournal = listJournal,
}) {
  for (const [name, value] of Object.entries({ restoreRef, resourceType, operation, fixture, build })) {
    if (typeof value !== 'string' || value.length === 0) throw new LiveGateRefusal(`--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (!/^[0-9a-f]{7,40}$/.test(build)) throw new LiveGateRefusal('--build must be the deployed commit sha');
  if (!hmacKey) throw new LiveGateRefusal('KEEL_QUALIFICATION_HMAC_KEY is required to sign a live record');
  if (typeof targetConfig?.tenantId !== 'string' || targetConfig.tenantId.length === 0) throw new LiveGateRefusal('the target config names no tenant');
  const rawTenantId = targetConfig.tenantId;
  const tenantRef = assertTestTenant(tenantRefFor(rawTenantId), testTenantRefs);

  const enforcement = operation === ENFORCEMENT_STEP;
  if (enforcement && resourceType !== 'conditionalAccessPolicy') throw new LiveGateRefusal(`${ENFORCEMENT_STEP} exists only for conditionalAccessPolicy`);
  if (!enforcement && !isSupportedClaim(capabilityFor(resourceType, operation).claim)) {
    throw new LiveGateRefusal(`${resourceType} ${operation} is not a registered write; nothing to qualify`);
  }

  const artifact = await getArtifact(client, { id: restoreRef });
  if (!artifact) throw new LiveGateRefusal(`no restore artifact ${restoreRef}`);
  if (artifact.tenantRef !== tenantRef) throw new LiveGateRefusal('refusing: the restore artifact belongs to a different tenant');
  if (enforcement !== Boolean(artifact.conditionalAccessEnforcement)) {
    throw new LiveGateRefusal(enforcement ? 'that artifact is not a Conditional Access enforcement step' : 'that artifact is an enforcement step; capture it with --operation ' + ENFORCEMENT_STEP);
  }

  const guidance = guidanceFor(resourceType);
  const entries = (await getJournal(client, { restoreRef }))
    .filter((entry) => matchesFixture(entry, fixture))
    .filter((entry) => {
      const identity = journalIdentity(entry, { enforcement });
      return identity.key === resourceType && identity.operation === operation;
    });
  if (entries.length === 0) {
    return { status: 'not-exercised', record: null, captureLog: null, reason: `restore ${restoreRef} made no ${resourceType} ${operation} write for ${fixture}` };
  }
  const entry = entries[entries.length - 1];

  if (!looksDisposable(entry)) {
    if (guidance.kind === 'tenant-setting' && !allowTenantSetting) {
      throw new LiveGateRefusal(`${resourceType} is a tenant-wide setting: pass --allow-tenant-setting once decision D-148b allows it`);
    }
    if (guidance.kind === 'by-reference' && !allowByReference) {
      throw new LiveGateRefusal(`${resourceType} has no name of its own: confirm its principal and role are KEEL-RT fixtures and pass --allow-by-reference`);
    }
    if (guidance.kind === 'named-object') {
      throw new LiveGateRefusal(`refusing: ${fixture} is not a disposable KEEL-RT-* or keel-rehearsal-* fixture`);
    }
  }

  const { walk } = pseudonymizer(tenantRef);
  const ok = entry.outcome === 'succeeded';
  const log = walk({
    restoreRef,
    entry: {
      naturalKey: entry.naturalKey, resourceType: entry.resourceType, operation: entry.operation, targetId: entry.targetId,
      outcome: entry.outcome, outcomeDetail: entry.outcomeDetail, recordedAt: new Date(entry.recordedAt).toISOString(),
      priorState: entry.priorState, intendedState: entry.intendedState, postState: entry.postState,
    },
  });
  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  assertSafeText(captureLog, { rawTenantId, label: 'the capture log' });

  const stem = evidenceStem(resourceType, operation);
  const unsigned = {
    contractVersion: ENTRA_LIVE_CONTRACT_VERSION,
    kind: ENTRA_LIVE_KIND,
    gate: ENTRA_LIVE_GATE,
    issue: 148,
    tenantRef,
    resourceType,
    operation,
    ...(enforcement ? {} : policyFields(resourceType, operation)),
    fieldProjectionContractVersion: FIELD_PROJECTION_CONTRACT_VERSION,
    build,
    synthetic: false,
    evidenceLevel: ok ? 'live-qualified' : 'failed',
    ok,
    outcome: entry.outcome,
    outcomeDetail: log.entry.outcomeDetail ?? null,
    readBackVerified: ok,
    observedAt: log.entry.recordedAt,
    restoreRef: log.restoreRef,
    naturalKey: log.entry.naturalKey,
    fixtureKind: guidance.kind,
    captureSha256: sha256(captureLog),
    proofRef: `${ENTRA_LIVE_EVIDENCE_DIR}/${stem}.json`,
  };
  const record = signEvidence(unsigned, hmacKey, LIVE_RUNNER);
  assertSafeText(JSON.stringify(record), { rawTenantId, label: 'the record' });
  return { status: ok ? 'captured' : 'failed', record, captureLog };
}

/**
 * A synthetic record from the fixture harness (production applyWave against a
 * fake Graph). It is signed as the fixture runner and can never be promoted.
 */
export async function captureOffline({ resourceType, operation, build, hmacKey = 'keel-offline-fixture-key', tenantRef = 'sha256:fixture-tenant' }) {
  const [result] = (await runFixtureHarness({ types: [resourceType] })).filter((entry) => entry.operation === operation);
  if (!result) throw new LiveGateRefusal(`the fixture harness has no ${resourceType} ${operation} run`);
  const captureLog = `${JSON.stringify({ synthetic: true, writes: result.writes ?? [], result: result.result }, null, 2)}\n`;
  const stem = evidenceStem(resourceType, operation);
  const unsigned = {
    contractVersion: ENTRA_LIVE_CONTRACT_VERSION, kind: ENTRA_LIVE_KIND, gate: ENTRA_LIVE_GATE, issue: 148,
    tenantRef, resourceType, operation, ...policyFields(resourceType, operation),
    fieldProjectionContractVersion: FIELD_PROJECTION_CONTRACT_VERSION, build, synthetic: true,
    evidenceLevel: 'fixture-tested', ok: result.result === 'passed', outcome: result.result === 'passed' ? 'succeeded' : 'failed',
    outcomeDetail: result.detail ?? null, readBackVerified: result.result === 'passed', observedAt: new Date().toISOString(),
    restoreRef: null, naturalKey: `${resourceType}:fixture`, fixtureKind: 'fixture-harness',
    captureSha256: sha256(captureLog), proofRef: `${ENTRA_LIVE_EVIDENCE_DIR}/${stem}.json`,
  };
  return { status: 'synthetic', record: signEvidence(unsigned, hmacKey, FIXTURE_RUNNER), captureLog };
}

function verifyRunner(record, hmacKey) {
  const runner = record?.proof?.runner;
  if (!runner || typeof runner.identity !== 'string' || typeof runner.signature !== 'string') return { ok: false, reason: 'no runner signature' };
  const trusted = RUNNERS[runner.identity];
  if (!trusted) return { ok: false, reason: `untrusted runner ${runner.identity}` };
  if (!hmacKey) return { ok: false, reason: 'no verification key (KEEL_QUALIFICATION_HMAC_KEY) configured' };
  const expected = Buffer.from(signEvidence(record, hmacKey, runner.identity).proof.runner.signature, 'hex');
  const actual = Buffer.from(runner.signature, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { ok: false, reason: 'runner signature mismatch' };
  return { ok: true, synthetic: trusted.synthetic };
}

/**
 * Promotes one record through the real qualifyLiveEvidence path. Every check
 * here is in addition to that function's own (tenant, operation, projection
 * contract, freshness, non-synthetic, proofRef); none replaces it.
 */
export function promoteRecord(record, {
  hmacKey, captureLog = null, now = new Date(), tenantRef = TEST_TENANT_REFS[0], testTenantRefs = TEST_TENANT_REFS,
} = {}) {
  const failures = [];
  const resourceType = record?.resourceType;
  const operation = record?.operation;
  const before = resourceType && operation && operation !== ENFORCEMENT_STEP ? capabilityFor(resourceType, operation).claim : null;
  const refuse = () => ({ promoted: false, before, after: before, failures });

  if (record?.kind !== ENTRA_LIVE_KIND) failures.push(`not a ${ENTRA_LIVE_KIND} record`);
  if (operation === ENFORCEMENT_STEP) {
    failures.push('the Conditional Access enforcement step is not a registered capability; its record is kept as evidence and never promoted');
    return refuse();
  }
  if (!testTenantRefs.includes(tenantRef)) failures.push(`refusing: ${tenantRef} is not the test tenant`);
  if (!testTenantRefs.includes(record?.tenantRef)) failures.push(`refusing: the record's tenant ${record?.tenantRef} is not the test tenant`);
  const runner = verifyRunner(record, hmacKey);
  if (!runner.ok) failures.push(runner.reason);
  else if (runner.synthetic) failures.push('signed by the fixture runner: synthetic evidence is never live qualification');
  if (record?.synthetic !== false) failures.push('synthetic evidence (a fixture run) is never live qualification');
  if (record?.ok !== true || record?.outcome !== 'succeeded' || record?.readBackVerified !== true) failures.push('the write did not succeed and read back; demote instead');
  if (captureLog !== null && sha256(captureLog) !== record?.captureSha256) failures.push('the capture log does not match the record\'s captureSha256');
  if (failures.length > 0) return refuse();

  const result = isPolicyGoverned(resourceType)
    ? qualifyPolicyLiveEvidence(resourceType, operation, record, { tenantRef, now, subtype: record.subtype })
    : qualifyLiveEvidence(resourceType, operation, record, { tenantRef, now });
  return { promoted: result.promoted, before, after: capabilityFor(resourceType, operation).claim, failures: result.failures };
}

/** The demotion record a failed live capture leaves; a builder applies it in code. */
export function demotionRecord({ resourceType, operation, restoreRef = null, reason, tenantRef = TEST_TENANT_REFS[0], now = new Date() }) {
  if (typeof reason !== 'string' || reason.trim().length < 10) throw new LiveGateRefusal('--reason must say what failed, in plain words');
  if (operation !== ENFORCEMENT_STEP && !isSupportedClaim(capabilityFor(resourceType, operation).claim)) {
    throw new LiveGateRefusal(`${resourceType} ${operation} is not registered; there is nothing to demote`);
  }
  const { walk } = pseudonymizer(tenantRef);
  return {
    contractVersion: ENTRA_LIVE_CONTRACT_VERSION,
    kind: ENTRA_DEMOTION_KIND,
    gate: ENTRA_LIVE_GATE,
    issue: 148,
    tenantRef,
    resourceType,
    operation,
    reason: walk(reason.trim()),
    restoreRef: restoreRef ? walk(restoreRef) : null,
    decidedAt: now.toISOString(),
    builderSteps: [
      `remove the ${operation} registration for ${resourceType} in engine/coverage/capabilities.mjs`,
      `add "live gate #148: ${operation} failed live: <reason>" to TYPE_DECISIONS.${resourceType}.reason in engine/coverage/qualification.mjs (manual if no operation is left)`,
      'commit this file under docs/release/qualifications/entra-live/ in the same PR',
    ],
  };
}

/**
 * Committed demotions that the code has not applied yet. A demotion is applied
 * when the operation is no longer a registered write and the type's
 * TYPE_DECISIONS reason quotes the recorded reason.
 */
export function unappliedDemotions({ dir = ENTRA_LIVE_EVIDENCE_DIR, decisions = TYPE_DECISIONS, claimOf = (type, op) => capabilityFor(type, op).claim } = {}) {
  if (!existsSync(dir)) return [];
  const problems = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.demotion.json')).sort()) {
    const demotion = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const key = demotion.resourceType.split('#')[0];
    if (demotion.operation !== ENFORCEMENT_STEP && isSupportedClaim(claimOf(demotion.resourceType, demotion.operation))) {
      problems.push(`${name}: ${demotion.resourceType} ${demotion.operation} is still a registered write`);
    }
    if (!String(decisions[key]?.reason ?? '').includes(demotion.reason)) {
      problems.push(`${name}: TYPE_DECISIONS.${key}.reason does not record the demotion reason`);
    }
  }
  return problems;
}

/** Applies every committed record in `dir` (verifying each capture digest). */
export function applyCommittedEvidence({ dir = ENTRA_LIVE_EVIDENCE_DIR, hmacKey, now = new Date(), tenantRef = TEST_TENANT_REFS[0] } = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.capture.json') && !name.endsWith('.demotion.json'))
    .sort()
    .map((name) => {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const capturePath = join(dir, name.replace(/\.json$/, '.capture.json'));
      const captureLog = existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '';
      return { file: name, ...promoteRecord(record, { hmacKey, captureLog, now, tenantRef }) };
    });
}

function arg(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index > -1 ? argv[index + 1] : undefined;
}

function writeOutputs(out, stem, { record, captureLog }) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `${stem}.capture.json`), captureLog);
  writeFileSync(join(out, `${stem}.json`), `${JSON.stringify(record, null, 2)}\n`);
}

export async function main({ argv = process.argv.slice(2), out = console, env = process.env, connectFn = null, readFile = readFileSync } = {}) {
  const [command] = argv;
  const hmacKey = env.KEEL_QUALIFICATION_HMAC_KEY || null;
  try {
    if (command === 'capture') {
      const resourceType = arg(argv, 'resource-type');
      const operation = arg(argv, 'operation');
      const outDir = arg(argv, 'out');
      if (!outDir) throw new LiveGateRefusal('--out is required');
      const stem = evidenceStem(resourceType ?? '', operation ?? '');
      if (argv.includes('--offline')) {
        const result = await captureOffline({ resourceType, operation, build: arg(argv, 'build') ?? 'offline' });
        writeOutputs(outDir, stem, result);
        out.log(`synthetic record written to ${join(outDir, `${stem}.json`)} (never promotable)`);
        return 0;
      }
      const configPath = arg(argv, 'target-config');
      if (!configPath) throw new LiveGateRefusal('--target-config is required');
      const dbUrl = arg(argv, 'db-url') ?? env.KEEL_DB_URL;
      if (!dbUrl) throw new LiveGateRefusal('--db-url or KEEL_DB_URL is required');
      const connect = connectFn ?? (await import('../../engine/store/db.mjs')).connect;
      const client = await connect(dbUrl);
      try {
        const result = await captureLive({
          client, restoreRef: arg(argv, 'restore-ref'), resourceType, operation, fixture: arg(argv, 'fixture'),
          targetConfig: JSON.parse(readFile(configPath, 'utf8')), build: arg(argv, 'build'), hmacKey,
          allowTenantSetting: argv.includes('--allow-tenant-setting'), allowByReference: argv.includes('--allow-by-reference'),
        });
        if (result.status === 'not-exercised') {
          out.error(`not exercised: ${result.reason}. Report this step as blocked; nothing was written.`);
          return 4;
        }
        writeOutputs(outDir, stem, result);
        if (result.status === 'failed') {
          out.error(`the write did not succeed (${result.record.outcome}). Record written for the report; now run: entraLive.mjs demote --resource-type '${resourceType}' --operation ${operation} --restore-ref <A> --reason '<what failed>' --out ${outDir}`);
          return 3;
        }
        out.log(`captured ${resourceType} ${operation}: ${join(outDir, `${stem}.json`)}`);
        return 0;
      } finally {
        await client.end?.();
      }
    }
    if (command === 'promote') {
      const evidencePath = arg(argv, 'evidence');
      if (!evidencePath) throw new LiveGateRefusal('--evidence is required');
      const record = JSON.parse(readFile(evidencePath, 'utf8'));
      const capturePath = join(dirname(evidencePath), basename(evidencePath).replace(/\.json$/, '.capture.json'));
      const captureLog = existsSync(capturePath) ? readFile(capturePath, 'utf8') : '';
      const result = promoteRecord(record, { hmacKey, captureLog, tenantRef: arg(argv, 'tenant') ?? TEST_TENANT_REFS[0] });
      if (!result.promoted) {
        out.error(`not promoted (${record.resourceType} ${record.operation} stays ${result.after}):`);
        for (const failure of result.failures) out.error(`  - ${failure}`);
        return 1;
      }
      out.log(`promoted ${record.resourceType} ${record.operation}: ${result.before} -> ${result.after}`);
      return 0;
    }
    if (command === 'demote') {
      const outDir = arg(argv, 'out');
      if (!outDir) throw new LiveGateRefusal('--out is required');
      const record = demotionRecord({
        resourceType: arg(argv, 'resource-type'), operation: arg(argv, 'operation'),
        restoreRef: arg(argv, 'restore-ref') ?? null, reason: arg(argv, 'reason'),
      });
      mkdirSync(outDir, { recursive: true });
      const path = join(outDir, `${evidenceStem(record.resourceType, record.operation)}.demotion.json`);
      writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
      out.log(`demotion recorded: ${path}. A builder applies it (see builderSteps in the file).`);
      return 0;
    }
    out.error('usage: entraLive.mjs capture|promote|demote ... (see the file header)');
    return 2;
  } catch (error) {
    out.error(error instanceof LiveGateRefusal ? error.message : `error: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
