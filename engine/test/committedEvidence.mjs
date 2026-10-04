// Checks for a gate's committed evidence once a live capture replaces the pending
// placeholder. The committed record must be a real live capture bound to its raw
// capture file, carry no credential material, and still never verify without the
// HMAC key, which never goes into git or CI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SECRET_PATTERNS = [
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // a JWT (Access token, Graph token)
  /CF_Authorization/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /postgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]+@/, // a database URL with a password
];

export function isPendingPlaceholder(path) {
  return JSON.parse(readFileSync(path, 'utf8')).status === 'pending';
}

/**
 * Asserts the committed live record at `path` for `gate`. `verify(path, opts)` is the
 * gate's own file verifier; it is called without a key and must refuse.
 */
export function assertCommittedLiveRecord(path, { gate, root, verify, verifyOptions = {} }) {
  const text = readFileSync(path, 'utf8');
  const record = JSON.parse(text);
  assert.notEqual(record.status, 'pending');
  assert.equal(record.evidenceLevel, 'live-qualified');
  assert.equal(record.synthetic, false);
  assert.match(String(record.build), /^[0-9a-f]{7,40}$/);
  assert.match(String(record.tenantRef), /^sha256:[0-9a-f]+$/);

  // The raw capture sits next to the record, and the record names its digest.
  const dir = path.slice(0, path.lastIndexOf('/'));
  const raw = [`${gate}.capture.json`, `${gate}.artifact.json`].map((name) => join(dir, name)).find((file) => existsSync(file));
  assert.ok(raw, `${gate}: the raw capture file is committed with the record`);
  const rawText = readFileSync(raw, 'utf8');
  const digest = createHash('sha256').update(readFileSync(raw)).digest('hex');
  assert.ok(text.includes(digest), `${gate}: the record binds the raw capture's sha256`);

  for (const pattern of SECRET_PATTERNS) {
    assert.doesNotMatch(text, pattern, `${gate}: record carries no credential material`);
    assert.doesNotMatch(rawText, pattern, `${gate}: raw capture carries no credential material`);
  }

  // Without the HMAC key it never verifies, through the API or the CLI.
  const unkeyed = verify(path, { ...verifyOptions, hmacKey: null });
  assert.equal(unkeyed.ok, false, `${gate}: a committed record must not verify without the key`);
  const env = { ...process.env };
  delete env.KEEL_QUALIFICATION_HMAC_KEY;
  const cli = spawnSync(process.execPath, [join(root, 'tools/release/qualification.mjs'), 'verify', '--require-live',
    '--gate', gate, '--evidence', path, '--build', record.build], { cwd: root, encoding: 'utf8', env });
  assert.equal(cli.status, 1, `${gate}: the CLI refuses the record without the key`);
  return record;
}
