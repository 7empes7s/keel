/**
 * Roadmap task-105: qualified Exchange mailbox and organization configuration restore.
 *
 * One plan covers one mailbox and, when asked, the organization configuration. It
 * holds up to four DISTINCT operations, each with its own qualification, outcome and
 * evidence row:
 *  - mailbox-settings: one PATCH /users/{id}/mailboxSettings with the changed settings;
 *  - client-access:    one Set-CASMailbox with the changed protocol switches;
 *  - retention:        one Set-Mailbox with the changed hold and retention settings;
 *  - organization:     one Set-OrganizationConfig with the changed supported settings.
 * Everything else stays manual or excluded:
 *  - holds Purview or an administrator owns (in-place, compliance tag and delay holds,
 *    the litigation hold duration) are observed and never written;
 *  - read-only settings (userPurpose) are server-owned;
 *  - messages, folders, rules, calendars and contacts are content. They are never read,
 *    written or claimed as recovered.
 *
 * Rules:
 *  - Immutable plan, persisted as a restore_dry_run artifact; the task-66 approval and
 *    promotion checks are the existing ones.
 *  - Disabled until qualified, per operation (coverage/qualification.mjs). That needs
 *    the operation's own live write proof, its read-back enabled, Teams (and so
 *    SharePoint) qualified first, and the restorer's grants OBSERVED: unknown RBAC
 *    blocks the write.
 *  - Hold effect guard. An operation that releases a hold or shortens retention runs
 *    only with the separate, current high-impact approval of exactly these effects
 *    (safety/contentEffects.mjs); without it the operation is blocked and nothing is
 *    sent. A mailbox under a hold Purview owns refuses such an operation outright.
 *  - Bounded argument transport. Cmdlet parameters are JSON data splatted in the
 *    container; the mailbox identity is never placed in script source.
 *  - No overwrite. Each observation is re-read first; a change since the plan is
 *    `stale` for the operations it touches only.
 *  - Errors are structured. A cmdlet error is `failed` with { code, cmdlet, message,
 *    category, errorId } in its evidence row, never an empty success. An ambiguous
 *    outcome (timeout, lost answer, 5xx) is reconciled by re-reading; it is never
 *    sent a second time.
 */
import { createHash, randomUUID } from 'node:crypto';

import {
  COMPLIANCE_HOLD_FIELDS, EXCHANGE_EXCLUDED_CONTENT, EXCHANGE_GROUPS, EXCHANGE_WORKLOAD, assertExchangeRequest, exchangeCmdlet,
  mailboxIdentity, mailboxKey, readMailbox, readOrganization, structuredFailure,
} from '../../collect/workloads/exchange.mjs';
import { WORKLOAD_WRITE_OPERATIONS } from '../../coverage/qualification.mjs';
import { appendEvidence } from '../../govern/evidence.mjs';
import { CmdletError } from '../../powershell/jobQueue.mjs';
import { assertContentEffectApproval, classifyContentEffects } from '../../safety/contentEffects.mjs';
import { createDryRunArtifact, getDryRunArtifact, validateArtifactForApproval } from '../dryRunArtifact.mjs';

export const EXCHANGE_MAILBOX_SETTINGS_WRITE = 'exchange.mailbox-settings.update';
export const EXCHANGE_CLIENT_ACCESS_WRITE = 'exchange.client-access.update';
export const EXCHANGE_RETENTION_WRITE = 'exchange.mailbox-retention.update';
export const EXCHANGE_ORGANIZATION_WRITE = 'exchange.organization-config.update';
export const EXCHANGE_WRITE_OPERATIONS = Object.freeze([
  EXCHANGE_MAILBOX_SETTINGS_WRITE, EXCHANGE_CLIENT_ACCESS_WRITE, EXCHANGE_RETENTION_WRITE, EXCHANGE_ORGANIZATION_WRITE,
]);
export const EXCHANGE_RESTORE_EVIDENCE_KIND = 'workload-restore';
const CONFIG_PATH = 'workload:exchange-mailbox-settings';
const GRAPH = 'https://graph.microsoft.com';
const VERSION = 'v1.0';
const THROTTLE_MAX_ATTEMPTS = 3;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Effects that put mail at risk of deletion: the hold effect guard covers these.
export const HOLD_EFFECTS = Object.freeze(['hold-releasing', 'retention-reducing']);

const declared = (id) => WORKLOAD_WRITE_OPERATIONS[id];
for (const id of EXCHANGE_WRITE_OPERATIONS) if (!declared(id)) throw new Error(`${id} is not a declared workload write`);

// Each operation: the observation it restores, how it is sent, and its content-effect type.
const OPERATIONS = Object.freeze({
  mailboxSettings: { kind: 'mailbox-settings', operationId: EXCHANGE_MAILBOX_SETTINGS_WRITE, resourceType: 'exchangeMailboxSettings' },
  clientAccess: { kind: 'client-access', operationId: EXCHANGE_CLIENT_ACCESS_WRITE, resourceType: 'exchangeClientAccess', cmdlet: 'Set-CASMailbox' },
  retention: { kind: 'retention', operationId: EXCHANGE_RETENTION_WRITE, resourceType: 'exchangeMailboxRetention', cmdlet: 'Set-Mailbox' },
  organization: { kind: 'organization', operationId: EXCHANGE_ORGANIZATION_WRITE, resourceType: 'exchangeOrganizationConfig', cmdlet: 'Set-OrganizationConfig' },
});
const SERVER_OWNED = Object.freeze({ mailboxSettings: ['userPurpose'] });
const MANUAL_REASON = Object.freeze({
  retention: 'this hold is owned by Purview or a compliance administrator; KEEL observes it and never writes it',
});

function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
const truthy = (value) => value === true || value === 'true' || value === 'True';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function exchangePlanDigest(plan) {
  const { digest, ...rest } = plan;
  return sha256(rest);
}

/** Whether every field of one observation group was read. */
function groupObserved(entry, group) {
  return EXCHANGE_GROUPS[group].fields.every((field) => entry?.fieldCoverage?.[`${group}.${field}`]?.status === 'observed');
}

/** The live state of one group as KEEL compares it; null when not fully read. */
export function groupFingerprint(entry, group) {
  return groupObserved(entry, group) ? sha256(entry.fields[group]) : null;
}

/** True when a hold Purview or an administrator owns applies to the mailbox now. */
export function underComplianceHold(retention) {
  if (!retention) return false;
  const inPlace = Array.isArray(retention.InPlaceHolds) ? retention.InPlaceHolds.length > 0 : Boolean(retention.InPlaceHolds);
  return inPlace || truthy(retention.ComplianceTagHoldApplied) || truthy(retention.DelayHoldApplied) || truthy(retention.DelayReleaseHoldApplied);
}

function planGroup(group, { observation, live, resourceKey, manual, excluded }) {
  const writable = declared(OPERATIONS[group].operationId).fields;
  const changes = [];
  for (const field of EXCHANGE_GROUPS[group].fields) {
    if ((SERVER_OWNED[group] ?? []).includes(field)) { excluded.push({ resourceKey, field: `${group}.${field}`, reason: 'server-owned' }); continue; }
    const coverage = observation?.fieldCoverage?.[`${group}.${field}`]?.status ?? 'unknown';
    if (coverage !== 'observed') {
      manual.push({ resourceKey, field: `${group}.${field}`, reason: `${coverage} in the source collection, so there is no value to restore` });
      continue;
    }
    const after = observation.fields?.[group]?.[field] ?? null;
    const before = live.fields?.[group]?.[field] ?? null;
    if (same(before, after)) continue;
    if (!writable.includes(field)) {
      manual.push({ resourceKey, field: `${group}.${field}`, reason: MANUAL_REASON[group] ?? 'KEEL does not write this setting' });
      continue;
    }
    changes.push({ field, before, after });
  }
  return changes;
}

function operationFor(group, { changes, identity }) {
  const spec = OPERATIONS[group];
  const target = identity === null ? 'organization' : mailboxKey(identity);
  const base = { key: `${spec.kind}:${target}`, kind: spec.kind, group, operationId: spec.operationId, naturalKey: `exchange:${target}:${group}`, changes };
  const values = Object.fromEntries(changes.map(({ field, after }) => [field, after]));
  if (group === 'mailboxSettings') {
    return { ...base, transport: 'graph', method: 'PATCH', identity, body: values };
  }
  // Parameters are data: Identity is the literal identity string, never source text.
  return { ...base, transport: 'cmdlet', cmdlet: spec.cmdlet, identity, parameters: identity === null ? values : { Identity: identity, ...values } };
}

/**
 * Builds the frozen plan. `source` is a recorded task-105 collection ({ collectionId,
 * outcome, observedTo, observations: [{ resourceKey, fields, fieldCoverage }] });
 * `live` is { mailbox: readMailbox(...), organization: readOrganization(...) | null }
 * read now. `tenantId` is the managed tenant the plan is bound to.
 */
export function planExchangeRestore({ source, live, tenantId, mailbox, includeOrganization = false }) {
  if (!source?.collectionId) throw new TypeError('an Exchange restore needs a recorded source collection');
  if (typeof tenantId !== 'string' || !GUID_RE.test(tenantId)) throw new TypeError('tenantId must be the managed tenant\'s directory id');
  const identity = mailboxIdentity(mailbox);
  if (!['complete', 'complete-empty', 'partial'].includes(source.outcome)) throw new Error(`a ${source.outcome} collection is not a restore source`);
  if (!live?.mailbox || live.mailbox.identity !== identity) throw new Error('the live read is not of this mailbox');
  if (includeOrganization && !live.organization) throw new Error('the organization was not read live');

  const manual = [];
  const excluded = [];
  const operations = [];
  const refusals = [];
  const resources = [];
  const targets = [{ resourceKey: mailboxKey(identity), groups: ['mailboxSettings', 'clientAccess', 'retention'], entry: live.mailbox, identity }];
  if (includeOrganization) targets.push({ resourceKey: 'organization', groups: ['organization'], entry: live.organization, identity: null });

  for (const { resourceKey, groups, entry, identity: targetIdentity } of targets) {
    excluded.push(...EXCHANGE_EXCLUDED_CONTENT.map((field) => ({ resourceKey, field, reason: 'mailbox content: messages, folders, rules, calendars and contacts are never read or restored' })));
    const observation = (source.observations ?? []).find((item) => item.resourceKey === resourceKey);
    if (!observation) { manual.push({ resourceKey, field: null, reason: 'the source collection has no observation of this target' }); continue; }
    for (const group of groups) {
      if (!groupObserved(entry, group)) {
        const status = Object.entries(entry.fieldCoverage ?? {}).find(([key, value]) => key.startsWith(`${group}.`) && value.status !== 'observed')?.[1];
        manual.push({ resourceKey, field: group, reason: `the live ${group} read was ${status?.status ?? 'incomplete'}, so no change is planned`, error: status?.error ?? null });
        continue;
      }
      const changes = planGroup(group, { observation, live: entry, resourceKey, manual, excluded });
      if (!changes.length) continue;
      const op = operationFor(group, { changes, identity: targetIdentity });
      operations.push(op);
      resources.push({
        naturalKey: op.naturalKey, resourceType: OPERATIONS[group].resourceType, verb: 'update',
        payload: { ...entry.fields[group], ...Object.fromEntries(changes.map(({ field, after }) => [field, after])) },
        live: { state: 'present', payload: entry.fields[group] },
      });
    }
  }

  const classified = resources.length ? classifyContentEffects(resources) : { effects: [], refusals: [] };
  // Source authority: a mailbox under a hold Purview owns never has a hold released
  // or its retention shortened by KEEL, whatever the approval.
  const retentionOp = operations.find((op) => op.group === 'retention');
  if (retentionOp && underComplianceHold(live.mailbox.fields.retention)
    && classified.effects.some((effect) => effect.naturalKey === retentionOp.naturalKey && HOLD_EFFECTS.includes(effect.effect))) {
    refusals.push({ naturalKey: retentionOp.naturalKey, reason: 'the mailbox is under a hold Purview or a compliance administrator owns; KEEL never releases a hold or shortens retention on it' });
  }

  const plan = {
    workload: EXCHANGE_WORKLOAD,
    tenantId: tenantId.toLowerCase(),
    mailbox: identity,
    includeOrganization: Boolean(includeOrganization),
    source: { collectionId: source.collectionId, observedTo: source.observedTo ?? null, outcome: source.outcome },
    operations,
    manual,
    excluded,
    complianceHolds: Object.fromEntries(COMPLIANCE_HOLD_FIELDS.map((field) => [field, live.mailbox.fields.retention?.[field] ?? null])),
    contentEffects: classified.effects,
    refusals: [...refusals, ...classified.refusals],
    liveFingerprints: {
      mailboxSettings: groupFingerprint(live.mailbox, 'mailboxSettings'),
      clientAccess: groupFingerprint(live.mailbox, 'clientAccess'),
      retention: groupFingerprint(live.mailbox, 'retention'),
      organization: includeOrganization ? groupFingerprint(live.organization, 'organization') : null,
    },
  };
  plan.digest = exchangePlanDigest(plan);
  return deepFreeze(plan);
}

/** Reads a recorded task-105 collection as a restore source. */
export async function loadExchangeSource(client, { tenantRef, collectionId }) {
  const { rows: [run] } = await client.query(
    `SELECT * FROM workload_collection WHERE id::text = $1 AND tenant_ref = $2 AND workload = $3`,
    [collectionId, tenantRef, EXCHANGE_WORKLOAD],
  );
  if (!run) return null;
  const { rows } = await client.query(
    `SELECT resource_key, fields, field_coverage FROM workload_observation WHERE collection_id = $1 ORDER BY resource_key`,
    [run.id],
  );
  return {
    collectionId: run.id,
    outcome: run.outcome,
    observedTo: new Date(run.observed_to).toISOString(),
    observations: rows.map((row) => ({ resourceKey: row.resource_key, fields: row.fields, fieldCoverage: row.field_coverage })),
  };
}

/** Reads the live mailbox (and organization) the plan needs. */
export async function readLiveExchange({ transport, powershell, mailbox, includeOrganization = false, sleep }) {
  const entry = await readMailbox({ identity: mailboxIdentity(mailbox), transport, powershell, sleep });
  return { mailbox: entry, organization: includeOrganization ? await readOrganization({ powershell }) : null };
}

/** Persists the plan as an immutable dry-run artifact. */
export async function createExchangeRestoreArtifact(client, { tenantRef, plan, requestedBy }) {
  const keys = [`exchange:${mailboxKey(plan.mailbox)}`, ...plan.operations.map((op) => op.naturalKey)];
  return createDryRunArtifact(client, {
    id: randomUUID(),
    tenantRef,
    snapshotId: null,
    selection: [`exchange:${mailboxKey(plan.mailbox)}`, ...(plan.includeOrganization ? ['exchange:organization'] : [])],
    closureKeys: [...new Set(keys)],
    targetTenantId: plan.tenantId,
    collectorConfigPath: CONFIG_PATH,
    targetConfigPath: CONFIG_PATH,
    reconciliationResources: null,
    waves: [],
    patches: [],
    guardRefusals: plan.refusals,
    results: { operations: plan.operations.length, manual: plan.manual.length },
    currentStateFingerprint: sha256(plan.liveFingerprints),
    digest: plan.digest,
    status: plan.refusals.length ? 'refused' : 'completed',
    requestedBy,
    contentEffects: plan.contentEffects,
    workloadRestore: plan,
  });
}

async function recordOperation(client, { tenantRef, artifactId, actor, op, result }) {
  await appendEvidence(client, {
    tenantRef,
    kind: EXCHANGE_RESTORE_EVIDENCE_KIND,
    subject: {
      artifactId, operationId: op.operationId, kind: op.kind, target: op.identity === null ? 'organization' : mailboxKey(op.identity),
      outcome: result.outcome, writes: result.writes, attempts: result.attempts ?? result.writes, verified: result.verified ?? [],
      reasons: result.reasons, error: result.error ?? null,
    },
    actor,
  });
}

/**
 * Hold effect guard. The effects one operation carries that put mail at risk of
 * deletion, or widen its audience, need the plan's separate high-impact approval.
 * Returns the reason the operation is blocked, or null when it may run.
 */
export function heldBack(op, plan, approval) {
  const effects = plan.contentEffects.filter((effect) => effect.naturalKey === op.naturalKey);
  if (effects.length === 0) return null;
  if (approval.ok) return null;
  const kinds = [...new Set(effects.map((effect) => effect.effect))].join(', ');
  return `${op.kind} would have a content effect (${kinds}) and needs the separate, current high-impact approval of exactly these effects: ${approval.reason}`;
}

/**
 * Promotes one approved artifact. `qualifications` maps each Exchange write
 * operationId to workloadWriteQualification(operationId, ...). `transport(url, init?)`
 * answers Graph; `powershell` holds the runCmdlet options.
 * Plan outcomes: refused, blocked-content-effect, no-change, disabled, verified, partial.
 * Operation outcomes: disabled, blocked-content-effect, refused, stale, failed,
 * verification-failed, verified.
 */
export async function executeExchangeRestore(client, {
  tenantRef, artifactId, tenantId, transport, powershell = {}, qualifications = {}, actor = null, sleep = async () => {},
}) {
  const requests = [];
  const counted = async (url, init) => {
    assertExchangeRequest(url, init?.method ?? 'GET');
    requests.push({ url, method: init?.method ?? 'GET' });
    return transport(url, init);
  };
  const artifact = await getDryRunArtifact(client, { id: artifactId, tenantRef });
  const by = actor ?? artifact?.requestedBy ?? 'keel';
  const finish = async (result) => {
    await appendEvidence(client, {
      tenantRef, kind: EXCHANGE_RESTORE_EVIDENCE_KIND,
      subject: { artifactId, operationId: 'exchange.restore', outcome: result.outcome, operations: result.operations.map(({ key, outcome }) => ({ key, outcome })), reasons: result.reasons ?? [] },
      actor: by,
    });
    return { ...result, requests };
  };
  const refuse = (reason) => finish({ outcome: 'refused', operations: [], reasons: [reason] });

  const plan = artifact?.workloadRestore ?? null;
  if (!plan || plan.workload !== EXCHANGE_WORKLOAD) return refuse('no Exchange restore plan with this id');
  const promotable = validateArtifactForApproval(artifact);
  if (!promotable.ok) return refuse(promotable.reason);
  if (exchangePlanDigest(plan) !== plan.digest || artifact.digest !== plan.digest || !same(artifact.contentEffects ?? [], plan.contentEffects)) {
    return refuse('the stored plan no longer matches its digest; a new dry run is required');
  }
  if (String(tenantId ?? '').toLowerCase() !== plan.tenantId) return refuse(`the plan targets tenant ${plan.tenantId}, not ${tenantId}`);
  if (plan.operations.length === 0) return finish({ outcome: 'no-change', operations: [], reasons: ['the live configuration already matches the source'] });

  const results = new Map();
  const settle = async (op, result) => {
    const full = { writes: 0, verified: [], ...result };
    results.set(op.key, { key: op.key, kind: op.kind, operationId: op.operationId, ...full });
    await recordOperation(client, { tenantRef, artifactId, actor: by, op, result: full });
  };

  // Qualification first, per operation: an unqualified operation sends nothing.
  let runnable = [];
  for (const op of plan.operations) {
    const qualification = qualifications[op.operationId];
    if (qualification?.operationId !== op.operationId || qualification.enabled !== true) {
      await settle(op, { outcome: 'disabled', reasons: [...(qualification?.reasons ?? [`no write qualification was supplied for ${op.operationId}`])] });
    } else runnable.push(op);
  }

  // The hold effect guard, per operation: one held back sends nothing; the others run.
  if (runnable.length) {
    let approval = { ok: true, reason: null };
    if (plan.contentEffects.length) {
      try {
        await assertContentEffectApproval(client, { artifact, effects: plan.contentEffects });
      } catch (error) {
        approval = { ok: false, reason: error.message };
      }
    }
    const cleared = [];
    for (const op of runnable) {
      const blocked = heldBack(op, plan, approval);
      if (blocked) await settle(op, { outcome: 'blocked-content-effect', reasons: [blocked] });
      else cleared.push(op);
    }
    runnable = cleared;
  }
  if (runnable.length) await runOperations(plan, runnable, { counted, powershell, sleep, settle });

  const operations = plan.operations.map((op) => results.get(op.key));
  const outcomes = new Set(operations.map((op) => op.outcome));
  let outcome;
  if (outcomes.size === 1 && outcomes.has('verified')) outcome = 'verified';
  else if (outcomes.size === 1 && outcomes.has('disabled')) outcome = 'disabled';
  else if (outcomes.size === 1 && outcomes.has('blocked-content-effect')) outcome = 'blocked-content-effect';
  else outcome = 'partial';
  return finish({ outcome, operations, reasons: [] });
}

async function runOperations(plan, runnable, { counted, powershell, sleep, settle }) {
  // Re-read: nothing an operation touches may have changed since the dry run.
  let live;
  try {
    live = await readLiveExchange({ transport: counted, powershell, mailbox: plan.mailbox, includeOrganization: plan.includeOrganization, sleep });
  } catch (error) {
    for (const op of runnable) await settle(op, { outcome: 'failed', reasons: [`could not re-read before writing: ${error.message}`], error: structuredFailure(error).error });
    return;
  }
  for (const op of runnable) {
    const entry = op.group === 'organization' ? live.organization : live.mailbox;
    if (groupFingerprint(entry, op.group) !== plan.liveFingerprints[op.group]) {
      await settle(op, { outcome: 'stale', reasons: [`the live ${op.group} changed since the dry run, or could not be fully re-read; a new dry run is required`] });
      continue;
    }
    if (op.group === 'retention' && underComplianceHold(entry.fields.retention)
      && plan.contentEffects.some((effect) => effect.naturalKey === op.naturalKey && HOLD_EFFECTS.includes(effect.effect))) {
      await settle(op, { outcome: 'refused', reasons: ['the mailbox is now under a hold Purview or a compliance administrator owns; KEEL never releases it'] });
      continue;
    }
    if (op.transport === 'graph') await runGraph(op, plan, { counted, powershell, sleep, settle });
    else await runCmdletOperation(op, plan, { counted, powershell, sleep, settle });
  }
}

async function readBack(op, plan, { counted, powershell, sleep }) {
  if (op.group === 'organization') return readOrganization({ powershell });
  return readMailbox({ identity: plan.mailbox, transport: counted, powershell, sleep, groups: [op.group] });
}

async function verify(op, plan, context, { attempts, ambiguous, cause }) {
  let entry;
  try {
    entry = await readBack(op, plan, context);
  } catch (error) {
    entry = null;
    cause = cause ?? error.message;
  }
  if (!entry || !groupObserved(entry, op.group)) {
    const failure = entry ? Object.values(entry.fieldCoverage).find((coverage) => coverage.status !== 'observed') : null;
    await context.settle(op, {
      outcome: 'verification-failed', writes: 1, attempts,
      reasons: [`the write ${ambiguous ? 'had an unknown outcome' : 'was sent'} and could not be read back`], error: failure?.error ?? null,
    });
    return;
  }
  const verified = [];
  const mismatched = [];
  for (const { field, after } of op.changes) (same(entry.fields[op.group]?.[field], after) ? verified : mismatched).push(field);
  if (!mismatched.length) {
    await context.settle(op, {
      outcome: 'verified', writes: 1, attempts, verified,
      reasons: ambiguous ? [`the write outcome was unknown (${cause}); the re-read shows it applied, so it was not resent`] : [],
    });
    return;
  }
  await context.settle(op, {
    outcome: ambiguous ? 'failed' : 'verification-failed', writes: 1, attempts, verified,
    reasons: ambiguous
      ? [`the write outcome was unknown (${cause}) and the re-read does not show it; it was not resent`]
      : mismatched.map((field) => `${field} did not read back as written`),
  });
}

async function runGraph(op, plan, context) {
  const url = `${GRAPH}/${VERSION}/users/${encodeURIComponent(op.identity)}/mailboxSettings`;
  let attempts = 0;
  let response = null;
  let thrown = null;
  for (;;) {
    attempts += 1;
    try {
      response = await context.counted(url, { method: op.method, body: op.body });
    } catch (error) {
      thrown = error;
      response = null;
    }
    if (!response || response.status !== 429 || attempts >= THROTTLE_MAX_ATTEMPTS) break;
    const seconds = Number(response.headers?.['retry-after']);
    await context.sleep(Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 2 ** attempts * 1000);
  }
  const ambiguous = response === null || response.status >= 500;
  if (!ambiguous && (response.status < 200 || response.status >= 300)) {
    await context.settle(op, {
      outcome: 'failed', writes: 1, attempts,
      reasons: [`the mailbox settings write failed with HTTP ${response.status}; nothing is retried automatically`],
      error: { code: `HTTP_${response.status}`, cmdlet: null, message: String(response.body?.error?.message ?? `HTTP ${response.status}`), category: null, errorId: response.body?.error?.code ?? null, httpStatus: response.status },
    });
    return;
  }
  await verify(op, plan, context, { attempts, ambiguous, cause: thrown ? thrown.message : response && `HTTP ${response.status}` });
}

async function runCmdletOperation(op, plan, context) {
  try {
    await exchangeCmdlet({ cmdlet: op.cmdlet, parameters: op.parameters }, context.powershell);
  } catch (error) {
    if (error instanceof CmdletError && error.detail.code === 'CMDLET_ERROR') {
      // The cmdlet answered with an error: a definite failure, recorded as it came.
      const failed = structuredFailure(error);
      await context.settle(op, {
        outcome: failed.status === 'denied' ? 'refused' : 'failed', writes: 1, attempts: 1,
        reasons: [`${op.cmdlet} failed: ${error.detail.message}; nothing is retried automatically`], error: failed.error,
      });
      return;
    }
    // No answer (timeout, crash, malformed output): reconcile by reading, never resend.
    await verify(op, plan, context, { attempts: 1, ambiguous: true, cause: error.message });
    return;
  }
  await verify(op, plan, context, { attempts: 1, ambiguous: false, cause: null });
}
