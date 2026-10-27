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
 *  - output that still holds the raw tenant id, a raw object id (GUID or SID) or credential material.
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
import { BRANDING_FILE_CAPABILITY, capabilityFor, isSupportedClaim, liveEvidenceFailures, qualifyLiveEvidence } from '../../engine/coverage/capabilities.mjs';
import { TYPE_DECISIONS } from '../../engine/coverage/qualification.mjs';
import { readConfigFile } from '../../engine/config/configFile.mjs';
import { ENFORCEMENT_STEP } from '../../engine/restore/conditionalAccessEnforcement.mjs';
import { getDryRunArtifactById } from '../../engine/restore/dryRunArtifact.mjs';
import { isPolicyGoverned, policyLiveEvidenceFailures, policyProofFor, qualifyPolicyLiveEvidence } from '../../engine/restore/policyOperations.mjs';
import { listJournal } from '../../engine/restore/rollbackJournal.mjs';
import { tenantRefFor } from '../../engine/store/tenantRef.mjs';
import { signEvidence } from '../release/qualification.mjs';
import { ENTRA_LIVE_EVIDENCE_DIR, evidenceStem, guidanceFor } from './live-gate-plan.mjs';
import { runFixtureHarness } from './operations.mjs';
import { pseudonymizer, rawIdentifiers } from './pseudonymize.mjs';

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
// Anchored: a fixture's own name starts with the prefix.
const DISPOSABLE = /^(?:KEEL-RT-|keel-rehearsal-)/i;
const NAME_FIELDS = Object.freeze(['displayName', 'name', 'mailNickname', 'userPrincipalName']);
/**
 * Kinds whose own name is in another field (issue #478). Only these fields count
 * for such a kind, and every one of them must name a fixture: a branding
 * profile's displayName is the organization name it shows, not its own name,
 * and an app relationship touches both of its apps.
 */
const OWN_NAME_FIELDS = Object.freeze({
  intuneBrandingProfile: Object.freeze(['profileName']),
  groupPolicyUploadedDefinitionFile: Object.freeze(['fileName']),
  mobileAppRelationship: Object.freeze(['sourceDisplayName', 'targetDisplayName']),
});

/** The fields a kind's own name is read from when its fixture is checked. */
export const nameFieldsFor = (resourceType) => OWN_NAME_FIELDS[resourceType] ?? NAME_FIELDS;

/**
 * Whether a journal entry's 'succeeded' outcome means the write was verified by
 * its read-back. applyEngine also records 'succeeded' for writes it stopped
 * short of verifying, with a detail saying so (a synced user that is restored
 * but not written, a "not-remediable residual"). Only these details mean
 * verified: none, a converged read-back, and a delete that reads back absent
 * or soft-deleted.
 */
export function verifiedOutcome(outcome, detail) {
  if (outcome !== 'succeeded') return false;
  return detail === null || detail === undefined || detail === 'absent' || detail === 'soft-deleted' || /^converged\b/.test(String(detail));
}
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

/**
 * An edge's natural key is `edge:<parent symbol>|<family>|<action>|<target>`, and the
 * parent symbol is typed (`group:KEEL-RT-148-group`). The parent's own name is the
 * symbol without its type, so the checklist's bare fixture name matches it too.
 */
const edgeParent = (naturalKey) => {
  const key = String(naturalKey ?? '');
  if (!key.startsWith('edge:')) return null;
  const symbol = key.slice(5).split('|')[0];
  return { symbol, name: symbol.replace(/^[A-Za-z]+:/, '') };
};

const matchesFixture = (entry, fixture) => {
  if (entry.naturalKey === fixture) return true;
  const parent = edgeParent(entry.naturalKey);
  return parent !== null && (parent.symbol === fixture || parent.name === fixture);
};

/**
 * Q45 (live run 2026-10-13): a tenant whose GET /organization/{id}/branding
 * answers 404 keeps its default branding only as language '0' (Graph's id for
 * the default branding). Keel backs it up and restores it at
 * /branding/localizations/0 and journals it under that language. That write is
 * the default-branding update, so it is captured for organizationalBranding
 * too; the capture log keeps the type and key it was journaled under.
 */
const DEFAULT_BRANDING_LANGUAGE_KEY = 'organizationalBrandingLocalization:0';
const DEFAULT_BRANDING_FIXTURES = Object.freeze(['organizationalBranding', 'organizationalBranding:organizationalBranding']);
const isDefaultBrandingLanguage = (entry) => entry.resourceType === 'organizationalBrandingLocalization'
  && entry.naturalKey === DEFAULT_BRANDING_LANGUAGE_KEY;

/** Whether a journal entry is the write this capture asks for. */
function isCapturedWrite(entry, { resourceType, operation, fixture, enforcement }) {
  const identity = journalIdentity(entry, { enforcement });
  if (identity.operation !== operation) return false;
  if (identity.key === resourceType && matchesFixture(entry, fixture)) return true;
  return resourceType === 'organizationalBranding' && isDefaultBrandingLanguage(entry) && DEFAULT_BRANDING_FIXTURES.includes(fixture);
}

const namesOf = (state) => (state && typeof state === 'object'
  ? NAME_FIELDS.map((field) => state[field]).filter((value) => typeof value === 'string')
  : []);

/**
 * Whether a state names a fixture: one of the default name fields does, or, for
 * a kind with its own name fields, all of them do.
 */
export function namesFixture(resourceType, state) {
  if (!state || typeof state !== 'object') return false;
  const disposable = (field) => typeof state[field] === 'string' && DISPOSABLE.test(state[field]);
  const own = OWN_NAME_FIELDS[resourceType];
  return own ? own.every(disposable) : NAME_FIELDS.some(disposable);
}

/**
 * The fixture's own name: its natural key (an edge's parent key), or a name in
 * its prior state. A create has no prior state, so the snapshot's own copy of
 * the object stands in for it. Never the intended or post-write state.
 */
function looksDisposable(entry, snapshotPayload) {
  const own = edgeParent(entry.naturalKey)?.name ?? String(entry.naturalKey ?? '');
  if (DISPOSABLE.test(own)) return true;
  return namesFixture(entry.resourceType, entry.priorState ?? snapshotPayload ?? null);
}

// Any KEEL-RT custom role: queue items recreate fixtures under a fresh prefix.
// A built-in role is refused by its payload, whatever its name.
const FIXTURE_ROLE = /^KEEL-RT-/i;

/**
 * The references a role assignment's composed natural key names
 * (`roleAssignment:<role>@<principal>@<scope>`, engine/cir/naturalKey.mjs), shaped
 * like snapshot reference rows. The role symbol holds no `@` and the scope is the
 * last part; the principal (a user principal name has its own `@`) is what lies
 * between. A tenant-wide scope ('/') is no reference. Null for any other key.
 */
export function composedKeyReferences(naturalKey) {
  const match = /^roleAssignment:([^@]+)@(.+)@([^@]+)$/.exec(String(naturalKey ?? ''));
  if (!match) return null;
  const [, role, principal, scope] = match;
  return [
    { field_path: 'roleDefinitionId', to_symbol: role },
    { field_path: 'principalId', to_symbol: principal },
    ...(scope === '/' ? [] : [{ field_path: 'directoryScopeId', to_symbol: scope }]),
  ];
}

/**
 * For an object with no name of its own (a role assignment or eligibility), the
 * names of what it points at, read from the restore's snapshot: the principal
 * must be a fixture, the role must be a KEEL-RT custom role (never a built-in
 * role), and a scope, if any, must be a fixture. A delegated consent grant
 * (oauth2PermissionGrant) is checked by its client app and its one user instead.
 */
export function byReferenceProblems({ versions, references, naturalKey, deleted = false, resourceType = null }) {
  const own = versions.find((version) => version.natural_key === naturalKey);
  // A delete removes an object the snapshot was taken without, so its references
  // come from its own composed key instead (role, principal and scope symbols).
  const keyRefs = !own && deleted ? composedKeyReferences(naturalKey) : null;
  if (!own && !keyRefs) return [`the snapshot has no object ${naturalKey}`];
  // A reference symbol is the referenced object's own natural key, typed
  // (`roleDefinition:<template id>`, `user:<upn>`), so it is looked up whole
  // first. The untyped key is only a fallback, and the name it stands for
  // when the object is not in the snapshot (a UPN names its user; a role
  // template id never matches the fixture role).
  // A deleted assignment's scope is the raw directory path from its key
  // (`/administrativeUnits/<object id>`), so it is found by the object id in the
  // snapshot's payloads instead.
  const targetOf = (symbol) => {
    const text = String(symbol ?? '');
    if (text.startsWith('/')) {
      const id = text.slice(text.lastIndexOf('/') + 1).toLowerCase();
      return { key: text, target: id ? versions.find((version) => String(version.payload?.id ?? '').toLowerCase() === id) : undefined };
    }
    const key = text.slice(text.indexOf(':') + 1);
    return {
      key,
      target: versions.find((version) => version.natural_key === text)
        ?? versions.find((version) => version.natural_key === key),
    };
  };
  const nameOf = (symbol) => {
    const { key, target } = targetOf(symbol);
    return target ? (namesOf(target.payload)[0] ?? key) : key;
  };
  const refs = keyRefs ?? references.filter((ref) => ref.from_version === own.id);
  const find = (pattern) => refs.find((ref) => pattern.test(String(ref.field_path)));
  const problems = [];
  if (resourceType === 'oauth2PermissionGrant') {
    // A delegated consent grant points at no role: its client app and the one
    // user it consents for must both be fixtures. The resource (Microsoft Graph)
    // is not, and is not checked. A consent for all users is never a fixture.
    const client = find(/^clientId$/i);
    if (!client) problems.push('no client app reference');
    else if (!DISPOSABLE.test(nameOf(client.to_symbol))) problems.push('the client app is not a KEEL-RT fixture');
    if (own && own.payload?.consentType !== 'Principal') problems.push('the consent is not for one user (consentType Principal)');
    const user = find(/^principalId$/i);
    if (!user) problems.push('no user reference');
    else if (!DISPOSABLE.test(nameOf(user.to_symbol))) problems.push('the user is not a KEEL-RT fixture');
    return problems;
  }
  const principal = find(/principal/i);
  const role = find(/roleDefinition/i);
  const scope = find(/directoryScope/i);
  if (!principal) problems.push('no principal reference');
  else if (!DISPOSABLE.test(nameOf(principal.to_symbol))) problems.push('the principal is not a KEEL-RT fixture');
  if (!role) problems.push('no role reference');
  else if (!FIXTURE_ROLE.test(nameOf(role.to_symbol)) || targetOf(role.to_symbol).target?.payload?.isBuiltIn === true) {
    problems.push('the role is not the fixture role');
  }
  if (scope && !DISPOSABLE.test(nameOf(scope.to_symbol))) problems.push('the scope is not a KEEL-RT fixture');
  return problems;
}

/**
 * A branding restore journals each uploaded file apart from the branding
 * object's own update. When the operator asked for the object and the
 * restore only uploaded files, name the file captures to run instead.
 */
async function brandingFileHint(client, { restoreRef, resourceType, getJournal }) {
  if (!/^organizationalBranding(?:Localization)?$/.test(resourceType)) return '';
  const keys = (await getJournal(client, { restoreRef }))
    .filter((entry) => entry.resourceType === BRANDING_FILE_CAPABILITY && entry.operation === 'update')
    .map((entry) => entry.naturalKey);
  if (keys.length === 0) return '';
  return `; it did upload branding files, which are their own write: capture each with --resource-type '${BRANDING_FILE_CAPABILITY}' --operation update --allow-tenant-setting --fixture one of ${[...new Set(keys)].map((key) => `'${key}'`).join(', ')}`;
}

async function snapshotRows(client, snapshotId) {
  const { getReferences, getResourceVersions } = await import('../../engine/store/db.mjs');
  return { versions: await getResourceVersions(client, { snapshotId }), references: await getReferences(client, { snapshotId }) };
}

/** Refuses unless the tenant reference is a test tenant. */
export function assertTestTenant(tenantRef, testTenantRefs = TEST_TENANT_REFS) {
  if (!testTenantRefs.includes(tenantRef)) {
    throw new LiveGateRefusal(`refusing: tenant ${tenantRef} is not the test tenant; live gate #148 runs on the test tenant only`);
  }
  return tenantRef;
}

/**
 * Refuses text that still holds the raw tenant id, any raw id (GUID or SID) the capture held
 * before pseudonymization, or credential material. Exported for its test only.
 */
export function assertSafeText(text, { rawTenantId, rawIds = [], label }) {
  const lower = text.toLowerCase();
  if (rawTenantId && lower.includes(String(rawTenantId).toLowerCase())) {
    throw new LiveGateRefusal(`refusing: ${label} still holds the raw tenant id after pseudonymization`);
  }
  if (rawIds.some((id) => lower.includes(String(id).toLowerCase()))) {
    throw new LiveGateRefusal(`refusing: ${label} still holds a raw object id after pseudonymization`);
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
 * status 'captured' (the write succeeded and its read-back verified), 'failed'
 * (a demotion candidate), 'unverified' (recorded as done but not verified; report
 * as blocked, never promoted), 'pending' (no outcome recorded; blocked) or
 * 'not-exercised' (the restore made no such write; blocked).
 */
export async function captureLive({
  client, restoreRef, resourceType, operation, fixture, targetConfig, build, hmacKey,
  allowTenantSetting = false, allowByReference = false, testTenantRefs = TEST_TENANT_REFS,
  getArtifact = getDryRunArtifactById, getJournal = listJournal, getSnapshot = snapshotRows,
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
  // The tenant the restore actually wrote to, not only the one it was filed under.
  if (typeof artifact.targetTenantId !== 'string' || artifact.targetTenantId.length === 0
    || !testTenantRefs.includes(tenantRefFor(artifact.targetTenantId))) {
    throw new LiveGateRefusal('refusing: the restore wrote to a tenant that is not the test tenant');
  }
  if (enforcement !== Boolean(artifact.conditionalAccessEnforcement)) {
    throw new LiveGateRefusal(enforcement ? 'that artifact is not a Conditional Access enforcement step' : 'that artifact is an enforcement step; capture it with --operation ' + ENFORCEMENT_STEP);
  }

  const guidance = guidanceFor(resourceType);
  const entries = (await getJournal(client, { restoreRef }))
    .filter((entry) => isCapturedWrite(entry, { resourceType, operation, fixture, enforcement }));
  if (entries.length === 0) {
    return { status: 'not-exercised', record: null, captureLog: null, reason: `restore ${restoreRef} made no ${resourceType} ${operation} write for ${fixture}${await brandingFileHint(client, { restoreRef, resourceType, getJournal })}` };
  }
  const entry = entries[entries.length - 1];

  if (entry.outcome === 'pending' || !entry.outcome) {
    return { status: 'pending', record: null, captureLog: null, reason: `the ${resourceType} ${operation} write for ${fixture} has no recorded outcome (pending)` };
  }

  let snapshot = null;
  const loadSnapshot = async () => {
    snapshot ??= await getSnapshot(client, artifact.snapshotId);
    return snapshot;
  };
  if (guidance.kind === 'by-reference') {
    if (!allowByReference) {
      const checked = resourceType === 'oauth2PermissionGrant' ? 'its client app and user' : 'its principal and role';
      throw new LiveGateRefusal(`${resourceType} has no name of its own: pass --allow-by-reference; the capture then checks that ${checked} are fixtures`);
    }
    const problems = byReferenceProblems({ ...(await loadSnapshot()), naturalKey: entry.naturalKey, deleted: operation === 'delete', resourceType });
    if (problems.length > 0) throw new LiveGateRefusal(`refusing ${resourceType} ${fixture}: ${problems.join('; ')}`);
  } else {
    const snapshotPayload = entry.priorState ? null
      : (await loadSnapshot()).versions.find((version) => version.natural_key === entry.naturalKey)?.payload ?? null;
    if (!looksDisposable(entry, snapshotPayload)) {
      if (guidance.kind !== 'tenant-setting') {
        throw new LiveGateRefusal(`refusing: ${fixture} is not a disposable KEEL-RT-* or keel-rehearsal-* fixture`);
      }
      if (!allowTenantSetting) {
        throw new LiveGateRefusal(`${resourceType} is a tenant-wide setting: pass --allow-tenant-setting once decision D-148b allows it`);
      }
    }
  }

  const { walk } = pseudonymizer(tenantRef);
  const ok = verifiedOutcome(entry.outcome, entry.outcomeDetail);
  // 'succeeded' without a verified read-back is not a failed write: report it, never promote it.
  const status = ok ? 'captured' : entry.outcome === 'succeeded' ? 'unverified' : 'failed';
  const rawLog = {
    restoreRef,
    entry: {
      naturalKey: entry.naturalKey, resourceType: entry.resourceType, operation: entry.operation, targetId: entry.targetId,
      outcome: entry.outcome, outcomeDetail: entry.outcomeDetail, recordedAt: new Date(entry.recordedAt).toISOString(),
      priorState: entry.priorState, intendedState: entry.intendedState, postState: entry.postState,
    },
  };
  // Every GUID and SID the log held before pseudonymization must be gone from what is written.
  const rawIds = rawIdentifiers(JSON.stringify(rawLog));
  const log = walk(rawLog);
  const captureLog = `${JSON.stringify(log, null, 2)}\n`;
  assertSafeText(captureLog, { rawTenantId, rawIds, label: 'the capture log' });
  // A by-reference object's id is opaque: whatever its shape, it must not survive unchanged.
  if (guidance.kind === 'by-reference') {
    const targetIds = [entry.targetId, entry.priorState?.id].filter((id) => typeof id === 'string' && id.length >= 16);
    const kept = targetIds.find((id) => captureLog.toLowerCase().includes(id.toLowerCase()));
    if (kept) throw new LiveGateRefusal(`refusing: the capture log still holds the target's raw id (${kept.length} characters) after pseudonymization`);
  }

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
    evidenceLevel: ok ? 'live-qualified' : status,
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
  assertSafeText(JSON.stringify(record), { rawTenantId, rawIds, label: 'the record' });
  return { status, record, captureLog };
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

export function verifyRunner(record, hmacKey) {
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
  const resourceType = record?.resourceType;
  const operation = record?.operation;
  const before = resourceType && operation && operation !== ENFORCEMENT_STEP ? capabilityFor(resourceType, operation).claim : null;
  const failures = recordFailures(record, { hmacKey, captureLog, tenantRef, testTenantRefs });
  if (failures.length > 0) return { promoted: false, before, after: before, failures };

  const result = isPolicyGoverned(resourceType)
    ? qualifyPolicyLiveEvidence(resourceType, operation, record, { tenantRef, now, subtype: record.subtype })
    : qualifyLiveEvidence(resourceType, operation, record, { tenantRef, now });
  return { promoted: result.promoted, before, after: capabilityFor(resourceType, operation).claim, failures: result.failures };
}

/**
 * Gap P2: every check promoteRecord makes (signature, test tenant, read-back,
 * capture digest, then the capability's own live gate), without promoting.
 * The portal calls it on each refresh, so a record that expires stops
 * counting as live without a restart. `ok` true means the record proves the
 * write live on `tenantRef`.
 */
export function verifyRecord(record, {
  hmacKey, captureLog = null, now = new Date(), tenantRef, testTenantRefs = TEST_TENANT_REFS,
} = {}) {
  const failures = recordFailures(record, { hmacKey, captureLog, tenantRef, testTenantRefs });
  if (failures.length > 0) return { ok: false, failures };
  const { resourceType, operation } = record;
  try {
    const gate = isPolicyGoverned(resourceType)
      ? policyLiveEvidenceFailures(resourceType, operation, record, { tenantRef, now, subtype: record.subtype })
      : liveEvidenceFailures(resourceType, operation, record, { tenantRef, now });
    return { ok: gate.length === 0, failures: gate };
  } catch {
    return { ok: false, failures: [`${resourceType} ${operation} is not a registered write`] };
  }
}

function recordFailures(record, { hmacKey, captureLog, tenantRef, testTenantRefs }) {
  const failures = [];
  if (record?.kind !== ENTRA_LIVE_KIND) failures.push(`not a ${ENTRA_LIVE_KIND} record`);
  if (record?.operation === ENFORCEMENT_STEP) {
    failures.push('the Conditional Access enforcement step is not a registered capability; its record is kept as evidence and never promoted');
    return failures;
  }
  if (!testTenantRefs.includes(tenantRef)) failures.push(`refusing: ${tenantRef} is not the test tenant`);
  if (!testTenantRefs.includes(record?.tenantRef)) failures.push(`refusing: the record's tenant ${record?.tenantRef} is not the test tenant`);
  const runner = verifyRunner(record, hmacKey);
  if (!runner.ok) failures.push(runner.reason);
  else if (runner.synthetic) failures.push('signed by the fixture runner: synthetic evidence is never live qualification');
  if (record?.synthetic !== false) failures.push('synthetic evidence (a fixture run) is never live qualification');
  if (record?.ok !== true || record?.readBackVerified !== true || !verifiedOutcome(record?.outcome, record?.outcomeDetail)) {
    failures.push('the write was not verified by its read-back, so it cannot be promoted');
  }
  if (captureLog !== null && sha256(captureLog) !== record?.captureSha256) failures.push('the capture log does not match the record\'s captureSha256');
  return failures;
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
      `or, when the cause is a KEEL bug with a fix under way, keep the registration and record the failure under TYPE_DECISIONS.${resourceType}.liveFailures['${operation}'] (failedAt = this record's date, reason = this record's reason, verbatim); the ledger then shows the write as fixture-tested with a failed live run`,
      'commit this file under docs/release/qualifications/entra-live/ in the same PR',
    ],
  };
}

/**
 * Committed demotions that the code has not applied yet. A demotion is applied
 * in one of two ways:
 *  - the operation is no longer a registered write and the type's
 *    TYPE_DECISIONS reason quotes the recorded reason; or
 *  - the write stays registered (the cause is a KEEL bug with a fix under way)
 *    and TYPE_DECISIONS.<type>.liveFailures.<operation> records the demotion's
 *    date and quotes its reason, so the ledger row shows the failed live run.
 * (liveFailures also holds tenant limits, which have no demotion record and no
 * fix; see tenantLimit in engine/coverage/qualification.mjs.)
 */
export function unappliedDemotions({ dir = ENTRA_LIVE_EVIDENCE_DIR, decisions = TYPE_DECISIONS, claimOf = (type, op) => capabilityFor(type, op).claim } = {}) {
  if (!existsSync(dir)) return [];
  const problems = [];
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.demotion.json')).sort()) {
    const demotion = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    const key = demotion.resourceType.split('#')[0];
    const noted = decisions[key]?.liveFailures?.[demotion.operation];
    if (noted) {
      if (!String(noted.reason ?? '').includes(demotion.reason)) {
        problems.push(`${name}: TYPE_DECISIONS.${key}.liveFailures.${demotion.operation}.reason does not quote the demotion reason`);
      }
      if (noted.failedAt !== String(demotion.decidedAt ?? '').slice(0, 10)) {
        problems.push(`${name}: TYPE_DECISIONS.${key}.liveFailures.${demotion.operation}.failedAt is not the demotion's date`);
      }
      continue;
    }
    if (demotion.operation !== ENFORCEMENT_STEP && isSupportedClaim(claimOf(demotion.resourceType, demotion.operation))) {
      problems.push(`${name}: ${demotion.resourceType} ${demotion.operation} is still a registered write`);
    }
    if (!String(decisions[key]?.reason ?? '').includes(demotion.reason)) {
      problems.push(`${name}: TYPE_DECISIONS.${key}.reason does not record the demotion reason`);
    }
  }
  return problems;
}

/**
 * Applies every committed record in `dir` (verifying each capture digest).
 * Issue #294: a record with a sibling `.demotion.json` is never promoted,
 * however well it verifies; the demotion is the later, overriding decision.
 */
/**
 * The sibling `<stem>.demotion.json` that still decides for a committed record,
 * or null. The later decision wins, as in the release ledger
 * (acceptanceLedger.mjs): a demotion overrides a record observed before it or at
 * the same time (issue #294), and a record observed after it is a verified rerun
 * of the fixed write. A demotion or record without a readable date decides.
 */
export function decidingDemotion(dir, recordFile, record) {
  const name = recordFile.replace(/\.json$/, '.demotion.json');
  if (!existsSync(join(dir, name))) return null;
  let demotion;
  try {
    demotion = JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch {
    return name;
  }
  const recordAt = Date.parse(record?.observedAt);
  const demotedAt = Date.parse(demotion?.decidedAt);
  return Number.isNaN(recordAt) || Number.isNaN(demotedAt) || !(recordAt > demotedAt) ? name : null;
}

export function applyCommittedEvidence({
  dir = ENTRA_LIVE_EVIDENCE_DIR, hmacKey, now = new Date(), tenantRef = TEST_TENANT_REFS[0], testTenantRefs = TEST_TENANT_REFS,
} = {}) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.capture.json') && !name.endsWith('.demotion.json'))
    .sort()
    .map((name) => {
      const record = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const demotion = decidingDemotion(dir, name, record);
      if (demotion) {
        const { resourceType, operation } = record ?? {};
        const claim = resourceType && operation && operation !== ENFORCEMENT_STEP ? capabilityFor(resourceType, operation).claim : null;
        return { file: name, promoted: false, before: claim, after: claim, failures: [`${demotion} demotes this write, so it is not promoted`] };
      }
      const capturePath = join(dir, name.replace(/\.json$/, '.capture.json'));
      const captureLog = existsSync(capturePath) ? readFileSync(capturePath, 'utf8') : '';
      return { file: name, ...promoteRecord(record, { hmacKey, captureLog, now, tenantRef, testTenantRefs }) };
    });
}

function arg(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index > -1 ? argv[index + 1] : undefined;
}

/** Reads a JSON file; an error never echoes the parser's text, which can quote the file. */
function readJson(readFile, path, label) {
  let text;
  try {
    text = readFile(path, 'utf8');
  } catch {
    throw new LiveGateRefusal(`${label} could not be read`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new LiveGateRefusal(`${label} is not valid JSON`);
  }
}

/** The restorer settings file under /etc/keel, refused with the plain settings-file sentence. */
function readTargetConfig(readFile, path) {
  try {
    return readConfigFile(path, { readFile, what: 'restorer settings' });
  } catch (error) {
    throw new LiveGateRefusal(error.message);
  }
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
          targetConfig: readTargetConfig(readFile, configPath), build: arg(argv, 'build'), hmacKey,
          allowTenantSetting: argv.includes('--allow-tenant-setting'), allowByReference: argv.includes('--allow-by-reference'),
        });
        if (result.status === 'not-exercised' || result.status === 'pending') {
          out.error(`${result.status}: ${result.reason}. Report this step as blocked (not failed, do not demote); nothing was written.`);
          return 4;
        }
        if (result.status === 'unverified') {
          writeOutputs(outDir, stem, result);
          out.error(`unverified: the write is recorded as done but its read-back was not verified (${result.record.outcomeDetail}). Report this step as blocked with that detail; it cannot be promoted.`);
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
      const record = readJson(readFile, evidencePath, 'the evidence record');
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
