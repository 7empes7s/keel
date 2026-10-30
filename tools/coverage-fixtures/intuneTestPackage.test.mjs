import assert from 'node:assert/strict';
import { createDecipheriv, createHash, createHmac } from 'node:crypto';
import test from 'node:test';

import {
  PACKAGE_FILE_NAME,
  PackageRefusal,
  SETUP_CONTENT,
  SETUP_FILE,
  buildTestPackage,
  crc32,
  uploadTestPackage,
} from './intuneTestPackage.mjs';

const fixedRandom = () => {
  let n = 0;
  return (size) => Buffer.alloc(size, (n += 1));
};

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('the package decrypts, its MAC and digest check out, and it holds only install.cmd', () => {
  const pkg = buildTestPackage({ random: fixedRandom() });
  const info = pkg.fileEncryptionInfo;
  const mac = pkg.encrypted.subarray(0, 32);
  const iv = pkg.encrypted.subarray(32, 48);
  const ciphertext = pkg.encrypted.subarray(48);
  assert.equal(iv.toString('base64'), info.initializationVector);
  assert.equal(mac.toString('base64'), info.mac);
  const expectedMac = createHmac('sha256', Buffer.from(info.macKey, 'base64')).update(Buffer.concat([iv, ciphertext])).digest();
  assert.deepEqual(mac, expectedMac);

  const decipher = createDecipheriv('aes-256-cbc', Buffer.from(info.encryptionKey, 'base64'), iv);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.deepEqual(plain, pkg.plain);
  assert.equal(info.fileDigest, createHash('sha256').update(plain).digest('base64'));
  assert.equal(info.fileDigestAlgorithm, 'SHA256');
  assert.equal(info.profileIdentifier, 'ProfileVersion1');
  assert.equal(pkg.size, plain.length);
  assert.equal(pkg.sizeEncrypted, pkg.encrypted.length);

  // One stored zip entry: install.cmd with the echo-only script.
  assert.equal(plain.readUInt32LE(0), 0x04034b50);
  assert.equal(plain.readUInt16LE(8), 0, 'stored, not compressed');
  const nameLength = plain.readUInt16LE(26);
  const size = plain.readUInt32LE(22);
  assert.equal(plain.subarray(30, 30 + nameLength).toString(), SETUP_FILE);
  const data = plain.subarray(30 + nameLength, 30 + nameLength + size);
  assert.equal(data.toString(), SETUP_CONTENT);
  assert.equal(plain.readUInt32LE(14), crc32(data));
  const end = plain.subarray(plain.length - 22);
  assert.equal(end.readUInt32LE(0), 0x06054b50);
  assert.equal(end.readUInt16LE(10), 1, 'one entry');
  assert.doesNotMatch(SETUP_CONTENT, /reg |del |msiexec|powershell|curl|http/i, 'the script only echoes');
});

const BLOB = 'https://keeltest.blob.core.windows.net/c/f?sv=1&sig=x';

function fakeTenant({ app, assignments, blobUri = BLOB }) {
  const calls = [];
  const blobCalls = [];
  let fileGets = 0;
  const graph = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'GET' && path.endsWith('/assignments')) return { ok: true, status: 200, body: assignments === undefined ? {} : { value: assignments } };
    if (method === 'GET' && /\/files\/f1$/.test(path)) {
      fileGets += 1;
      const committed = calls.some((c) => c.path.endsWith('/commit'));
      return { ok: true, status: 200, body: committed ? { uploadState: 'commitFileSuccess' } : fileGets === 1 ? { uploadState: 'azureStorageUriRequestPending' } : { uploadState: 'azureStorageUriRequestSuccess', azureStorageUri: blobUri } };
    }
    if (method === 'GET') return { ok: true, status: 200, body: { ...app, publishingState: calls.some((c) => c.method === 'PATCH') ? 'published' : 'notPublished' } };
    if (method === 'POST' && path.endsWith('/contentVersions')) return { ok: true, status: 201, body: { id: '1' } };
    if (method === 'POST' && path.endsWith('/files')) return { ok: true, status: 201, body: { id: 'f1' } };
    return { ok: true, status: 200, body: null };
  };
  const putBlob = async (url, body, headers) => {
    blobCalls.push({ url, body, headers });
    return { ok: true, status: 201 };
  };
  return { calls, blobCalls, graph, putBlob, sleep: async () => {} };
}

const ID = '5a2b3211-0000-4000-8000-000000000001';
const SHELL = { id: ID, displayName: 'KEEL-RT-209-app-main', '@odata.type': '#microsoft.graph.win32LobApp' };

test('uploads, commits and publishes a KEEL-RT- Win32 app in the documented order', async () => {
  const t = fakeTenant({ app: SHELL, assignments: [] });
  const pkg = buildTestPackage({ random: fixedRandom() });
  const result = await uploadTestPackage(ID, { ...t, pkg });
  assert.deepEqual(result, { name: 'KEEL-RT-209-app-main', contentVersion: '1', publishingState: 'published' });

  const writes = t.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`);
  const win32 = `/deviceAppManagement/mobileApps/${ID}/microsoft.graph.win32LobApp/contentVersions`;
  assert.deepEqual(writes, [
    `POST ${win32}`,
    `POST ${win32}/1/files`,
    `POST ${win32}/1/files/f1/commit`,
    `PATCH /deviceAppManagement/mobileApps/${ID}`,
  ]);
  const fileBody = t.calls.find((c) => c.path === `${win32}/1/files`).body;
  assert.equal(fileBody.name, PACKAGE_FILE_NAME);
  assert.equal(fileBody.size, pkg.size);
  assert.equal(fileBody.sizeEncrypted, pkg.sizeEncrypted);
  assert.deepEqual(t.calls.find((c) => c.path.endsWith('/commit')).body, { fileEncryptionInfo: pkg.fileEncryptionInfo });
  assert.deepEqual(t.calls.find((c) => c.method === 'PATCH').body, {
    '@odata.type': '#microsoft.graph.win32LobApp',
    committedContentVersion: '1',
    fileName: PACKAGE_FILE_NAME,
  });

  assert.equal(t.blobCalls.length, 2);
  assert.match(t.blobCalls[0].url, /&comp=block&blockid=/);
  assert.deepEqual(t.blobCalls[0].body, pkg.encrypted);
  assert.match(t.blobCalls[1].url, /&comp=blocklist$/);
  for (const call of t.blobCalls) assert.equal(call.headers.authorization, undefined, 'no token to storage');
});

for (const [label, app, assignments, pattern] of [
  ['a name without KEEL-RT-', { ...SHELL, displayName: 'Company Portal' }, [], /does not start with KEEL-RT-/],
  ['a web link', { ...SHELL, '@odata.type': '#microsoft.graph.webApp' }, [], /not a Win32 app/],
  ['an assigned app', SHELL, [{ id: 'x' }], /1 assignment/],
  ['an app whose assignments cannot be read', SHELL, undefined, /could not be read/],
]) {
  test(`refuses ${label} before writing anything`, async () => {
    const t = fakeTenant({ app, assignments });
    await assert.rejects(uploadTestPackage(ID, t), (error) => error instanceof PackageRefusal && pattern.test(error.message));
    assert.deepEqual(t.calls.filter((c) => c.method !== 'GET'), []);
    assert.deepEqual(t.blobCalls, []);
  });
}

test('refuses an upload address outside Azure Storage and sends no package there', async () => {
  const t = fakeTenant({ app: SHELL, assignments: [], blobUri: 'https://evil.example.com/x?sig=1' });
  await assert.rejects(uploadTestPackage(ID, t), /blob\.core\.windows\.net/);
  assert.deepEqual(t.blobCalls, []);
});

test('refuses an app id that is not a GUID before any call', async () => {
  const t = fakeTenant({ app: SHELL, assignments: [] });
  await assert.rejects(uploadTestPackage('a1?x=', t), (error) => error instanceof PackageRefusal && /GUID/.test(error.message));
  assert.deepEqual(t.calls, []);
});
