/**
 * Roadmap task-46 boundary tests: M4 portal source reconciled with current
 * engine contracts. Exercises the production release-parity contract, the
 * portal read inventory against the real source tree, the task-08 immutable
 * artifact-only restore gate, the ported reconciliation preview binding and
 * the zero-item collection boundary — including the three required mutation
 * checks:
 *
 * - Omit a ported surface from read inventory.
 * - Submit restore using raw selection instead of artifact.
 * - Treat zero-item successful collection as failure.
 */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';

import {
  DeploymentEvidenceRequiredError,
  RELEASE_CONTRACT_VERSION,
  SURFACE_FAMILIES,
  UnknownSurfaceFamilyError,
  defineSurfaceParity,
  missingSurfaceFamilies,
  readSurfaceParity,
  summarizeParity,
} from '../contracts/release.mjs';
import { OBSERVATION_CONTRACT_VERSION, readObservation } from '../contracts/observation.mjs';
import { readCoverageOutcome } from '../coverage/snapshots.mjs';
import { runRestore } from '../../cli/keel-restore.mjs';

const ROOT = new URL('../../', import.meta.url).pathname;
const APP_DIR = join(ROOT, 'portal/app');
const READ_INVENTORY = join(ROOT, 'portal/lib/read.ts');

// Task 34's approval inbox has its own approve-only contract and inventory;
// health is the sole public route. Both are excluded exactly as the portal's
// own read-inventory test excludes them.
// Approve-gated surfaces (an approver need not hold read): the approval inbox and,
// since task-93, the approved emergency changes page and its API.
const NON_READ_SURFACES = new Set([
  'approvals/page.tsx', 'api/approvals/route.ts', 'api/health/route.ts',
  'emergency-changes/page.tsx', 'api/change-intents/route.ts',
]);

// ---------------------------------------------------------------- contract

test('release parity contract: closed inventory, provenance and deployment evidence', () => {
  assert.equal(RELEASE_CONTRACT_VERSION, 1);
  for (const family of ['jobs', 'policies', 'notifications', 'principals', 'evidence', 'collection-history']) {
    assert.ok(SURFACE_FAMILIES.includes(family), `${family} must be in the closed inventory`);
  }

  const record = defineSurfaceParity({
    family: 'jobs',
    reader: 'engine/jobs/queue.mjs',
    status: 'source-tested',
    provenance: { commit: '5805149', ref: 'm4-portal-design' },
  });
  assert.equal(record.status, 'source-tested');
  assert.equal(record.evidence, null, 'a source-tested record carries no deployment evidence');

  assert.throws(
    () => defineSurfaceParity({ family: 'audit-log', reader: 'engine/x.mjs', status: 'source-tested', provenance: { commit: 'abc' } }),
    UnknownSurfaceFamilyError,
  );
  assert.throws(
    () => defineSurfaceParity({ family: 'jobs', reader: 'fixtures/fake-reader.mjs', status: 'source-tested', provenance: { commit: 'abc' } }),
    /engine reader/,
  );
  assert.throws(
    () => defineSurfaceParity({ family: 'jobs', reader: 'engine/jobs/queue.mjs', status: 'source-tested' }),
    /provenance/,
  );
  // A source test can never assert deployment.
  assert.throws(
    () => defineSurfaceParity({ family: 'jobs', reader: 'engine/jobs/queue.mjs', status: 'deployed', provenance: { commit: 'abc' } }),
    DeploymentEvidenceRequiredError,
  );
  const deployed = defineSurfaceParity({
    family: 'jobs',
    reader: 'engine/jobs/queue.mjs',
    status: 'deployed',
    provenance: { commit: 'abc' },
    evidence: 'docs/release/readiness.json#2026-09-15',
  });
  assert.equal(deployed.evidence, 'docs/release/readiness.json#2026-09-15');
});

test('release parity contract: legacy and absent records read unknown and are never promoted', () => {
  for (const legacy of [null, undefined, {}, { family: 'jobs', status: 'deployed', evidence: 'forged' }]) {
    const read = readSurfaceParity(legacy, { family: 'jobs' });
    assert.equal(read.status, 'unknown');
    assert.equal(read.legacy, true);
    assert.equal(read.evidence, null, 'a legacy deployed claim is never promoted');
  }
  assert.throws(() => readSurfaceParity(null, { family: 'not-a-family' }), UnknownSurfaceFamilyError);

  // Mutation check (1) at contract level: an omitted ported family is named,
  // never silently dropped from the inventory.
  const omitted = SURFACE_FAMILIES.filter((family) => family !== 'evidence');
  assert.deepEqual(missingSurfaceFamilies(omitted), ['evidence']);
  assert.deepEqual(missingSurfaceFamilies(SURFACE_FAMILIES), []);

  const summary = summarizeParity([
    defineSurfaceParity({ family: 'jobs', reader: 'engine/jobs/queue.mjs', status: 'source-tested', provenance: { commit: 'abc' } }),
    defineSurfaceParity({ family: 'policies', reader: 'engine/policy/evaluate.mjs', status: 'deployed', provenance: { commit: 'abc' }, evidence: 'docs/release/readiness.json#1' }),
    null,
  ].map((record) => record ?? { family: 'drift' }));
  assert.deepEqual(summary.sourceTested, ['jobs']);
  assert.deepEqual(summary.deployment, { policies: 'docs/release/readiness.json#1' });
  assert.deepEqual(summary.unknown, ['drift'], 'an absent record summarizes as unknown, never as tested or deployed');
});

// ------------------------------------------------- portal read inventory seam

function appSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? appSources(path) : [path];
  });
}

function familiesForSources(sources) {
  const families = new Set();
  for (const source of sources) {
    if (source === 'page.tsx') families.add('dashboard');
    else if (source.startsWith('coverage/') || source.startsWith('api/coverage/')) families.add('coverage');
    else if (source.startsWith('drift/') || source.startsWith('api/drift/')) families.add('drift');
    else if (source.startsWith('baselines/') || source.startsWith('api/baselines/')) families.add('baselines');
    else if (source.startsWith('backups/')) families.add('backups');
    else if (source.startsWith('restore/') || source.startsWith('api/actions/restore/')) families.add('restore');
    // The collection history binding: every collection run is a job, rendered
    // through the job history surfaces.
    else if (source.startsWith('jobs/') || source.startsWith('api/jobs/')) {
      families.add('jobs');
      families.add('collection-history');
    } else if (source.startsWith('policies/') || source.startsWith('api/policies/')) families.add('policies');
    else if (source.startsWith('notifications/') || source.startsWith('api/channels/') || source.startsWith('api/subscriptions/') || source.startsWith('api/deliveries/')) families.add('notifications');
    else if (source.startsWith('principals/') || source.startsWith('api/principals/')) families.add('principals');
    else if (source.startsWith('evidence/') || source.startsWith('api/evidence/')) families.add('evidence');
  }
  return families;
}

test('every portal read surface is registered in the closed read inventory', () => {
  const declared = [...readFileSync(READ_INVENTORY, 'utf8').matchAll(/source:\s*"([^"]+)"/g)]
    .map((match) => match[1]);
  const declaredSet = new Set(declared);
  assert.equal(declared.length, declaredSet.size, 'read inventory entries must be unique');

  const sources = appSources(APP_DIR)
    .map((path) => relative(APP_DIR, path).replaceAll('\\', '/'));

  // Mutation check (1): omit a ported surface from the read inventory and an
  // on-disk page or GET route loses its declaration, failing this boundary.
  const undeclaredPages = sources
    .filter((source) => source.endsWith('page.tsx'))
    .filter((source) => !NON_READ_SURFACES.has(source))
    .filter((source) => !declaredSet.has(source));
  assert.deepEqual(undeclaredPages, [], 'every server-rendered page must declare read');

  const undeclaredGetRoutes = sources
    .filter((source) => source.endsWith('route.ts'))
    .filter((source) => /export\s+(?:async\s+)?(?:function|const)\s+GET\b/.test(readFileSync(join(APP_DIR, source), 'utf8')))
    .filter((source) => !NON_READ_SURFACES.has(source))
    .filter((source) => !declaredSet.has(source));
  assert.deepEqual(undeclaredGetRoutes, [], 'every data GET route must declare read');

  assert.deepEqual(
    missingSurfaceFamilies(familiesForSources(declared)),
    [],
    'every contract surface family — existing and ported — must be covered by the read inventory',
  );
});

// --------------------------------------- immutable artifact-only restore gate

test('mutation check (2): a raw selection can never be submitted as an enforce restore', async () => {
  await assert.rejects(
    runRestore({
      snapshotId: 'snapshot-1',
      selection: ['group:Finance'],
      mode: 'enforce',
      collectorConfig: { tenantId: 't', clientId: 'collector' },
      targetConfig: { tenantId: 't', clientId: 'restorer' },
      dbUrl: 'postgres://unused',
      logger: { log() {} },
    }),
    /enforce requires artifactId/,
  );
  // The promotion scope is frozen in the artifact; raw scope beside it is refused.
  await assert.rejects(
    runRestore({
      artifactId: 'artifact-1',
      selection: ['group:Finance'],
      mode: 'enforce',
      dbUrl: 'postgres://unused',
      logger: { log() {} },
    }),
    /mutually exclusive/,
  );
  await assert.rejects(
    runRestore({
      snapshotId: 'snapshot-1',
      selection: ['group:Finance'],
      mode: 'enforce',
      persistArtifactId: 'artifact-1',
      collectorConfig: { tenantId: 't', clientId: 'collector' },
      targetConfig: { tenantId: 't', clientId: 'restorer' },
      dbUrl: 'postgres://unused',
      logger: { log() {} },
    }),
    /never an enforce run/,
  );
});

// ----------------------------------------------------- reconciliation preview

function previewDependencies({ tokens, state }) {
  return {
    // Task-71: the snapshot's tenant is resolved for the incident gate; that tenant has no incidents.
    connect: async () => ({
      query: async (sql) => ({ rows: /SELECT tenant_ref FROM snapshot/.test(sql) ? [{ tenant_ref: 'sha256:parity' }] : [] }),
      end: async () => {},
    }),
    getResourceVersions: async () => [{
      id: 'v1',
      natural_key: 'group:lockout',
      resource_type: 'group',
      payload: { displayName: 'Lockout', mailNickname: 'lockout' },
      payload_hash: 'hash',
      blast_radius: 'tenant-lockout',
    }],
    getReferences: async () => [],
    buildReconciliationPlan: async (reader, resources) => ({
      resources: resources.map((resource) => ({
        ...resource, verb: 'delete', verbReason: 'desired absence', targetId: 'target-1',
      })),
    }),
    getToken: async (config) => {
      tokens.push(config?.clientId ?? 'NO-CONFIG');
      return { accessToken: 'token' };
    },
    GraphReader: class {
      async collect() { return { items: [], error: null }; }
      async get() { return { ok: true, status: 200, body: { accountEnabled: true } }; }
    },
    collectM1: async () => ({}),
    canonicalizeAll: () => state.targetResources,
    GraphWriter: class {
      constructor() { state.writerConstructions += 1; }
      async write() { state.writes += 1; }
    },
  };
}

test('preview shares the enforce plan but never acquires Restorer credentials or a writer', async () => {
  const tokens = [];
  const state = {
    writerConstructions: 0,
    writes: 0,
    targetResources: [{
      naturalKey: 'roleAssignment:GlobalAdministrator:break-glass',
      resourceType: 'roleAssignment',
      sourceId: 'assignment-1',
      payload: { principalId: 'break-glass-id' },
    }],
  };
  const preview = await runRestore({
    snapshotId: 'snapshot-1',
    selection: ['group:lockout'],
    previewOnly: true,
    mode: 'dry-run',
    collectorConfig: { tenantId: 'tenant', clientId: 'collector' },
    targetConfig: undefined,
    dbUrl: 'postgres://unused',
    dependencies: previewDependencies({ tokens, state }),
    logger: { log() {} },
  });
  assert.equal(preview.snapshotId, 'snapshot-1');
  assert.deepEqual(preview.resources, [{
    naturalKey: 'group:lockout', resourceType: 'group', verb: 'delete', verbReason: 'desired absence',
  }]);
  assert.deepEqual(preview.deletionWaves, [['group:lockout']]);
  // A tenant-lockout delete without simulation evidence is a refusal, never a
  // green preview — evaluated by the real apply guards in dry-run mode.
  assert.deepEqual(preview.guardRefusals, [{
    naturalKey: 'group:lockout',
    reason: 'refusing to delete tenant-lockout resource: simulationPassed must be true',
  }]);
  assert.deepEqual(tokens, ['collector'], 'no Restorer token may be requested for a preview');
  assert.equal(state.writerConstructions, 0, 'a preview never constructs a writer');
  assert.equal(state.writes, 0);
});

test('missing sign-in-path safety evidence is a preview refusal, never a green preview', async () => {
  const tokens = [];
  const state = { writerConstructions: 0, writes: 0, targetResources: [] };
  const preview = await runRestore({
    snapshotId: 'snapshot-1',
    selection: ['group:lockout'],
    previewOnly: true,
    mode: 'dry-run',
    collectorConfig: { tenantId: 'tenant', clientId: 'collector' },
    targetConfig: undefined,
    dbUrl: 'postgres://unused',
    dependencies: previewDependencies({ tokens, state }),
    logger: { log() {} },
  });
  assert.equal(preview.guardRefusals.length, 1);
  assert.match(preview.guardRefusals[0].reason, /sign-in path gate requires at least one protected principal/);
  assert.equal(state.writerConstructions, 0);
  assert.equal(state.writes, 0);
});

// --------------------------------------- zero-item successful collection seam

test('mutation check (3): a zero-item successful collection is complete-empty, never a failure', () => {
  // Legacy digest read: outcome complete with zero items is covered and empty.
  assert.deepEqual(readCoverageOutcome({ outcome: 'complete', itemCount: 0 }), {
    covered: true, itemCount: 0,
  });
  // The versioned branch of the same function: a contract v1 envelope whose
  // window completed with zero items is covered and empty — never a failure.
  assert.deepEqual(readCoverageOutcome({
    contractVersion: OBSERVATION_CONTRACT_VERSION,
    completeness: 'complete',
    itemCount: 0,
  }), { covered: true, itemCount: 0 });
  // A versioned partial or failed window never reads as covered, whatever the
  // item count it managed to observe.
  assert.equal(readCoverageOutcome({ contractVersion: OBSERVATION_CONTRACT_VERSION, completeness: 'partial', itemCount: 5 }).covered, false);
  assert.equal(readCoverageOutcome({ contractVersion: OBSERVATION_CONTRACT_VERSION, completeness: 'failed', itemCount: 3 }).covered, false);
  // A versioned contract entry keeps its complete state at zero items.
  const versioned = readObservation({
    contractVersion: 1,
    tenantRef: 'sha256:t',
    window: { startedAt: '2026-09-15T00:00:00Z', endedAt: '2026-09-15T00:01:00Z' },
    completeness: 'complete',
    evidenceLevel: 'fixture-tested',
    itemCount: 0,
  }, { tenantRef: 'sha256:t', observationId: 'obs-1', resourceType: 'group' });
  assert.equal(versioned.completeness, 'complete');
  assert.notEqual(versioned.completeness, 'failed');
  // A legacy complete-empty entry reads complete at unknown evidence level —
  // never failed, and never promoted.
  const legacy = readObservation({ outcome: 'complete', itemCount: 0 }, {
    tenantRef: 'sha256:t',
    observationId: 'obs-1',
    resourceType: 'group',
    snapshotWindow: { startedAt: '2026-09-15T00:00:00Z', endedAt: '2026-09-15T00:01:00Z' },
  });
  assert.equal(legacy.completeness, 'complete');
  assert.equal(legacy.evidenceLevel, 'unknown');
  // An empty successful read differs from a failure: a failed outcome reads
  // failed, a bare zero count reads unknown — neither is complete, and a
  // successful zero is never reclassified as failed.
  assert.equal(readCoverageOutcome({ outcome: 'failed', itemCount: 0 }).covered, false);
  const bareZero = readObservation(0, {
    tenantRef: 'sha256:t',
    observationId: 'obs-1',
    resourceType: 'group',
    snapshotWindow: { startedAt: '2026-09-15T00:00:00Z', endedAt: '2026-09-15T00:01:00Z' },
  });
  assert.equal(bareZero.completeness, 'unknown');
  assert.notEqual(bareZero.completeness, 'failed');
});
