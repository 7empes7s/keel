/**
 * Roadmap task-62 boundary tests: Microsoft API and catalog drift detection.
 * Exercises the production bounded fetcher (tools/qualification/apiDrift.mjs),
 * the catalog diff/persistence (engine/coverage/catalogDrift.mjs), the job
 * queue helper and the worker/capability registration against adversarial
 * fixtures and the isolated test database — including the three required
 * mutation checks:
 *
 * - Auto-enable discovered endpoint.
 * - Equate fetch failure with no changes.
 * - Ignore source size limit.
 *
 * No network calls: every fetch is an injected fake. No live tenant is
 * touched; the metadata endpoints compared here are anonymous Microsoft
 * documents, and the feature emits REVIEW CANDIDATES ONLY.
 */
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, test } from 'node:test';

import {
  DEFAULT_MAX_BYTES, DEFAULT_SOURCES, DEFAULT_TIMEOUT_MS, fetchMetadataSource,
  main as apiDriftMain, parseCsdl, parseOpenApi, runApiDrift,
} from '../../tools/qualification/apiDrift.mjs';
import {
  buildComparisonModel, catalogEndpointName, diffCatalog, listCandidates,
  loadSourceState, persistCandidates,
} from '../coverage/catalogDrift.mjs';
import { capabilityFor, capabilitySummaryFor } from '../coverage/capabilities.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { DESCRIPTORS } from '../collect/descriptors.mjs';
import { capabilityForJobKind } from '../authz/jobCapabilities.mjs';
import { apiDriftIdempotencyKey, enqueueApiDriftRun } from '../jobs/queue.mjs';
import { JOB_HANDLERS } from '../../cli/keel-worker.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';

// A minimal explicit catalog: two mappings the fixture metadata carries, one
// (widget) the fixture lacks, all under the v1.0 source version.
const MINI_CATALOG = [
  { type: 'user', path: '/users', version: 'v1.0', criticality: 'tier2', blastRadius: 'access-affecting', select: 'id,displayName' },
  { type: 'group', path: '/groups', version: 'v1.0', criticality: 'tier1', blastRadius: 'access-affecting', select: 'id,displayName,mailEnabled' },
  { type: 'widget', path: '/widgets', version: 'v1.0', criticality: 'tier3', blastRadius: 'cosmetic' },
];

const CSDL_V1 = `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">
  <edmx:DataServices>
    <Schema Namespace="microsoft.graph" xmlns="http://docs.oasis-open.org/odata/ns/edm">
      <EntityType Name="user">
        <Property Name="id" Type="Edm.String" Nullable="false"/>
        <Property Name="displayName" Type="Edm.String"/>
      </EntityType>
      <EntityType Name="group">
        <Property Name="id" Type="Edm.String" Nullable="false"/>
        <Property Name="displayName" Type="Edm.String"/>
        <Property Name="mailEnabled" Type="Edm.Boolean" Nullable="false"/>
      </EntityType>
      <EntityType Name="newThing">
        <Property Name="id" Type="Edm.String" Nullable="false"/>
      </EntityType>
      <EntitySet Name="users" EntityType="microsoft.graph.user"/>
      <EntitySet Name="groups" EntityType="Collection(microsoft.graph.group)"/>
      <EntitySet Name="newThings" EntityType="microsoft.graph.newThing"/>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;

// v2: displayName's type changed, group.mailEnabled was removed, and
// group.mailNickname was ADDED (an additive change that must NOT produce a
// finding). Everything else is identical.
const CSDL_V2 = CSDL_V1
  .replace('<Property Name="displayName" Type="Edm.String"/>\n      </EntityType>\n      <EntityType Name="group">',
    '<Property Name="displayName" Type="Collection(Edm.String)"/>\n      </EntityType>\n      <EntityType Name="group">')
  .replace('        <Property Name="mailEnabled" Type="Edm.Boolean" Nullable="false"/>\n',
    '        <Property Name="mailNickname" Type="Edm.String"/>\n');

assert.notEqual(CSDL_V1, CSDL_V2, 'the changed-field fixture must actually differ');

const digestOf = (body) => createHash('sha256').update(body).digest('hex');

function okResponse(body, { etag = '"etag-v1"', date = 'Tue, 22 Sep 2026 03:00:00 GMT' } = {}) {
  return {
    status: 200,
    headers: { get: (name) => ({ etag, date })[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

const MINI_SOURCES = [{
  key: 'graph-csdl-v1.0',
  url: 'https://graph.microsoft.com/v1.0/$metadata',
  format: 'csdl',
  catalogVersion: 'v1.0',
}];

// ---------------------------------------------------------------- pure fetch
test('fetchMetadataSource pins digest, ETag and Date of a 200 body and sends the conditional header', async () => {
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return okResponse(CSDL_V1);
  };
  const result = await fetchMetadataSource({ url: 'https://example.test/$metadata', etag: '"pinned"', fetchImpl });
  assert.equal(result.status, 'fetched');
  assert.equal(result.digest, digestOf(CSDL_V1));
  assert.equal(result.etag, '"etag-v1"');
  assert.equal(result.date, 'Tue, 22 Sep 2026 03:00:00 GMT');
  assert.equal(seen[0].options.headers['If-None-Match'], '"pinned"', 'the pinned ETag is sent back conditionally');
});

test('fetchMetadataSource: 304 is a proven no-change, not a fetch and not an error', async () => {
  const result = await fetchMetadataSource({
    url: 'https://example.test/$metadata',
    etag: '"pinned"',
    fetchImpl: async () => ({ status: 304, headers: { get: () => null } }),
  });
  assert.deepEqual(result, { status: 'not-modified' });
});

test('fetchMetadataSource: network failure and non-2xx are UNKNOWN, never no-change', async () => {
  // Mutation pin (2): a fetch failure must never surface as 'not-modified' or
  // 'fetched' — it is 'unknown', and the run layer must keep the old pin.
  const thrown = await fetchMetadataSource({
    url: 'https://example.test/$metadata',
    fetchImpl: async () => { throw new Error('connection reset'); },
  });
  assert.equal(thrown.status, 'unknown');
  assert.match(thrown.error, /connection reset/);

  const http = await fetchMetadataSource({
    url: 'https://example.test/$metadata',
    fetchImpl: async () => ({ status: 503, headers: { get: () => null } }),
  });
  assert.equal(http.status, 'unknown');
  assert.match(http.error, /HTTP 503/);
});

test('fetchMetadataSource: a hung fetch is bounded by the timeout and reads as timeout', async () => {
  const started = Date.now();
  const result = await fetchMetadataSource({
    url: 'https://example.test/$metadata',
    timeoutMs: 25,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.equal(result.status, 'timeout');
  assert.match(result.error, /timed out after 25ms/);
  assert.ok(Date.now() - started < 5000, 'the timeout actually bounds the wait');
});

test('fetchMetadataSource: an oversized source is refused by header AND by stream, never digested', async () => {
  // Mutation pin (3): dropping the size limit would let both fixtures through
  // as 'fetched'. The limit is enforced on Content-Length before any body
  // read, and on the streamed body chunk-by-chunk.
  const small = 64;
  const bigBody = 'x'.repeat(small + 1);

  let bodyRead = false;
  const byHeader = await fetchMetadataSource({
    url: 'https://example.test/$metadata',
    maxBytes: small,
    fetchImpl: async () => ({
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(bigBody.length) : null) },
      text: async () => { bodyRead = true; return bigBody; },
    }),
  });
  assert.equal(byHeader.status, 'oversized');
  assert.match(byHeader.error, /content-length 65 exceeds the 64-byte limit/);
  assert.equal(bodyRead, false, 'the body is never read once the declared length exceeds the limit');

  const chunks = ['a'.repeat(40), 'b'.repeat(40)];
  let index = 0;
  let cancelled = false;
  const byStream = await fetchMetadataSource({
    url: 'https://example.test/$metadata',
    maxBytes: small,
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => (index < chunks.length
            ? { done: false, value: Buffer.from(chunks[index++]) }
            : { done: true, value: undefined }),
          cancel: async () => { cancelled = true; },
        }),
      },
    }),
  });
  assert.equal(byStream.status, 'oversized');
  assert.match(byStream.error, /body exceeded the 64-byte limit/);
  assert.equal(byStream.digest, undefined, 'an oversized body is never hashed into a pin');
  assert.equal(cancelled, true, 'the oversized stream is cancelled, not drained');
});

test('fetchMetadataSource: a mid-read body failure is UNKNOWN, never no-change', async () => {
  // Mutation pin (2), read layer: a body that starts downloading and then
  // fails mid-stream is not a fetch and not a 304 — it is unknown. Equating it
  // with 'not-modified' would let a truncated document pass as "no changes".
  const failingReader = await fetchMetadataSource({
    url: 'https://example.test/$metadata',
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      body: {
        getReader: () => ({
          read: async () => { throw new Error('stream reset'); },
          cancel: async () => {},
        }),
      },
    }),
  });
  assert.equal(failingReader.status, 'unknown');
  assert.match(failingReader.error, /reading body failed: stream reset/);
  assert.equal(failingReader.digest, undefined, 'a failed read never mints a digest');

  const failingText = await fetchMetadataSource({
    url: 'https://example.test/$metadata',
    fetchImpl: async () => ({
      status: 200,
      headers: { get: () => null },
      text: async () => { throw new Error('socket hangup'); },
    }),
  });
  assert.equal(failingText.status, 'unknown');
  assert.match(failingText.error, /reading body failed: socket hangup/);
});

test('fetchMetadataSource: the time and size bounds themselves are validated, never silently ignored', async () => {
  // Mutation pin (3), configuration layer: dropping the bound validation lets
  // a caller pass maxBytes 0/negative/fractional (an effectively absent or
  // nonsensical limit) or a non-positive timeout. Each must be refused loudly.
  for (const maxBytes of [0, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      () => fetchMetadataSource({ url: 'https://example.test/$metadata', maxBytes, fetchImpl: async () => okResponse(CSDL_V1) }),
      /maxBytes must be a positive integer/,
    );
  }
  for (const timeoutMs of [0, -25, 2.5, Number.NaN]) {
    await assert.rejects(
      () => fetchMetadataSource({ url: 'https://example.test/$metadata', timeoutMs, fetchImpl: async () => okResponse(CSDL_V1) }),
      /timeoutMs must be a positive integer/,
    );
  }
});

// ------------------------------------------------------------------- parsing
test('parseCsdl extracts version, endpoints and field signatures; malformed input throws', () => {
  const parsed = parseCsdl(CSDL_V1);
  assert.equal(parsed.version, '4.0');
  assert.equal(parsed.endpoints.get('users'), 'user');
  assert.equal(parsed.endpoints.get('groups'), 'group', 'Collection(...) wrappers unwrap to the entity type');
  assert.equal(parsed.endpoints.get('newThings'), 'newThing');
  assert.deepEqual(parsed.types.get('user').fields.get('displayName'), { type: 'Edm.String', nullable: true });
  assert.deepEqual(parsed.types.get('user').fields.get('id'), { type: 'Edm.String', nullable: false });

  assert.throws(() => parseCsdl('not xml at all'), /not a CSDL metadata document/);
  assert.throws(() => parseCsdl('<Schema Namespace="x"></Schema>'), /no EntitySet or Singleton/);
  assert.throws(
    () => parseCsdl('<Schema><EntitySet Name="a"/><EntitySet Name="b" EntityType="ns.b"/></Schema>'),
    /malformed EntitySet/,
  );
});

test('parseOpenApi contributes endpoint paths with no field signatures', () => {
  const parsed = parseOpenApi(JSON.stringify({
    info: { version: 'v1.0.9' },
    paths: { '/users': {}, '/groups/{groupId}/members': {} },
  }));
  assert.equal(parsed.version, 'v1.0.9');
  assert.deepEqual([...parsed.endpoints.keys()].sort(), ['members', 'users']);
  assert.equal(parsed.endpoints.get('users'), null, 'OpenAPI paths carry no entity type — no field diff');
  assert.throws(() => parseOpenApi('{'), /not an OpenAPI JSON document/);
  assert.throws(() => parseOpenApi('{"info":{}}'), /no paths object/);
});

test('buildComparisonModel persists a catalog-bounded model, never the whole metadata document', () => {
  // Mutation pin (3), persistence layer: the pinned model is the comparison
  // baseline stored per tenant per source, so it must stay bounded by the
  // CATALOG size, not by the metadata size. newThing is declared in the
  // fixture metadata but mapped by no catalog entry — its fields must not
  // enter the model.
  const model = buildComparisonModel(parseCsdl(CSDL_V1), CATALOG, 'v1.0');
  assert.deepEqual(
    Object.keys(model.fields).sort(),
    ['group', 'user'],
    'only catalog-mapped types with a present endpoint carry field signatures',
  );
  assert.equal(model.fields.newThing, undefined, 'an unmapped metadata type is never pinned into the model');

  // The same bound holds for the mini catalog: widget's endpoint is absent
  // from the fixture, so even a mapped type without metadata contributes
  // nothing.
  const miniModel = buildComparisonModel(parseCsdl(CSDL_V1), MINI_CATALOG, 'v1.0');
  assert.deepEqual(Object.keys(miniModel.fields).sort(), ['group', 'user']);
});

test('catalogEndpointName maps the last literal segment, skipping {parameters}', () => {
  assert.equal(catalogEndpointName({ path: '/users' }), 'users');
  assert.equal(catalogEndpointName({ path: '/directory/administrativeUnits' }), 'administrativeUnits');
  assert.equal(
    catalogEndpointName({ path: '/organization/{org}/certificateBasedAuthConfiguration' }),
    'certificateBasedAuthConfiguration',
  );
  assert.throws(() => catalogEndpointName({ path: '/{org}' }), /no literal path segment/);
});

test('diffCatalog against the REAL catalog: unmapped endpoints are candidates, mappings hold', () => {
  const parsed = parseCsdl(CSDL_V1);
  const model = buildComparisonModel(parsed, CATALOG, 'v1.0');
  assert.deepEqual(model.endpoints, ['groups', 'newThings', 'users']);
  assert.deepEqual(model.fields.user, {
    id: { type: 'Edm.String', nullable: false },
    displayName: { type: 'Edm.String', nullable: true },
  });

  const findings = diffCatalog({ previous: null, current: model, catalog: CATALOG, catalogVersion: 'v1.0' });
  const added = findings.filter((f) => f.kind === 'added-endpoint');
  assert.deepEqual(added, [
    { kind: 'added-endpoint', resourceType: null, path: '/newThings', field: null, detail: {} },
  ], 'exactly the unmapped fixture endpoint is a candidate');
  const removed = findings.filter((f) => f.kind === 'removed-endpoint');
  // Every v1.0 catalog mapping absent from the fixture metadata is reported —
  // users and groups are present, so they are NOT among them.
  assert.ok(removed.length >= 40, 'the real catalog is fully enumerated');
  assert.ok(removed.every((f) => f.resourceType && f.path.startsWith('/')));
  assert.ok(!removed.some((f) => f.resourceType === 'user' || f.resourceType === 'group'));
  // Beta catalog entries are out of scope for a v1.0 source.
  assert.ok(!findings.some((f) => f.resourceType === 'configurationPolicy'));

  // Changed fields require a previous pin; additive fields are not findings.
  const changed = diffCatalog({
    previous: model,
    current: buildComparisonModel(parseCsdl(CSDL_V2), CATALOG, 'v1.0'),
    catalog: CATALOG,
    catalogVersion: 'v1.0',
  });
  const fieldChanges = changed.filter((f) => f.kind === 'changed-field');
  assert.deepEqual(fieldChanges, [
    { kind: 'changed-field', resourceType: 'user', path: '/users', field: 'displayName',
      detail: { change: 'type', before: 'Edm.String', after: 'Collection(Edm.String)' } },
    { kind: 'changed-field', resourceType: 'group', path: '/groups', field: 'mailEnabled',
      detail: { change: 'removed', before: { type: 'Edm.Boolean', nullable: false }, after: null } },
  ]);
  assert.ok(!fieldChanges.some((f) => f.field === 'mailNickname'), 'a purely additive field is not a finding');
});

// ------------------------------------------------------------ DB integration
const database = await createIsolatedTestDatabase(import.meta.url);
after(async () => { await database.cleanup(); });

async function freshSchema() {
  const client = await database.connect();
  const schema = readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8');
  await client.query(schema);
  await client.query(schema); // re-application is idempotent and legacy-safe
  return client;
}

test('a full drift pass: added endpoint creates a candidate with source proof, never a registration', async (t) => {
  const client = await freshSchema();
  t.after(async () => { await client.end(); });
  const tenantRef = 'sha256:api-drift-added-endpoint';

  const catalogBefore = JSON.stringify(CATALOG);
  const descriptorsBefore = JSON.stringify(DESCRIPTORS);
  const capabilityBefore = JSON.stringify(capabilitySummaryFor('group'));

  const first = await runApiDrift({
    client, tenantRef, sources: MINI_SOURCES, catalog: MINI_CATALOG,
    fetchImpl: async () => okResponse(CSDL_V1),
    now: new Date('2026-09-22T03:00:00Z'),
  });
  assert.equal(first.ok, true);
  assert.equal(first.results[0].status, 'fetched');

  const candidates = await listCandidates(client, { tenantRef });
  assert.equal(candidates.length, 2, 'added endpoint + the missing widget mapping');
  const added = candidates.find((c) => c.kind === 'added-endpoint');
  assert.equal(added.path, '/newThings');
  assert.equal(added.resource_type, null, 'a discovered endpoint names no engine resource type');
  assert.equal(added.status, 'review', 'a candidate is review-only by construction');
  // Acceptance: the candidate carries its source proof — the pinned digest of
  // the exact bytes, the ETag, the HTTP Date, the document version, the fetch
  // instant and the URL.
  assert.equal(added.proof.digest, digestOf(CSDL_V1));
  assert.equal(added.proof.etag, '"etag-v1"');
  assert.equal(added.proof.sourceDate, 'Tue, 22 Sep 2026 03:00:00 GMT');
  assert.equal(added.proof.metadataVersion, '4.0');
  assert.equal(added.proof.fetchedAt, '2026-09-22T03:00:00.000Z');
  assert.equal(added.proof.sourceUrl, 'https://graph.microsoft.com/v1.0/$metadata');
  const removed = candidates.find((c) => c.kind === 'removed-endpoint');
  assert.equal(removed.resource_type, 'widget');
  assert.equal(removed.path, '/widgets');

  // The source pin itself is recorded.
  const pin = await loadSourceState(client, { tenantRef, sourceKey: 'graph-csdl-v1.0' });
  assert.equal(pin.digest, digestOf(CSDL_V1));
  assert.equal(pin.etag, '"etag-v1"');
  assert.equal(pin.source_date, 'Tue, 22 Sep 2026 03:00:00 GMT');
  assert.equal(pin.metadata_version, '4.0');
  assert.equal(pin.last_status, 'fetched');
  assert.ok(pin.last_changed_at);
  assert.deepEqual(pin.model.endpoints, ['groups', 'newThings', 'users']);

  // Mutation pin (1): the discovered endpoint is NOT auto-enabled anywhere.
  // The capability registry, the catalog and the descriptors are untouched —
  // 'newThing' stays 'unsupported' for every operation, exactly like any
  // unregistered type.
  assert.equal(capabilityFor('newThing', 'create').claim, 'unsupported');
  assert.equal(capabilityFor('newThing', 'update').claim, 'unsupported');
  assert.equal(capabilityFor('newThing', 'delete').claim, 'unsupported');
  assert.equal(JSON.stringify(CATALOG), catalogBefore, 'the drift pass never extends the catalog');
  assert.equal(JSON.stringify(DESCRIPTORS), descriptorsBefore, 'the drift pass never adds a descriptor');
  assert.equal(JSON.stringify(capabilitySummaryFor('group')), capabilityBefore, 'existing claims are untouched');
});

test('a duplicate fetch inserts zero duplicate findings; 304 and identical digests are both no-change', async (t) => {
  const client = await freshSchema();
  t.after(async () => { await client.end(); });
  const tenantRef = 'sha256:api-drift-duplicate';

  await runApiDrift({
    client, tenantRef, sources: MINI_SOURCES, catalog: MINI_CATALOG,
    fetchImpl: async () => okResponse(CSDL_V1),
  });
  const repeat = await runApiDrift({
    client, tenantRef, sources: MINI_SOURCES, catalog: MINI_CATALOG,
    fetchImpl: async () => okResponse(CSDL_V1),
  });
  assert.equal(repeat.results[0].status, 'not-modified', 'an identical body is a proven no-change even without a 304');
  assert.equal(repeat.results[0].inserted, 0);
  assert.equal((await listCandidates(client, { tenantRef })).length, 2, 'no duplicate findings');

  // A server that honours the conditional request answers 304 to the pinned ETag.
  const seenEtag = [];
  const notModified = await runApiDrift({
    client, tenantRef, sources: MINI_SOURCES, catalog: MINI_CATALOG,
    fetchImpl: async (url, options) => {
      seenEtag.push(options.headers['If-None-Match']);
      return { status: 304, headers: { get: () => null } };
    },
  });
  assert.deepEqual(seenEtag, ['"etag-v1"'], 'the pinned ETag drove the conditional request');
  assert.equal(notModified.results[0].status, 'not-modified');
  assert.equal(notModified.ok, true, 'a 304 pass is a successful no-change run');
  assert.equal((await listCandidates(client, { tenantRef })).length, 2, 'a 304 pass adds nothing');
  const pin = await loadSourceState(client, { tenantRef, sourceKey: 'graph-csdl-v1.0' });
  assert.equal(pin.last_status, 'not-modified');
  assert.equal(pin.digest, digestOf(CSDL_V1), 'a 304 never moves the digest pin');
});

test('a changed field becomes a review candidate and never becomes writable', async (t) => {
  const client = await freshSchema();
  t.after(async () => { await client.end(); });
  const tenantRef = 'sha256:api-drift-changed-field';

  await runApiDrift({
    client, tenantRef, sources: MINI_SOURCES, catalog: MINI_CATALOG,
    fetchImpl: async () => okResponse(CSDL_V1),
  });
  const capabilitiesBefore = {
    user: JSON.stringify(capabilitySummaryFor('user')),
    group: JSON.stringify(capabilitySummaryFor('group')),
  };

  const second = await runApiDrift({
    client, tenantRef, sources: MINI_SOURCES, catalog: MINI_CATALOG,
    fetchImpl: async () => okResponse(CSDL_V2, { etag: '"etag-v2"' }),
    now: new Date('2026-09-29T03:00:00Z'),
  });
  assert.equal(second.ok, true);

  const candidates = await listCandidates(client, { tenantRef });
  const fieldChanges = candidates.filter((c) => c.kind === 'changed-field');
  assert.equal(fieldChanges.length, 2);
  const typeChange = fieldChanges.find((c) => c.resource_type === 'user' && c.field === 'displayName');
  assert.equal(typeChange.detail.change, 'type');
  assert.equal(typeChange.detail.before, 'Edm.String');
  assert.equal(typeChange.detail.after, 'Collection(Edm.String)');
  assert.equal(typeChange.status, 'review');
  assert.equal(typeChange.proof.digest, digestOf(CSDL_V2), 'the changed-field candidate pins the new source');
  const removedField = fieldChanges.find((c) => c.resource_type === 'group' && c.field === 'mailEnabled');
  assert.equal(removedField.detail.change, 'removed');
  assert.ok(!candidates.some((c) => c.field === 'mailNickname'), 'the additive field is not a finding');

  // Acceptance: a changed field does not become writable. The drift pass ran
  // against metadata showing changed and new fields; every operation claim —
  // including the never-registered user create — is exactly what it was.
  assert.equal(capabilityFor('user', 'create').claim, 'unsupported');
  assert.equal(JSON.stringify(capabilitySummaryFor('user')), capabilitiesBefore.user);
  assert.equal(JSON.stringify(capabilitySummaryFor('group')), capabilitiesBefore.group);

  // The pin moved to the new document, with last_changed_at set.
  const pin = await loadSourceState(client, { tenantRef, sourceKey: 'graph-csdl-v1.0' });
  assert.equal(pin.digest, digestOf(CSDL_V2));
  assert.equal(pin.etag, '"etag-v2"');
  assert.ok(pin.last_changed_at);
});

test('fetch failure is UNKNOWN — the pin survives, the run fails visibly, nothing reads as no-change', async (t) => {
  const client = await freshSchema();
  t.after(async () => { await client.end(); });
  const tenantRef = 'sha256:api-drift-fetch-failure';

  await runApiDrift({
    client, tenantRef, sources: MINI_SOURCES, catalog: MINI_CATALOG,
    fetchImpl: async () => okResponse(CSDL_V1),
  });
  const candidatesBefore = await listCandidates(client, { tenantRef });

  // Mutation pin (2), run layer: a network failure mid-schedule must not
  // record 'not-modified', must not clear or move the pin, and must fail the
  // run so the job queue shows the failure.
  const failed = await runApiDrift({
    client, tenantRef, sources: MINI_SOURCES, catalog: MINI_CATALOG,
    fetchImpl: async () => { throw new Error('connection reset'); },
  });
  assert.equal(failed.ok, false, 'an unknown source fails the run visibly');
  assert.equal(failed.results[0].status, 'unknown');
  assert.match(failed.results[0].error, /connection reset/);

  const pin = await loadSourceState(client, { tenantRef, sourceKey: 'graph-csdl-v1.0' });
  assert.equal(pin.last_status, 'unknown');
  assert.match(pin.last_error, /connection reset/);
  assert.equal(pin.digest, digestOf(CSDL_V1), 'the last genuinely observed digest is retained');
  assert.equal(pin.etag, '"etag-v1"', 'the conditional-fetch pin is retained');
  assert.deepEqual(pin.model.endpoints, ['groups', 'newThings', 'users'], 'the comparison baseline is retained');
  assert.deepEqual(await listCandidates(client, { tenantRef }), candidatesBefore, 'a failed run adds and removes nothing');

  // A parse failure is equally UNKNOWN: the body downloaded fine but cannot
  // be diffed, so the pin must not move to it.
  const unparsable = await runApiDrift({
    client, tenantRef, sources: MINI_SOURCES, catalog: MINI_CATALOG,
    fetchImpl: async () => okResponse('<not-csdl/>', { etag: '"etag-bogus"' }),
  });
  assert.equal(unparsable.ok, false);
  assert.equal(unparsable.results[0].status, 'unknown');
  const pinAfter = await loadSourceState(client, { tenantRef, sourceKey: 'graph-csdl-v1.0' });
  assert.equal(pinAfter.digest, digestOf(CSDL_V1), 'an unparsable document never becomes the pin');
  assert.equal(pinAfter.etag, '"etag-v1"');
});

test('timeout and oversized sources are bounded and visible in the source state and the run result', async (t) => {
  const client = await freshSchema();
  t.after(async () => { await client.end(); });
  const tenantRef = 'sha256:api-drift-bounds';

  const timedOut = await runApiDrift({
    client, tenantRef, sources: MINI_SOURCES, catalog: MINI_CATALOG, timeoutMs: 25,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.results[0].status, 'timeout');
  let pin = await loadSourceState(client, { tenantRef, sourceKey: 'graph-csdl-v1.0' });
  assert.equal(pin.last_status, 'timeout', 'the timeout is visible on the tenant-scoped source row');
  assert.match(pin.last_error, /timed out after 25ms/);
  assert.equal(pin.digest, null, 'no pin is ever minted from a timed-out fetch');

  // Mutation pin (3), run layer: an oversized document is refused at the
  // configured bound and recorded as oversized — it is never diffed, so it
  // can never mint candidates from an unbounded body.
  const oversized = await runApiDrift({
    client, tenantRef, sources: MINI_SOURCES, catalog: MINI_CATALOG, maxBytes: 128,
    fetchImpl: async () => okResponse(CSDL_V1),
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.results[0].status, 'oversized');
  pin = await loadSourceState(client, { tenantRef, sourceKey: 'graph-csdl-v1.0' });
  assert.equal(pin.last_status, 'oversized');
  // okResponse() sets no content-length header, so this exercises the streamed
  // body's own running-total bound (readBoundedBody), not the header pre-check —
  // its message is worded differently ("exceeded" vs "exceeds").
  assert.match(pin.last_error, /exceeded the 128-byte limit/);
  assert.equal(pin.digest, null);
  assert.equal((await listCandidates(client, { tenantRef })).length, 0);
});

test('candidates and source state are tenant-scoped and legacy-empty reads are safe', async (t) => {
  const client = await freshSchema();
  t.after(async () => { await client.end(); });
  const tenantRef = 'sha256:api-drift-scoping';

  // Legacy-read: a store that predates task-62 data reads as empty, never an error.
  assert.deepEqual(await listCandidates(client, { tenantRef }), []);
  assert.equal(await loadSourceState(client, { tenantRef, sourceKey: 'graph-csdl-v1.0' }), null);

  await runApiDrift({
    client, tenantRef, sources: MINI_SOURCES, catalog: MINI_CATALOG,
    fetchImpl: async () => okResponse(CSDL_V1),
  });
  assert.equal((await listCandidates(client, { tenantRef })).length, 2);
  // Another tenant's read is isolated server-side by the tenant_ref predicate.
  assert.deepEqual(await listCandidates(client, { tenantRef: 'sha256:api-drift-scoping-other' }), []);
  assert.equal(await loadSourceState(client, { tenantRef: 'sha256:api-drift-scoping-other', sourceKey: 'graph-csdl-v1.0' }), null);

  // Candidate kinds are a closed inventory, and proof is mandatory.
  await assert.rejects(
    () => persistCandidates(client, {
      tenantRef, sourceKey: 'k', sourceUrl: 'https://u',
      findings: [{ kind: 'auto-enable', path: '/x' }], proof: { digest: 'd' },
    }),
    /unknown candidate kind: auto-enable/,
  );
  await assert.rejects(
    () => persistCandidates(client, {
      tenantRef, sourceKey: 'k', sourceUrl: 'https://u', findings: [], proof: {},
    }),
    /requires source proof/,
  );
});

test('persistCandidates refuses a raw/invalid tenantRef before writing any row', async (t) => {
  const client = await freshSchema();
  t.after(async () => { await client.end(); });

  // Mutation pin: dropping the assertTenantRef(tenantRef) guard at the top of
  // persistCandidates would let an unhashed/malformed tenantRef through to the
  // INSERT unchecked — the table has no format CHECK on tenant_ref, so the row
  // would land silently instead of being refused.
  const before = await client.query(
    `SELECT count(*) FROM api_drift_candidate WHERE tenant_ref = 'raw-unhashed-tenant-id'`,
  );
  await assert.rejects(
    () => persistCandidates(client, {
      tenantRef: 'raw-unhashed-tenant-id',
      sourceKey: 'graph-csdl-v1.0',
      sourceUrl: 'https://graph.microsoft.com/v1.0/$metadata',
      findings: [{ kind: 'added-endpoint', resourceType: null, path: '/newThings', field: null, detail: {} }],
      proof: { digest: 'd' },
    }),
    /must be a derived tenant reference/,
  );
  const after = await client.query(
    `SELECT count(*) FROM api_drift_candidate WHERE tenant_ref = 'raw-unhashed-tenant-id'`,
  );
  assert.equal(after.rows[0].count, before.rows[0].count, 'no candidate is ever written under an unvalidated tenantRef');
  assert.equal(after.rows[0].count, '0');
});

test('enqueueApiDriftRun dedupes per tenant and cadence period through the existing queue', async (t) => {
  const client = await freshSchema();
  t.after(async () => { await client.end(); });
  const tenantRef = 'sha256:api-drift-queue';

  const first = await enqueueApiDriftRun(client, {
    tenantRef, requestedBy: 'test-operator', periodKey: '2026-W39',
  });
  assert.equal(first.kind, 'api-drift', 'the schema CHECK accepts the new kind');
  assert.equal(first.status, 'queued');
  const repeat = await enqueueApiDriftRun(client, {
    tenantRef, requestedBy: 'test-operator', periodKey: '2026-W39',
  });
  assert.equal(repeat.id, first.id, 'a duplicate fire in the same period returns the existing job');
  const next = await enqueueApiDriftRun(client, {
    tenantRef, requestedBy: 'test-operator', periodKey: '2026-W40',
  });
  assert.notEqual(next.id, first.id, 'the next cadence period is a new run');
  const otherTenant = await enqueueApiDriftRun(client, {
    tenantRef: 'sha256:api-drift-queue-other', requestedBy: 'test-operator', periodKey: '2026-W39',
  });
  assert.notEqual(otherTenant.id, first.id, 'the same period in another tenant is a different run');

  assert.equal(apiDriftIdempotencyKey(tenantRef, '2026-W39'), `api-drift:${tenantRef}:2026-W39`);
  assert.throws(() => apiDriftIdempotencyKey('', '2026-W39'), /tenantRef is required/);
  assert.throws(() => apiDriftIdempotencyKey(tenantRef, ''), /periodKey is required/);
});

test('worker and capability registration: api-drift is deny-by-default wired, never a parallel gate', () => {
  assert.equal(capabilityForJobKind('api-drift'), 'collect', 'read-only metadata comparison rides the collect capability');
  assert.ok(JOB_HANDLERS['api-drift'], 'a worker handler exists for the kind');
  assert.ok(JOB_HANDLERS['api-drift'].script.endsWith('tools/qualification/apiDrift.mjs'));
  assert.deepEqual(JOB_HANDLERS['api-drift'].argsFor({}), []);
  assert.deepEqual(
    JOB_HANDLERS['api-drift'].argsFor({ config: '/etc/keel/tenant.json', sources: '/etc/keel/api-sources.json' }),
    ['--config', '/etc/keel/tenant.json', '--sources', '/etc/keel/api-sources.json'],
  );
  assert.throws(() => JOB_HANDLERS['api-drift'].argsFor({ sources: 42 }), /params.sources must be a non-empty string/);
});

test('CLI main end-to-end: exit code reflects source health through the real run path', async (t) => {
  const noopLogger = { log() {}, error() {} };
  const runMain = (fetchImpl) => apiDriftMain({
    argv: ['node', 'apiDrift.mjs', '--config', '/fixtures/tenant.json', '--db-url', database.url],
    readFile: () => JSON.stringify({ tenantId: 'fixture-tenant-api-drift' }),
    dependencies: { connect: async () => database.connect(), fetchImpl },
    logger: noopLogger,
  });

  // Fresh schema in the shared database: main() needs the task-62 tables.
  const setup = await database.connect();
  await setup.query(readFileSync(new URL('../store/schema.sql', import.meta.url), 'utf8'));
  await setup.end();

  assert.equal(await runMain(async () => okResponse(CSDL_V1)), 0, 'a healthy pass exits zero');
  assert.equal(
    (await apiDriftMain({
      argv: ['node', 'apiDrift.mjs', '--config', '/fixtures/tenant.json', '--db-url', database.url],
      readFile: () => JSON.stringify({ tenantId: 'fixture-tenant-api-drift' }),
      dependencies: { connect: async () => database.connect(), fetchImpl: async () => { throw new Error('dns failure'); } },
      logger: noopLogger,
    })),
    1,
    'an unknown source exits non-zero so the worker job fails visibly',
  );

  // The CLI-derived tenant scope matches the tenantRef convention everywhere else.
  const tenantRef = tenantRefFor('fixture-tenant-api-drift');
  const client = await database.connect();
  t.after(async () => { await client.end(); });

  // The CLI always diffs against the real production CATALOG (there is no seam to
  // substitute MINI_CATALOG through the CLI path), and the fake fetchImpl above
  // serves the same CSDL_V1 body to every configured default source — so the
  // expected candidate set is whatever the production diff functions themselves
  // produce for each source's catalog version against that one parsed body, not a
  // number hand-picked against MINI_CATALOG.
  const parsedFixture = parseCsdl(CSDL_V1);
  const expectedCandidateCount = DEFAULT_SOURCES.reduce((total, source) => {
    const model = buildComparisonModel(parsedFixture, CATALOG, source.catalogVersion);
    const findings = diffCatalog({ previous: null, current: model, catalog: CATALOG, catalogVersion: source.catalogVersion });
    return total + findings.length;
  }, 0);
  assert.ok(expectedCandidateCount > 0, 'the real catalog actually diverges from the tiny fixture');
  assert.equal((await listCandidates(client, { tenantRef })).length, expectedCandidateCount);
});

test('CLI main refuses invalid --timeout-ms / --max-bytes before touching anything', async () => {
  // The CLI validates its bounds up front; a dropped check would let an
  // operator-configured zero or fractional limit through to the fetcher.
  const noopLogger = { log() {}, error() {} };
  await assert.rejects(
    () => apiDriftMain({
      argv: ['node', 'apiDrift.mjs', '--config', '/fixtures/tenant.json', '--max-bytes', '0'],
      readFile: () => JSON.stringify({ tenantId: 'fixture-tenant-api-drift' }),
      dependencies: { connect: async () => database.connect(), fetchImpl: async () => okResponse(CSDL_V1) },
      logger: noopLogger,
    }),
    /--max-bytes must be a positive integer/,
  );
  await assert.rejects(
    () => apiDriftMain({
      argv: ['node', 'apiDrift.mjs', '--config', '/fixtures/tenant.json', '--timeout-ms', '-5'],
      readFile: () => JSON.stringify({ tenantId: 'fixture-tenant-api-drift' }),
      dependencies: { connect: async () => database.connect(), fetchImpl: async () => okResponse(CSDL_V1) },
      logger: noopLogger,
    }),
    /--timeout-ms must be a positive integer/,
  );
});

test('defaults are genuinely bounded and official', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 30 * 1000);
  assert.equal(DEFAULT_MAX_BYTES, 32 * 1024 * 1024, 'the default size bound is exactly the documented 32 MB');
  assert.ok(DEFAULT_MAX_BYTES > 0 && DEFAULT_MAX_BYTES <= 64 * 1024 * 1024, 'the size bound is finite and small');
  assert.ok(DEFAULT_SOURCES.length >= 1);
  for (const source of DEFAULT_SOURCES) {
    assert.ok(source.url.startsWith('https://'), 'official sources are https only');
    assert.ok(['csdl', 'openapi'].includes(source.format));
  }
});
