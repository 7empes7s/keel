#!/usr/bin/env node
/**
 * Offline recovery verifier and disposable-database reconstruction
 * (roadmap task-68, WS10).
 *
 * reconstructRecovery() rebuilds keel READ-ONLY from the independent
 * artifacts a task-67 recovery manifest links (SQL dump, configuration
 * export, evidence checkpoint), in this exact refusal-ordered sequence:
 *
 * 1. identity      — an explicit recovery identity, authenticated through an
 *                    injected INDEPENDENT authenticator. Anonymous identities
 *                    are refused; there is no emergency bypass.
 * 2. prerequisites — every named credential prerequisite
 *                    (engine/authz/recoveryMode.mjs) must be satisfied by a
 *                    reference; missing ones are reported BY NAME and nothing
 *                    else runs.
 * 3. manifest      — verifyRecoveryManifest() reads the actual artifact bytes
 *                    and re-checks every pin (tenant, build, schema, dump
 *                    checksum, export tree, evidence checkpoint). A tampered
 *                    manifest or head stops here (mutation check: accept
 *                    tampered manifest).
 * 4. schema        — the schema about to be applied must hash to exactly the
 *                    manifest's schema pin; an incompatible schema stops
 *                    BEFORE any import.
 * 5. import        — schema + dump are loaded into a DISPOSABLE database
 *                    supplied by the caller (createTargetDatabase). Never the
 *                    production database; the default target factory refuses
 *                    KEEL_DB_URL outright.
 * 6. history       — a fresh read-only session (writers disabled at the
 *                    database level, mutation check: enable writes during
 *                    reconstruction) verifies the evidence chain and requires
 *                    the reconstructed evidence head to equal the manifest
 *                    checkpoint before any access is handed back.
 *
 * On success the result carries the recovered history (schedules, approvals,
 * principals, grants, evidence summary) read through the read-only session,
 * plus the access handle itself. Recovery completeness gaps from task-67
 * (missing key instructions, unverified checkpoint) propagate unchanged.
 */
import { readFile as fsReadFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  authenticateRecoveryIdentity,
  listMissingPrerequisites,
  openRecoveryReadOnlySession,
  RecoveryIdentityError,
} from '../../engine/authz/recoveryMode.mjs';
import { sha256Hex } from '../../engine/export/manifest.mjs';
import { verifyChain } from '../../engine/govern/evidence.mjs';
import { connect } from '../../engine/store/db.mjs';
import { assertTenantRef } from '../../engine/store/tenantRef.mjs';
import { verifyRecoveryManifest } from '../../engine/storage/recoveryManifest.mjs';

function refusal(stage, failures, extra = {}) {
  return {
    ok: false,
    stage,
    failures: Array.isArray(failures) ? failures : [failures],
    prerequisites: [],
    readOnly: false,
    ...extra,
  };
}

async function defaultSchemaBytes({ readFile }) {
  return readFile(new URL('../../engine/store/schema.sql', import.meta.url));
}

/**
 * The default disposable target: a fresh schema on an explicitly supplied
 * PostgreSQL URL. Refuses the production database URL — reconstruction must
 * never land where live services write. Test suites inject their own
 * createTargetDatabase (engine/test/dbTestHelper.mjs) instead.
 */
export async function createDisposableTarget({ targetUrl, dependencies = {} }) {
  const { connectFn = connect, env = process.env } = dependencies;
  if (typeof targetUrl !== 'string' || targetUrl.length === 0) {
    throw new TypeError('a disposable target URL is required');
  }
  if (env.KEEL_DB_URL && targetUrl === env.KEEL_DB_URL) {
    throw new Error('refusing to reconstruct into the production database URL (KEEL_DB_URL)');
  }
  const schema = `keel_recovery_${randomUUID().replaceAll('-', '')}`;
  const admin = await connectFn(targetUrl);
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
  } finally {
    await admin.end();
  }
  return {
    schema,
    async connect() {
      const client = await connectFn(targetUrl);
      await client.query(`SET search_path TO "${schema}"`);
      return client;
    },
    async cleanup() {
      const client = await connectFn(targetUrl);
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await client.end();
      }
    },
  };
}

function checkpointOf(manifest) {
  const checkpoint = manifest?.evidenceCheckpoint ?? {};
  return {
    headSeq: Number(checkpoint.headSeq),
    headHash: checkpoint.headHash,
    recordCount: Number(checkpoint.recordCount),
  };
}

/** Reads the recovered history through the read-only session, tenant-scoped. */
async function readRecoveredHistory(access, { tenantRef, checkpoint }) {
  const [schedules, approvals, principals, grants, jobs] = await Promise.all([
    access.query(
      `SELECT id, tenant_ref, job_kind, tier, cadence, cron_override, enabled,
              next_due_at, created_at, updated_at
         FROM schedule WHERE tenant_ref = $1
         ORDER BY job_kind, COALESCE(tier, ''), id`,
      [tenantRef],
    ),
    access.query(
      `SELECT id, action, params, requested_by, justification, status,
              decided_by, decided_at, reason, created_at, expires_at
         FROM approval_request ORDER BY created_at, id`,
    ),
    access.query(
      'SELECT id, email, display_name, disabled_at FROM principal ORDER BY lower(email), id',
    ),
    access.query(
      `SELECT id, principal_id, role, scope, active_from, active_until, granted_by, reason
         FROM role_grant ORDER BY active_from, id`,
    ),
    access.query('SELECT count(*)::int AS count FROM job'),
  ]);
  return {
    schedules: schedules.rows,
    approvals: approvals.rows,
    principals: principals.rows,
    grants: grants.rows,
    jobCount: jobs.rows[0].count,
    evidence: {
      chainOk: true,
      headSeq: checkpoint.headSeq,
      headHash: checkpoint.headHash,
      recordCount: checkpoint.recordCount,
    },
  };
}

/**
 * Runs the reconstruction. Never throws for a refusal — refusals are data
 * ({ ok: false, stage, failures | prerequisites }) so a caller can report
 * them; programming errors (bad option types) still throw.
 *
 * On success: { ok: true, stage: 'recovered', identity, readOnly: true,
 * recovered, recoveryComplete, incomplete, access, target }. `access` is the
 * read-only session; `target` is the disposable database handle. The caller
 * owns their lifetimes (access.client.end(), target.cleanup()).
 */
export async function reconstructRecovery({
  tenantRef,
  manifestPath,
  manifest: manifestOption,
  dumpPath,
  configExportDir,
  expectedBuild,
  expectedCheckpoint,
  identity,
  authenticator,
  credentials = {},
  createTargetDatabase,
  dependencies = {},
}) {
  const { readFile = fsReadFile } = dependencies;
  assertTenantRef(tenantRef);
  if (typeof createTargetDatabase !== 'function') {
    throw new TypeError('reconstruction requires an explicit disposable target (createTargetDatabase)');
  }

  // 1. Independently authenticated recovery identity — anonymous is refused
  //    inside authenticateRecoveryIdentity; no authenticator is refused too.
  let recoveryIdentity;
  try {
    recoveryIdentity = await authenticateRecoveryIdentity({ identity, authenticator });
  } catch (error) {
    if (error instanceof RecoveryIdentityError) return refusal('identity', error.message);
    throw error;
  }

  // 2. Named credential prerequisites.
  const missing = listMissingPrerequisites({ credentials });
  if (missing.length > 0) {
    return refusal(
      'prerequisites',
      missing.map((name) => `missing credential prerequisite: ${name}`),
      { prerequisites: missing },
    );
  }

  // 3. Manifest verification against the actual artifact bytes.
  let manifest = manifestOption;
  if (manifest === undefined) {
    if (typeof manifestPath !== 'string' || manifestPath.length === 0) {
      throw new TypeError('a recovery manifest or manifestPath is required');
    }
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      return refusal('manifest', `recovery manifest unreadable at ${manifestPath}`);
    }
  }
  const verification = await verifyRecoveryManifest(manifest, {
    expectedTenantRef: tenantRef,
    dumpPath,
    expectedBuild,
    configExportDir,
    expectedCheckpoint,
    dependencies: { readFile },
  });
  if (!verification.ok) {
    return refusal('manifest', verification.failures, { incomplete: verification.incomplete });
  }

  // 4. The schema we are about to apply must be exactly the pinned schema.
  const schemaBytes = dependencies.schemaBytes ?? await defaultSchemaBytes({ readFile });
  const schemaPin = sha256Hex(schemaBytes);
  if (schemaPin !== manifest.build.schemaPin) {
    return refusal('schema', [
      `schema pin mismatch: the schema to apply (${schemaPin}) is not the manifest pin `
      + `(${manifest.build.schemaPin}) — refusing to import into an incompatible schema`,
    ]);
  }

  // 5. Import into the disposable target. The writable import connection is
  //    ended before any access session exists.
  let target;
  let dumpBytes;
  try {
    dumpBytes = await readFile(dumpPath ?? manifest.dump.path);
  } catch {
    return refusal('import', `dump artifact unreadable at ${dumpPath ?? manifest.dump.path}`);
  }
  let dumpSql;
  if (dumpBytes.length < 2 || dumpBytes[0] !== 0x1f || dumpBytes[1] !== 0x8b) {
    return refusal('import', 'dump artifact is not gzip-compressed SQL');
  }
  try {
    dumpSql = gunzipSync(dumpBytes).toString('utf8');
  } catch {
    return refusal('import', 'dump artifact is not gzip-readable');
  }
  try {
    target = await createTargetDatabase();
    const importClient = await target.connect();
    try {
      await importClient.query(schemaBytes.toString('utf8'));
      await importClient.query(dumpSql);
    } finally {
      await importClient.end();
    }
  } catch (error) {
    if (target) {
      // A half-imported disposable database is discarded, never handed back.
      try { await target.cleanup?.(); } catch { /* best-effort discard */ }
    }
    return refusal('import', `dump import failed: ${error.message}`);
  }

  // 6. History verification through the read-only session, before access.
  const accessClient = await target.connect();
  const access = await openRecoveryReadOnlySession(accessClient);
  const checkpoint = checkpointOf(manifest);
  const chain = await verifyChain(access, { tenantRef });
  if (!chain.ok) {
    return refusal('history', [
      `evidence chain verification failed in the reconstructed database (${chain.reason ?? `broken at seq ${chain.brokenAtSeq}`})`,
    ], { access, target });
  }
  const { rows: headRows } = await access.query(
    'SELECT head_seq, head_hash, record_count FROM evidence_head WHERE tenant_ref = $1',
    [tenantRef],
  );
  const head = headRows[0];
  if (
    !head
    || Number(head.head_seq) !== checkpoint.headSeq
    || head.head_hash !== checkpoint.headHash
    || Number(head.record_count) !== checkpoint.recordCount
  ) {
    return refusal('history', [
      'evidence head mismatch: the reconstructed chain head does not equal the manifest checkpoint',
    ], { access, target, incomplete: verification.incomplete });
  }

  return {
    ok: true,
    stage: 'recovered',
    failures: [],
    prerequisites: [],
    identity: recoveryIdentity,
    readOnly: true,
    writersDisabled: true,
    recovered: await readRecoveredHistory(access, { tenantRef, checkpoint }),
    recoveryComplete: verification.recoveryComplete,
    incomplete: verification.incomplete,
    access,
    target,
  };
}

function argValue(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
}

function parseEvidenceHead(value) {
  if (!value) return undefined;
  const [headSeq, headHash, recordCount] = value.split(':');
  return { headSeq: Number(headSeq), headHash, recordCount: Number(recordCount) };
}

const USAGE = `usage:
  reconstruct.mjs --manifest RECOVERY.json --tenant-ref REF
    --build-revision REV --schema-pin HEX --config-export-dir DIR
    --target-url URL --identity-principal ID --credential-ref REF
    --recovery-key-ref REF --storage-read-ref REF --tenant-authz-ref REF
    [--dump DUMP.sql.gz] [--evidence-head SEQ:HASH:COUNT]

Reconstructs keel read-only into a disposable schema on --target-url. The
target must not be the production database. Recovery identity authentication
requires an independent authenticator: this CLI refuses to run without one
(dependencies.authenticator); there is no anonymous emergency bypass.
Credentials are REFERENCES to separately-held material, never the material.`;

/**
 * CLI entry, injectable for tests. Exit 0 on a recovered read-only instance,
 * 1 on any refusal. Prints verdicts and counts only — never row contents.
 */
export async function runCli({ argv, logger = console, dependencies = {} } = {}) {
  const args = argv.slice(2);
  if (args.includes('--help')) {
    logger.log(USAGE);
    return 0;
  }
  const targetUrl = argValue(args, 'target-url');
  try {
    const result = await reconstructRecovery({
      tenantRef: argValue(args, 'tenant-ref'),
      manifestPath: argValue(args, 'manifest'),
      dumpPath: argValue(args, 'dump'),
      configExportDir: argValue(args, 'config-export-dir'),
      expectedBuild: {
        revision: argValue(args, 'build-revision'),
        schemaPin: argValue(args, 'schema-pin'),
      },
      expectedCheckpoint: parseEvidenceHead(argValue(args, 'evidence-head')),
      identity: {
        principalId: argValue(args, 'identity-principal'),
        credentialRef: argValue(args, 'credential-ref'),
      },
      authenticator: dependencies.authenticator,
      credentials: {
        recoveryKeyMaterial: argValue(args, 'recovery-key-ref'),
        artifactStorageRead: argValue(args, 'storage-read-ref'),
        tenantRecoveryAuthorization: argValue(args, 'tenant-authz-ref'),
      },
      createTargetDatabase: dependencies.createTargetDatabase
        ?? (() => createDisposableTarget({ targetUrl, dependencies })),
      dependencies,
    });
    for (const failure of result.failures) logger.error(`${result.stage}: ${failure}`);
    if (!result.ok) {
      if (result.access) await result.access.client.end();
      return 1;
    }
    for (const gap of result.incomplete) logger.log(`recovery incomplete: ${gap}`);
    logger.log(`recovered read-only as ${result.identity.principalId} (writers disabled)`);
    logger.log(`schedules: ${result.recovered.schedules.length}`);
    logger.log(`approvals: ${result.recovered.approvals.length}`);
    logger.log(`principals: ${result.recovered.principals.length}`);
    logger.log(`grants: ${result.recovered.grants.length}`);
    logger.log(`evidence records: ${result.recovered.evidence.recordCount} (chain ok, head seq ${result.recovered.evidence.headSeq})`);
    // The verifier session proves the reconstruction and lets go; the
    // disposable target database remains under the caller's control.
    await result.access.client.end();
    return 0;
  } catch (error) {
    logger.error(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const exitCode = await runCli({ argv: process.argv });
  if (exitCode !== 0) process.exit(exitCode);
}
