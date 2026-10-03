#!/usr/bin/env node
/**
 * Local-copy storage recovery evidence capture (roadmap task-114, gate
 * storage-live-acceptance).
 *
 *   # Offline (default): a generated fixture backup in a temp directory,
 *   # synthetic, fixture-tested, signed only as keel-fixture-runner.
 *   node tools/qualification/storageLiveAcceptance.mjs capture --out DIR
 *
 *   # Live: run AS the recovery account (not the backup writer).
 *   node tools/qualification/storageLiveAcceptance.mjs capture --live \
 *     --primary-root /var/backups/keel --copy-root /mnt/keel-copy \
 *     --manifest recovery-manifest.json --dump keel.sql.gz --export config-export \
 *     --recovery-principal os-user:keel-recovery --recovery-credential-ref <ref> \
 *     --recovery-key-ref <ref> --storage-read-ref <ref> --tenant-authorization-ref <ref> \
 *     --checkpoint-seq N --checkpoint-hash HEX --checkpoint-count N --out DIR
 *
 * Writes DIR/storage-live-acceptance.json (the record) and
 * DIR/storage-live-acceptance.artifact.json (the raw capture: volume ids,
 * account ids, digests of what was read, the manifest verification result and
 * the copy listing digest — no backup content, no credentials).
 *
 * What it does, all read-only:
 *  1. authenticates the recovery identity through task-68
 *     authenticateRecoveryIdentity; the independent channel is the operating
 *     system login — the principal must name the account this process runs as;
 *  2. lists the task-68 credential prerequisites still missing (references
 *     only, never the material);
 *  3. records the volume of the primary backup and of the copy (must differ),
 *     the reader account, the accounts that own the backup files, and whether
 *     the reader can write to the copy (it must not);
 *  4. lists the copy, reads the recovery manifest, dump and export manifest
 *     back from the copy through the local storage adapter, and verifies the
 *     manifest against the copied bytes (task-67/68 verifyRecoveryManifest);
 *  5. lists the copy again: the two listings must be identical.
 *
 * It never deletes, writes or renames anything in either backup location and
 * never runs a deletion canary: the local copy has no lock, so retention lock,
 * immutability and the lock canary are reported UNQUALIFIED.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants as fsConstants, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { userInfo, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

import { authenticateRecoveryIdentity, listMissingPrerequisites } from '../../engine/authz/recoveryMode.mjs';
import { buildManifest, filenameForKey, sha256Hex, stableJson } from '../../engine/export/manifest.mjs';
import { tenantRefFor } from '../../engine/store/tenantRef.mjs';
import { assertObjectName, createLocalStorageAdapter, LOCAL_PROVIDER } from '../../engine/storage/local.mjs';
import { buildRecoveryManifest, currentSchemaPin, verifyRecoveryManifest } from '../../engine/storage/recoveryManifest.mjs';
import {
  STORAGE_LIVE_CREDENTIAL_MODE, STORAGE_LIVE_GATE, STORAGE_LIVE_OPERATION, STORAGE_LIVE_QUALIFIED_CLAIMS,
  storageLivePrerequisite, storageLiveUnqualified,
} from '../../engine/storage/storageLiveEvidence.mjs';
import { QUALIFICATION_CONTRACT_VERSION, signEvidence } from '../release/qualification.mjs';

export const STORAGE_OFFLINE_FIXTURE = Object.freeze({
  tenantId: 'storage-recovery-offline-fixture',
  manifest: 'recovery-manifest.json',
  dump: 'keel.sql.gz',
  export: 'config-export',
});

/**
 * Writes a small, complete recovery backup (dump, configuration export,
 * recovery manifest) to `primaryRoot` and the same objects to `copyRoot`
 * through the local storage adapter. Used by the offline capture and tests;
 * the live capture reads a real backup instead.
 */
export async function writeStorageFixtureBackup({ primaryRoot, copyRoot, tenantRef, build, generatedAt }) {
  const schemaPin = await currentSchemaPin();
  const snapshotId = 'storage-fixture-snapshot';
  const resource = stableJson({ id: 'fixture-policy', displayName: 'KEEL-RT storage fixture policy' });
  const filename = filenameForKey('conditionalAccessPolicy:fixture-policy');
  const exportManifest = `${JSON.stringify(buildManifest({
    tenantRef,
    snapshot: { id: snapshotId, startedAt: generatedAt, completedAt: generatedAt },
    exportedAt: generatedAt,
    types: {
      conditionalAccessPolicy: {
        resourceType: 'conditionalAccessPolicy', outcome: 'complete', itemCount: 1,
        resources: { [filename]: { resourceType: 'conditionalAccessPolicy', sha256: sha256Hex(resource), bytes: Buffer.byteLength(resource) } },
      },
    },
  }), null, 2)}\n`;
  const dump = gzipSync(Buffer.from('-- keel storage fixture dump\n'));
  const checkpoint = { headSeq: 3, headHash: 'a'.repeat(64), recordCount: 3 };
  const manifest = buildRecoveryManifest({
    tenantRef,
    build: { revision: build, schemaPin },
    dump: { path: STORAGE_OFFLINE_FIXTURE.dump, sha256: sha256Hex(dump), bytes: dump.length },
    observationIds: [`${snapshotId}:conditionalAccessPolicy`],
    configExport: { manifestPath: `${STORAGE_OFFLINE_FIXTURE.export}/manifest.json`, manifestSha256: sha256Hex(exportManifest) },
    evidenceCheckpoint: checkpoint,
    residency: { provider: LOCAL_PROVIDER, region: 'local', boundary: 'separate local volume' },
    keyRecovery: { heldBy: 'fixture operator', location: 'fixture vault reference', instructions: 'fixture key recovery runbook reference' },
    generatedAt,
  });
  const objects = [
    [STORAGE_OFFLINE_FIXTURE.dump, dump],
    [`${STORAGE_OFFLINE_FIXTURE.export}/manifest.json`, Buffer.from(exportManifest)],
    [`${STORAGE_OFFLINE_FIXTURE.export}/conditionalAccessPolicy/${filename}`, Buffer.from(resource)],
    [STORAGE_OFFLINE_FIXTURE.manifest, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)],
  ];
  for (const root of [primaryRoot, copyRoot]) {
    const adapter = createLocalStorageAdapter({ root });
    for (const [name, bytes] of objects) await adapter.publish(name, bytes);
  }
  return { checkpoint, manifestSha256: sha256Hex(objects[3][1]) };
}

function listingDigest(names) {
  return { count: names.length, sha256: sha256Hex(names.join('\n')) };
}

const defaultHost = {
  volumeOf: (path) => String(statSync(path).dev),
  ownerOf: (path) => statSync(path).uid,
  readerAccount: () => process.getuid(),
  readerName: () => userInfo().username,
  canWrite: (path) => {
    try { accessSync(path, fsConstants.W_OK); return true; } catch { return false; }
  },
};

/**
 * Reads the backup back from the copy and returns the record's storage,
 * identity and recovery parts. Throws (before reading anything) when the
 * identity is anonymous or the independent authenticator refuses it.
 */
export async function captureLocalCopyRecovery({
  primaryRoot, copyRoot, names, identity, authenticator, credentials, expectedTenantRef, build,
  expectedCheckpoint, manifestSha256 = null, host = defaultHost, now = () => new Date(),
}) {
  const authenticated = await authenticateRecoveryIdentity({ identity, authenticator, at: now() });
  const missingPrerequisites = listMissingPrerequisites({ credentials });
  for (const name of [names.manifest, names.dump, names.export]) assertObjectName(name);

  const copy = createLocalStorageAdapter({ root: copyRoot });
  const before = await copy.list();
  const manifestBytes = await copy.read(names.manifest);
  let manifest = null;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch { /* reported by verification */ }
  let expectedManifestSha256 = manifestSha256;
  if (!expectedManifestSha256) {
    try { expectedManifestSha256 = sha256Hex(readFileSync(join(resolve(primaryRoot), names.manifest))); } catch { expectedManifestSha256 = null; }
  }
  const dumpBytes = await copy.read(names.dump);
  const exportManifestBytes = await copy.read(`${names.export}/manifest.json`);
  const reads = [
    { role: 'manifest', name: names.manifest, sha256: sha256Hex(manifestBytes), expectedSha256: expectedManifestSha256 },
    { role: 'dump', name: names.dump, sha256: sha256Hex(dumpBytes), expectedSha256: manifest?.dump?.sha256 ?? null },
    { role: 'export-manifest', name: `${names.export}/manifest.json`, sha256: sha256Hex(exportManifestBytes), expectedSha256: manifest?.configExport?.manifestSha256 ?? null },
  ];
  const verification = await verifyRecoveryManifest(manifest, {
    expectedTenantRef,
    dumpPath: join(resolve(copyRoot), names.dump),
    expectedBuild: { revision: build, schemaPin: await currentSchemaPin() },
    configExportDir: join(resolve(copyRoot), names.export),
    expectedCheckpoint,
  });
  const after = await copy.list();

  const ownedPaths = [primaryRoot, copyRoot, ...before.map((n) => join(resolve(copyRoot), n))];
  const writerAccounts = [...new Set(ownedPaths.map((p) => host.ownerOf(p)))].sort();
  const readerCanWrite = [copyRoot, ...before.map((n) => join(resolve(copyRoot), n))].some((p) => host.canWrite(p));
  return {
    storage: {
      provider: LOCAL_PROVIDER,
      retentionLock: copy.capabilities.retentionLock,
      immutability: copy.capabilities.immutability,
      copyRootRef: resolve(copyRoot),
      volumes: { primary: { device: host.volumeOf(primaryRoot) }, copy: { device: host.volumeOf(copyRoot) } },
    },
    identity: {
      principalId: authenticated.principalId,
      credentialRef: authenticated.credentialRef,
      authenticatedBy: 'os-account-login',
      independent: authenticated.independent,
      readerAccount: host.readerAccount(),
      writerAccounts,
      readerCanWrite,
      missingPrerequisites,
    },
    recovery: {
      manifestGeneratedAt: manifest?.generatedAt ?? null,
      reads,
      manifestVerification: {
        ok: verification.ok, failures: verification.failures,
        recoveryComplete: verification.recoveryComplete, incomplete: verification.incomplete,
      },
      listing: { before: listingDigest(before), after: listingDigest(after) },
    },
  };
}

/** Builds the record and artifact. Offline output is always synthetic and fixture-tested. */
export function buildStorageEvidence({ live, tenantRef, build, capture, observedAt }) {
  const artifact = { gate: STORAGE_LIVE_GATE, tenantRef, build, operation: STORAGE_LIVE_OPERATION, capturedAt: observedAt, ...capture };
  const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
  const sha256 = createHash('sha256').update(artifactText).digest('hex');
  const evidence = {
    contractVersion: QUALIFICATION_CONTRACT_VERSION,
    gate: STORAGE_LIVE_GATE,
    tenantRef,
    build,
    operation: STORAGE_LIVE_OPERATION,
    credentialMode: STORAGE_LIVE_CREDENTIAL_MODE,
    observedAt,
    evidenceLevel: live ? 'live-qualified' : 'fixture-tested',
    synthetic: !live,
    subject: {
      prerequisite: storageLivePrerequisite(),
      ...capture,
      qualified: [...STORAGE_LIVE_QUALIFIED_CLAIMS],
      unqualified: storageLiveUnqualified(),
      captureSha256: sha256,
    },
    proof: { artifact: { path: `${STORAGE_LIVE_GATE}.artifact.json`, sha256 } },
  };
  return { evidence, artifactText };
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
}

const LIVE_REQUIRED = ['primary-root', 'copy-root', 'manifest', 'dump', 'export', 'recovery-principal', 'recovery-credential-ref',
  'checkpoint-seq', 'checkpoint-hash', 'checkpoint-count'];

export async function main({ argv = process.argv.slice(2), env = process.env, out = console, deps = {} } = {}) {
  if (argv[0] !== 'capture') {
    out.error('usage: storageLiveAcceptance.mjs capture --out DIR [--live --primary-root P --copy-root C --manifest N --dump N --export N '
      + '--recovery-principal os-user:NAME --recovery-credential-ref REF --recovery-key-ref REF --storage-read-ref REF '
      + '--tenant-authorization-ref REF --checkpoint-seq N --checkpoint-hash HEX --checkpoint-count N [--manifest-sha256 HEX]]');
    return 2;
  }
  const outDir = arg(argv, 'out');
  if (!outDir) { out.error('missing --out DIR'); return 2; }
  const live = argv.includes('--live');
  const now = deps.now ?? (() => new Date());
  const build = arg(argv, 'build') ?? deps.build ?? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const host = { ...defaultHost, ...(deps.host ?? {}) };

  let options;
  let tenantRef;
  let scratch = null;
  if (!live) {
    tenantRef = tenantRefFor(STORAGE_OFFLINE_FIXTURE.tenantId);
    scratch = mkdtempSync(join(tmpdir(), 'keel-storage-114-fixture-'));
    const primaryRoot = join(scratch, 'primary');
    const copyRoot = join(scratch, 'copy');
    const { checkpoint } = await writeStorageFixtureBackup({ primaryRoot, copyRoot, tenantRef, build, generatedAt: now().toISOString() });
    options = {
      primaryRoot, copyRoot, names: STORAGE_OFFLINE_FIXTURE,
      identity: { principalId: 'fixture-recovery-reader', credentialRef: 'fixture-recovery-credential-reference' },
      authenticator: async () => true,
      credentials: { recoveryKeyMaterial: 'fixture-key-ref', artifactStorageRead: 'fixture-read-ref', tenantRecoveryAuthorization: 'fixture-authz-ref' },
      expectedCheckpoint: checkpoint,
      // A fixture has no real volumes or accounts; these are labelled as such.
      host: { ...host, volumeOf: (p) => `fixture:${p === primaryRoot ? 'primary' : 'copy'}`, ownerOf: () => 'fixture-writer',
        readerAccount: () => 'fixture-reader', canWrite: () => false },
    };
  } else {
    const missing = LIVE_REQUIRED.filter((name) => !arg(argv, name));
    if (missing.length) { out.error(`refused: --live needs ${missing.map((m) => `--${m}`).join(', ')}`); return 2; }
    const tenantConfig = arg(argv, 'tenant-config') ?? env.KEEL_TENANT_CONFIG_PATH;
    if (!tenantConfig) { out.error('refused: --live needs --tenant-config or KEEL_TENANT_CONFIG_PATH'); return 2; }
    const readFile = deps.readFile ?? readFileSync;
    tenantRef = tenantRefFor(JSON.parse(readFile(tenantConfig, 'utf8')).tenantId);
    const principal = arg(argv, 'recovery-principal');
    options = {
      primaryRoot: arg(argv, 'primary-root'),
      copyRoot: arg(argv, 'copy-root'),
      names: { manifest: arg(argv, 'manifest'), dump: arg(argv, 'dump'), export: arg(argv, 'export') },
      identity: { principalId: principal, credentialRef: arg(argv, 'recovery-credential-ref') },
      // The independent channel is the OS login: this process must actually
      // run as the named recovery account.
      authenticator: deps.authenticator ?? (async ({ principalId }) => principalId === `os-user:${host.readerName()}`),
      credentials: {
        recoveryKeyMaterial: arg(argv, 'recovery-key-ref'),
        artifactStorageRead: arg(argv, 'storage-read-ref'),
        tenantRecoveryAuthorization: arg(argv, 'tenant-authorization-ref'),
      },
      expectedCheckpoint: {
        headSeq: Number(arg(argv, 'checkpoint-seq')), headHash: arg(argv, 'checkpoint-hash'), recordCount: Number(arg(argv, 'checkpoint-count')),
      },
      manifestSha256: arg(argv, 'manifest-sha256') ?? null,
      host,
    };
  }

  let capture;
  try {
    capture = await captureLocalCopyRecovery({ ...options, expectedTenantRef: tenantRef, build, now });
  } catch (error) {
    out.error(`refused: ${error.message}`);
    return 1;
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
  const { evidence, artifactText } = buildStorageEvidence({ live, tenantRef, build, capture, observedAt: now().toISOString() });
  const key = env.KEEL_QUALIFICATION_HMAC_KEY;
  const record = key ? signEvidence(evidence, key, live ? 'keel-release-runner' : 'keel-fixture-runner') : evidence;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `${STORAGE_LIVE_GATE}.artifact.json`), artifactText);
  writeFileSync(join(outDir, `${STORAGE_LIVE_GATE}.json`), `${JSON.stringify(record, null, 2)}\n`);
  const verified = capture.recovery.manifestVerification.ok && capture.recovery.manifestVerification.recoveryComplete;
  out.log(`${verified ? 'captured' : 'FAILED'} ${evidence.evidenceLevel} storage recovery evidence in ${outDir}`
    + `${key ? '' : ' (unsigned: KEEL_QUALIFICATION_HMAC_KEY not set)'}; retention lock, immutability and lock canary: UNQUALIFIED`);
  if (!verified) out.error(capture.recovery.manifestVerification.failures.join('; ') || 'recovery incomplete');
  return verified ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
