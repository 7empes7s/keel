/**
 * Custom Exchange admin role restore through Exchange Online PowerShell.
 *
 * Source: a Graph backup (snapshot) and its exchangeRoleDefinition records (beta
 * /roleManagement/exchange/roleDefinitions). Graph lists and gets these roles but cannot
 * create one. Each record holds the role's name, description and role entries
 * (rolePermissions[].allowedResourceActions, one "(snap-in) Cmdlet -Param -Param ..." per
 * entry). The live side, the write and the read-back all go through the bounded cmdlet job
 * transport (engine/powershell/jobQueue.mjs, ops/powershell/run-cmdlet.ps1).
 *
 * One plan covers the custom roles of one backup, or the ones named in it. A custom role
 * that is gone and whose name no role uses is one DISTINCT operation (`add`):
 *  1. New-ManagementRole -Name -Parent -Description -EnabledCmdlets: a new role copied from
 *     its parent, with only the cmdlets the backup lists;
 *  2. the new role's entries are read, and trimmed to the backup: an entry the backup does
 *     not have is removed (Remove-ManagementRoleEntry), and a parameter it does not have is
 *     removed from its entry (Set-ManagementRoleEntry -RemoveParameter);
 *  3. the entries and description are read back and must match the backup exactly.
 * The parent is the backup's parent when the record names one, otherwise the built-in role
 * in the same backup with the fewest entries that holds every entry and parameter the role
 * has (an Exchange child role only ever holds a subset of its parent). After trimming, the
 * entries are the backup's whichever parent was used; the plan says which one it chose.
 *
 * Everything else is listed for an administrator, and nothing that existed before the
 * operation is changed or deleted:
 *  - a role that still exists and differs from the backup (entries, description): Keel does
 *    not change an existing role's entries;
 *  - a role whose parent cannot be found live or in the backup, whose entries cannot be read
 *    (a script entry, excluded actions), or whose name another role now uses;
 *  - who holds the role (role groups, users, apps): restored separately, after a privilege review;
 *  - built-in roles: set by Microsoft, never written.
 *
 * Rules (the same as the other workload writers):
 *  - Immutable plan, persisted as a restore_dry_run artifact; the task-66 approval and
 *    promotion checks are the existing ones.
 *  - Disabled until qualified: a live write capture on this tenant, the Exchange admin role
 *    read enabled, and the restorer's grants observed.
 *  - No overwrite. The roles are read again just before each write; a change since the plan
 *    makes only that role's operation `stale`. Set- and Remove-ManagementRoleEntry run only
 *    on the role this operation just created.
 *  - Test tenant fixtures only (fixtureGuard.mjs): on the test tenant every role written is
 *    named KEEL-RT-*, at plan time and again before writing.
 *  - Creating a role grants nothing (it has no holders), so it has no content effect; no
 *    trust, certificate, federation or sign-in field is written.
 *  - Errors are structured; an ambiguous outcome is reconciled by reading again and is never
 *    sent a second time.
 */
import { createHash, randomUUID } from 'node:crypto';

import { appendEvidence } from '../../govern/evidence.mjs';
import { CmdletError, runCmdlet } from '../../powershell/jobQueue.mjs';
import { createDryRunArtifact, getDryRunArtifact, validateArtifactForApproval } from '../dryRunArtifact.mjs';
import {
  CREATE_FIELDS, EXCHANGE_ROLE_ADD, EXCHANGE_ROLE_EVIDENCE_KIND, EXCHANGE_ROLE_MODULE, EXCHANGE_ROLE_RESOURCE_TYPE, EXCHANGE_ROLE_WRITE_OPERATIONS,
  EXCHANGE_ROLES_WORKLOAD, MAX_ROLE_TARGETS, ROLE_READ_CMDLETS, ROLE_WRITE_CMDLETS,
} from './exchangeRoleDeclarations.mjs';
import { TEST_TENANT_REFS, fixtureProblem } from './fixtureGuard.mjs';

export {
  CREATE_FIELDS, EXCHANGE_ROLE_ADD, EXCHANGE_ROLE_WRITE_OPERATIONS, EXCHANGE_ROLES_WORKLOAD, MAX_ROLE_TARGETS, ROLE_READ_CMDLETS, ROLE_WRITE_CMDLETS,
};

// PowerShell's common and risk parameters: every role entry carries them, they grant
// nothing, and Exchange may or may not list them. They are never compared or removed.
export const COMMON_PARAMETERS = Object.freeze([
  'Confirm', 'Debug', 'ErrorAction', 'ErrorVariable', 'InformationAction', 'InformationVariable', 'OutBuffer', 'OutVariable',
  'PipelineVariable', 'ProgressAction', 'Verbose', 'WarningAction', 'WarningVariable', 'WhatIf',
]);
const COMMON = new Set(COMMON_PARAMETERS.map((name) => name.toLowerCase()));
const CMDLET_RE = /^[A-Za-z]+-[A-Za-z0-9]+$/;
const ENTRY_RE = /^\s*(?:\(([^)]*)\)\s*)?([A-Za-z]+-[A-Za-z0-9]+)((?:\s+-[A-Za-z0-9_]+)*)\s*$/;
// A role name Keel sends: no wildcard, no entry separator, no control character.
// eslint-disable-next-line no-control-regex
const ROLE_NAME_RE = /^[^\\*?\u0000-\u001f\u007f]{1,64}$/;

function canonical(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const sha256 = (value) => createHash('sha256').update(canonical(value)).digest('hex');
const lower = (value) => String(value ?? '').toLowerCase();
const text = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// ------------------------------------------------------------ role entries

/**
 * The role's entries as { cmdlet -> [parameters] } (common parameters left out, sorted,
 * case kept as given), or { problem } when one cannot be read safely.
 */
export function recordEntries(record) {
  const permissions = Array.isArray(record?.rolePermissions) ? record.rolePermissions : [];
  if (!permissions.length) return { problem: 'the backup lists no role entries for it' };
  const entries = {};
  for (const permission of permissions) {
    if (Array.isArray(permission?.excludedResourceActions) && permission.excludedResourceActions.length) {
      return { problem: 'the backup lists excluded actions for it, which Exchange roles do not have' };
    }
    if (permission?.condition) return { problem: 'the backup lists a condition on its entries, which Keel cannot write' };
    for (const action of Array.isArray(permission?.allowedResourceActions) ? permission.allowedResourceActions : []) {
      const match = typeof action === 'string' ? ENTRY_RE.exec(action) : null;
      if (!match) return { problem: `the backup holds an entry Keel cannot read (${String(action).slice(0, 80)}); a script or unknown entry is restored by hand` };
      const [, , cmdlet, rest] = match;
      if (Object.keys(entries).some((name) => lower(name) === lower(cmdlet))) return { problem: `the backup lists ${cmdlet} twice` };
      entries[cmdlet] = normalizeParameters(rest.trim() ? rest.trim().split(/\s+/).map((part) => part.replace(/^-/, '')) : []);
    }
  }
  if (!Object.keys(entries).length) return { problem: 'the backup lists no role entries for it' };
  return { entries };
}

function normalizeParameters(list) {
  const seen = new Map();
  for (const name of list) if (typeof name === 'string' && name && !COMMON.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  return [...seen.values()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

/** Live entries (Get-ManagementRoleEntry output) as { cmdlet -> [parameters] }. */
export function liveEntries(output) {
  const entries = {};
  for (const row of Array.isArray(output) ? output : []) {
    const name = text(row?.Name) ?? text(String(row?.Identity ?? '').split('\\').pop());
    if (!name) continue;
    const parameters = Array.isArray(row?.Parameters) ? row.Parameters : (typeof row?.Parameters === 'string' ? row.Parameters.split(/[\s,]+/) : []);
    entries[name] = normalizeParameters(parameters.map(String));
  }
  return entries;
}

const find = (entries, cmdlet) => Object.keys(entries).find((name) => lower(name) === lower(cmdlet)) ?? null;
/** True when `outer` holds every entry of `inner` with at least its parameters. */
function covers(outer, inner) {
  return Object.entries(inner).every(([cmdlet, parameters]) => {
    const key = find(outer, cmdlet);
    if (!key) return false;
    const have = new Set(outer[key].map(lower));
    return parameters.every((name) => have.has(lower(name)));
  });
}
/** What to change so `live` equals `wanted`: entries to remove, parameters to remove, and what cannot be added. */
export function entryDifferences(live, wanted) {
  const removeEntries = [];
  const removeParameters = [];
  const missing = [];
  for (const [cmdlet, parameters] of Object.entries(live)) {
    const key = find(wanted, cmdlet);
    if (!key) { removeEntries.push(cmdlet); continue; }
    const keep = new Set(wanted[key].map(lower));
    const extra = parameters.filter((name) => !keep.has(lower(name)));
    if (extra.length) removeParameters.push({ cmdlet, parameters: extra });
    const have = new Set(parameters.map(lower));
    const lacking = wanted[key].filter((name) => !have.has(lower(name)));
    if (lacking.length) missing.push({ cmdlet, parameters: lacking });
  }
  for (const cmdlet of Object.keys(wanted)) if (!find(live, cmdlet)) missing.push({ cmdlet, parameters: null });
  return { removeEntries: removeEntries.sort(), removeParameters, missing };
}
const sameEntries = (a, b) => {
  const { removeEntries, removeParameters, missing } = entryDifferences(a, b);
  return !removeEntries.length && !removeParameters.length && !missing.length;
};

// ------------------------------------------------------------ live reads

/** A cmdlet runner for one connection: ({ cmdlet, parameters }) -> output list, or throws CmdletError. */
export function roleCmdletRunner(powershell = {}, { run = runCmdlet } = {}) {
  const { tenantConfigPath = null, ...options } = powershell;
  return async ({ cmdlet, parameters = {} }) => {
    const declared = ROLE_READ_CMDLETS[cmdlet] ?? ROLE_WRITE_CMDLETS[cmdlet];
    if (!declared) throw new RoleWriteScopeError(`${cmdlet} is not a cmdlet the Exchange role writer runs`);
    for (const name of Object.keys(parameters)) if (!declared.includes(name)) throw new RoleWriteScopeError(`${cmdlet} does not take ${name} from Keel`);
    const { output } = await run({ module: EXCHANGE_ROLE_MODULE, cmdlet, parameters, tenantConfigPath }, { ...options, allowedCmdlets: new Set([cmdlet]) });
    return output;
  };
}

export class RoleWriteScopeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoleWriteScopeError';
  }
}

const parentName = (value) => text(typeof value === 'object' && value !== null ? (value.Name ?? value.name) : value);
/** Every management role live, as [{ name, parent, description }]. */
export async function readLiveRoles(cmdlet) {
  const output = await cmdlet({ cmdlet: 'Get-ManagementRole' });
  return (Array.isArray(output) ? output : []).map((row) => ({
    name: text(row?.Name), parent: parentName(row?.Parent), description: typeof row?.Description === 'string' ? row.Description : null,
  })).filter((row) => row.name);
}
/** One role's entries live. */
export async function readLiveRoleEntries(cmdlet, roleName) {
  return liveEntries(await cmdlet({ cmdlet: 'Get-ManagementRoleEntry', parameters: { Identity: `${roleName}\\*` } }));
}

// ------------------------------------------------------------ source

/**
 * The exchangeRoleDefinition records of one complete backup of this tenant, as
 * { collectionId, observedTo, outcome, roles: [{ naturalKey, record }] }, or null.
 */
export async function loadRoleSource(client, { tenantRef, collectionId }) {
  const { rows: [snapshot] } = await client.query(
    'SELECT id, status, completed_at, coverage_digest FROM snapshot WHERE id::text = $1 AND tenant_ref = $2',
    [String(collectionId), tenantRef],
  );
  if (!snapshot) return null;
  const { rows } = await client.query(
    'SELECT natural_key, payload FROM resource_version WHERE snapshot_id = $1 AND resource_type = $2 ORDER BY natural_key',
    [snapshot.id, EXCHANGE_ROLE_RESOURCE_TYPE],
  );
  const kind = snapshot.coverage_digest?.[EXCHANGE_ROLE_RESOURCE_TYPE]?.outcome ?? null;
  return {
    collectionId: snapshot.id,
    observedTo: snapshot.completed_at ? new Date(snapshot.completed_at).toISOString() : null,
    outcome: snapshot.status === 'complete' ? (kind ?? 'complete') : snapshot.status,
    roles: rows.map((row) => ({ naturalKey: row.natural_key, record: row.payload })),
  };
}

const isBuiltIn = (record) => record?.isBuiltIn !== false;
const roleName = (record) => text(record?.displayName);

/** The custom roles the plan covers: every one in the backup, or the named ones. */
function targetRoles(source, targets) {
  const custom = (source.roles ?? []).filter(({ record }) => !isBuiltIn(record));
  if (!targets.length) return custom;
  const wanted = new Set(targets.map(lower));
  const all = source.roles ?? [];
  const picked = all.filter(({ naturalKey, record }) => [naturalKey, record?.id, roleName(record)].some((value) => value && wanted.has(lower(value))));
  const known = new Set(picked.flatMap(({ naturalKey, record }) => [naturalKey, record?.id, roleName(record)].filter(Boolean).map(lower)));
  const unknown = [...wanted].filter((target) => !known.has(target));
  if (unknown.length) throw new Error(`the backup holds no Exchange admin role named ${unknown.join(', ')}`);
  const builtIn = picked.filter(({ record }) => isBuiltIn(record)).map(({ record }) => roleName(record));
  if (builtIn.length) throw new Error(`${builtIn.join(', ')} ${builtIn.length > 1 ? 'are' : 'is a'} built-in role${builtIn.length > 1 ? 's' : ''}, set by Microsoft; Keel restores custom roles only`);
  return picked;
}

/** The names of the roles a plan reads entries of live: the custom roles in scope that still exist. */
export function rolesToRead(source, targets, liveRoles) {
  const names = new Set(liveRoles.map((role) => lower(role.name)));
  return targetRoles(source, targets).map(({ record }) => roleName(record)).filter((name) => name && names.has(lower(name)));
}

/**
 * The parent to create a role from: the one the record names (when the backup holds it
 * and it covers the role), else the built-in role with the fewest entries that covers it.
 * With `liveNames`, only a role that exists live is chosen.
 */
export function chooseParent(record, entries, source, liveNames = null) {
  const others = (source.roles ?? []).filter(({ record: other }) => other !== record && roleName(other) && lower(roleName(other)) !== lower(roleName(record)));
  const parsed = others.map(({ record: other }) => ({ record: other, name: roleName(other), entries: recordEntries(other).entries ?? null }))
    .filter((item) => item.entries && covers(item.entries, entries) && (!liveNames || liveNames.has(lower(item.name))));
  // Graph's inheritsPermissionsFrom names the parent by id, when it is filled in.
  const named = (Array.isArray(record?.inheritsPermissionsFrom) ? record.inheritsPermissionsFrom : [])
    .map((item) => text(item?.displayName) ?? roleName(others.find(({ record: other }) => other?.id && other.id === item?.id)?.record))
    .filter(Boolean);
  for (const name of named) {
    const hit = parsed.find((item) => lower(item.name) === lower(name));
    if (hit) return { name: hit.name, how: 'named in the backup' };
  }
  const ranked = parsed.sort((a, b) => (isBuiltIn(b.record) - isBuiltIn(a.record))
    || Object.keys(a.entries).length - Object.keys(b.entries).length || a.name.localeCompare(b.name));
  return ranked.length ? { name: ranked[0].name, how: 'the smallest role in the backup that holds every entry' } : null;
}

// ------------------------------------------------------------ planning

const listed = (resourceKey, field, before, after, reason) => ({ resourceKey, field, before: before ?? null, after: after ?? null, reason });
/** The live state an operation was planned against. */
const addFingerprint = (liveRoles, name, parent) => sha256({
  target: liveRoles.some((role) => lower(role.name) === lower(name)) ? 'present' : 'absent',
  parent: liveRoles.some((role) => lower(role.name) === lower(parent)) ? 'present' : 'absent',
});

/**
 * Builds the frozen plan. `live` is { roles: readLiveRoles(), entries: { [role]: entries } }
 * for the roles that exist, or { error } when the roles could not be read.
 */
export function planExchangeRoleRestore({ source, live, tenantId, tenantRef, targets = [], testTenantRefs = TEST_TENANT_REFS }) {
  if (!source?.collectionId) throw new TypeError('an Exchange role restore needs a backup');
  if (typeof tenantRef !== 'string' || !tenantRef) throw new TypeError('an Exchange role restore plan needs the tenant');
  if (typeof tenantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(tenantId)) throw new TypeError('tenantId must be the managed tenant\'s directory id');
  if (!['complete', 'complete-empty', 'partial'].includes(source.outcome)) throw new Error(`a ${source.outcome} backup is not a restore source`);
  if (live?.error || !Array.isArray(live?.roles)) throw new Error(`the Exchange admin roles could not be read live (${live?.error ?? 'no answer'}); nothing is planned`);
  const roles = targetRoles(source, targets);
  if (roles.length > MAX_ROLE_TARGETS) throw new Error(`a plan covers at most ${MAX_ROLE_TARGETS} roles; name them with --target`);

  const operations = [];
  const manual = [];
  const builtIn = targets.length ? 0 : (source.roles ?? []).filter(({ record }) => isBuiltIn(record)).length;
  const excluded = builtIn ? [{ resourceKey: null, count: builtIn, reason: 'built-in Exchange admin roles are set by Microsoft and are never written' }] : [];
  const refusals = [];
  const liveFingerprints = {};
  for (const { naturalKey, record } of [...roles].sort((a, b) => a.naturalKey.localeCompare(b.naturalKey))) {
    const key = naturalKey;
    const name = roleName(record);
    if (!name || !ROLE_NAME_RE.test(name)) {
      manual.push(listed(key, 'Name', null, name, 'the backup holds no role name Keel can send, so an administrator restores it'));
      continue;
    }
    const notFixture = fixtureProblem({ tenantRef, testTenantRefs, label: key, names: [name] });
    if (notFixture) {
      refusals.push({ naturalKey: key, reason: `not-a-fixture: ${notFixture}` });
      continue;
    }
    const parsed = recordEntries(record);
    const current = live.roles.find((role) => lower(role.name) === lower(name)) ?? null;
    if (current) {
      // The role is still there: Keel does not change an existing role, it lists what differs.
      const entries = live.entries?.[current.name] ?? live.entries?.[name] ?? null;
      if (parsed.problem) manual.push(listed(key, null, null, null, `${parsed.problem}; the role still exists and is left as it is`));
      else if (!entries) manual.push(listed(key, null, null, null, 'the role still exists, but its entries could not be read live; it is left as it is'));
      else {
        const { removeEntries, removeParameters, missing } = entryDifferences(entries, parsed.entries);
        if (removeEntries.length) manual.push(listed(key, 'Entries', removeEntries, null, `the live role holds ${removeEntries.length} entr${removeEntries.length > 1 ? 'ies' : 'y'} the backup does not; Keel does not change an existing role, so an administrator removes them`));
        if (missing.length) manual.push(listed(key, 'Entries', null, missing.map(({ cmdlet, parameters }) => (parameters ? `${cmdlet} ${parameters.map((p) => `-${p}`).join(' ')}` : cmdlet)), 'the backup holds entries or parameters the live role does not; an administrator adds them from the parent role'));
        if (removeParameters.length) manual.push(listed(key, 'Parameters', removeParameters.map(({ cmdlet, parameters }) => `${cmdlet} ${parameters.map((p) => `-${p}`).join(' ')}`), null, 'the live role allows parameters the backup does not; an administrator removes them'));
      }
      if (typeof record.description === 'string' && current.description !== null && current.description !== record.description) {
        manual.push(listed(key, 'Description', current.description, record.description, 'the description changed; Keel does not change an existing role'));
      }
      continue;
    }
    if (parsed.problem) {
      manual.push(listed(key, null, null, null, `${parsed.problem}, so an administrator recreates it`));
      continue;
    }
    const parent = chooseParent(record, parsed.entries, source, new Set(live.roles.map((role) => lower(role.name))));
    if (!parent) {
      const anywhere = chooseParent(record, parsed.entries, source);
      manual.push(listed(key, 'Parent', null, anywhere?.name ?? null, anywhere
        ? `no role that holds every entry it has exists live (the backup's ${anywhere.name} would); restore the parent first, then plan again`
        : 'no role in the backup holds every entry this role has, so its parent is unknown; an administrator recreates it from the right parent role'));
      continue;
    }
    const description = typeof record.description === 'string' ? record.description : null;
    const parameters = { Name: name, Parent: parent.name, EnabledCmdlets: Object.keys(parsed.entries).sort() };
    if (description) parameters.Description = description;
    liveFingerprints[key] = addFingerprint(live.roles, name, parent.name);
    operations.push({
      key, resourceKey: key, naturalKey: key, kind: 'add', operationId: EXCHANGE_ROLE_ADD, name, parent: parent.name, parentChosen: parent.how,
      description, entries: parsed.entries, parameters,
      changes: [{ field: 'Name', before: null, after: name }, { field: 'Parent', before: null, after: parent.name }, { field: 'Entries', before: null, after: Object.keys(parsed.entries).length }],
    });
    manual.push(listed(key, 'Holders', null, null, 'the recreated role has no holders: who held it (role groups, people, apps) is restored separately, after a privilege review'));
  }

  const plan = {
    workload: EXCHANGE_ROLES_WORKLOAD,
    writer: 'exchange-powershell',
    tenantId: tenantId.toLowerCase(),
    targets: roles.map(({ naturalKey }) => naturalKey).sort(),
    source: { collectionId: source.collectionId, observedTo: source.observedTo ?? null, outcome: source.outcome },
    operations,
    manual,
    excluded,
    contentEffects: [],
    refusals,
    liveFingerprints,
  };
  plan.digest = exchangeRolePlanDigest(plan);
  return deepFreeze(plan);
}

export function exchangeRolePlanDigest(plan) {
  const { digest, ...rest } = plan;
  return sha256(rest);
}

/** Persists the plan as an immutable dry-run artifact. */
export async function createExchangeRoleArtifact(client, { tenantRef, plan, requestedBy, id = randomUUID() }) {
  const configPath = `workload:${plan.workload}`;
  return createDryRunArtifact(client, {
    id,
    tenantRef,
    snapshotId: null,
    selection: plan.targets,
    closureKeys: [...new Set([...plan.targets, ...plan.operations.map((op) => op.naturalKey)])],
    targetTenantId: plan.tenantId,
    collectorConfigPath: configPath,
    targetConfigPath: configPath,
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
    complianceFix: null,
  });
}

// ------------------------------------------------------------ execution

/**
 * Promotes one approved artifact. `cmdlet` is the restorer's runner (roleCmdletRunner);
 * `qualifications` maps the write operationId to its qualification.
 * Plan outcomes: refused, no-change, disabled, verified, partial.
 * Operation outcomes: disabled, refused, stale, failed, verification-failed, verified.
 */
export async function executeExchangeRoleRestore(client, {
  tenantRef, artifactId, tenantId, cmdlet, qualifications = {}, actor = null, testTenantRefs = TEST_TENANT_REFS,
}) {
  const artifact = await getDryRunArtifact(client, { id: artifactId, tenantRef });
  const by = actor ?? artifact?.requestedBy ?? 'keel';
  const finish = async (result) => {
    await appendEvidence(client, {
      tenantRef, kind: EXCHANGE_ROLE_EVIDENCE_KIND,
      subject: { artifactId, operationId: `${EXCHANGE_ROLES_WORKLOAD}.restore`, outcome: result.outcome, operations: result.operations.map(({ key, outcome }) => ({ key, outcome })), reasons: result.reasons ?? [] },
      actor: by,
    });
    return result;
  };
  const refuse = (reason) => finish({ outcome: 'refused', operations: [], reasons: [reason] });

  const plan = artifact?.workloadRestore ?? null;
  if (!plan || plan.workload !== EXCHANGE_ROLES_WORKLOAD || plan.writer !== 'exchange-powershell') return refuse('no Exchange admin role restore plan with this id');
  const promotable = validateArtifactForApproval(artifact);
  if (!promotable.ok) return refuse(promotable.reason);
  if (exchangeRolePlanDigest(plan) !== plan.digest || artifact.digest !== plan.digest || canonical(artifact.contentEffects ?? []) !== canonical(plan.contentEffects)) {
    return refuse('the stored plan no longer matches its digest; a new dry run is required');
  }
  if (String(tenantId ?? '').toLowerCase() !== plan.tenantId) return refuse(`the plan targets tenant ${plan.tenantId}, not ${tenantId}`);
  if (plan.operations.length === 0) return finish({ outcome: 'no-change', operations: [], reasons: ['no custom role in the backup is missing live'] });

  const results = new Map();
  const settle = async (op, result) => {
    const full = { writes: 0, verified: [], ...result };
    results.set(op.key, { key: op.key, kind: op.kind, operationId: op.operationId, ...full });
    await appendEvidence(client, {
      tenantRef, kind: EXCHANGE_ROLE_EVIDENCE_KIND,
      subject: {
        artifactId, operationId: op.operationId, kind: op.kind, target: op.resourceKey, outcome: full.outcome, writes: full.writes,
        attempts: full.attempts ?? full.writes, verified: full.verified, reasons: full.reasons, error: full.error ?? null,
      },
      actor: by,
    });
  };

  for (const op of plan.operations) {
    const qualification = qualifications[op.operationId];
    if (qualification?.operationId !== op.operationId || qualification.enabled !== true) {
      await settle(op, { outcome: 'disabled', reasons: [...(qualification?.reasons ?? [`no write qualification was supplied for ${op.operationId}`])] });
      continue;
    }
    // Read again just before writing: the role must still be gone and its parent still there.
    let now = null;
    try { now = addFingerprint(await readLiveRoles(cmdlet), op.name, op.parent); } catch { now = null; }
    if (now !== plan.liveFingerprints[op.resourceKey]) {
      await settle(op, { outcome: 'stale', reasons: ['the role or its parent changed since the dry run, or could not be read again; a new dry run is required'] });
      continue;
    }
    const notFixture = fixtureProblem({ tenantRef, testTenantRefs, label: op.resourceKey, names: [op.name] });
    if (notFixture) {
      await settle(op, { outcome: 'refused', reasons: [notFixture] });
      continue;
    }
    await settle(op, await recreateRole(op, { cmdlet }));
  }

  const operations = plan.operations.map((op) => results.get(op.key));
  const outcomes = new Set(operations.map((op) => op.outcome));
  let outcome = 'partial';
  for (const single of ['verified', 'disabled']) if (outcomes.size === 1 && outcomes.has(single)) outcome = single;
  return finish({ outcome, operations, reasons: [] });
}

const errorDetail = (error) => (error instanceof CmdletError ? error.detail : { message: error.message });
const denied = (error) => /access|denied|forbidden|unauthori[sz]ed|permission|not allowed/i.test(error?.detail?.message ?? error?.message ?? '');
async function exists(cmdlet, name) {
  try { return (await readLiveRoles(cmdlet)).some((role) => lower(role.name) === lower(name)); } catch { return null; }
}

/**
 * Runs one planned `add` with the restorer's runner: create, trim, read back. Returns
 * { outcome, writes, attempts?, verified?, reasons, error? }; sends nothing twice. The
 * caller has checked the qualification, the live state and the fixture rule.
 */
export async function recreateRole(op, { cmdlet }) {
  let writes = 0;
  const reasons = [];
  // 1. Create the role from its parent.
  try {
    writes += 1;
    await cmdlet({ cmdlet: 'New-ManagementRole', parameters: op.parameters });
  } catch (error) {
    if (error instanceof RoleWriteScopeError) return { outcome: 'refused', writes: 0, attempts: 0, reasons: [`${error.message}; nothing was sent`] };
    // A failed or unanswered create is reconciled by reading, never resent.
    const there = await exists(cmdlet, op.name);
    if (there !== true) {
      return {
        outcome: denied(error) ? 'refused' : 'failed', writes, attempts: 1, error: errorDetail(error),
        reasons: [`New-ManagementRole failed: ${error.message}; ${there === false ? 'the role does not exist, and nothing is retried automatically' : 'the role could not be read again'}`],
      };
    }
    reasons.push(`New-ManagementRole answered ${error.message}, but the role exists, so it was not resent`);
  }

  // 2. Trim the new role's entries to the backup. These run only on the role just created.
  let entries;
  try {
    entries = await readLiveRoleEntries(cmdlet, op.name);
  } catch (error) {
    return {
      outcome: 'verification-failed', writes, error: errorDetail(error),
      reasons: [...reasons, `the new role's entries could not be read (${error.message}); it may hold more than the backup, so an administrator checks it`],
    };
  }
  const { removeEntries, removeParameters } = entryDifferences(entries, op.entries);
  const steps = [
    ...removeParameters.map(({ cmdlet: name, parameters }) => ({ cmdlet: 'Set-ManagementRoleEntry', parameters: { Identity: `${op.name}\\${name}`, Parameters: parameters, RemoveParameter: true } })),
    ...removeEntries.map((name) => ({ cmdlet: 'Remove-ManagementRoleEntry', parameters: { Identity: `${op.name}\\${name}`, Confirm: false } })),
  ];
  for (const step of steps) {
    if (!CMDLET_RE.test(step.parameters.Identity.split('\\').pop())) {
      reasons.push(`${step.parameters.Identity} is not one role entry; it was not sent`);
      break;
    }
    try {
      writes += 1;
      await cmdlet(step);
    } catch (error) {
      reasons.push(`${step.cmdlet} ${step.parameters.Identity} failed: ${error.message}; nothing is retried automatically`);
      break;
    }
  }

  // 3. Read back: the entries and the description must be the backup's.
  let after;
  let role;
  try {
    after = await readLiveRoleEntries(cmdlet, op.name);
    role = (await readLiveRoles(cmdlet)).find((item) => lower(item.name) === lower(op.name)) ?? null;
  } catch (error) {
    return { outcome: 'verification-failed', writes, reasons: [...reasons, `the role could not be read back (${error.message})`], error: errorDetail(error) };
  }
  const problems = [];
  if (!role) problems.push('the role is not there');
  else {
    if (!sameEntries(after, op.entries)) {
      const left = entryDifferences(after, op.entries);
      if (left.removeEntries.length) problems.push(`it still holds ${left.removeEntries.join(', ')}`);
      if (left.removeParameters.length) problems.push(`it still allows ${left.removeParameters.map(({ cmdlet: name, parameters }) => `${name} -${parameters.join(' -')}`).join('; ')}`);
      if (left.missing.length) problems.push(`it lacks ${left.missing.map(({ cmdlet: name, parameters }) => (parameters ? `${name} -${parameters.join(' -')}` : name)).join('; ')} (the parent role ${op.parent} does not hold ${left.missing.length > 1 ? 'them' : 'it'})`);
    }
    if (op.description && role.description !== null && role.description !== op.description) problems.push('the description did not read back as written');
  }
  return {
    outcome: problems.length ? 'verification-failed' : 'verified', writes, attempts: writes,
    verified: problems.length ? [] : ['Name', 'Parent', 'Entries', ...(op.description ? ['Description'] : [])],
    reasons: [...reasons, ...problems],
    trimmed: { parameters: removeParameters.length, entries: removeEntries.length },
  };
}

// ------------------------------------------------------------ dispatch entry

/**
 * The dispatch.mjs entry. `--collection` names the Graph backup (snapshot) that holds the
 * roles; `runner` builds a cmdlet runner from a connection's PowerShell options (the
 * collector for the dry run, the restorer to promote).
 */
export function exchangeRoleRestore({ load = loadRoleSource, runner = roleCmdletRunner } = {}) {
  return Object.freeze({
    label: 'Exchange admin roles',
    operations: Object.freeze(Object.keys(EXCHANGE_ROLE_WRITE_OPERATIONS)),
    usage: '--collection <backup id> [--target <role name> ...]',
    async plan(client, { tenantRef, tenantId, request, connection }) {
      if (typeof request.collectionId !== 'string' || !request.collectionId) throw new Error('--collection <backup id> is required for this workload');
      const source = await load(client, { tenantRef, collectionId: request.collectionId });
      if (!source) throw new Error(`no backup ${request.collectionId} for this tenant`);
      const cmdlet = runner(connection.powershell);
      let live;
      try {
        const roles = await readLiveRoles(cmdlet);
        const entries = {};
        for (const name of rolesToRead(source, request.targets ?? [], roles)) entries[name] = await readLiveRoleEntries(cmdlet, name);
        live = { roles, entries };
      } catch (error) {
        live = { error: error.message };
      }
      return planExchangeRoleRestore({ source, live, tenantId, tenantRef, targets: request.targets ?? [] });
    },
    create: createExchangeRoleArtifact,
    execute: (client, { tenantRef, artifactId, tenantId, connection, qualifications }) => executeExchangeRoleRestore(client, {
      tenantRef, artifactId, tenantId, cmdlet: runner(connection.powershell), qualifications,
    }),
  });
}
