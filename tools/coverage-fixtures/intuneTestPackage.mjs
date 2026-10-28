#!/usr/bin/env node
/**
 * Upload a tiny, harmless package to a KEEL-RT- Win32 app in the test tenant (#653).
 *
 * Intune refuses links (dependencies, supersedence) and changes on a Win32 app whose
 * package was never uploaded: "Invalid operation: app's PublishingState is not 'Published'."
 * This tool gives such a test app a package, so the link restores can be tested live.
 *
 * The package holds one file, install.cmd, which only echoes a line and exits 0. It is
 * built here in the same encrypted form IntuneWinAppUtil produces (a zip of the source
 * folder, AES-256-CBC, HMAC-SHA256 over IV + ciphertext), so no Windows tool is needed.
 *
 * Guards, checked against the app as Intune holds it before anything is written:
 *   - the app's name starts with KEEL-RT-;
 *   - it is a Win32 app (win32LobApp);
 *   - it has no assignments, so the package never reaches a device.
 * The bearer token is only sent to graph.microsoft.com. The package goes to the
 * Azure Storage upload address Intune hands out (*.blob.core.windows.net), without it.
 *
 *   node tools/coverage-fixtures/intuneTestPackage.mjs --app <appId> [--app <appId> ...]
 *
 * Uses the Restorer credential (/etc/keel/restorer.json). Prints one line per app:
 *   uploaded KEEL-RT-209-app-main: content version 1, publishingState published
 */
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const TEST_PREFIX = 'KEEL-RT-';
export const PACKAGE_FILE_NAME = 'IntunePackage.intunewin';
export const SETUP_FILE = 'install.cmd';
export const SETUP_CONTENT = '@echo off\r\necho KEEL test package: nothing is installed.\r\nexit /b 0\r\n';

const GRAPH = 'https://graph.microsoft.com/beta';
const GRAPH_HOST = 'graph.microsoft.com';
const BLOB_HOST_SUFFIX = '.blob.core.windows.net';

/* ------------------------------------------------------------- package --- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip holding the given files, stored without compression (the files are a few bytes). */
export function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

/**
 * The encrypted package and the fileEncryptionInfo Intune needs to commit it.
 * `random` is injectable so the test can fix the keys.
 */
export function buildTestPackage({ random = randomBytes } = {}) {
  const plain = storedZip([{ name: SETUP_FILE, data: Buffer.from(SETUP_CONTENT, 'utf8') }]);
  const encryptionKey = random(32);
  const macKey = random(32);
  const iv = random(16);
  const cipher = createCipheriv('aes-256-cbc', encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const mac = createHmac('sha256', macKey).update(Buffer.concat([iv, ciphertext])).digest();
  const encrypted = Buffer.concat([mac, iv, ciphertext]);
  return {
    plain,
    encrypted,
    size: plain.length,
    sizeEncrypted: encrypted.length,
    fileEncryptionInfo: {
      encryptionKey: encryptionKey.toString('base64'),
      macKey: macKey.toString('base64'),
      initializationVector: iv.toString('base64'),
      mac: mac.toString('base64'),
      profileIdentifier: 'ProfileVersion1',
      fileDigest: createHash('sha256').update(plain).digest('base64'),
      fileDigestAlgorithm: 'SHA256',
    },
  };
}

/* -------------------------------------------------------------- upload --- */

export class PackageRefusal extends Error {}

/** Throws PackageRefusal unless the app is an unassigned KEEL-RT- Win32 app. */
export function assertTestApp(app, assignments) {
  const name = app?.displayName ?? '';
  if (!name.startsWith(TEST_PREFIX)) throw new PackageRefusal(`refusing ${app?.id}: name "${name}" does not start with ${TEST_PREFIX}`);
  if (app['@odata.type'] !== '#microsoft.graph.win32LobApp') {
    throw new PackageRefusal(`refusing ${name}: it is ${app['@odata.type']}, not a Win32 app`);
  }
  if ((assignments ?? []).length > 0) throw new PackageRefusal(`refusing ${name}: it has ${assignments.length} assignment(s); test apps stay unassigned`);
}

function isBlobUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.host.endsWith(BLOB_HOST_SUFFIX);
  } catch {
    return false;
  }
}

async function waitForState(graph, path, wanted, { sleep, attempts = 30 }) {
  for (let i = 0; i < attempts; i += 1) {
    const res = await graph('GET', path);
    if (!res.ok) throw new Error(`GET ${path} failed (${res.status}): ${res.body?.error?.message ?? 'no message'}`);
    const state = res.body?.uploadState;
    if (state === wanted) return res.body;
    if (typeof state === 'string' && /Fail|Timed/i.test(state)) throw new Error(`upload state ${state} on ${path}`);
    await sleep(2000);
  }
  throw new Error(`upload state never reached ${wanted} on ${path}`);
}

/**
 * Upload the test package to one app and commit it.
 *   graph(method, path, body) -> { ok, status, body }   (Graph calls, token attached by the caller)
 *   putBlob(url, body, headers) -> { ok, status }        (Azure Storage, no token)
 */
export async function uploadTestPackage(appId, { graph, putBlob, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), pkg = buildTestPackage() }) {
  const appPath = `/deviceAppManagement/mobileApps/${appId}`;
  const appRes = await graph('GET', appPath);
  if (!appRes.ok) throw new Error(`GET app ${appId} failed (${appRes.status}): ${appRes.body?.error?.message ?? 'no message'}`);
  const assignRes = await graph('GET', `${appPath}/assignments`);
  if (!assignRes.ok) throw new Error(`GET assignments of ${appId} failed (${assignRes.status})`);
  const app = appRes.body;
  assertTestApp(app, assignRes.body?.value);

  const win32 = `${appPath}/microsoft.graph.win32LobApp`;
  const version = await graph('POST', `${win32}/contentVersions`, {});
  if (!version.ok) throw new Error(`content version failed (${version.status}): ${version.body?.error?.message ?? 'no message'}`);
  const versionPath = `${win32}/contentVersions/${version.body.id}`;

  const file = await graph('POST', `${versionPath}/files`, {
    '@odata.type': '#microsoft.graph.mobileAppContentFile',
    name: PACKAGE_FILE_NAME,
    size: pkg.size,
    sizeEncrypted: pkg.sizeEncrypted,
    isDependency: false,
    manifest: null,
  });
  if (!file.ok) throw new Error(`content file failed (${file.status}): ${file.body?.error?.message ?? 'no message'}`);
  const filePath = `${versionPath}/files/${file.body.id}`;

  const ready = await waitForState(graph, filePath, 'azureStorageUriRequestSuccess', { sleep });
  const uri = ready.azureStorageUri;
  if (!isBlobUrl(uri)) throw new Error(`refusing upload address on a host other than *${BLOB_HOST_SUFFIX}`);

  const blockId = Buffer.from('block-0000').toString('base64');
  const block = await putBlob(`${uri}&comp=block&blockid=${encodeURIComponent(blockId)}`, pkg.encrypted, { 'x-ms-blob-type': 'BlockBlob' });
  if (!block.ok) throw new Error(`block upload failed (${block.status})`);
  const list = `<?xml version="1.0" encoding="utf-8"?><BlockList><Latest>${blockId}</Latest></BlockList>`;
  const done = await putBlob(`${uri}&comp=blocklist`, Buffer.from(list, 'utf8'), { 'content-type': 'application/xml' });
  if (!done.ok) throw new Error(`block list failed (${done.status})`);

  const commit = await graph('POST', `${filePath}/commit`, { fileEncryptionInfo: pkg.fileEncryptionInfo });
  if (!commit.ok) throw new Error(`commit failed (${commit.status}): ${commit.body?.error?.message ?? 'no message'}`);
  await waitForState(graph, filePath, 'commitFileSuccess', { sleep });

  const patch = await graph('PATCH', appPath, {
    '@odata.type': '#microsoft.graph.win32LobApp',
    committedContentVersion: version.body.id,
    fileName: PACKAGE_FILE_NAME,
  });
  if (!patch.ok) throw new Error(`committing content version failed (${patch.status}): ${patch.body?.error?.message ?? 'no message'}`);

  const after = await graph('GET', appPath);
  return { name: app.displayName, contentVersion: version.body.id, publishingState: after.body?.publishingState ?? 'unknown' };
}

/* ----------------------------------------------------------------- CLI --- */

async function main(argv) {
  const appIds = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app' && argv[i + 1]) appIds.push(argv[(i += 1)]);
    else throw new Error(`unknown argument ${argv[i]}; usage: --app <appId> [--app <appId> ...]`);
  }
  if (appIds.length === 0) throw new Error('usage: --app <appId> [--app <appId> ...]');

  const { getToken } = await import('../tenant-probe/auth.mjs');
  const { readConfigFile } = await import('../../engine/config/configFile.mjs');
  const cfg = readConfigFile('/etc/keel/restorer.json', { readFile: readFileSync, what: 'restorer settings' });
  const { accessToken } = await getToken(cfg);

  const graph = async (method, path, body) => {
    const url = `${GRAPH}${path}`;
    if (new URL(url).host !== GRAPH_HOST) throw new Error('refusing a non-Graph host');
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'accept-language': 'en-US' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { ok: res.ok, status: res.status, body: parsed };
  };
  const putBlob = async (url, body, headers) => {
    if (!isBlobUrl(url)) throw new Error('refusing a non-storage host');
    const res = await fetch(url, { method: 'PUT', headers, body });
    return { ok: res.ok, status: res.status };
  };

  let failed = 0;
  for (const appId of appIds) {
    try {
      const r = await uploadTestPackage(appId, { graph, putBlob });
      console.log(`uploaded ${r.name}: content version ${r.contentVersion}, publishingState ${r.publishingState}`);
    } catch (error) {
      failed += 1;
      console.log(`${error instanceof PackageRefusal ? 'refused' : 'failed'} ${appId}: ${error.message}`);
    }
  }
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(2);
    },
  );
}
