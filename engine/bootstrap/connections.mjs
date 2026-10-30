// Connections (handoff/delegated-access DESIGN 3.4, build step 2): one row per Keel
// app in the tenant, with its state and certificate expiry, and an access_event for
// every change. Filled from what the Setup page already reads: the setup host's
// read-only tenant observation (the planner's readers) and the credential files the
// host is configured with. Nothing here calls Microsoft or changes the tenant.
//
// Unknown is never absent: without a tenant read an app is 'not-checked', and a
// connection already recorded keeps its last observed state until Keel can look again.
import { X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { planBootstrap } from './plan.mjs';
import { SETUP_SCOPES } from './onboarding.mjs';
import { registeredWorkloads } from './prerequisites.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { assertTokenFree } from '../../tools/tenant-probe/auth.mjs';

// Today's four apps and the DESIGN 3.2 role each becomes. Listed in the order the
// portal shows them: required first.
export const CONNECTION_APPS = Object.freeze([
  Object.freeze({ role: 'settings-reader', identity: 'collector', name: 'Keel Settings Reader', required: true,
    purpose: 'Backs up your Microsoft 365 settings. Read only.' }),
  Object.freeze({ role: 'content-reader', identity: 'content-reader', name: 'Keel Content Reader', required: false,
    purpose: 'Backs up mail, files, Teams and Planner. Read only.' }),
  Object.freeze({ role: 'settings-restorer', identity: 'restorer', name: 'Keel Settings Restorer', required: false,
    purpose: 'Puts settings back when you approve a restore.' }),
  // Issue #681: Viva Engage refuses the Settings Restorer's sign-in once it holds many
  // permissions, so community restores use this small app of its own.
  Object.freeze({ role: 'engage-writer', identity: 'engage-writer', name: 'Keel Engage Writer', required: false,
    purpose: 'Puts Viva Engage communities back when you approve a restore. Holds one permission only.' }),
]);

export const CONNECTION_STATES = Object.freeze(['not-checked', 'not-created', 'waiting-for-consent', 'working',
  'missing-permission', 'switched-off', 'needs-reconnect', 'removed']);

// Who records a change Keel observed itself (not a portal user's action).
export const OBSERVER = 'keel:setup-check';

/** The certificate's expiry as an ISO time, or null when the file cannot be read. */
export function certificateExpiry(certPath, readFile = readFileSync) {
  if (typeof certPath !== 'string' || certPath.length === 0) return null;
  try {
    return new Date(new X509Certificate(readFile(certPath)).validTo).toISOString();
  } catch {
    return null;
  }
}

const sorted = (values) => [...values].sort();

/**
 * One app's connection from a planner run over the tenant observation. `plan` is
 * null when the tenant could not be read. Returns { state, objectRef, wanted, observed }.
 */
export function deriveConnection({ identity, appId, plan, servicePrincipals = [], uncheckedKinds = [],
  credentialExpiresAt = null, previousMissingRoles = null, now = new Date() }) {
  if (!appId) return { state: 'not-created', objectRef: null, wanted: null, observed: null };
  const expired = credentialExpiresAt !== null && Date.parse(credentialExpiresAt) <= now.getTime();
  if (!plan) return { state: expired ? 'needs-reconnect' : 'not-checked', objectRef: appId, wanted: null, observed: null };

  const steps = plan.steps.filter((step) => step.identity === identity);
  const registration = steps.find((step) => step.kind === 'registration');
  // The tenant read did not cover this app: nothing is claimed.
  if (!registration) return { state: expired ? 'needs-reconnect' : 'not-checked', objectRef: appId, wanted: null, observed: null };
  const consent = steps.find((step) => step.kind === 'graph-permission');
  const roles = steps.filter((step) => step.kind === 'workload-rbac');
  const rolesChecked = !uncheckedKinds.includes('workload-rbac');
  const sp = registration?.servicePrincipalObjectId
    ? servicePrincipals.find((candidate) => candidate?.id === registration.servicePrincipalObjectId) ?? null
    : null;

  const wanted = {
    permissions: sorted(consent?.requiredScopes ?? []),
    roles: sorted(roles.map((step) => step.name)),
  };
  const observed = {
    at: now.toISOString(),
    displayName: registration?.reference?.displayName ?? null,
    registered: Boolean(registration?.reference),
    servicePrincipal: Boolean(registration?.servicePrincipalObjectId),
    enabled: sp ? sp.accountEnabled !== false : null,
    grantedPermissions: sorted(consent?.consentedScopes ?? []),
    missingPermissions: sorted(consent?.missingScopes ?? []),
    extraPermissions: sorted(consent?.excessScopes ?? []),
    // When Keel cannot see the role assignments this time, the last read stands; with
    // none, null: no role is called missing, and none is called assigned either.
    missingRoles: rolesChecked ? sorted(roles.filter((step) => step.status !== 'satisfied').map((step) => step.name))
      : previousMissingRoles,
    rolesChecked,
  };

  let state;
  if (!observed.registered) state = 'not-created';
  else if (!observed.servicePrincipal) state = 'waiting-for-consent';
  else if (observed.enabled === false) state = 'switched-off';
  else if (expired) state = 'needs-reconnect';
  else if (wanted.permissions.length > 0 && observed.grantedPermissions.filter((p) => wanted.permissions.includes(p)).length === 0) {
    state = 'waiting-for-consent';
  } else if (observed.missingPermissions.length > 0 || (observed.missingRoles ?? []).length > 0) state = 'missing-permission';
  else if (wanted.roles.length > 0 && observed.missingRoles === null) state = 'not-checked';
  else state = 'working';
  return { state, objectRef: appId, wanted, observed };
}

// What an access_event records: everything that matters except the observation time.
const material = (row) => ({
  state: row.state,
  objectRef: row.object_ref ?? null,
  credentialRef: row.credential_ref ?? null,
  credentialExpiresAt: row.credential_expires_at ? new Date(row.credential_expires_at).toISOString() : null,
  wanted: row.wanted ?? null,
  observed: row.observed ? canonical({ ...row.observed, at: undefined, rolesChecked: undefined }) : null,
});
// jsonb does not keep key order, so compare with sorted keys.
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => [key, canonical(value[key])]))
    : value;
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

// The identities the setup planner observes. Others (the content reader) are read for
// the permission table only, so their steps are built from that table.
const PLANNED_IDENTITIES = Object.freeze(Object.values(SETUP_SCOPES));
const tableId = (identity) => `table:${identity}`;

// Registration and Graph consent steps for an app the planner does not see, from the
// setup host's permission table entry ({ app, registered, servicePrincipal, enabled, granted }).
function tableSteps(identity, entry) {
  if (!entry || typeof entry.registered !== 'boolean') return [];
  const required = sorted(new Set(registeredWorkloads().filter((r) => r.identity === identity).flatMap((r) => r.graphPermissions)));
  const consented = sorted(new Set((entry.granted ?? []).filter((grant) => grant.api === 'graph').map((grant) => grant.name)));
  return [
    { kind: 'registration', identity, reference: entry.registered ? { appId: entry.app?.appId ?? null, displayName: entry.app?.displayName ?? null } : null,
      servicePrincipalObjectId: entry.servicePrincipal ? tableId(identity) : null },
    { kind: 'graph-permission', identity, requiredScopes: required, consentedScopes: consented,
      missingScopes: required.filter((scope) => !consented.includes(scope)),
      excessScopes: consented.filter((scope) => !required.includes(scope)) },
  ];
}

async function plannedObservation({ tenantRef, readers, identities, now }) {
  if (!readers) return { plan: null, servicePrincipals: [], uncheckedKinds: [] };
  const planned = identities.filter((identity) => PLANNED_IDENTITIES.includes(identity));
  const workloads = registeredWorkloads().filter((r) => planned.includes(r.identity)).map((r) => r.workload);
  const plan = await planBootstrap({ tenantRef, workloads, readAdapters: readers, operatorPrincipalId: null, now });
  const table = readers.listPermissions ? await readers.listPermissions() : {};
  const others = identities.filter((identity) => !planned.includes(identity));
  return {
    plan: { ...plan, steps: [...plan.steps, ...others.flatMap((identity) => tableSteps(identity, table[identity]))] },
    servicePrincipals: [...await readers.listServicePrincipals(),
      ...others.filter((identity) => table[identity]?.servicePrincipal)
        .map((identity) => ({ id: tableId(identity), ...(table[identity].enabled === false ? { accountEnabled: false } : {}) }))],
    uncheckedKinds: readers.uncheckedKinds ? await readers.uncheckedKinds() : [],
  };
}

/**
 * Records each Keel app's connection for the tenant. `apps` maps an identity
 * (collector, content-reader, restorer, engage-writer) to { appId, credentialRef, credentialExpiresAt }
 * or null when the host has no credential for it. `readers` are the setup host's
 * read adapters, or null when the tenant cannot be read. Writes an access_event only
 * when something changed. Runs in its own transaction on `client`.
 */
export async function syncConnections(client, { tenantRef, apps = {}, readers = null, actor = OBSERVER, now = new Date() }) {
  assertTenantRef(tenantRef);
  const identities = CONNECTION_APPS.map((app) => app.identity).filter((identity) => apps[identity]?.appId);
  let observation;
  try {
    observation = await plannedObservation({ tenantRef, readers: identities.length ? readers : null, identities, now });
  } catch {
    // The tenant could not be read just now: nothing is claimed, the last observation stands.
    observation = await plannedObservation({ tenantRef, readers: null, identities, now });
  }

  await client.query('BEGIN');
  try {
    for (const app of CONNECTION_APPS) {
      const bound = apps[app.identity] ?? null;
      const { rows: [current] } = await client.query(
        'SELECT * FROM access_connection WHERE tenant_ref = $1 AND role = $2 FOR UPDATE', [tenantRef, app.role]);
      // No credential file on the host says nothing about the tenant: a recorded
      // connection stays as it was (a missing file may be a redeploy or a move).
      if (!bound?.appId && current) continue;
      // A slower check that read the tenant before a newer one committed adds nothing.
      if (current?.observed?.at && observation.plan && Date.parse(current.observed.at) > now.getTime()) continue;
      const derived = deriveConnection({
        identity: app.identity, appId: bound?.appId ?? null, ...observation,
        credentialExpiresAt: bound?.credentialExpiresAt ?? null, now,
        previousMissingRoles: current?.object_ref === bound?.appId ? current?.observed?.missingRoles ?? null : null,
      });
      const next = assertTokenFree({
        state: derived.state, object_ref: derived.objectRef, wanted: derived.wanted, observed: derived.observed,
        credential_ref: bound?.credentialRef ?? null, credential_expires_at: bound?.credentialExpiresAt ?? null,
      }, 'access connection');

      if (!current) {
        const { rows: [created] } = await client.query(`INSERT INTO access_connection
            (tenant_ref, kind, role, object_ref, state, wanted, observed, credential_ref, credential_expires_at, created_by, updated_by, updated_at)
          VALUES ($1, 'app', $2, $3, $4, $5, $6, $7, $8, $9, $9, $10)
          ON CONFLICT (tenant_ref, role) DO NOTHING RETURNING *`,
        [tenantRef, app.role, next.object_ref, next.state, next.wanted, next.observed, next.credential_ref, next.credential_expires_at, actor, now]);
        // Another check recorded it first; it is current, so this one adds nothing.
        if (!created) continue;
        await client.query(`INSERT INTO access_event (tenant_ref, connection_id, action, actor, at, before, after)
          VALUES ($1, $2, 'recorded', $3, $4, NULL, $5)`, [tenantRef, created.id, actor, now, material(created)]);
        continue;
      }

      // Without a tenant read, keep what was last observed: not checked is not changed.
      // An expired certificate is known without a tenant read, so that state still applies.
      if (observation.plan === null && next.object_ref === current.object_ref) {
        // A renewed certificate clears needs-reconnect, but nothing else is known yet.
        if (next.state === 'not-checked') next.state = current.state === 'needs-reconnect' ? 'not-checked' : current.state;
        next.wanted = current.wanted;
        next.observed = current.observed;
      }
      const before = material(current);
      const after = material({ ...current, ...next });
      if (same(before, after)) {
        if (next.observed && !same(next.observed, current.observed)) {
          // Only the observation time moved.
          await client.query('UPDATE access_connection SET observed = $2 WHERE id = $1', [current.id, next.observed]);
        }
        continue;
      }
      await client.query(`UPDATE access_connection SET object_ref = $2, state = $3, wanted = $4, observed = $5,
          credential_ref = $6, credential_expires_at = $7, updated_by = $8, updated_at = $9 WHERE id = $1`,
      [current.id, next.object_ref, next.state, next.wanted, next.observed, next.credential_ref, next.credential_expires_at, actor, now]);
      await client.query(`INSERT INTO access_event (tenant_ref, connection_id, action, actor, at, before, after)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantRef, current.id, before.state === after.state ? 'observed' : 'state-changed', actor, now, before, after]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

const DAY = 24 * 60 * 60 * 1000;

/** The tenant's connections as /api/setup returns them, in CONNECTION_APPS order. */
export async function loadConnections(client, { tenantRef, now = new Date() }) {
  assertTenantRef(tenantRef);
  const { rows } = await client.query('SELECT * FROM access_connection WHERE tenant_ref = $1', [tenantRef]);
  const byRole = new Map(rows.map((row) => [row.role, row]));
  return CONNECTION_APPS.filter((app) => byRole.has(app.role)).map((app) => {
    const row = byRole.get(app.role);
    const expiresAt = row.credential_expires_at ? new Date(row.credential_expires_at) : null;
    return {
      id: row.id,
      kind: row.kind,
      role: app.role,
      name: app.name,
      purpose: app.purpose,
      required: app.required,
      state: row.state,
      appId: row.object_ref,
      // The certificate on the Keel host. The file path is server configuration and stays there.
      credentialExpiresAt: expiresAt ? expiresAt.toISOString() : null,
      credentialExpiresInDays: expiresAt ? Math.floor((expiresAt.getTime() - now.getTime()) / DAY) : null,
      wanted: row.wanted,
      observed: row.observed,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
      lastSignInAt: row.last_sign_in_at ? new Date(row.last_sign_in_at).toISOString() : null,
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  });
}
