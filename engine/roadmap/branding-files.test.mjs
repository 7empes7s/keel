/**
 * Gap register M6: backup and restore of the company branding files
 * (background image, banner logo, square logo and its dark variant, favicon,
 * custom stylesheet) of the default branding and each language.
 *
 * Fixture readers, a stubbed fetch and an isolated test database only; no
 * tenant is read or written. Mutation checks:
 *
 * - An unchanged file is neither stored twice nor uploaded again.
 * - A file the backup did not have is never removed from or written to the tenant.
 * - A file larger than the bound is never buffered or stored.
 * - Stored bytes that do not match their hash are never uploaded.
 * - An upload counts only when the live file reads back with the backed-up hash.
 * - A language that does not exist live is not created.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import { GraphReader } from '../../tools/tenant-probe/graph.mjs';
import { describeBrandingFileReads, runCollect } from '../../cli/keel-collect.mjs';
import {
  BRANDING_ASSETS, brandingAssetPath, brandingContentType, brandingLocales, sha256Hex,
} from '../collect/brandingAssets.mjs';
import { collectSnapshot } from '../collect/snapshot.mjs';
import { BRANDING_FILE_CAPABILITY, capabilityFor } from '../coverage/capabilities.mjs';
import { TYPE_DECISIONS } from '../coverage/qualification.mjs';
import { planCompensation } from '../restore/compensation.mjs';
import { computePlanDigest } from '../restore/dryRunArtifact.mjs';
import {
  applyBrandingAssetUploads, brandingFileKey, brandingLocaleFor, brandingUploadDigestInput, planBrandingAssetUploads,
  readLiveBrandingAssets,
} from '../restore/brandingAssets.mjs';
import { GraphWriter } from '../restore/graphWriter.mjs';
import { listJournal } from '../restore/rollbackJournal.mjs';
import { loadSnapshotBrandingAssets } from '../store/brandingAssets.mjs';
import { pruneSnapshots } from '../store/retention.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

const PROOF = 'engine/roadmap/branding-files.test.mjs';
const ORG = '11111111-1111-4111-8111-111111111111';
const SCHEMA = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');

const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

const png = (text) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(text)]);
const jpeg = (text) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(text)]);
const BANNER = png('banner-v1');
const BANNER_FR = png('banner-v1'); // the same file for both languages: stored once
const BACKGROUND = jpeg('background-v1');
const CSS = Buffer.from('.ext-sign-in-box { background: #1B2A4A; }');

const fileRoute = (locale, asset) => brandingAssetPath(ORG, locale, asset);

/**
 * A reader with the object reads collectSnapshot needs and stream reads served
 * from `files` (route -> { bytes, contentType } | { status } | { tooLarge }).
 */
function fixtureReader(files) {
  const streamCalls = [];
  const ok = (items) => ({ items, pages: 1, status: 200, capped: false, error: null });
  return {
    streamCalls,
    async collect(version, path) {
      if (path === '/organization' || path.startsWith('/organization?')) return ok([{ id: ORG, displayName: 'Contoso' }]);
      if (path === `/organization/${ORG}/branding`) return ok([{ id: '0', signInPageText: 'Welcome', bannerLogoRelativeUrl: 'c1/banner.png' }]);
      if (path === `/organization/${ORG}/branding/localizations`) return ok([{ id: '0' }, { id: 'fr-FR', signInPageText: 'Bienvenue' }]);
      return ok([]);
    },
    async getStream(version, path, { maxBytes }) {
      streamCalls.push(path);
      const file = files.get(path);
      if (!file) return { ok: false, status: 404, error: 'not found' };
      if (file.status) return { ok: false, status: file.status, error: `HTTP ${file.status}` };
      if (file.bytes.length > maxBytes) return { ok: true, status: 200, tooLarge: true, contentType: file.contentType };
      return { ok: true, status: 200, bytes: file.bytes, contentType: file.contentType };
    },
  };
}

function backupFiles() {
  return new Map([
    [fileRoute('0', 'bannerLogo'), { bytes: BANNER, contentType: 'image/png' }],
    [fileRoute('0', 'backgroundImage'), { bytes: BACKGROUND, contentType: 'application/octet-stream' }],
    [fileRoute('0', 'customCSS'), { bytes: CSS, contentType: 'text/plain' }],
    [fileRoute('0', 'favicon'), { bytes: Buffer.alloc(0), contentType: 'image/x-icon' }], // empty answer: not set
    [fileRoute('fr-FR', 'bannerLogo'), { bytes: BANNER_FR, contentType: 'image/png' }],
    [fileRoute('fr-FR', 'backgroundImage'), { bytes: Buffer.alloc(2 * 1024 * 1024, 1), contentType: 'image/jpeg' }], // over the bound
    [fileRoute('fr-FR', 'squareLogo'), { status: 500 }],
  ]);
}

async function freshClient(t) {
  const client = await database.connect();
  t.after(async () => { await client.end(); });
  await client.query(SCHEMA);
  return client;
}

// ------------------------------------------------------------------ registration

test('the file upload is a registered write, fixture-tested and not live-qualified', () => {
  const capability = capabilityFor(BRANDING_FILE_CAPABILITY, 'update');
  assert.equal(capability.claim, 'fixture-tested');
  assert.equal(capability.proofRef, PROOF);
  assert.equal(capability.path, '/organization/{org}/branding/localizations/{locale}/{file}');
  for (const operation of ['create', 'delete', 'restore-soft-deleted']) {
    assert.equal(capabilityFor(BRANDING_FILE_CAPABILITY, operation).claim, 'unsupported', operation);
  }
  assert.match(TYPE_DECISIONS.organizationalBranding.reason, /fixture-tested, not yet live/);
  assert.match(TYPE_DECISIONS.organizationalBrandingLocalization.reason, /fixture-tested, not yet live/);
  assert.deepEqual(BRANDING_ASSETS, ['backgroundImage', 'bannerLogo', 'squareLogo', 'squareLogoDark', 'favicon', 'customCSS']);
});

test('content types: the stylesheet is text/css; an image keeps its image type, else the type its bytes show', () => {
  assert.equal(brandingContentType('customCSS', 'text/plain', CSS), 'text/css');
  assert.equal(brandingContentType('bannerLogo', 'image/png; charset=binary', BANNER), 'image/png');
  assert.equal(brandingContentType('backgroundImage', 'application/octet-stream', BACKGROUND), 'image/jpeg');
  assert.equal(brandingContentType('favicon', null, Buffer.from([0, 0, 1, 0, 9])), 'image/x-icon');
  assert.equal(brandingContentType('squareLogo', 'application/octet-stream', Buffer.from('????')), null);
  assert.deepEqual(brandingLocales([['organizationalBranding', [{ id: '0' }]], ['organizationalBrandingLocalization', [{ id: '0' }, { id: 'fr-FR' }, { id: '../x' }]]]), ['0', 'fr-FR']);
  assert.deepEqual(brandingLocales([['organizationalBranding', []]]), []);
  assert.throws(() => brandingAssetPath(ORG, '../evil', 'bannerLogo'), /invalid branding locale/);
  assert.throws(() => brandingAssetPath(ORG, '0', 'headerLogo'), /unknown branding file/);
});

// ------------------------------------------------------------------ HTTP clients

test('GraphReader.getStream reads bytes, stops at the bound, and reports a missing file as 404', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const headers = (map) => ({ get: (name) => map[name.toLowerCase()] ?? null });
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url, method: options.method });
    if (url.endsWith('/bannerLogo')) return new Response(BANNER, { status: 200, headers: { 'content-type': 'image/png' } });
    if (url.endsWith('/backgroundImage')) {
      return { ok: true, status: 200, headers: headers({ 'content-length': String(5 * 1024 * 1024) }), body: { cancel: async () => {} } };
    }
    if (url.endsWith('/squareLogo')) return new Response(Buffer.alloc(4096, 7), { status: 200 }); // no length: streamed and cut
    return new Response(JSON.stringify({ error: { code: 'ImageNotFound', message: 'not set' } }), { status: 404 });
  };
  const reader = new GraphReader(async () => 'fixture-token');
  const banner = await reader.getStream('v1.0', fileRoute('0', 'bannerLogo'), { maxBytes: 1024 });
  assert.equal(banner.ok, true);
  assert.equal(banner.contentType, 'image/png');
  assert.equal(sha256Hex(banner.bytes), sha256Hex(BANNER));
  assert.equal((await reader.getStream('v1.0', fileRoute('0', 'backgroundImage'), { maxBytes: 1024 })).tooLarge, true);
  assert.equal((await reader.getStream('v1.0', fileRoute('0', 'squareLogo'), { maxBytes: 1024 })).tooLarge, true);
  const missing = await reader.getStream('v1.0', fileRoute('0', 'favicon'), { maxBytes: 1024 });
  assert.deepEqual([missing.ok, missing.status, missing.code], [false, 404, 'ImageNotFound']);
  assert.ok(seen.every((call) => call.method === 'GET' && call.url.startsWith(`https://graph.microsoft.com/v1.0/organization/${ORG}/branding/localizations/0/`)));
  await assert.rejects(() => reader.getStream('v1.0', fileRoute('0', 'favicon')), /maxBytes/);
});

test('GraphWriter.putStream sends the bytes with PUT and the file\'s own Content-Type', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const seen = [];
  globalThis.fetch = async (url, options) => {
    seen.push({ url, method: options.method, contentType: options.headers['Content-Type'], body: options.body });
    return new Response(null, { status: 204 });
  };
  const writer = new GraphWriter(async () => 'fixture-token');
  const result = await writer.putStream('v1.0', fileRoute('fr-FR', 'customCSS'), { body: CSS, contentType: 'text/css' });
  assert.deepEqual([result.ok, result.status], [true, 204]);
  assert.equal(seen[0].url, `https://graph.microsoft.com/v1.0/organization/${ORG}/branding/localizations/fr-FR/customCSS`);
  assert.equal(seen[0].method, 'PUT');
  assert.equal(seen[0].contentType, 'text/css');
  assert.ok(Buffer.isBuffer(seen[0].body) && seen[0].body.equals(CSS), 'the body is the raw bytes, never JSON');
  await assert.rejects(() => writer.putStream('v1.0', 'https://evil.example/x', { body: CSS, contentType: 'text/css' }), /non-Graph host/);
  await assert.rejects(() => writer.putStream('v1.0', fileRoute('0', 'favicon'), { body: CSS }), /Content-Type/);
});

// ------------------------------------------------------------------ collection

test('collect: each file of the default branding and each language is stored with the snapshot by hash, size and type', async (t) => {
  const client = await freshClient(t);
  const tenantRef = 'sha256:branding-files-collect';
  const reader = fixtureReader(backupFiles());
  const result = await collectSnapshot(client, { reader, tenantRef, tenantId: ORG, brandingAssets: true });

  assert.equal(reader.streamCalls.length, 2 * BRANDING_ASSETS.length, 'one read per file for locale 0 and fr-FR');
  assert.deepEqual(result.brandingAssets, { present: 4, absent: 6, 'too-large': 1, failed: 1, stored: 3, reused: 1 });

  const rows = await loadSnapshotBrandingAssets(client, { snapshotId: result.snapshotId });
  const byKey = new Map(rows.map((row) => [`${row.locale}/${row.asset}`, row]));
  assert.equal(rows.length, 12);
  assert.deepEqual(
    ['0/bannerLogo', '0/backgroundImage', '0/customCSS', 'fr-FR/bannerLogo'].map((key) => [key, byKey.get(key).contentType, byKey.get(key).size]),
    [['0/bannerLogo', 'image/png', BANNER.length], ['0/backgroundImage', 'image/jpeg', BACKGROUND.length], ['0/customCSS', 'text/css', CSS.length], ['fr-FR/bannerLogo', 'image/png', BANNER.length]],
  );
  assert.ok(byKey.get('0/customCSS').bytes.equals(CSS));
  assert.equal(byKey.get('0/customCSS').sha256, sha256Hex(CSS));
  assert.equal(byKey.get('0/favicon').outcome, 'absent', 'an empty answer is a file that is not set');
  assert.equal(byKey.get('0/squareLogoDark').outcome, 'absent', 'a 404 is a file that is not set');
  assert.equal(byKey.get('fr-FR/backgroundImage').outcome, 'too-large');
  assert.equal(byKey.get('fr-FR/backgroundImage').bytes, null, 'a file over the bound is never stored');
  assert.deepEqual([byKey.get('fr-FR/squareLogo').outcome, byKey.get('fr-FR/squareLogo').httpStatus], ['failed', 500]);
  const { rows: blobs } = await client.query('SELECT sha256, size_bytes FROM branding_asset_blob WHERE tenant_ref = $1', [tenantRef]);
  assert.equal(blobs.length, 3, 'the same banner for two languages is stored once');

  // Objects keep their own outcomes; file reads never change them.
  assert.equal(result.coverageDigest.organizationalBranding.outcome, 'complete');
  assert.match(describeBrandingFileReads(result.brandingAssets), /^branding file reads: 4 backed up \(3 new, 1 unchanged\), 6 not set, 1 too large, 1 failed — those files will not be restored$/);
});

test('collect, unchanged: a second backup of the same files stores no new contents', async (t) => {
  const client = await freshClient(t);
  const tenantRef = 'sha256:branding-files-unchanged';
  const first = await collectSnapshot(client, { reader: fixtureReader(backupFiles()), tenantRef, tenantId: ORG, brandingAssets: true });
  const second = await collectSnapshot(client, { reader: fixtureReader(backupFiles()), tenantRef, tenantId: ORG, brandingAssets: true });
  assert.equal(first.brandingAssets.stored, 3);
  assert.deepEqual([second.brandingAssets.stored, second.brandingAssets.reused], [0, 4]);
  const { rows } = await client.query('SELECT count(*)::int AS n FROM branding_asset_blob WHERE tenant_ref = $1', [tenantRef]);
  assert.equal(rows[0].n, 3);
  assert.equal((await loadSnapshotBrandingAssets(client, { snapshotId: second.snapshotId, locales: ['0'] })).length, BRANDING_ASSETS.length);

  // Prune: the pruned snapshot's rows go with it; contents the kept snapshot
  // still points at stay, and nothing is left unreferenced.
  await client.query('UPDATE snapshot SET started_at = $2, completed_at = $2 WHERE id = $1', [first.snapshotId, '2000-01-01T00:00:00Z']);
  const pruned = await pruneSnapshots(client, { tenantRef, policy: { tier1: 7, tier2: 90, tier3: 365 }, now: new Date('2026-10-12T00:00:00Z') });
  assert.deepEqual(pruned, [first.snapshotId]);
  assert.equal((await loadSnapshotBrandingAssets(client, { snapshotId: first.snapshotId })).length, 0);
  assert.equal((await client.query('SELECT count(*)::int AS n FROM branding_asset_blob WHERE tenant_ref = $1', [tenantRef])).rows[0].n, 3);
});

test('collect is opt-in and every scheduled backup opts in', async () => {
  const reader = fixtureReader(backupFiles());
  let options;
  await runCollect({
    config: { tenantId: ORG },
    dbUrl: 'postgres://fixture',
    dependencies: {
      connect: async () => ({ end: async () => {} }),
      getToken: async () => ({ accessToken: 'fixture-token' }),
      GraphReader: class {},
      collectSnapshot: async (_client, received) => {
        options = received;
        return { snapshotId: 'fixture-snapshot', coverageDigest: {}, brandingAssets: { present: 1, stored: 1 } };
      },
    },
    logger: { log() {}, error() {}, table() {} },
  });
  assert.equal(options.brandingAssets, true);
  assert.equal(reader.streamCalls.length, 0);
  assert.equal(describeBrandingFileReads(null), null);
});

// ------------------------------------------------------------------ restore

/** A fake target: live files by route, recording every upload. */
function fakeTarget(liveFiles, { corruptReadBack = false, failUpload = null } = {}) {
  const uploads = [];
  const files = new Map(liveFiles);
  const reader = {
    async getStream(version, path) {
      const file = files.get(path);
      if (!file) return { ok: false, status: 404 };
      if (file.status) return { ok: false, status: file.status };
      return { ok: true, status: 200, bytes: file.bytes, contentType: file.contentType };
    },
  };
  const writer = {
    async putStream(version, path, { body, contentType }) {
      uploads.push({ path, contentType, sha256: sha256Hex(body) });
      if (failUpload === path) return { ok: false, status: 400, body: { error: { code: 'BadRequest' } } };
      files.set(path, { bytes: corruptReadBack ? Buffer.from('re-encoded') : body, contentType });
      return { ok: true, status: 204, body: null };
    },
    async write() { throw new Error('no JSON write is expected'); },
  };
  return { reader, writer, uploads, files };
}

async function backedUp(t, tenantRef) {
  const client = await freshClient(t);
  const { snapshotId } = await collectSnapshot(client, { reader: fixtureReader(backupFiles()), tenantRef, tenantId: ORG, brandingAssets: true });
  return { client, snapshotId, desired: await loadSnapshotBrandingAssets(client, { snapshotId }) };
}

test('restore: only changed files are uploaded, with PUT and their own type, and each is read back by hash', async (t) => {
  const { client, desired } = await backedUp(t, 'sha256:branding-files-restore');
  const target = fakeTarget([
    [fileRoute('0', 'bannerLogo'), { bytes: png('banner-v2'), contentType: 'image/png' }], // changed
    [fileRoute('0', 'backgroundImage'), { bytes: BACKGROUND, contentType: 'image/jpeg' }], // unchanged
    // customCSS removed from the tenant; fr-FR banner removed too
    [fileRoute('0', 'favicon'), { bytes: Buffer.from([0, 0, 1, 0, 1]), contentType: 'image/x-icon' }], // backup had none
  ]);
  const locales = ['0', 'fr-FR'];
  const live = await readLiveBrandingAssets(target.reader, { organizationId: ORG, locales });
  const plan = planBrandingAssetUploads({ desired, live, liveLocales: new Set(locales) });

  assert.deepEqual(plan.refusals, []);
  assert.deepEqual(plan.uploads.map((upload) => upload.naturalKey), [
    brandingFileKey('0', 'bannerLogo'), brandingFileKey('0', 'customCSS'), brandingFileKey('fr-FR', 'bannerLogo'),
  ]);
  assert.deepEqual(plan.unchanged.map((entry) => entry.naturalKey), [brandingFileKey('0', 'backgroundImage')]);
  assert.ok(plan.notes.some((note) => note.naturalKey === brandingFileKey('0', 'favicon') && /live one is kept/.test(note.note)));
  assert.ok(plan.notes.some((note) => note.naturalKey === brandingFileKey('fr-FR', 'backgroundImage') && /too large/.test(note.note)));
  assert.ok(plan.notes.some((note) => note.naturalKey === brandingFileKey('fr-FR', 'squareLogo') && /read failed/.test(note.note)));
  assert.ok(!JSON.stringify(brandingUploadDigestInput(plan.uploads)).includes('"bytes"'), 'the digest binds hashes, never the bytes');

  // A dry run reads and writes nothing.
  const dry = await applyBrandingAssetUploads(target.writer, plan.uploads, { reader: target.reader, mode: 'dry-run', targetTenant: ORG });
  assert.equal(dry.applied.length, 3);
  assert.equal(target.uploads.length, 0);

  const restoreRef = '0f0e0d0c-0b0a-4908-8706-050403020100';
  const result = await applyBrandingAssetUploads(target.writer, plan.uploads, {
    reader: target.reader, mode: 'enforce', targetTenant: ORG, rollbackClient: client, runId: `run-${restoreRef}`, restoreRef,
  });
  assert.deepEqual(result.failed, []);
  assert.equal(result.applied.length, 3);
  assert.deepEqual(target.uploads, [
    { path: fileRoute('0', 'bannerLogo'), contentType: 'image/png', sha256: sha256Hex(BANNER) },
    { path: fileRoute('0', 'customCSS'), contentType: 'text/css', sha256: sha256Hex(CSS) },
    { path: fileRoute('fr-FR', 'bannerLogo'), contentType: 'image/png', sha256: sha256Hex(BANNER) },
  ]);
  assert.ok(target.files.get(fileRoute('0', 'favicon')), 'a file the backup did not have is never removed');

  // Each upload was journaled before it was sent, and its outcome recorded.
  const journal = await listJournal(client, { restoreRef });
  assert.equal(journal.length, 3);
  assert.ok(journal.every((entry) => entry.outcome === 'succeeded' && entry.priorState.kind === 'branding-file'));
  assert.equal(journal[0].priorState.sha256, sha256Hex(png('banner-v2')));
  assert.equal(journal[1].priorState.sha256, null, 'the stylesheet was not set before the upload');
  // Compensation never guesses the earlier bytes: an uploaded file is put back by hand.
  const compensation = planCompensation({ restoreRef, entries: journal, current: new Map() });
  assert.equal(compensation.operations.length, 0);
  assert.equal(compensation.manual.length, 3);

  // Restoring again finds every file unchanged and uploads nothing.
  const again = planBrandingAssetUploads({
    desired, live: await readLiveBrandingAssets(target.reader, { organizationId: ORG, locales }), liveLocales: new Set(locales),
  });
  assert.deepEqual(again.uploads, []);
  assert.equal(again.unchanged.length, 4);
});

test('restore, missing image: a file the backup did not have is never written, and a missing language is not created', async (t) => {
  const { desired } = await backedUp(t, 'sha256:branding-files-missing');
  const target = fakeTarget([]);
  // Only the default branding exists live; fr-FR was removed.
  const live = await readLiveBrandingAssets(target.reader, { organizationId: ORG, locales: ['0'] });
  const plan = planBrandingAssetUploads({ desired, live, liveLocales: new Set(['0']) });
  assert.deepEqual(plan.uploads.map((upload) => upload.asset).sort(), ['backgroundImage', 'bannerLogo', 'customCSS']);
  assert.ok(!plan.uploads.some((upload) => ['favicon', 'squareLogo', 'squareLogoDark'].includes(upload.asset) && upload.locale === '0'),
    'a file that was not set in the backup is never uploaded');
  assert.deepEqual(plan.refusals, [{
    naturalKey: brandingFileKey('fr-FR', 'bannerLogo'),
    reason: 'dependency: language fr-FR does not exist in the tenant; add it by hand first',
  }]);
  assert.equal(plan.notes.length, 2, 'only the too-large and unreadable backup files are noted; absent ones with no live file need nothing');
  assert.equal(brandingLocaleFor({ resourceType: 'organizationalBranding' }), '0');
  assert.equal(brandingLocaleFor({ resourceType: 'organizationalBrandingLocalization', naturalKey: 'organizationalBrandingLocalization:fr-FR', payload: { id: 'fr-FR' } }), 'fr-FR');
  assert.equal(brandingLocaleFor({ resourceType: 'group' }), null);
});

test('mutation: corrupted stored bytes, an unknown image type or an unreadable live file are refused before any upload', async (t) => {
  const { desired } = await backedUp(t, 'sha256:branding-files-integrity');
  const target = fakeTarget([[fileRoute('0', 'customCSS'), { status: 503 }]]);
  const live = await readLiveBrandingAssets(target.reader, { organizationId: ORG, locales: ['0', 'fr-FR'] });
  const tampered = desired.map((row) => {
    if (row.locale === '0' && row.asset === 'bannerLogo') return { ...row, bytes: png('tampered') };
    if (row.locale === '0' && row.asset === 'backgroundImage') return { ...row, contentType: null };
    return row;
  });
  const plan = planBrandingAssetUploads({ desired: tampered, live, liveLocales: new Set(['0', 'fr-FR']) });
  const reasons = Object.fromEntries(plan.refusals.map((refusal) => [refusal.naturalKey, refusal.reason]));
  assert.match(reasons[brandingFileKey('0', 'bannerLogo')], /^integrity: /);
  assert.match(reasons[brandingFileKey('0', 'backgroundImage')], /no known file type/);
  assert.match(reasons[brandingFileKey('0', 'customCSS')], /^blocked-read: .*HTTP 503/);
  assert.deepEqual(plan.uploads.map((upload) => upload.naturalKey), [brandingFileKey('fr-FR', 'bannerLogo')]);
  assert.equal(target.uploads.length, 0);
});

test('mutation: an upload that is rejected or does not read back as written fails', async (t) => {
  const { desired } = await backedUp(t, 'sha256:branding-files-readback');
  const locales = ['0'];
  for (const [options, error] of [
    [{ corruptReadBack: true }, /post-state: the uploaded file did not read back as written/],
    [{ failUpload: fileRoute('0', 'bannerLogo') }, /upload failed \(HTTP 400\)/],
  ]) {
    const target = fakeTarget([], options);
    const plan = planBrandingAssetUploads({
      desired, live: await readLiveBrandingAssets(target.reader, { organizationId: ORG, locales }), liveLocales: new Set(locales),
    });
    const result = await applyBrandingAssetUploads(target.writer, plan.uploads.filter((upload) => upload.asset === 'bannerLogo'), {
      reader: target.reader, mode: 'enforce', targetTenant: ORG,
    });
    assert.equal(result.applied.length, 0);
    assert.match(result.failed[0].error, error);
  }
});

test('the dry-run digest changes with the planned uploads and is unchanged without them', () => {
  const base = {
    snapshotId: 's', selection: ['organizationalBranding:organizationalBranding'], closureKeys: [], targetTenantId: ORG,
    collectorConfigPath: 'c', targetConfigPath: 't', reconciliationResources: undefined, waves: [], patches: [],
  };
  const upload = { locale: '0', asset: 'bannerLogo', sha256: sha256Hex(BANNER), size: BANNER.length, contentType: 'image/png', liveSha256: null };
  assert.equal(computePlanDigest({ ...base, brandingUploads: [] }), computePlanDigest(base));
  assert.notEqual(computePlanDigest({ ...base, brandingUploads: [upload] }), computePlanDigest(base));
  assert.notEqual(
    computePlanDigest({ ...base, brandingUploads: [upload] }),
    computePlanDigest({ ...base, brandingUploads: [{ ...upload, liveSha256: 'f'.repeat(64) }] }),
  );
});
