// engine/govern/workloadApproved.mjs
//
// The approved setup for service settings: for each workload (Exchange, SharePoint and
// OneDrive, Teams, Purview, Power Platform), the value each resource is approved to
// have. Workload drift (workloadDrift.mjs) compares every read with it, so a change
// stays on the Changes page until a person accepts it (it joins the approved setup
// here) or undoes it (the workload restore puts the approved value back, and the next
// read matches again).
//
// A workload's approved setup is taken once, from a read, the first time drift runs for
// it. Changes still waiting for review at that moment keep their earlier value, so
// taking the setup never quietly approves them.
import { appendEvidence } from './evidence.mjs';

// The alert states a change is still waiting in (the Changes page's own list).
export const WAITING_ALERT_STATES = Object.freeze(['open', 'reopened', 'acknowledged']);

// Reads that hold settings (workloadDrift.mjs compares only these).
export const USABLE_OUTCOMES = Object.freeze(['complete', 'complete-empty', 'partial']);

export class ServiceChangeError extends Error {}

/** The approved setup's row for one tenant and workload, or null when there is none yet. */
export async function getApprovedSetup(client, { tenantRef, workload }) {
  const { rows: [setup] } = await client.query(
    'SELECT * FROM workload_approved_setup WHERE tenant_ref = $1 AND workload = $2',
    [tenantRef, workload],
  );
  return setup ?? null;
}

async function upsertApproved(client, { tenantRef, workload, resourceKey, collectionId, actor = null, reason = null }) {
  const { rowCount } = await client.query(
    `INSERT INTO workload_approved (tenant_ref, workload, resource_key, fields, field_coverage, collection_id, approved_by, reason)
     SELECT $1, $2, o.resource_key, o.fields, o.field_coverage, o.collection_id, $5, $6
       FROM workload_observation o WHERE o.collection_id = $3 AND o.resource_key = $4
     ON CONFLICT (tenant_ref, workload, resource_key) DO UPDATE
       SET fields = EXCLUDED.fields, field_coverage = EXCLUDED.field_coverage, collection_id = EXCLUDED.collection_id,
           approved_by = EXCLUDED.approved_by, reason = EXCLUDED.reason, approved_at = now()`,
    [tenantRef, workload, collectionId, resourceKey, actor, reason],
  );
  return rowCount;
}

/**
 * Takes a workload's approved setup from the read `collectionId`, unless one exists.
 * Every resource of that read is approved as read, except changes still waiting for
 * review (their alert is open, reopened or acknowledged, or they raised none): those
 * keep the value from before the change, so they stay changes to decide on.
 * Runs inside the caller's transaction. Returns the setup row.
 */
export async function seedApprovedSetup(client, { tenantRef, workload, collectionId }) {
  const { rows: [created] } = await client.query(
    `INSERT INTO workload_approved_setup (tenant_ref, workload, seeded_from) VALUES ($1, $2, $3)
     ON CONFLICT (tenant_ref, workload) DO NOTHING RETURNING *`,
    [tenantRef, workload, collectionId],
  );
  if (!created) return getApprovedSetup(client, { tenantRef, workload });

  await client.query(
    `INSERT INTO workload_approved (tenant_ref, workload, resource_key, fields, field_coverage, collection_id)
     SELECT $1, $2, resource_key, fields, field_coverage, collection_id FROM workload_observation WHERE collection_id = $3
     ON CONFLICT (tenant_ref, workload, resource_key) DO NOTHING`,
    [tenantRef, workload, collectionId],
  );
  const { rows: waiting } = await client.query(
    `SELECT * FROM (
       SELECT DISTINCT ON (d.resource_key) d.resource_key, d.change_type, d.previous_collection_id, a.state AS alert_state
         FROM workload_drift d
         JOIN workload_collection c ON c.id = d.collection_id
         JOIN workload_collection base ON base.id = $3
         LEFT JOIN alert a ON a.tenant_ref = d.tenant_ref AND a.resource_key = d.workload || ':' || d.resource_key
                          AND a.control = 'baseline' AND a.condition = 'drift'
        WHERE d.tenant_ref = $1 AND d.workload = $2 AND c.created_at <= base.created_at
        ORDER BY d.resource_key, c.created_at DESC, d.detected_at DESC
     ) newest WHERE alert_state IS NULL OR alert_state = ANY($4::text[])`,
    [tenantRef, workload, collectionId, WAITING_ALERT_STATES],
  );
  for (const change of waiting) {
    if (change.change_type === 'added') {
      await client.query(
        'DELETE FROM workload_approved WHERE tenant_ref = $1 AND workload = $2 AND resource_key = $3',
        [tenantRef, workload, change.resource_key],
      );
    } else {
      await upsertApproved(client, { tenantRef, workload, resourceKey: change.resource_key, collectionId: change.previous_collection_id });
    }
  }
  return created;
}

/**
 * The approved setup as a compareWorkloads side: { collectionId, outcome, at,
 * observations }. It is authoritative (outcome complete): a resource it lacks is not
 * approved. `strip` removes the fields that move on their own. `sources` maps each
 * resource key to the read that holds its approved value.
 */
export async function loadApprovedSide(client, { setup, strip = (value) => value }) {
  const { rows } = await client.query(
    `SELECT resource_key, fields, field_coverage, collection_id FROM workload_approved
      WHERE tenant_ref = $1 AND workload = $2`,
    [setup.tenant_ref, setup.workload],
  );
  return {
    side: new Map([[setup.workload, {
      collectionId: setup.seeded_from,
      outcome: 'complete',
      at: setup.seeded_at,
      observations: rows.map((row) => ({ resourceKey: row.resource_key, fields: strip(row.fields), fieldCoverage: strip(row.field_coverage) })),
    }]]),
    sources: new Map(rows.map((row) => [row.resource_key, row.collection_id])),
  };
}

/**
 * Accept one service setting change: the state it found joins the approved setup (or,
 * for a removal, leaves it). Nothing in Microsoft 365 changes. Only the newest change
 * to a resource can be accepted, and only on its own tenant. Records a `disposition`
 * evidence row. Returns { workload, resourceKey, changeType, alertId } so the caller
 * can settle the change's alert.
 */
export async function acceptServiceChange(client, { tenantRef, changeId, actor, reason }) {
  if (typeof reason !== 'string' || !reason.trim()) throw new ServiceChangeError('a reason is required');
  if (typeof actor !== 'string' || !actor) throw new ServiceChangeError('an actor is required');
  let change;
  await client.query('BEGIN');
  try {
    const { rows: [row] } = await client.query(
      `SELECT d.*, c.created_at AS collected_at FROM workload_drift d JOIN workload_collection c ON c.id = d.collection_id
        WHERE d.id = $1 AND d.tenant_ref = $2 FOR UPDATE OF d`,
      [changeId, tenantRef],
    );
    if (!row) throw new ServiceChangeError('service change not found');
    const { rows: [newer] } = await client.query(
      `SELECT d.id FROM workload_drift d JOIN workload_collection c ON c.id = d.collection_id
        WHERE d.tenant_ref = $1 AND d.workload = $2 AND d.resource_key = $3 AND d.id <> $4
          AND (c.created_at, c.id) > ($5, $6)
        LIMIT 1`,
      [tenantRef, row.workload, row.resource_key, row.id, row.collected_at, row.collection_id],
    );
    if (newer) throw new ServiceChangeError('a newer change to the same setting exists; decide on that one');

    // A change recorded before this workload had an approved setup: take it now from
    // the newest usable read (this change, still waiting, keeps its earlier value).
    if (!(await getApprovedSetup(client, { tenantRef, workload: row.workload }))) {
      const { rows: [latest] } = await client.query(
        `SELECT id FROM workload_collection WHERE tenant_ref = $1 AND workload = $2 AND outcome = ANY($3::text[])
          ORDER BY created_at DESC, id DESC LIMIT 1`,
        [tenantRef, row.workload, USABLE_OUTCOMES],
      );
      await seedApprovedSetup(client, { tenantRef, workload: row.workload, collectionId: latest?.id ?? row.collection_id });
    }
    if (row.change_type === 'removed') {
      await client.query(
        'DELETE FROM workload_approved WHERE tenant_ref = $1 AND workload = $2 AND resource_key = $3',
        [tenantRef, row.workload, row.resource_key],
      );
    } else {
      const written = await upsertApproved(client, {
        tenantRef, workload: row.workload, resourceKey: row.resource_key, collectionId: row.collection_id, actor, reason: reason.trim(),
      });
      if (written !== 1) throw new ServiceChangeError('the read that found this change no longer holds the setting');
    }
    await client.query('COMMIT');
    change = row;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }

  await appendEvidence(client, {
    tenantRef,
    kind: 'disposition',
    subject: {
      action: 'accept', serviceChangeId: change.id, workload: change.workload, resourceKey: change.resource_key,
      changeType: change.change_type, collectionId: change.collection_id, reason: reason.trim(),
    },
    actor,
  });
  const { rows: [alert] } = await client.query(
    `SELECT id FROM alert WHERE tenant_ref = $1 AND resource_key = $2 AND control = 'baseline' AND condition = 'drift'
        AND state = ANY($3::text[])`,
    [tenantRef, `${change.workload}:${change.resource_key}`, WAITING_ALERT_STATES],
  );
  return { workload: change.workload, resourceKey: change.resource_key, changeType: change.change_type, alertId: alert?.id ?? null };
}
