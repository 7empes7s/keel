#!/usr/bin/env node
/**
 * Operator tooling for the signed-assertion recovery authenticator
 * (engine/authz/recoveryAuthenticator.mjs, task-68).
 *
 *   keygen --private-out KEY.pem --public-out KEY.pub.pem
 *       Generates an Ed25519 key pair. Run it on the operator's offline
 *       machine or token host; the private key never goes to the recovery
 *       host, git, a backup or the evidence.
 *   enroll --principal ID --key-id ID --public-key KEY.pub.pem [--trust-store FILE]
 *       Prints (or adds to FILE) the trust store entry for that public key.
 *   sign --key KEY.pem --principal ID --key-id ID --tenant-ref REF
 *        [--lifetime-minutes N] --out ASSERTION.json
 *       Signs a single-use recovery assertion, valid for N minutes (default 10,
 *       at most 15). Pass its path as --credential-ref to reconstruct.mjs.
 */
import { generateKeyPairSync, createPrivateKey, randomBytes, sign as signBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  canonicalAssertionBytes,
  MAX_ASSERTION_LIFETIME_MS,
  RECOVERY_ASSERTION_PURPOSE,
  RECOVERY_ASSERTION_VERSION,
  TRUST_STORE_VERSION,
} from '../../engine/authz/recoveryAuthenticator.mjs';

/** Builds and signs an assertion envelope with an Ed25519 private key. */
export function signRecoveryAssertion({
  privateKey, principalId, keyId, tenantRef, now = new Date(), lifetimeMs = 10 * 60 * 1000,
  nonce = randomBytes(16).toString('hex'),
}) {
  const assertion = {
    v: RECOVERY_ASSERTION_VERSION,
    purpose: RECOVERY_ASSERTION_PURPOSE,
    principalId,
    keyId,
    tenantRef,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + lifetimeMs).toISOString(),
    nonce,
  };
  const key = typeof privateKey === 'string' || Buffer.isBuffer(privateKey) ? createPrivateKey(privateKey) : privateKey;
  return { assertion, signature: signBytes(null, canonicalAssertionBytes(assertion), key).toString('base64') };
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 ? argv[i + 1] : undefined;
}

function required(argv, names) {
  const missing = names.filter((name) => !arg(argv, name));
  if (missing.length > 0) throw new Error(`missing ${missing.map((n) => `--${n}`).join(', ')}`);
}

export async function main({ argv = process.argv.slice(2), out = console, now = () => new Date() } = {}) {
  const [command] = argv;
  try {
    if (command === 'keygen') {
      required(argv, ['private-out', 'public-out']);
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      await writeFile(arg(argv, 'private-out'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
      await writeFile(arg(argv, 'public-out'), publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o644 });
      out.log(`wrote ${arg(argv, 'public-out')} (enroll this) and ${arg(argv, 'private-out')} (keep offline)`);
      return 0;
    }
    if (command === 'enroll') {
      required(argv, ['principal', 'key-id', 'public-key']);
      const entry = {
        principalId: arg(argv, 'principal'),
        keyId: arg(argv, 'key-id'),
        publicKey: await readFile(arg(argv, 'public-key'), 'utf8'),
      };
      if (entry.publicKey.includes('PRIVATE KEY')) throw new Error('refusing to enroll a private key — pass the public key');
      const storePath = arg(argv, 'trust-store');
      if (!storePath) {
        out.log(JSON.stringify(entry, null, 2));
        return 0;
      }
      let store = { version: TRUST_STORE_VERSION, principals: [] };
      try { store = JSON.parse(await readFile(storePath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      store.principals = (store.principals ?? []).filter((p) => p.principalId !== entry.principalId);
      store.principals.push(entry);
      await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o644 });
      out.log(`enrolled ${entry.principalId} (${entry.keyId}) in ${storePath}`);
      return 0;
    }
    if (command === 'sign') {
      required(argv, ['key', 'principal', 'key-id', 'tenant-ref', 'out']);
      const minutes = Number(arg(argv, 'lifetime-minutes') ?? 10);
      const lifetimeMs = minutes * 60 * 1000;
      if (!Number.isFinite(minutes) || minutes <= 0 || lifetimeMs > MAX_ASSERTION_LIFETIME_MS) {
        throw new Error(`--lifetime-minutes must be between 0 and ${MAX_ASSERTION_LIFETIME_MS / 60000}`);
      }
      const envelope = signRecoveryAssertion({
        privateKey: await readFile(arg(argv, 'key')),
        principalId: arg(argv, 'principal'),
        keyId: arg(argv, 'key-id'),
        tenantRef: arg(argv, 'tenant-ref'),
        now: now(),
        lifetimeMs,
      });
      await writeFile(arg(argv, 'out'), `${JSON.stringify(envelope, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      out.log(`signed single-use recovery assertion for ${envelope.assertion.principalId}, expires ${envelope.assertion.expiresAt}`);
      return 0;
    }
    out.error('usage: recovery-assertion.mjs keygen|enroll|sign … (see the file header)');
    return 2;
  } catch (error) {
    out.error(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const exitCode = await main();
  if (exitCode !== 0) process.exit(exitCode);
}
