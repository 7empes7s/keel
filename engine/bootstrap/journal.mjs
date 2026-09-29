// Task 75: additive, tenant-scoped provisioning evidence. Use a dedicated DB
// connection: the session advisory lock must span committed journal events.
import { createHash } from 'node:crypto';
import { can } from '../authz/can.mjs';
import { findPrincipalById } from '../authz/principals.mjs';
import { assertTenantRef } from '../store/tenantRef.mjs';
import { assertTokenFree } from '../../tools/tenant-probe/auth.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const artifactDigest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
export function immutable(value) {
  if (value && typeof value === 'object') Object.values(value).forEach(immutable);
  return Object.freeze(value);
}

export async function migrateBootstrapJournal(client) {
  // No previous executor tables exist. Planner v1 outputs remain readable as
  // plans, but are deliberately not promoted into approvals during migration.
  await client.query(`
    CREATE TABLE IF NOT EXISTS bootstrap_plan (
      tenant_ref text NOT NULL,
      artifact_id text NOT NULL,
      artifact jsonb NOT NULL,
      approved_by text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (tenant_ref, artifact_id)
    );
    CREATE TABLE IF NOT EXISTS bootstrap_event (
      id bigserial PRIMARY KEY,
      tenant_ref text NOT NULL,
      artifact_id text NOT NULL,
      step_id text,
      state text NOT NULL CHECK (state IN ('approved', 'desired', 'observed', 'verified', 'uncertain', 'pending-manual', 'stopped', 'complete')),
      evidence jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (tenant_ref, artifact_id) REFERENCES bootstrap_plan(tenant_ref, artifact_id)
    );
  `);
}

const lockedClients = new WeakSet();
export class BootstrapJournal {
  constructor({ client, tenantRef, principalId }) {
    assertTenantRef(tenantRef);
    this.client = client;
    this.tenantRef = tenantRef;
    this.principalId = principalId;
  }

  async authorize(capability = 'configuration', principalId = this.principalId) {
    const principal = await findPrincipalById(this.client, principalId);
    if (!principal || !await can(this.client, principal, capability)) throw new Error('bootstrap: not authorized');
  }

  async approve(artifact) {
    await this.authorize();
    await this.authorize('approve');
    assertTokenFree(artifact, 'bootstrap artifact');
    if (artifact.tenantRef !== this.tenantRef || artifact.runAs !== this.principalId) throw new Error('bootstrap: tenant/run-as mismatch');
    const artifactId = artifactDigest(artifact);
    await this.client.query(`INSERT INTO bootstrap_plan(tenant_ref, artifact_id, artifact, approved_by)
      VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`, [this.tenantRef, artifactId, artifact, this.principalId]);
    await this.append(artifactId, null, 'approved', {});
    return artifactId;
  }

  async load(artifactId) {
    await this.authorize();
    const { rows: [row] } = await this.client.query('SELECT artifact, approved_by FROM bootstrap_plan WHERE tenant_ref = $1 AND artifact_id = $2', [this.tenantRef, artifactId]);
    if (!row) throw new Error('bootstrap: immutable approved artifact required (legacy plans are not approvals)');
    if (artifactDigest(row.artifact) !== artifactId || row.artifact.version !== 1
      || row.artifact.tenantRef !== this.tenantRef || row.artifact.runAs !== this.principalId
      || row.approved_by !== row.artifact.runAs) throw new Error('bootstrap: immutable artifact mismatch');
    await this.authorize('approve', row.approved_by);
    return immutable(assertTokenFree(row.artifact, 'bootstrap artifact'));
  }

  async append(artifactId, stepId, state, evidence) {
    await this.load(artifactId);
    assertTokenFree(evidence, 'bootstrap evidence');
    await this.client.query(`INSERT INTO bootstrap_event(tenant_ref, artifact_id, step_id, state, evidence)
      VALUES ($1, $2, $3, $4, $5)`, [this.tenantRef, artifactId, stepId, state, evidence]);
  }

  async events(artifactId) {
    await this.load(artifactId);
    const { rows } = await this.client.query('SELECT id, step_id, state, evidence, created_at FROM bootstrap_event WHERE tenant_ref = $1 AND artifact_id = $2 ORDER BY id', [this.tenantRef, artifactId]);
    return rows;
  }

  async exclusive(fn) {
    await this.authorize();
    if (lockedClients.has(this.client)) throw new Error('bootstrap execution already running');
    lockedClients.add(this.client);
    let locked = false;
    try {
      const { rows: [row] } = await this.client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [`bootstrap:${this.tenantRef}`]);
      locked = row.locked;
      if (!locked) throw new Error('bootstrap execution already running');
      return await fn();
    } finally {
      if (locked) await this.client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`bootstrap:${this.tenantRef}`]);
      lockedClients.delete(this.client);
    }
  }
}
