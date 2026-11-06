/**
 * Issue #1015: writes that cannot be undone, behind a "can't be undone"
 * (permanent) review in the restore approval: a recreated custom security
 * attribute set or attribute, and user sync from a partner tenant turned on.
 *
 * Drives the production applyWave() path. Microsoft Graph is an in-memory fake
 * only; no tenant is read or written. Payloads are in the stored shape
 * (canonicalizeAll of what the collector returns).
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { OPERATIONS, capabilityFor, isSupportedClaim } from '../coverage/capabilities.mjs';
import { serviceForResourceType } from '../govern/restoreApprovalSettings.mjs';
import { applyWave } from '../restore/applyEngine.mjs';
import { CONTENT_EFFECTS, classifyContentEffects, disclosureFor } from '../safety/contentEffects.mjs';
import { PERMANENT_EFFECT } from '../safety/permanentEffects.mjs';

const governor = { async acquire() {}, observeRetryAfter() {} };
const SETS = '/directory/attributeSets';
const ATTRIBUTES = '/directory/customSecurityAttributeDefinitions';
const PARTNERS = '/policies/crossTenantAccessPolicy/partners';
const PARTNER = '22222222-2222-4222-8222-222222222222';
const SYNC = `${PARTNERS}/${PARTNER}/identitySynchronization`;

/**
 * The Graph routes these writers use. Objects live at their path. An attribute
 * set keeps the id it is given; an attribute's id is its set and name; sync
 * settings are put only under a partner that exists. `failReads` answers a
 * read of a path with that result instead.
 */
function graph({ objects = {}, failReads = {} } = {}) {
  const store = new Map(Object.entries(objects).map(([path, body]) => [path, structuredClone(body)]));
  const calls = [];
  const ok = (body, status = 200) => ({ ok: true, status, body });
  const missing = { ok: false, status: 404, body: { error: { code: 'Request_ResourceNotFound' } } };
  return {
    store, calls,
    writes: () => calls.filter((call) => call.method !== 'GET'),
    async read(version, requested) {
      const [path, query = ''] = requested.split('?');
      calls.push({ method: 'GET', path });
      if (failReads[path]) return failReads[path];
      const found = store.get(path);
      if (!found) return missing;
      if (query.includes('$expand=allowedValues')) return ok({ allowedValues: [], ...found });
      return ok(found);
    },
    async write(version, path, { method, body }) {
      calls.push({ method, path, body: structuredClone(body) });
      if (method === 'POST' && (path === SETS || path === ATTRIBUTES)) {
        const created = { ...body, id: path === SETS ? body.id : `${body.attributeSet}_${body.name}` };
        store.set(`${path}/${created.id}`, created);
        return ok(created, 201);
      }
      const sync = new RegExp(`^(${PARTNERS}/([^/]+))/identitySynchronization$`).exec(path);
      if (sync && method === 'PUT') {
        if (!store.has(sync[1])) return { ok: false, status: 400, body: { error: { message: 'the tenant is not a partner' } } };
        store.set(path, { tenantId: decodeURIComponent(sync[2]), ...body });
        return ok(null, 204);
      }
      if (method === 'PATCH' && store.has(path)) {
        store.set(path, { ...store.get(path), ...body });
        return ok(null, 204);
      }
      return { ok: false, status: 400, body: { error: { message: `fake has no route for ${method} ${path}` } } };
    },
  };
}

const run = (fake, wave, options = {}) => applyWave(fake, governor, wave, {
  targetTenant: 'fixture', mode: 'enforce', readAfterWriteOptions: { attempts: 1, delayMs: 0 }, ...options,
});

/** The effects the dry run lists, as the promotion hands them to the writers once approved (or approvals are off). */
const approvalsFor = (resources) => classifyContentEffects(resources).effects;

/** A resource in the stored shape, with its live object when it has one. */
function resourceOf(resourceType, collected, verb, live = null) {
  const [stored] = canonicalizeAll([[resourceType, [collected]]]);
  return {
    naturalKey: stored.naturalKey, resourceType, verb, payload: stored.payload, references: [], blastRadius: 'access-affecting',
    ...(live ? { targetId: live.id ?? live.tenantId, live: { state: 'present', targetId: live.id, payload: live } } : {}),
  };
}

const SET = Object.freeze({ id: 'KEELRT1015Set', description: 'KEEL-RT-1015 fixture set', maxAttributesPerSet: 10 });
const ATTRIBUTE = Object.freeze({
  id: 'KEELRT1015Set_Level', attributeSet: 'KEELRT1015Set', name: 'Level', description: 'KEEL-RT-1015 clearance', isCollection: false,
  isSearchable: true, status: 'Available', type: 'String', usePreDefinedValuesOnly: true,
  allowedValues: [{ id: 'High', isActive: true }, { id: 'Low', isActive: true }],
});
const syncOf = (isSyncAllowed, displayName = 'KEEL-RT-1015 partner') => ({ tenantId: PARTNER, displayName, userSyncInbound: { isSyncAllowed } });
const PARTNER_ENTRY = Object.freeze({ [`${PARTNERS}/${PARTNER}`]: { tenantId: PARTNER, isServiceProvider: false } });

const setCreate = () => resourceOf('attributeSet', SET, 'create');
const attributeCreate = () => resourceOf('customSecurityAttributeDefinition', ATTRIBUTE, 'create');
const syncOn = (live = null) => resourceOf('crossTenantIdentitySyncPolicyPartner', syncOf(true), live ? 'update' : 'create', live);

// ------------------------------------------------------- the effect itself

test('"permanent" is a restore approval effect, and each permanent write says in its dry run what stays', () => {
  assert.ok(CONTENT_EFFECTS.includes(PERMANENT_EFFECT));
  assert.match(disclosureFor(PERMANENT_EFFECT), /cannot be undone/);
  const effects = approvalsFor([setCreate(), attributeCreate(), syncOn()]);
  assert.deepEqual(effects.map((effect) => `${effect.resourceType}:${effect.field}:${effect.effect}`), [
    'attributeSet:(object created):permanent',
    'crossTenantIdentitySyncPolicyPartner:userSyncInbound.isSyncAllowed:access-changing',
    'crossTenantIdentitySyncPolicyPartner:userSyncInbound.isSyncAllowed:permanent',
    'customSecurityAttributeDefinition:(object created):permanent',
  ]);
  const said = (type, effect) => effects.find((entry) => entry.resourceType === type && entry.effect === effect).disclosure;
  assert.match(said('attributeSet', PERMANENT_EFFECT), /never deletes a custom security attribute set: once "KEELRT1015Set" is made it stays in the tenant for good/);
  assert.match(said('customSecurityAttributeDefinition', PERMANENT_EFFECT), /never deletes a custom security attribute: once "Level" is made in the attribute set "KEELRT1015Set" it stays for good/);
  assert.match(said('crossTenantIdentitySyncPolicyPartner', PERMANENT_EFFECT), /only stops new users being synced: the accounts it already synced stay in this tenant/);
  assert.match(said('crossTenantIdentitySyncPolicyPartner', 'access-changing'), /turns on user sync from KEEL-RT-1015 partner/);
  // No raw tenant id in what a person reads.
  for (const effect of effects) assert.doesNotMatch(effect.disclosure, new RegExp(PARTNER));
  // Each type sits in Entra, so the customer's Entra approval setting can waive the review.
  for (const type of ['attributeSet', 'customSecurityAttributeDefinition', 'crossTenantIdentitySyncPolicyPartner']) assert.equal(serviceForResourceType(type), 'Entra');
});

test('only a create, or sync turned on, is permanent: updates, sync off and sync kept carry no effect', () => {
  const setLive = { ...SET, description: 'Old' };
  const attributeLive = { ...ATTRIBUTE, description: 'Old' };
  assert.deepEqual(approvalsFor([
    resourceOf('attributeSet', SET, 'update', setLive),
    resourceOf('customSecurityAttributeDefinition', ATTRIBUTE, 'update', attributeLive),
    resourceOf('crossTenantIdentitySyncPolicyPartner', syncOf(false), 'update', syncOf(true)),
    resourceOf('crossTenantIdentitySyncPolicyPartner', syncOf(true, 'Renamed'), 'update', syncOf(true)),
    resourceOf('crossTenantIdentitySyncPolicyPartner', syncOf(false), 'create'),
  ]), []);
  // Off to on, on an existing object, is held like a create.
  assert.deepEqual(approvalsFor([syncOn(syncOf(false))]).map((effect) => [effect.effect, effect.before, effect.after]),
    [['access-changing', false, true], [PERMANENT_EFFECT, false, true]]);
});

// ------------------------------------------------------- the gate

for (const [label, make] of [['an attribute set create', setCreate], ['an attribute create', attributeCreate]]) {
  test(`${label} is held until its "can't be undone" effect is approved, and then written`, async () => {
    const held = graph();
    const refused = await run(held, [make()]);
    assert.equal(refused.applied.length, 0);
    assert.equal(held.writes().length, 0, 'nothing is written without the approval');
    assert.match(refused.skipped[0].reason, /cannot be undone .*approve "Can't be undone"/);
    assert.equal(refused.skipped[0].completion[0].requirement, 'permanentApproval');

    // An approval of other effects, or of a different object, does not count.
    const other = { ...approvalsFor([make()])[0], naturalKey: `${make().resourceType}:Other` };
    const stillHeld = graph();
    assert.equal((await run(stillHeld, [make()], { approvedContentEffects: [other] })).applied.length, 0);
    assert.equal(stillHeld.writes().length, 0);

    const fake = graph();
    const done = await run(fake, [make()], { approvedContentEffects: approvalsFor([make()]) });
    assert.deepEqual(done.failed, []);
    assert.equal(done.applied.length, 1);
    assert.equal(fake.writes().length, 1);
  });
}

test('an attribute set create sends its name as its id, its description and size, and reads back as written', async () => {
  const fake = graph();
  const result = await run(fake, [setCreate()], { approvedContentEffects: approvalsFor([setCreate()]) });
  assert.deepEqual(result.failed, []);
  const [post] = fake.writes();
  assert.equal(post.path, SETS);
  assert.deepEqual(post.body, { id: 'KEELRT1015Set', description: 'KEEL-RT-1015 fixture set', maxAttributesPerSet: 10 });
  assert.equal(result.applied[0].targetId, 'KEELRT1015Set');
});

test('an attribute create sends its set, name, type and allowed values, never an id', async () => {
  const fake = graph();
  const result = await run(fake, [attributeCreate()], { approvedContentEffects: approvalsFor([attributeCreate()]) });
  assert.deepEqual(result.failed, []);
  const [post] = fake.writes();
  assert.equal(post.path, ATTRIBUTES);
  assert.equal('id' in post.body, false);
  assert.deepEqual(post.body.allowedValues, [{ id: 'High', isActive: true }, { id: 'Low', isActive: true }]);
  for (const field of ['attributeSet', 'name', 'type', 'isCollection', 'isSearchable', 'usePreDefinedValuesOnly', 'status']) assert.ok(field in post.body, field);
  assert.equal(result.applied[0].targetId, 'KEELRT1015Set_Level');
});

test('an update of an attribute set or attribute needs no permanent approval, as before', async () => {
  const path = `${SETS}/${SET.id}`;
  const fake = graph({ objects: { [path]: { ...SET, description: 'Old' } } });
  const result = await run(fake, [resourceOf('attributeSet', SET, 'update', { ...SET, description: 'Old' })]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(fake.writes().map((call) => [call.method, call.path, call.body]), [['PATCH', path, { description: 'KEEL-RT-1015 fixture set' }]]);
});

test('a dry run of a permanent write writes nothing and plans the write for review', async () => {
  for (const resource of [setCreate(), attributeCreate(), syncOn()]) {
    const fake = graph({ objects: PARTNER_ENTRY });
    const result = await run(fake, [resource], { mode: 'dry-run' });
    assert.equal(fake.writes().length, 0, resource.resourceType);
    assert.equal(result.applied.length, 1, resource.resourceType);
  }
});

// ------------------------------------------------------- partner user sync

test('turning sync on is held until both "changes admin access" and "can\'t be undone" are approved', async () => {
  const [access, permanent] = approvalsFor([syncOn()]);
  for (const approved of [[], [access], [permanent]]) {
    const fake = graph({ objects: PARTNER_ENTRY });
    const result = await run(fake, [syncOn()], { approvedContentEffects: approved });
    assert.equal(fake.writes().length, 0, `approved: ${approved.map((effect) => effect.effect).join(', ') || 'nothing'}`);
    assert.match(result.skipped[0].reason, /approve "Can't be undone" and "Changes admin access"|approve "Can't be undone"|approve "Changes admin access"/);
  }
  const fake = graph({ objects: PARTNER_ENTRY });
  const result = await run(fake, [syncOn()], { approvedContentEffects: [access, permanent] });
  assert.deepEqual(result.failed, []);
  assert.deepEqual(fake.writes().map((call) => [call.method, call.path, call.body]), [
    ['PUT', SYNC, { displayName: 'KEEL-RT-1015 partner', userSyncInbound: { isSyncAllowed: true } }],
  ]);
  assert.deepEqual(fake.store.get(SYNC).userSyncInbound, { isSyncAllowed: true });
});

test('turning sync off, or keeping it, needs only the restore approval and PUTs the name and userSyncInbound only', async () => {
  const off = graph({ objects: { ...PARTNER_ENTRY, [SYNC]: syncOf(true) } });
  const stopped = await run(off, [resourceOf('crossTenantIdentitySyncPolicyPartner', syncOf(false), 'update', syncOf(true))]);
  assert.deepEqual(stopped.failed, []);
  assert.deepEqual(off.writes().map((call) => [call.method, call.path, call.body]), [
    ['PUT', SYNC, { displayName: 'KEEL-RT-1015 partner', userSyncInbound: { isSyncAllowed: false } }],
  ]);

  const kept = graph({ objects: { ...PARTNER_ENTRY, [SYNC]: syncOf(true, 'Old name') } });
  const renamed = await run(kept, [resourceOf('crossTenantIdentitySyncPolicyPartner', syncOf(true), 'update', syncOf(true, 'Old name'))]);
  assert.deepEqual(renamed.failed, []);
  assert.equal(kept.writes().length, 1);
  assert.deepEqual(Object.keys(kept.writes()[0].body).sort(), ['displayName', 'userSyncInbound']);
});

test('sync settings are written only for a partner the target has; a failed read writes nothing', async () => {
  const approvedContentEffects = approvalsFor([syncOn()]);
  const absent = graph();
  const missing = await run(absent, [syncOn()], { approvedContentEffects });
  assert.equal(absent.writes().length, 0);
  assert.match(missing.failed[0].error, /no cross-tenant access settings in the target/);
  assert.doesNotMatch(missing.failed[0].error, new RegExp(PARTNER));

  const unreadable = graph({ objects: PARTNER_ENTRY, failReads: { [`${PARTNERS}/${PARTNER}`]: { ok: false, status: 403, body: { error: { code: 'Authorization_RequestDenied' } } } } });
  const failed = await run(unreadable, [syncOn()], { approvedContentEffects });
  assert.equal(unreadable.writes().length, 0);
  assert.match(failed.failed[0].error, /could not be read/);
});

test('delete is not registered for any of the three, and create and update are', () => {
  for (const type of ['attributeSet', 'customSecurityAttributeDefinition', 'crossTenantIdentitySyncPolicyPartner']) {
    for (const operation of OPERATIONS) {
      const supported = isSupportedClaim(capabilityFor(type, operation).claim);
      assert.equal(supported, operation === 'create' || operation === 'update', `${type} ${operation}`);
    }
  }
});
