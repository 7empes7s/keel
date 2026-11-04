/**
 * Issue #964: owner review. Which Microsoft 365 groups and teams, app
 * registrations and enterprise apps have no working owner, read from the
 * newest complete backup. Read only: it reads stored backups and never calls
 * Microsoft.
 *
 * For each kind, the owner edges come from the newest complete backup that
 * read that owner family (`owner`, `appOwner`, `servicePrincipalOwner` in
 * engine/collect/relationships.mjs), and the parents from the same backup.
 * Owners are matched to users from the newest complete backup whose user read
 * finished in full (coverage outcome complete), so "no longer exists" is only
 * said when the whole user list was read.
 *
 * Honesty rules:
 *  - A failed, refused or partial owner read is never "no owner". It is
 *    `read-failed`, with Microsoft's answer and the permission the read needs.
 *  - A parent the backup holds but whose owners were not read is `not-read`.
 *  - Relationship reads are never reported complete (engine/coverage/report.mjs
 *    reports relationshipCompleteness `partial` at best); `completeness` says so.
 *  - Enterprise apps published by Microsoft are skipped. The backup's service
 *    principal read does not select appOwnerOrganizationId, so when it is not
 *    stored, an enterprise app counts as the tenant's own only when its appId
 *    matches an app registration in the backup; the rest are skipped and
 *    counted as `unknownPublisher`, never reviewed as ownerless.
 */
import { RELATIONSHIP_FAMILIES } from '../collect/relationships.mjs';
import { MICROSOFT_OWNER_TENANTS } from '../restore/identityObjectOperations.mjs';

export const OWNER_REVIEW_CONTRACT_VERSION = 1;

/** The kinds reviewed, each with the owner family and parent type it reads. */
export const OWNER_KINDS = Object.freeze({
  group: Object.freeze({ family: 'owner', parentType: 'group' }),
  application: Object.freeze({ family: 'appOwner', parentType: 'application' }),
  servicePrincipal: Object.freeze({ family: 'servicePrincipalOwner', parentType: 'servicePrincipal' }),
});

/** What is wrong with an item's owners, worst first. `fine` is not a problem. */
export const OWNER_PROBLEMS = Object.freeze(['no-owner', 'only-disabled', 'guest-owner', 'read-failed', 'not-read', 'fine']);

const COMPLETE = ['complete', 'complete-empty'];
const TEAMS_WORKLOAD = 'teams-settings';
const STORED_WORKLOAD = ['complete', 'complete-empty', 'partial'];

const lower = (value) => (typeof value === 'string' ? value.toLowerCase() : null);
const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * The newest complete backup whose user read finished in full, else the newest
 * complete backup holding any users (then `complete` is false and a missing
 * owner is "unknown", not "no longer exists"). Users are keyed by lower-case id.
 */
export async function loadOwnerDirectory(client, { tenantRef }) {
  const pick = async (fullOnly) => (await client.query(
    `SELECT s.id, s.completed_at FROM snapshot s
      WHERE s.tenant_ref = $1 AND s.status = 'complete'
        AND ($2::boolean IS FALSE OR s.coverage_digest->'user'->>'outcome' = ANY($3::text[]))
        AND (SELECT 1 FROM resource_version rv WHERE rv.snapshot_id = s.id AND rv.resource_type = 'user' LIMIT 1) IS NOT NULL
      ORDER BY s.started_at DESC LIMIT 1`,
    [tenantRef, fullOnly, COMPLETE],
  )).rows[0];
  const full = await pick(true);
  const row = full ?? await pick(false);
  const users = new Map();
  if (!row) return { snapshotId: null, readAt: null, complete: false, users };
  const { rows } = await client.query(
    `SELECT payload->>'id' AS id, payload->>'displayName' AS name, payload->>'userPrincipalName' AS upn,
            payload->'accountEnabled' AS enabled, payload->>'userType' AS user_type
       FROM resource_version WHERE snapshot_id = $1 AND resource_type = 'user'`,
    [row.id],
  );
  for (const user of rows) {
    const id = lower(user.id);
    if (!id) continue;
    users.set(id, {
      id,
      name: user.name ?? user.upn ?? null,
      upn: user.upn ?? null,
      // Only an explicit false is disabled: a user read without the field is not.
      disabled: user.enabled === false,
      guest: lower(user.user_type) === 'guest',
    });
  }
  return { snapshotId: row.id, readAt: iso(row.completed_at), complete: Boolean(full), users };
}

/** The newest complete backup that read `family` for the tenant, with its edge sets. */
async function loadFamily(client, tenantRef, family) {
  const { rows: [snap] } = await client.query(
    `SELECT s.id, s.completed_at FROM snapshot s
      WHERE s.tenant_ref = $1 AND s.status = 'complete'
        AND (SELECT 1 FROM relationship_edge_set r WHERE r.snapshot_id = s.id AND r.family = $2 AND r.tenant_ref = $1 LIMIT 1) IS NOT NULL
      ORDER BY s.started_at DESC LIMIT 1`,
    [tenantRef, family],
  );
  if (!snap) return null;
  const { rows } = await client.query(
    `SELECT lower(s.parent_source_id) AS parent_id, s.outcome, s.http_status, s.graph_code, s.error, s.completed_at,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', lower(e.target_source_id), 'type', e.target_type) ORDER BY e.target_source_id)
                        FROM relationship_edge e WHERE e.set_id = s.id AND e.tenant_ref = $3), '[]'::jsonb) AS targets
       FROM relationship_edge_set s
      WHERE s.snapshot_id = $1 AND s.family = $2 AND s.tenant_ref = $3`,
    [snap.id, family, tenantRef],
  );
  const sets = new Map(rows.map((row) => [row.parent_id, row]));
  return { snapshotId: snap.id, readAt: iso(snap.completed_at), sets };
}

/** The payloads of one type in one backup. */
async function loadParents(client, snapshotId, type) {
  const { rows } = await client.query(
    `SELECT natural_key, payload FROM resource_version WHERE snapshot_id = $1 AND resource_type = $2 ORDER BY natural_key`,
    [snapshotId, type],
  );
  return rows.filter((row) => typeof row.payload?.id === 'string');
}

/** Team ids from the newest Teams settings read that stored teams; empty when none. */
async function loadTeamIds(client, tenantRef) {
  const { rows: [run] } = await client.query(
    `SELECT id FROM workload_collection WHERE tenant_ref = $1 AND workload = $2 AND outcome = ANY($3::text[])
      ORDER BY created_at DESC, observed_to DESC LIMIT 1`,
    [tenantRef, TEAMS_WORKLOAD, STORED_WORKLOAD],
  );
  if (!run) return new Set();
  const { rows } = await client.query(
    `SELECT resource_key FROM workload_observation WHERE collection_id = $1 AND resource_key LIKE 'team:%'`,
    [run.id],
  );
  return new Set(rows.map((row) => lower(String(row.resource_key).slice('team:'.length))));
}

/**
 * One owner as the review sees it: a working user, a disabled user, a guest, an
 * app, a user who no longer exists (`gone`), or `unknown` when the user list
 * was not read in full.
 */
export function ownerState(target, directory, apps = new Map()) {
  const id = lower(target?.id);
  const user = id ? directory.users.get(id) : null;
  if (user) return { id, name: user.name, state: user.disabled ? 'disabled' : user.guest ? 'guest' : 'working' };
  const app = id ? apps.get(id) : null;
  const type = target?.type ?? null;
  if (app || (type && type !== 'user')) return { id, name: app ?? null, state: 'app' };
  return { id, name: null, state: directory.complete ? 'gone' : 'unknown' };
}

/**
 * The problem with one edge set. A failed or refused read is `read-failed`; a
 * partial read is judged on what it returned only when that includes a working
 * owner, and is `read-failed` otherwise (an owner may be on the unread page).
 */
export function classifyOwners(set, directory, apps = new Map()) {
  if (!set) return { problem: 'not-read', owners: [] };
  const owners = (set.targets ?? []).map((target) => ownerState(target, directory, apps));
  const working = owners.filter((owner) => owner.state === 'working' || owner.state === 'app' || owner.state === 'unknown');
  const guests = owners.filter((owner) => owner.state === 'guest');
  const disabled = owners.filter((owner) => owner.state === 'disabled');
  if (!COMPLETE.includes(set.outcome)) {
    if (set.outcome === 'partial' && working.length) return { problem: guests.length ? 'guest-owner' : 'fine', owners };
    return { problem: 'read-failed', owners };
  }
  if (working.length) return { problem: guests.length ? 'guest-owner' : 'fine', owners };
  if (guests.length) return { problem: 'guest-owner', owners };
  if (disabled.length) return { problem: 'only-disabled', owners };
  // No owners, or only owners who no longer exist.
  return { problem: 'no-owner', owners };
}

function readFailure(set) {
  if (!set || COMPLETE.includes(set.outcome)) return null;
  return { outcome: set.outcome, httpStatus: set.http_status ?? null, graphCode: set.graph_code ?? null, error: set.error ?? null };
}

/** Whether an enterprise app is the tenant's to review, and why not when it is not. */
export function enterpriseAppScope(payload, ownAppIds) {
  if (payload?.servicePrincipalType && payload.servicePrincipalType !== 'Application') return 'other-type';
  const publisher = lower(payload?.appOwnerOrganizationId);
  if (publisher && MICROSOFT_OWNER_TENANTS.includes(publisher)) return 'microsoft';
  if (ownAppIds.has(lower(payload?.appId))) return 'review';
  return publisher ? 'review' : 'unknown-publisher';
}

/**
 * The whole review for one tenant. `items` holds every reviewed group, team and
 * app with its problem (including `fine`), so the page can count and filter.
 */
export async function ownerReview(client, { tenantRef, now = new Date() }) {
  const directory = await loadOwnerDirectory(client, { tenantRef });
  const teamIds = await loadTeamIds(client, tenantRef);
  const items = [];
  const reads = {};
  const skipped = { microsoft: 0, unknownPublisher: 0, otherType: 0 };
  const parentsByType = {};

  for (const [kind, { family, parentType }] of Object.entries(OWNER_KINDS)) {
    const loaded = await loadFamily(client, tenantRef, family);
    const requires = RELATIONSHIP_FAMILIES[family]?.requires ?? [];
    reads[kind] = { family, permission: requires[0] ?? null, snapshotId: loaded?.snapshotId ?? null, readAt: loaded?.readAt ?? null, failed: 0, refused: 0, notRead: 0 };
    parentsByType[parentType] = loaded ? await loadParents(client, loaded.snapshotId, parentType) : [];
    reads[kind].loaded = loaded;
  }

  // Names for app owners (a service principal can own a group or an app).
  const apps = new Map(parentsByType.servicePrincipal.map((row) => [lower(row.payload.id), row.payload.displayName ?? null]));
  const ownAppIds = new Set(parentsByType.application.map((row) => lower(row.payload.appId)).filter(Boolean));

  for (const [kind, { parentType }] of Object.entries(OWNER_KINDS)) {
    const read = reads[kind];
    const { loaded } = read;
    delete read.loaded;
    if (!loaded) continue;
    for (const row of parentsByType[parentType]) {
      const payload = row.payload;
      const id = lower(payload.id);
      let itemKind = kind;
      if (kind === 'group') {
        // Microsoft 365 groups only; a team is a Microsoft 365 group with a team.
        if (!Array.isArray(payload.groupTypes) || !payload.groupTypes.includes('Unified')) continue;
        if (teamIds.has(id)) itemKind = 'team';
      }
      if (kind === 'servicePrincipal') {
        const scope = enterpriseAppScope(payload, ownAppIds);
        if (scope === 'microsoft') { skipped.microsoft += 1; continue; }
        if (scope === 'unknown-publisher') { skipped.unknownPublisher += 1; continue; }
        if (scope === 'other-type') { skipped.otherType += 1; continue; }
      }
      const set = loaded.sets.get(id) ?? null;
      const { problem, owners } = classifyOwners(set, directory, apps);
      const failure = readFailure(set);
      if (problem === 'read-failed') {
        if (failure && [401, 403].includes(failure.httpStatus)) read.refused += 1;
        else read.failed += 1;
      }
      if (problem === 'not-read') read.notRead += 1;
      items.push({
        kind: itemKind,
        id,
        appId: payload.appId ?? null,
        naturalKey: row.natural_key,
        name: payload.displayName ?? null,
        problem,
        owners,
        counts: {
          total: owners.length,
          working: owners.filter((owner) => owner.state === 'working' || owner.state === 'app').length,
          disabled: owners.filter((owner) => owner.state === 'disabled').length,
          guests: owners.filter((owner) => owner.state === 'guest').length,
          gone: owners.filter((owner) => owner.state === 'gone').length,
          unknown: owners.filter((owner) => owner.state === 'unknown').length,
        },
        readFailure: failure,
        readAt: iso(set?.completed_at) ?? loaded.readAt,
      });
    }
  }

  return {
    generatedAt: now.toISOString(),
    tenantRef,
    directory: { snapshotId: directory.snapshotId, readAt: directory.readAt, complete: directory.complete, users: directory.users.size },
    reads,
    skipped,
    // Relationship reads are never complete (engine/coverage/report.mjs).
    completeness: 'partial',
    items,
  };
}

/**
 * The same disabled and guest check for owners known only by display name (a
 * SharePoint site's owners). A name counts only when exactly one user has it.
 * `count` is how many owners the site has; names may be fewer (some have no
 * name, and the stored list is capped), so "only disabled" needs every owner
 * matched to a disabled user.
 */
export function classifyNamedOwners({ names = [], count = names.length } = {}, directory) {
  const byName = new Map();
  for (const user of directory.users.values()) {
    const key = lower(user.name);
    if (!key) continue;
    byName.set(key, byName.has(key) ? null : user);
  }
  const disabled = [];
  const guests = [];
  let matched = 0;
  for (const name of names) {
    const user = byName.get(lower(name)) ?? null;
    if (!user) continue;
    matched += 1;
    if (user.disabled) disabled.push(name);
    else if (user.guest) guests.push(name);
  }
  const problem = count > 0 && disabled.length === count && matched === count
    ? 'only-disabled'
    : guests.length ? 'guest-owner' : null;
  return { problem, disabled, guests, matched };
}
