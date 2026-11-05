/**
 * Issue #1007: terms of use (agreementOperations.mjs) with their files, from
 * the catalog read through the store to the restore, against an in-memory
 * terms of use Graph in the shape the v1.0 reference documents
 * (agreement-list-files: `?$expand=files`, one agreementFileLocalization per
 * language; termsofusecontainer-post-agreements: the files in the create body
 * with `fileData.data` as base64; agreement-post-files for a new language).
 */
import { strict as assert } from 'node:assert';
import { after, test } from 'node:test';

import { canonicalHash } from '../cir/canonicalHash.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { digestAgreementFiles, sha256Hex } from '../collect/agreementFiles.mjs';
import { readItemExtras } from '../collect/entraAdapter.mjs';
import { classifyContentEffects } from '../safety/contentEffects.mjs';
import { createSnapshot, getResourceVersions, insertResourceVersion } from '../store/db.mjs';
import { loadAgreementFiles, recordAgreementFiles } from '../store/agreementFiles.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { applyWave } from './applyEngine.mjs';
import { APPROVAL_HELD_KINDS } from './approvalHeld.mjs';
import { IDENTITY_RECORDS, applyIdentityObjectWrite } from './identityObjectOperations.mjs';
import { TRUST_FIELD_PATTERN } from './workloads/writeDeclarations.mjs';

const AGREEMENTS = '/identityGovernance/termsOfUse/agreements';
const CA = '/identity/conditionalAccess/policies';
const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 }, tenantRef: 'sha256:customer0000000' };
const TENANT_REF = 'sha256:agreement-test';
const SOURCE_ID = 'aaaaaaaa-0000-4000-8000-000000000201';
const LIVE_ID = 'bbbbbbbb-0000-4000-8000-000000000201';
const KEY = `agreement:${SOURCE_ID}`;

const EN_PDF = Buffer.from('%PDF-1.4\n% KEEL-RT-1007 terms, English\n%%EOF\n');
const FR_PDF = Buffer.from('%PDF-1.4\n% KEEL-RT-1007 conditions, francais\n%%EOF\n');
const EN_CHANGED = Buffer.from('%PDF-1.4\n% KEEL-RT-1007 terms, English, changed\n%%EOF\n');

/** An agreement as Graph returns it with `?$expand=files` (the bytes as base64, or null). */
const graphAgreement = ({ en = EN_PDF, fr = FR_PDF } = {}) => ({
  id: SOURCE_ID, displayName: 'KEEL-RT-1007-terms', termsExpiration: null, userReacceptRequiredFrequency: 'P90D',
  isViewingBeforeAcceptanceRequired: true, isPerDeviceAcceptanceRequired: false,
  files: [
    { id: 'aaaaaaaa-0000-4000-8000-000000000211', fileName: 'Terms.pdf', displayName: 'KEEL-RT-1007-terms', language: 'en', isDefault: true, isMajorVersion: false,
      createdDateTime: '2026-01-02T10:00:00Z', fileData: en ? { data: en.toString('base64') } : null },
    { id: 'aaaaaaaa-0000-4000-8000-000000000212', fileName: 'Conditions.pdf', displayName: 'KEEL-RT-1007-conditions', language: 'fr-FR', isDefault: false, isMajorVersion: false,
      createdDateTime: '2026-01-02T10:00:00Z', fileData: fr ? { data: fr.toString('base64') } : null },
  ],
});

/** The agreement as the backup stores it: each PDF named by its hash. */
const backedUp = (options) => digestAgreementFiles([['agreement', [graphAgreement(options)]]]).collected[0][1][0];
const STORED = new Map([[sha256Hex(EN_PDF), EN_PDF], [sha256Hex(FR_PDF), FR_PDF]]);
const resource = (extra = {}) => ({ naturalKey: KEY, resourceType: 'agreement', blastRadius: 'access-affecting', payload: backedUp(), references: [], ...extra });

/** Terms of use and Conditional Access in memory, answering as the v1.0 reference shows. */
function touGraph({ agreements = [], policies = [] } = {}) {
  const state = new Map(agreements.map((agreement) => [agreement.id, structuredClone(agreement)]));
  const calls = [];
  let next = 0;
  const ok = (status, body) => ({ ok: true, status, body: structuredClone(body) });
  const notFound = () => ({ ok: false, status: 404, body: { error: { code: 'ResourceNotFound' } } });
  const own = ({ files: _files, ...agreement }) => agreement;
  return {
    state,
    calls,
    async read(_version, path) {
      calls.push({ method: 'GET', path });
      const [base, query = ''] = path.split('?');
      if (base === AGREEMENTS) return ok(200, { value: [...state.values()].map(own) });
      if (base === CA) return ok(200, { value: policies });
      const one = /^\/identityGovernance\/termsOfUse\/agreements\/([^/]+)$/.exec(base);
      const found = one && state.get(decodeURIComponent(one[1]));
      if (!found) return notFound();
      return ok(200, query.includes('$expand=files') ? found : own(found));
    },
    async write(_version, path, { method, body }) {
      calls.push({ method, path, body: structuredClone(body) });
      if (method === 'POST' && path === AGREEMENTS) {
        if (!(body.files ?? []).length) return { ok: false, status: 400, body: { error: { code: 'BadRequest', message: 'a file is required' } } };
        next += 1;
        const id = `cccccccc-0000-4000-8000-00000000000${next}`;
        state.set(id, { ...body, id, files: body.files.map((file, index) => ({ ...file, id: `${id}-file-${index}` })) });
        return ok(201, own(state.get(id)));
      }
      const files = /^\/identityGovernance\/termsOfUse\/agreements\/([^/]+)\/files$/.exec(path);
      if (method === 'POST' && files) {
        const found = state.get(decodeURIComponent(files[1]));
        if (!found) return notFound();
        found.files.push({ ...body, id: `${found.id}-file-${found.files.length}`, isDefault: false });
        return ok(200, body);
      }
      const one = /^\/identityGovernance\/termsOfUse\/agreements\/([^/]+)$/.exec(path);
      if (method === 'PATCH' && one && state.has(decodeURIComponent(one[1]))) {
        Object.assign(state.get(decodeURIComponent(one[1])), body);
        return ok(204, null);
      }
      return { ok: false, status: 405, body: null };
    },
  };
}

const writes = (graph) => graph.calls.filter((call) => call.method !== 'GET');
const approved = (res, verb = 'create') => classifyContentEffects([{ ...res, verb }]).effects;
const ctx = (extra = {}) => ({ ...FAST, agreementFiles: STORED, ...extra });
const stepOf = (outcome, requirement) => (outcome.applied ?? outcome.skipped)?.completion?.find((entry) => entry.requirement === requirement);
const noTrustField = (graph) => {
  for (const { body } of writes(graph)) {
    for (const key of JSON.stringify(body ?? {}).match(/"([^"]+)":/g) ?? []) assert.equal(TRUST_FIELD_PATTERN.test(key.slice(1, -2)), false, key);
  }
};
const noAcceptanceOrPolicyWrite = (graph) => {
  for (const { path } of writes(graph)) {
    assert.equal(/acceptances/i.test(path), false, `acceptances are never written: ${path}`);
    assert.equal(path.startsWith('/identity/conditionalAccess'), false, `Conditional Access is never written: ${path}`);
  }
};

// ------------------------------------------------------------------- backup

test('the catalog reads each agreement with its files, kept as a list in language order', async () => {
  const entry = CATALOG.find((candidate) => candidate.type === 'agreement');
  const reads = [];
  const reader = { async collect(version, path) { reads.push(path); return { items: [graphAgreement()], pages: 1 }; } };
  const items = [{ id: SOURCE_ID, displayName: 'KEEL-RT-1007-terms' }];
  const result = await readItemExtras(reader, entry, items);
  assert.equal(result.error, null);
  assert.deepEqual(reads, [`${AGREEMENTS}/${SOURCE_ID}?$expand=files`]);
  assert.deepEqual(items[0].files.map((file) => file.language), ['en', 'fr-FR']);
});

test('a PDF is stored by hash, never in the payload, and a changed PDF changes the backed-up payload', () => {
  const payload = backedUp();
  assert.equal(JSON.stringify(payload).includes(EN_PDF.toString('base64')), false, 'no bytes in the payload');
  assert.deepEqual(payload.files[0].fileData, { sha256: sha256Hex(EN_PDF), size: EN_PDF.length });
  const changed = backedUp({ en: EN_CHANGED });
  assert.notEqual(canonicalHash(changed, 'agreement'), canonicalHash(payload, 'agreement'), 'drift sees a changed PDF');
  assert.equal(canonicalHash(backedUp(), 'agreement'), canonicalHash(payload, 'agreement'), 'the same PDF is no change');
  // Graph returning no document is recorded as such, not as a file.
  assert.equal(backedUp({ fr: null }).files[1].fileData, null);
  assert.equal(digestAgreementFiles([['agreement', [graphAgreement()]], ['agreement', [graphAgreement()]]]).blobs.length, 2, 'one blob per distinct PDF');
});

const database = await createIsolatedTestDatabase(import.meta.url);
const client = await database.connect();
await client.query(schemaSql());
after(async () => { await client.end(); await database.cleanup(); });

test('the bytes are stored once per tenant and hash, read back by hash, and a copy that does not match its hash is never used', async () => {
  const { blobs } = digestAgreementFiles([['agreement', [graphAgreement()]]]);
  assert.deepEqual(await recordAgreementFiles(client, { tenantRef: TENANT_REF, blobs }), { stored: 2, reused: 0 });
  assert.deepEqual(await recordAgreementFiles(client, { tenantRef: TENANT_REF, blobs }), { stored: 0, reused: 2 });
  const loaded = await loadAgreementFiles(client, { tenantRef: TENANT_REF, hashes: [sha256Hex(EN_PDF), sha256Hex(FR_PDF)] });
  assert.ok(loaded.get(sha256Hex(EN_PDF)).equals(EN_PDF));
  assert.equal((await loadAgreementFiles(client, { tenantRef: 'sha256:other-tenant', hashes: [sha256Hex(EN_PDF)] })).size, 0);
  await client.query('UPDATE agreement_file_blob SET content = $1 WHERE tenant_ref = $2 AND sha256 = $3', [EN_CHANGED, TENANT_REF, sha256Hex(FR_PDF)]);
  assert.equal((await loadAgreementFiles(client, { tenantRef: TENANT_REF, hashes: [sha256Hex(FR_PDF)] })).size, 0);
});

test('the stored shape keeps each file\'s hash for the restore', async () => {
  const [stored] = canonicalizeAll(digestAgreementFiles([['agreement', [graphAgreement()]]]).collected);
  const snapshotId = await createSnapshot(client, { tenantRef: TENANT_REF });
  await insertResourceVersion(client, { snapshotId, resource: { ...stored, fidelity: stored.provenance.fidelity } });
  const [row] = await getResourceVersions(client, { snapshotId });
  assert.equal(row.payload.files[0].fileData.sha256, sha256Hex(EN_PDF));
  assert.equal(row.payload.files[1].language, 'fr-FR');
});

// ------------------------------------------------------------------ restore

test('terms of use are approval-held, and the effect names each document by language and hash', () => {
  assert.ok(APPROVAL_HELD_KINDS.includes('agreement'));
  assert.deepEqual(IDENTITY_RECORDS.agreement.operations, ['create', 'update']);
  const files = approved(resource()).find((effect) => effect.field === 'files');
  assert.equal(files.effect, 'access-changing');
  assert.deepEqual(files.after, [`en: Terms.pdf (default), document sha256 ${sha256Hex(EN_PDF)}`, `fr-FR: Conditions.pdf, document sha256 ${sha256Hex(FR_PDF)}`]);
});

test('missing terms of use are created with the default file and every language, the bytes checked against the backup', async () => {
  const graph = touGraph();
  const res = resource();
  const result = await applyIdentityObjectWrite(graph, res, 'create', ctx({ approvedContentEffects: approved(res) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(result.skipped, undefined, result.skipped?.reason);
  const [post] = writes(graph);
  assert.equal(post.path, AGREEMENTS);
  assert.deepEqual(post.body, {
    displayName: 'KEEL-RT-1007-terms', isViewingBeforeAcceptanceRequired: true, isPerDeviceAcceptanceRequired: false,
    userReacceptRequiredFrequency: 'P90D', termsExpiration: null,
    files: [
      { fileName: 'Terms.pdf', displayName: 'KEEL-RT-1007-terms', language: 'en', isDefault: true, isMajorVersion: false, fileData: { data: EN_PDF.toString('base64') } },
      { fileName: 'Conditions.pdf', displayName: 'KEEL-RT-1007-conditions', language: 'fr-FR', isDefault: false, isMajorVersion: false, fileData: { data: FR_PDF.toString('base64') } },
    ],
  });
  assert.deepEqual(result.applied.changes.files, ['en', 'fr-FR']);
  noTrustField(graph);
});

test('acceptances are never written: every create says everyone will be asked to accept again', async () => {
  const graph = touGraph();
  const res = resource();
  const result = await applyIdentityObjectWrite(graph, res, 'create', ctx({ approvedContentEffects: approved(res) }));
  assert.match(stepOf(result, 'acceptances').description, /never recreated: .* everyone they apply to will be asked to accept again/);
  assert.deepEqual(writes(graph).map((call) => `${call.method} ${call.path}`), [`POST ${AGREEMENTS}`]);
  noAcceptanceOrPolicyWrite(graph);
});

test('Conditional Access policies that require the backed-up terms are listed in the dry run and the run, and never written', async () => {
  const policies = [
    { id: 'p1', displayName: 'KEEL-RT guests accept terms', grantControls: { operator: 'OR', builtInControls: [], termsOfUse: [SOURCE_ID] } },
    { id: 'p2', displayName: 'KEEL-RT other', grantControls: { operator: 'OR', builtInControls: ['mfa'], termsOfUse: [] } },
  ];
  const dry = touGraph({ policies });
  const plan = await applyIdentityObjectWrite(dry, resource(), 'create', ctx({ mode: 'dry-run' }));
  assert.deepEqual(plan.applied.changes.conditionalAccessPolicies, ['KEEL-RT guests accept terms']);
  assert.match(plan.applied.changes.manualSteps.join(' '), /"KEEL-RT guests accept terms" still requires the old one\. KEEL never changes Conditional Access/);
  assert.ok(stepOf(plan, 'acceptances'), 'the dry run says people will be asked to accept again');
  assert.equal(writes(dry).length, 0);

  const graph = touGraph({ policies });
  const res = resource();
  const result = await applyIdentityObjectWrite(graph, res, 'create', ctx({ approvedContentEffects: approved(res) }));
  assert.match(stepOf(result, 'conditionalAccessTermsOfUse').description, /"KEEL-RT guests accept terms"/);
  noAcceptanceOrPolicyWrite(graph);
});

test('without the default file\'s bytes the create is held as a manual step, and nothing is written', async () => {
  for (const [label, res, files] of [
    ['Graph returned no document', resource({ payload: backedUp({ en: null }) }), STORED],
    ['the store lacks it', resource(), new Map([[sha256Hex(FR_PDF), FR_PDF]])],
    ['the stored copy does not match', resource(), new Map([[sha256Hex(EN_PDF), EN_CHANGED], [sha256Hex(FR_PDF), FR_PDF]])],
  ]) {
    const graph = touGraph();
    const result = await applyIdentityObjectWrite(graph, res, 'create', ctx({ agreementFiles: files, approvedContentEffects: approved(res) }));
    assert.match(result.skipped?.reason ?? '', /^manual: The backup cannot upload the en file "Terms.pdf"/, label);
    assert.equal(writes(graph).length, 0, label);
  }
});

test('a language without its bytes is a manual step; the terms are created with the others', async () => {
  const graph = touGraph();
  const res = resource({ payload: backedUp({ fr: null }) });
  const result = await applyIdentityObjectWrite(graph, res, 'create', ctx({ approvedContentEffects: approved(res) }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(writes(graph)[0].body.files.map((file) => file.language), ['en']);
  assert.match(stepOf(result, 'agreementFiles').description, /the fr-FR file "Conditions.pdf" \(Graph returned no document for it/);
});

test('without the approval the terms are held, and nothing is read or written', async () => {
  const graph = touGraph();
  const result = await applyIdentityObjectWrite(graph, resource(), 'create', ctx({ mode: 'enforce' }));
  assert.match(result.skipped?.reason ?? '', /changes admin access/);
  assert.equal(graph.calls.length, 0);
});

test('a second restore finds the terms the first one made and never makes a second', async () => {
  const first = touGraph();
  const res = resource();
  await applyIdentityObjectWrite(first, res, 'create', ctx({ approvedContentEffects: approved(res) }));
  const graph = touGraph({ agreements: [...first.state.values()] });
  const again = await applyIdentityObjectWrite(graph, res, 'create', ctx({ approvedContentEffects: approved(res) }));
  assert.match(again.skipped?.reason ?? '', /the terms of use is already there/);
  assert.equal(writes(graph).length, 0);
});

/** Live terms of use with only the English file, whose PDF is `en`, changed by hand. */
const liveAgreement = (en = EN_PDF) => ({
  ...graphAgreement(), id: LIVE_ID, displayName: 'Changed by hand', isPerDeviceAcceptanceRequired: true,
  files: [{ ...graphAgreement().files[0], id: `${LIVE_ID}-file-0`, fileData: { data: en.toString('base64') } }],
});
const updateResource = (live) => {
  const { files: _files, ...own } = live;
  return resource({ live: { state: 'present', targetId: LIVE_ID, payload: own } });
};

test('an update writes only what Graph updates, adds a missing language, and leaves create-only settings to a person', async () => {
  const live = liveAgreement();
  const graph = touGraph({ agreements: [live] });
  const res = updateResource(live);
  const result = await applyIdentityObjectWrite(graph, res, 'update', ctx({ approvedContentEffects: approved(res, 'update') }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(writes(graph).map((call) => `${call.method} ${call.path}`), [`PATCH ${AGREEMENTS}/${LIVE_ID}`, `POST ${AGREEMENTS}/${LIVE_ID}/files`]);
  assert.deepEqual(writes(graph)[0].body, { displayName: 'KEEL-RT-1007-terms' });
  assert.deepEqual(writes(graph)[1].body, { fileName: 'Conditions.pdf', displayName: 'KEEL-RT-1007-conditions', language: 'fr-FR', isMajorVersion: false, fileData: { data: FR_PDF.toString('base64') } });
  assert.deepEqual(result.applied.changes.filesAdded, ['fr-FR']);
  assert.match(stepOf(result, 'createOnlySettings').description, /whether people accept on every device only when terms of use are created/);
  noAcceptanceOrPolicyWrite(graph);
});

test('a live PDF that differs from the backup is a manual step, never overwritten', async () => {
  const live = liveAgreement(EN_CHANGED);
  const graph = touGraph({ agreements: [live] });
  const res = updateResource(live);
  const result = await applyIdentityObjectWrite(graph, res, 'update', ctx({ approvedContentEffects: approved(res, 'update') }));
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.match(stepOf(result, 'agreementFileVersion').description, /The live PDF of the en file "Terms.pdf" differs from the backup/);
  assert.equal(writes(graph).some((call) => call.body?.language === 'en'), false, 'the changed language is never written');
});

// ------------------------------------------------- production applyWave path

test('applyWave: approved terms of use land with their files; unapproved ones write nothing', async () => {
  const governor = { async acquire() {}, observeRetryAfter() {} };
  const res = { ...resource(), verb: 'create' };
  const graph = touGraph();
  const outcome = await applyWave(graph, governor, [res], {
    targetTenant: 'fixture-tenant', mode: 'enforce', agreementFiles: STORED,
    approvedContentEffects: classifyContentEffects([res]).effects, readAfterWriteOptions: { attempts: 1, delayMs: 0 },
  });
  assert.deepEqual(outcome.failed, [], JSON.stringify(outcome.failed));
  assert.deepEqual(outcome.skipped, [], JSON.stringify(outcome.skipped));
  const [created] = graph.state.values();
  assert.ok(Buffer.from(created.files[1].fileData.data, 'base64').equals(FR_PDF));

  const held = touGraph();
  const unapproved = await applyWave(held, governor, [res], { targetTenant: 'fixture-tenant', mode: 'enforce', agreementFiles: STORED, approvedContentEffects: [] });
  assert.equal(unapproved.applied.length, 0);
  assert.equal(writes(held).length, 0);
});

test('the restore\'s read of the live tenant names an agreement\'s files by hash too, so live and backup compare alike', async () => {
  const { collectM1 } = await import('../collect/entraAdapter.mjs');
  const reader = {
    async collect(_version, path) {
      if (path.startsWith(AGREEMENTS) && path.includes('$expand=files')) return { items: [graphAgreement()], pages: 1 };
      if (path.startsWith(AGREEMENTS)) return { items: [{ ...graphAgreement(), files: undefined }], pages: 1 };
      return { items: [], pages: 1 };
    },
  };
  const collected = await collectM1(reader, { needed: new Set(['agreement']) });
  const [live] = collected.find(([type]) => type === 'agreement')[1];
  assert.deepEqual(live.files.map((file) => file.fileData), backedUp().files.map((file) => file.fileData));
});
