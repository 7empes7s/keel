/**
 * Boundary tests for the production recovery authenticator (task-68 follow-up
 * for gate drill-live-acceptance): engine/authz/recoveryAuthenticator.mjs
 * through the real authenticateRecoveryIdentity() seam and the
 * tools/recovery/reconstruct.mjs CLI.
 *
 * - A valid signed assertion from an enrolled principal passes.
 * - Anonymous, wrong (unenrolled key, other principal, other tenant, other
 *   purpose, tampered or unsigned fields), expired, not-yet-valid, overlong and
 *   replayed identities are refused.
 * - The trust root is refused when it carries private key material, is
 *   writable by others, holds a non-Ed25519 key, or lies in the backup set.
 * - The fixture authenticator is never selectable in production mode.
 *
 * No database: every refusal here happens before reconstruction touches one,
 * and the CLI tests spy on target creation to prove it.
 */
import { strict as assert } from 'node:assert';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import {
  createSignedAssertionAuthenticator,
  MAX_ASSERTION_LIFETIME_MS,
  productionAuthenticatorKind,
  selectRecoveryAuthenticator,
  SIGNED_ASSERTION_AUTHENTICATOR,
} from '../authz/recoveryAuthenticator.mjs';
import {
  authenticateRecoveryIdentity,
  PREREQUISITE_RECOVERY_KEY_MATERIAL,
  RecoveryIdentityError,
} from '../authz/recoveryMode.mjs';
import { main as assertionCli, signRecoveryAssertion } from '../../tools/recovery/recovery-assertion.mjs';
import { runCli } from '../../tools/recovery/reconstruct.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'keel-recovery-authn-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const TENANT = 'sha256:recovery-authenticator-fixture';
const PRINCIPAL = 'recovery-officer@example.test';
const KEY_ID = 'officer-2026-10';
const NOW = new Date('2026-10-04T12:00:00.000Z');

const officer = generateKeyPairSync('ed25519');
const intruder = generateKeyPairSync('ed25519');
const pem = (key) => key.export({ type: 'spki', format: 'pem' });

let counter = 0;
function fresh(name) {
  counter += 1;
  return join(tmp, `${name}-${counter}`);
}

function writeTrustStore(principals = [{ principalId: PRINCIPAL, keyId: KEY_ID, publicKey: pem(officer.publicKey) }], { mode = 0o644 } = {}) {
  const path = fresh('trust.json');
  writeFileSync(path, JSON.stringify({ version: 1, principals }));
  chmodSync(path, mode);
  return path;
}

function writeAssertion(overrides = {}, { privateKey = officer.privateKey, mutate } = {}) {
  const envelope = signRecoveryAssertion({
    privateKey, principalId: PRINCIPAL, keyId: KEY_ID, tenantRef: TENANT, now: NOW, ...overrides,
  });
  mutate?.(envelope);
  const path = fresh('assertion.json');
  writeFileSync(path, JSON.stringify(envelope));
  return path;
}

async function authenticator({ at = NOW, trustStorePath = writeTrustStore(), replayLedgerDir = fresh('replay'), ...rest } = {}) {
  return createSignedAssertionAuthenticator({ trustStorePath, replayLedgerDir, tenantRef: TENANT, now: () => at, ...rest });
}

async function refusedWith(promise, pattern) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof RecoveryIdentityError, `expected RecoveryIdentityError, got ${error}`);
    assert.match(error.message, pattern);
    return true;
  });
}

test('a valid signed assertion from an enrolled principal authenticates', async () => {
  const replayLedgerDir = fresh('replay');
  const auth = await authenticator({ replayLedgerDir });
  const credentialRef = writeAssertion();
  const identity = await authenticateRecoveryIdentity({ identity: { principalId: PRINCIPAL, credentialRef }, authenticator: auth, at: NOW });
  assert.equal(identity.principalId, PRINCIPAL);
  assert.equal(identity.credentialRef, credentialRef);
  assert.equal(identity.independent, true);
  assert.ok(Object.isFrozen(identity));
  assert.equal(productionAuthenticatorKind(auth), SIGNED_ASSERTION_AUTHENTICATOR);
  // The nonce is claimed in the replay ledger, not in any database.
  assert.equal(readdirSync(replayLedgerDir).length, 1);

  // Valid within the window, including a little clock skew either way.
  const late = await authenticator({ at: new Date(NOW.getTime() + 9 * 60 * 1000) });
  assert.equal(await late({ principalId: PRINCIPAL, credentialRef: writeAssertion() }), true);
  const skewed = await authenticator({ at: new Date(NOW.getTime() - 30 * 1000) });
  assert.equal(await skewed({ principalId: PRINCIPAL, credentialRef: writeAssertion() }), true);
});

test('anonymous identities are refused before the authenticator reads anything', async () => {
  const replayLedgerDir = fresh('replay');
  const auth = await authenticator({ replayLedgerDir });
  await refusedWith(authenticateRecoveryIdentity({ identity: { anonymous: true }, authenticator: auth }), /anonymous/);
  await refusedWith(authenticateRecoveryIdentity({ identity: null, authenticator: auth }), /anonymous/);
  await refusedWith(authenticateRecoveryIdentity({ identity: { credentialRef: writeAssertion() }, authenticator: auth }), /principalId/);
  await refusedWith(authenticateRecoveryIdentity({ identity: { principalId: PRINCIPAL }, authenticator: auth }), /credentialRef/);
  assert.throws(() => readdirSync(replayLedgerDir), /ENOENT/, 'no nonce was claimed');
});

test('wrong identities are refused: key, principal, tenant, purpose, tampering', async () => {
  const auth = await authenticator({
    trustStorePath: writeTrustStore([
      { principalId: PRINCIPAL, keyId: KEY_ID, publicKey: pem(officer.publicKey) },
      { principalId: 'second-officer@example.test', keyId: 'second', publicKey: pem(intruder.publicKey) },
    ]),
  });
  const present = (credentialRef, principalId = PRINCIPAL) => auth({ principalId, credentialRef });

  // Signed by a key that is not the enrolled key for the claimed principal.
  await refusedWith(present(writeAssertion({}, { privateKey: intruder.privateKey })), /signature does not verify/);
  // An assertion issued to one principal presented as another.
  await refusedWith(present(writeAssertion(), 'second-officer@example.test'), /issued to recovery-officer/);
  // A principal that is not enrolled at all, even with a self-consistent assertion.
  await refusedWith(present(writeAssertion({ principalId: 'stranger@example.test' }), 'stranger@example.test'), /not enrolled/);
  // Another key id than the enrolled one.
  await refusedWith(present(writeAssertion({ keyId: 'old-key' })), /not the enrolled key/);
  // Bound to a different tenant.
  await refusedWith(present(writeAssertion({ tenantRef: 'sha256:other-tenant' })), /different tenant/);
  // Fields changed after signing.
  await refusedWith(present(writeAssertion({}, { mutate: (e) => { e.assertion.expiresAt = '2027-01-01T00:00:00.000Z'; } })), /signature|lifetime/);
  await refusedWith(present(writeAssertion({}, { mutate: (e) => { e.assertion.purpose = 'something-else'; } })), /purpose/);
  await refusedWith(present(writeAssertion({}, { mutate: (e) => { e.assertion.role = 'admin'; } })), /unsigned fields: role/);
  await refusedWith(present(writeAssertion({}, { mutate: (e) => { e.signature = Buffer.alloc(64).toString('base64'); } })), /signature does not verify/);
  await refusedWith(present(writeAssertion({}, { mutate: (e) => { delete e.signature; } })), /must be/);
  await refusedWith(present(writeAssertion({ nonce: 'short' })), /nonce/);
  // A credential reference that is not a readable assertion.
  await refusedWith(present(join(tmp, 'does-not-exist.json')), /unreadable/);
});

test('expired, not-yet-valid and overlong assertions are refused', async () => {
  const credentialRef = writeAssertion({ lifetimeMs: 10 * 60 * 1000 });
  const expired = await authenticator({ at: new Date(NOW.getTime() + 10 * 60 * 1000) });
  await refusedWith(expired({ principalId: PRINCIPAL, credentialRef }), /expired/);
  const early = await authenticator({ at: new Date(NOW.getTime() - 5 * 60 * 1000) });
  await refusedWith(early({ principalId: PRINCIPAL, credentialRef }), /not yet valid/);
  const auth = await authenticator();
  await refusedWith(auth({ principalId: PRINCIPAL, credentialRef: writeAssertion({ lifetimeMs: MAX_ASSERTION_LIFETIME_MS + 1000 }) }), /lifetime exceeds/);
  // A deployment may tighten the lifetime but never loosen it.
  const strict = await authenticator({ maxLifetimeMs: 5 * 60 * 1000 });
  await refusedWith(strict({ principalId: PRINCIPAL, credentialRef: writeAssertion() }), /lifetime exceeds/);
  await refusedWith(authenticator({ maxLifetimeMs: MAX_ASSERTION_LIFETIME_MS * 4 }), /at most 15 minutes/);
});

test('a replayed assertion is refused, also across authenticator instances and concurrent runs', async () => {
  const replayLedgerDir = fresh('replay');
  const trustStorePath = writeTrustStore();
  const credentialRef = writeAssertion();
  const first = await authenticator({ trustStorePath, replayLedgerDir });
  assert.equal(await first({ principalId: PRINCIPAL, credentialRef }), true);
  await refusedWith(first({ principalId: PRINCIPAL, credentialRef }), /already used/);
  // A new process (new authenticator) with the same ledger still refuses.
  const second = await authenticator({ trustStorePath, replayLedgerDir });
  await refusedWith(second({ principalId: PRINCIPAL, credentialRef }), /already used/);

  // Two simultaneous presentations of one fresh assertion: exactly one wins.
  const racing = writeAssertion();
  const outcomes = await Promise.allSettled([
    first({ principalId: PRINCIPAL, credentialRef: racing }),
    second({ principalId: PRINCIPAL, credentialRef: racing }),
  ]);
  assert.deepEqual(outcomes.map((o) => o.status).sort(), ['fulfilled', 'rejected']);
});

test('the trust root must hold Ed25519 public keys only, owner-writable, outside the backup set', async () => {
  await refusedWith(authenticator({ trustStorePath: writeTrustStore(undefined, { mode: 0o666 }) }), /world-writable/);
  await refusedWith(authenticator({ trustStorePath: writeTrustStore(undefined, { mode: 0o664 }) }), /group- or world-writable/);
  await refusedWith(authenticator({
    trustStorePath: writeTrustStore([{ principalId: PRINCIPAL, keyId: KEY_ID, publicKey: officer.privateKey.export({ type: 'pkcs8', format: 'pem' }) }]),
  }), /credential material/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await refusedWith(authenticator({ trustStorePath: writeTrustStore([{ principalId: PRINCIPAL, keyId: KEY_ID, publicKey: pem(rsa.publicKey) }]) }), /only Ed25519/);
  await refusedWith(authenticator({ trustStorePath: writeTrustStore([]) }), /enrolls no recovery principal/);
  await refusedWith(authenticator({
    trustStorePath: writeTrustStore([
      { principalId: PRINCIPAL, keyId: KEY_ID, publicKey: pem(officer.publicKey) },
      { principalId: PRINCIPAL, keyId: 'dup', publicKey: pem(intruder.publicKey) },
    ]),
  }), /enrolled twice/);
  await refusedWith(authenticator({ trustStorePath: join(tmp, 'missing-trust.json') }), /unreadable/);
  await refusedWith(createSignedAssertionAuthenticator({ replayLedgerDir: fresh('replay'), tenantRef: TENANT }), /trust store path/);
  await refusedWith(createSignedAssertionAuthenticator({ trustStorePath: writeTrustStore(), tenantRef: TENANT }), /replay ledger/);
  await refusedWith(createSignedAssertionAuthenticator({ trustStorePath: writeTrustStore(), replayLedgerDir: fresh('replay') }), /tenantRef/);

  // Inside the backup set: the trust store or ledger shipped with the
  // artifacts it is meant to authenticate is refused.
  const backupSet = fresh('backup-set');
  mkdirSync(backupSet);
  const insideStore = join(backupSet, 'trust.json');
  writeFileSync(insideStore, JSON.stringify({ version: 1, principals: [{ principalId: PRINCIPAL, keyId: KEY_ID, publicKey: pem(officer.publicKey) }] }));
  chmodSync(insideStore, 0o644);
  await refusedWith(authenticator({ trustStorePath: insideStore, backupSetPaths: [backupSet] }), /inside the backup set/);
  await refusedWith(authenticator({ replayLedgerDir: join(backupSet, 'replay'), backupSetPaths: [backupSet] }), /inside the backup set/);
});

test('the fixture authenticator is never selectable in production mode', async () => {
  const options = { trustStorePath: writeTrustStore(), replayLedgerDir: fresh('replay'), tenantRef: TENANT };
  for (const kind of ['fixture', 'always-true', 'none', '', undefined]) {
    await refusedWith(selectRecoveryAuthenticator({ kind, ...options }), /not selectable/);
  }
  const selected = await selectRecoveryAuthenticator({ kind: SIGNED_ASSERTION_AUTHENTICATOR, ...options });
  assert.equal(productionAuthenticatorKind(selected), SIGNED_ASSERTION_AUTHENTICATOR);
  // The fixture shape (tools/release/journeys.mjs) carries no production mark.
  assert.equal(productionAuthenticatorKind(async () => true), null);
});

function cliHarness() {
  const lines = [];
  const errors = [];
  let created = 0;
  const createTargetDatabase = async () => { created += 1; throw new Error('the CLI must not reach target creation here'); };
  return {
    lines, errors, created: () => created,
    logger: { log: (line) => lines.push(String(line)), error: (line) => errors.push(String(line)) },
    createTargetDatabase,
  };
}

function cliArgv({ credentialRef, trustStorePath, replayLedgerDir, authenticatorKind = SIGNED_ASSERTION_AUTHENTICATOR, credentials = true }) {
  const backup = join(tmp, 'artifacts');
  return [
    'node', 'reconstruct.mjs',
    '--manifest', join(backup, 'recovery.json'),
    '--dump', join(backup, 'dump.sql.gz'),
    '--config-export-dir', join(backup, 'export'),
    '--tenant-ref', TENANT,
    '--build-revision', 'c'.repeat(40),
    '--schema-pin', 'd'.repeat(64),
    '--target-url', 'postgres://unused-injected-target',
    '--identity-principal', PRINCIPAL,
    '--credential-ref', credentialRef,
    ...(authenticatorKind === null ? [] : ['--authenticator', authenticatorKind]),
    ...(trustStorePath ? ['--recovery-trust-store', trustStorePath] : []),
    ...(replayLedgerDir ? ['--recovery-replay-ledger', replayLedgerDir] : []),
    ...(credentials ? [
      '--recovery-key-ref', 'sealed envelope #7, offline safe',
      '--storage-read-ref', 'backup service account reference',
      '--tenant-authz-ref', 'change record CR-2026-1004',
    ] : []),
  ];
}

test('CLI: --authenticator signed-assertion authenticates; fixture, injection and replay are refused', async () => {
  const trustStorePath = writeTrustStore();
  const replayLedgerDir = fresh('replay');
  const run = async (argvOptions, dependencies = {}) => {
    const h = cliHarness();
    const exit = await runCli({
      argv: cliArgv({ trustStorePath, replayLedgerDir, ...argvOptions }),
      logger: h.logger,
      dependencies: { createTargetDatabase: h.createTargetDatabase, now: () => NOW, ...dependencies },
    });
    return { exit, ...h };
  };

  // Identity passes: the run proceeds to the next refusal-ordered stage
  // (prerequisites, credentials withheld here) and never creates a target.
  const credentialRef = writeAssertion();
  let r = await run({ credentialRef, credentials: false });
  assert.equal(r.exit, 1);
  assert.ok(r.errors.some((e) => e.includes(`prerequisites: missing credential prerequisite: ${PREREQUISITE_RECOVERY_KEY_MATERIAL}`)), JSON.stringify(r.errors));
  assert.ok(!r.errors.some((e) => e.startsWith('identity:')));
  assert.equal(r.created(), 0);

  // The same assertion again is a replay.
  r = await run({ credentialRef });
  assert.equal(r.exit, 1);
  assert.ok(r.errors.some((e) => e.startsWith('identity:') && e.includes('already used')), JSON.stringify(r.errors));

  // A fresh assertion with credentials passes identity and prerequisites and
  // stops at the manifest (none exists here) — still before any target.
  r = await run({ credentialRef: writeAssertion() });
  assert.equal(r.exit, 1);
  assert.ok(r.errors.some((e) => e.startsWith('manifest:')), JSON.stringify(r.errors));
  assert.equal(r.created(), 0);

  // The fixture is not selectable by name.
  r = await run({ credentialRef: writeAssertion(), authenticatorKind: 'fixture' });
  assert.equal(r.exit, 1);
  assert.ok(r.errors.some((e) => e.startsWith('identity:') && e.includes('not selectable')), JSON.stringify(r.errors));

  // Nor can it be injected alongside the production flag.
  r = await run({ credentialRef: writeAssertion() }, { authenticator: async () => true });
  assert.equal(r.exit, 1);
  assert.ok(r.errors.some((e) => e.includes('cannot be combined with an injected authenticator')), JSON.stringify(r.errors));

  // No flag and nothing injected: refused, no bypass.
  r = await run({ credentialRef: writeAssertion(), authenticatorKind: null });
  assert.equal(r.exit, 1);
  assert.ok(r.errors.some((e) => e.startsWith('identity:') && e.includes('independent authenticator')), JSON.stringify(r.errors));

  // Wrong, expired and anonymous identities through the CLI.
  r = await run({ credentialRef: writeAssertion({}, { privateKey: intruder.privateKey }) });
  assert.ok(r.exit === 1 && r.errors.some((e) => e.startsWith('identity:') && e.includes('signature does not verify')), JSON.stringify(r.errors));
  r = await run({ credentialRef: writeAssertion({ now: new Date(NOW.getTime() - 20 * 60 * 1000) }) });
  assert.ok(r.exit === 1 && r.errors.some((e) => e.startsWith('identity:') && e.includes('expired')), JSON.stringify(r.errors));
  const h = cliHarness();
  const anonymousArgv = cliArgv({ credentialRef: writeAssertion(), trustStorePath, replayLedgerDir })
    .filter((arg, i, argv) => arg !== '--identity-principal' && argv[i - 1] !== '--identity-principal');
  assert.equal(await runCli({ argv: anonymousArgv, logger: h.logger, dependencies: { createTargetDatabase: h.createTargetDatabase, now: () => NOW } }), 1);
  assert.ok(h.errors.some((e) => e.startsWith('identity:')), JSON.stringify(h.errors));

  // A trust store shipped inside the backup set is refused.
  const backupTrust = join(tmp, 'artifacts', 'trust.json');
  mkdirSync(join(tmp, 'artifacts'), { recursive: true });
  writeFileSync(backupTrust, JSON.stringify({ version: 1, principals: [{ principalId: PRINCIPAL, keyId: KEY_ID, publicKey: pem(officer.publicKey) }] }));
  chmodSync(backupTrust, 0o644);
  r = await run({ credentialRef: writeAssertion(), trustStorePath: backupTrust });
  assert.ok(r.exit === 1 && r.errors.some((e) => e.includes('inside the backup set')), JSON.stringify(r.errors));
  assert.equal(r.created(), 0);
});

test('operator tooling: keygen, enroll and sign produce an assertion the authenticator accepts', async () => {
  const dir = fresh('operator');
  mkdirSync(dir);
  const out = { log: () => {}, error: (line) => { throw new Error(line); } };
  const privatePath = join(dir, 'officer.pem');
  const publicPath = join(dir, 'officer.pub.pem');
  const trustStorePath = join(dir, 'recovery-authenticators.json');
  const assertionPath = join(dir, 'assertion.json');
  assert.equal(await assertionCli({ argv: ['keygen', '--private-out', privatePath, '--public-out', publicPath], out }), 0);
  assert.equal(await assertionCli({ argv: ['enroll', '--principal', PRINCIPAL, '--key-id', KEY_ID, '--public-key', publicPath, '--trust-store', trustStorePath], out }), 0);
  assert.equal(await assertionCli({
    argv: ['sign', '--key', privatePath, '--principal', PRINCIPAL, '--key-id', KEY_ID, '--tenant-ref', TENANT, '--lifetime-minutes', '5', '--out', assertionPath],
    out, now: () => NOW,
  }), 0);
  const auth = await authenticator({ trustStorePath });
  assert.equal(await auth({ principalId: PRINCIPAL, credentialRef: assertionPath }), true);

  // Enrolling a private key, or signing beyond the maximum lifetime, is refused.
  const errors = [];
  const quiet = { log: () => {}, error: (line) => errors.push(line) };
  assert.equal(await assertionCli({ argv: ['enroll', '--principal', PRINCIPAL, '--key-id', KEY_ID, '--public-key', privatePath], out: quiet }), 1);
  assert.equal(await assertionCli({
    argv: ['sign', '--key', privatePath, '--principal', PRINCIPAL, '--key-id', KEY_ID, '--tenant-ref', TENANT, '--lifetime-minutes', '60', '--out', join(dir, 'long.json')],
    out: quiet,
  }), 1);
  assert.equal(errors.length, 2);
});
