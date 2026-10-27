/**
 * Restore gaps batch 19: what a recreated Intune app lost after batch 18, its
 * app categories and the dependencies and supersedence between apps. Each test
 * drives the production writer (and, for the id remapping, the production
 * applyWave path) against an in-memory Graph (engine/test/idoFakeGraph.mjs);
 * nothing here reads or writes a tenant. Fixture names use the KEEL-RT- prefix.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { applyIntuneExtendedWrite } from './intuneOperations.mjs';
import { applyWave } from './applyEngine.mjs';
import { canonicalizeAll } from '../cir/canonicalize.mjs';
import { canonicalHash } from '../cir/canonicalHash.mjs';
import { isServerOwnedReference } from '../graph/resolver.mjs';
import { remappingFor } from '../coverage/qualification.mjs';
import { CATALOG } from '../../tools/tenant-probe/catalog.mjs';
import { idoFakeGraph } from '../test/idoFakeGraph.mjs';

const FAST = { readAfterWriteOptions: { attempts: 1, delayMs: 0 } };
const APPS = '/deviceAppManagement/mobileApps';
const CATEGORIES = '/deviceAppManagement/mobileAppCategories';
const CATEGORY_URL = 'https://graph.microsoft.com/beta/deviceAppManagement/mobileAppCategories';
const governor = { async acquire() {}, observeRetryAfter() {} };

const context = (runProvenance = new Map()) => ({ targetIndex: new Map(), mappingTable: new Map(), runProvenance });
const appOf = (payload, extra = {}) => ({
  naturalKey: `mobileApp:${payload.displayName}`, resourceType: 'mobileApp', payload, references: [], blastRadius: 'access-affecting', ...extra,
});

const OWN = Object.freeze({ id: 'cat-own', displayName: 'KEEL-RT-cat' });
const BUSINESS = Object.freeze({ id: 'cat-business-source', displayName: 'Business' });
const webApp = (categories) => ({
  '@odata.type': '#microsoft.graph.webApp', id: 'src-web', displayName: 'KEEL-RT-app-web', publisher: 'KEEL',
  appUrl: 'https://example.com/', useManagedBrowser: false, ...(categories ? { categories } : {}),
});

// The target's categories. `/deviceAppManagement` is seeded so the fake lists
// the categories collection under it.
const targetCategories = (...list) => Object.fromEntries([
  ['/deviceAppManagement', {}],
  ...list.map((category) => [`${CATEGORIES}/${category.id}`, category]),
]);
const refCalls = (graph) => graph.calls.filter((call) => call.method !== 'GET' && call.path.includes('/categories'));

// ------------------------------------------------------------ backup

test('the backup reads each app\'s categories, by id and name only, sorted by name', () => {
  const entry = CATALOG.find((candidate) => candidate.type === 'mobileApp');
  assert.deepEqual(entry.itemReads, {
    as: 'categories', path: '/deviceAppManagement/mobileApps/{item}/categories?$select=id,displayName', sortBy: 'displayName', omitEmpty: true,
  });
});

test('categories compare by name: a recreated category with another id is no change, a different name is', () => {
  const backup = webApp([OWN, BUSINESS]);
  const sameNames = webApp([{ ...OWN, id: 'cat-own-new' }, { ...BUSINESS, id: 'cat-business-target' }]);
  assert.equal(canonicalHash(backup, 'mobileApp'), canonicalHash(sameNames, 'mobileApp'));
  assert.notEqual(canonicalHash(backup, 'mobileApp'), canonicalHash(webApp([OWN]), 'mobileApp'));
  // The id inside never blocks or reorders the app on its own: the restore finds the category itself.
  const [resource] = canonicalizeAll([
    ['mobileApp', [{ ...webApp([{ id: '33333333-3333-4333-8333-333333333333', displayName: 'KEEL-RT-cat' }]), id: '11111111-1111-4111-8111-111111111111' }]],
    ['mobileAppCategory', [{ id: '33333333-3333-4333-8333-333333333333', displayName: 'KEEL-RT-cat' }]],
  ]).filter((candidate) => candidate.resourceType === 'mobileApp');
  assert.equal(resource.references.length, 1);
  assert.equal(isServerOwnedReference(resource.references[0], 'mobileApp'), true);
});

// ------------------------------------------------------------ categories

test('a recreated app is put back in its categories: one this run recreated, and a built-in one found by name', async () => {
  const graph = idoFakeGraph({ seed: targetCategories({ id: 'cat-own-new', displayName: 'KEEL-RT-cat' }, { id: 'cat-business-target', displayName: 'Business' }) });
  const result = await applyIntuneExtendedWrite(graph, appOf(webApp([BUSINESS, OWN])), 'create', {
    ...FAST, referenceContext: context(new Map([['mobileAppCategory:cat-own', 'cat-own-new']])),
  });
  assert.equal(result.failed, undefined, result.failed?.error);
  const appId = result.applied.targetId;
  const post = graph.calls.find((call) => call.method === 'POST' && call.path === APPS);
  assert.equal('categories' in post.body, false, 'categories are never in the app body');
  assert.deepEqual(refCalls(graph).map(({ version, method, path, body }) => ({ version, method, path, body })), [
    { version: 'beta', method: 'POST', path: `${APPS}/${appId}/categories/$ref`, body: { '@odata.id': `${CATEGORY_URL}/cat-business-target` } },
    { version: 'beta', method: 'POST', path: `${APPS}/${appId}/categories/$ref`, body: { '@odata.id': `${CATEGORY_URL}/cat-own-new` } },
  ]);
  assert.deepEqual(result.applied.changes.categories, { added: 2, removed: 0 });
  assert.equal(result.applied.completion, undefined);
});

test('an existing app leaves a category it was added to since the backup, and a second restore changes nothing', async () => {
  const live = { ...webApp(), id: 'live-web' };
  const seed = {
    ...targetCategories(OWN, { id: 'cat-extra', displayName: 'KEEL-RT-cat-extra' }),
    [`${APPS}/live-web`]: live,
    [`${APPS}/live-web/categories/cat-extra`]: { id: 'cat-extra', displayName: 'KEEL-RT-cat-extra' },
    [`${APPS}/live-web/categories/cat-own`]: OWN,
  };
  const graph = idoFakeGraph({ seed });
  const resource = appOf(webApp([OWN]), { live: { state: 'present', targetId: 'live-web', payload: live } });
  const first = await applyIntuneExtendedWrite(graph, resource, 'update', { ...FAST, referenceContext: context() });
  assert.equal(first.failed, undefined, first.failed?.error);
  assert.deepEqual(refCalls(graph).map(({ method, path }) => `${method} ${path}`), [`DELETE ${APPS}/live-web/categories/cat-extra/$ref`]);
  assert.deepEqual(first.applied.changes.categories, { added: 0, removed: 1 });

  const { [`${APPS}/live-web/categories/cat-extra`]: _left, ...restored } = seed;
  const again = idoFakeGraph({ seed: restored });
  const second = await applyIntuneExtendedWrite(again, resource, 'update', { ...FAST, referenceContext: context() });
  assert.equal(second.failed, undefined, second.failed?.error);
  assert.deepEqual(refCalls(again), []);
  assert.equal(second.applied.changes.categories, 'already as in the backup');
});

test('a category that is not in Intune is a step for a person; the others are still written', async () => {
  const graph = idoFakeGraph({ seed: targetCategories({ id: 'cat-business-target', displayName: 'Business' }) });
  const result = await applyIntuneExtendedWrite(graph, appOf(webApp([BUSINESS, OWN])), 'create', { ...FAST, referenceContext: context() });
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(refCalls(graph).length, 1);
  assert.deepEqual(result.applied.changes.categories, { added: 1, removed: 0 });
  assert.equal(result.applied.completion.length, 1);
  const [step] = result.applied.completion;
  assert.equal(step.kind, 'integration');
  assert.equal(step.requirement, 'categories');
  assert.match(step.description, /the app category KEEL-RT-cat is not in Intune\. Restore or add it first, then add the app to it/);
});

test('two target categories with the backup\'s name are never guessed between', async () => {
  const graph = idoFakeGraph({ seed: targetCategories({ id: 'a', displayName: 'KEEL-RT-cat' }, { id: 'b', displayName: 'keel-rt-cat ' }) });
  const result = await applyIntuneExtendedWrite(graph, appOf(webApp([{ id: 'gone', displayName: 'KEEL-RT-cat' }])), 'create', { ...FAST, referenceContext: context() });
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(refCalls(graph), []);
  assert.equal(result.applied.completion[0].requirement, 'categories');
});

test('on update, a category the app is in is kept when two target categories share the backup\'s name', async () => {
  const live = { ...webApp(), id: 'live-web' };
  const graph = idoFakeGraph({ seed: {
    ...targetCategories({ id: 'a', displayName: 'Business' }, { id: 'b', displayName: 'Business' }, { id: 'old', displayName: 'KEEL-RT-old' }),
    [`${APPS}/live-web`]: live,
    [`${APPS}/live-web/categories/a`]: { id: 'a', displayName: 'Business' },
    [`${APPS}/live-web/categories/old`]: { id: 'old', displayName: 'KEEL-RT-old' },
  } });
  const result = await applyIntuneExtendedWrite(graph, appOf(webApp([BUSINESS]), { live: { state: 'present', targetId: 'live-web', payload: live } }), 'update', {
    ...FAST, referenceContext: context(),
  });
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(refCalls(graph).map(({ method, path }) => `${method} ${path}`), [`DELETE ${APPS}/live-web/categories/old/$ref`]);
  assert.equal(result.applied.completion[0].requirement, 'categories');
});

test('a category list of more than one page is never guessed from', async () => {
  const graph = idoFakeGraph({ seed: targetCategories(OWN) });
  const paged = { ...graph, read: async (version, path) => {
    const answer = await graph.read(version, path);
    return path.startsWith(`${CATEGORIES}?`) ? { ...answer, body: { ...answer.body, '@odata.nextLink': 'https://graph.microsoft.com/next' } } : answer;
  } };
  const result = await applyIntuneExtendedWrite(paged, appOf(webApp([OWN])), 'create', { ...FAST, referenceContext: context() });
  assert.match(result.failed.error, /the list has more than one page/);
  assert.deepEqual(refCalls(graph), []);
});

test('a backup taken before categories were read changes no category', async () => {
  const graph = idoFakeGraph({ seed: targetCategories(OWN) });
  const result = await applyIntuneExtendedWrite(graph, appOf(webApp()), 'create', { ...FAST, referenceContext: context() });
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.equal(graph.calls.some((call) => call.path.includes('ategories')), false);
  assert.equal(result.applied.changes.categories, undefined);
});

test('categories that cannot be read fail the app with what was done, and nothing is guessed', async () => {
  const graph = idoFakeGraph();
  const result = await applyIntuneExtendedWrite(graph, appOf(webApp([OWN])), 'create', { ...FAST, referenceContext: context() });
  assert.match(result.failed.error, /^the object was created, but the app categories could not be read \(status 404\), so the app's categories were not changed/);
  assert.deepEqual(refCalls(graph), []);
});

test('a synced app is never created, but on update it is put back in its categories', async () => {
  const vpp = { '@odata.type': '#microsoft.graph.iosVppApp', id: 'src-vpp', displayName: 'KEEL-RT-app-vpp', categories: [OWN] };
  const live = { ...vpp, id: 'live-vpp', categories: undefined };
  const graph = idoFakeGraph({ seed: { ...targetCategories(OWN), [`${APPS}/live-vpp`]: live } });
  const result = await applyIntuneExtendedWrite(graph, appOf(vpp, { live: { state: 'present', targetId: 'live-vpp', payload: live } }), 'update', {
    ...FAST, referenceContext: context(),
  });
  assert.equal(result.failed, undefined, result.failed?.error);
  assert.deepEqual(refCalls(graph).map(({ method, path }) => `${method} ${path}`), [`POST ${APPS}/live-vpp/categories/$ref`]);
});

// ------------------------------------------------------------ dependencies

const MAIN = '11111111-1111-4111-8111-111111111111';
const DEP = '22222222-2222-4222-8222-222222222222';
const link = Object.freeze({
  '@odata.type': '#microsoft.graph.mobileAppDependency', id: `${MAIN}_${DEP}`,
  sourceId: MAIN, sourceDisplayName: 'KEEL-RT-app-main', targetId: DEP, targetDisplayName: 'KEEL-RT-app-dep', targetType: 'child', dependencyType: 'autoInstall',
});
// The link as the backup holds it: both ends are references to the apps' natural keys.
const [linkResource] = canonicalizeAll([
  ['mobileApp', [
    { '@odata.type': '#microsoft.graph.webApp', id: MAIN, displayName: 'KEEL-RT-app-main' },
    { '@odata.type': '#microsoft.graph.webApp', id: DEP, displayName: 'KEEL-RT-app-dep' },
  ]],
  ['mobileAppRelationship', [link]],
]).filter((resource) => resource.resourceType === 'mobileAppRelationship');

const wave = (graph, resources, options = {}) => applyWave(graph, governor, resources, {
  targetTenant: 'fixture', mode: 'enforce', existingTargetIds: new Map(), readAfterWriteOptions: { attempts: 1, delayMs: 0 }, ...options,
});
const appsInTarget = (...ids) => Object.fromEntries(ids.map((id) => [`${APPS}/${id}`, { id, displayName: id }]));

test('the backup names both ends of a link as the apps themselves', () => {
  assert.deepEqual(linkResource.references.map(({ field, symbol }) => ({ field, symbol })), [
    { field: 'sourceId', symbol: 'mobileApp:KEEL-RT-app-main' },
    { field: 'targetId', symbol: 'mobileApp:KEEL-RT-app-dep' },
  ]);
  assert.equal(remappingFor('mobileAppRelationship', 'create').qualified, true);
  assert.equal(remappingFor('mobileAppRelationship', 'update').qualified, false, 'an update never moves a link');
});

test('a link between two apps this run recreated is created between their new ids', async () => {
  const graph = idoFakeGraph({ seed: appsInTarget('new-main', 'new-dep') });
  const appliedIds = new Map([['mobileApp:KEEL-RT-app-main', 'new-main'], ['mobileApp:KEEL-RT-app-dep', 'new-dep']]);
  const outcome = await wave(graph, [{ ...linkResource, verb: 'create' }], { appliedIds });
  assert.deepEqual(outcome.failed, []);
  assert.equal(outcome.applied.length, 1);
  const post = graph.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/deviceAppManagement/mobileAppRelationships');
  assert.deepEqual(post.body, {
    '@odata.type': '#microsoft.graph.mobileAppDependency', sourceId: 'new-main', targetId: 'new-dep', targetType: 'child', dependencyType: 'autoInstall',
  });
  // Both new apps were checked, and the new app's links listed, before the write.
  assert.deepEqual(graph.calls.filter((call) => call.method === 'GET').slice(0, 3).map((call) => call.path.split('?')[0]),
    [`${APPS}/new-main`, `${APPS}/new-dep`, `${APPS}/new-main/relationships`]);
});

test('a link to an app that kept its id is written as backed up, and one already set between the new apps is not added again', async () => {
  const kept = idoFakeGraph({ seed: appsInTarget(MAIN, 'new-dep') });
  const existing = new Map([['mobileApp:KEEL-RT-app-main', MAIN]]);
  const first = await wave(kept, [{ ...linkResource, verb: 'create' }], {
    existingTargetIds: existing, appliedIds: new Map([['mobileApp:KEEL-RT-app-dep', 'new-dep']]),
  });
  assert.deepEqual(first.failed, []);
  const post = kept.calls.find((call) => call.method === 'POST');
  assert.equal(post.body.sourceId, MAIN);
  assert.equal(post.body.targetId, 'new-dep');

  const set = idoFakeGraph({ seed: { ...appsInTarget('new-main', 'new-dep'), [`${APPS}/new-main/relationships/l1`]: { ...link, id: 'l1', sourceId: 'new-main', targetId: 'new-dep' } } });
  const again = await wave(set, [{ ...linkResource, verb: 'create' }], {
    appliedIds: new Map([['mobileApp:KEEL-RT-app-main', 'new-main'], ['mobileApp:KEEL-RT-app-dep', 'new-dep']]),
  });
  assert.deepEqual(again.failed, []);
  assert.match(again.skipped[0].reason, /already set: KEEL-RT-app-main already has a dependency link to KEEL-RT-app-dep/);
  assert.equal(set.calls.some((call) => call.method !== 'GET'), false);
});

test('a link to an app that is neither in the target nor recreated by this run is never written', async () => {
  const graph = idoFakeGraph({ seed: appsInTarget('new-main') });
  const outcome = await wave(graph, [{ ...linkResource, verb: 'create' }], { appliedIds: new Map([['mobileApp:KEEL-RT-app-main', 'new-main']]) });
  assert.equal(outcome.applied.length, 0);
  assert.equal(outcome.failed.length, 1);
  assert.match(outcome.failed[0].error, /targetId/);
  assert.equal(graph.calls.some((call) => call.method !== 'GET'), false);
});

test('an update of a link whose apps now have other ids is left to a person, not refused as a remapping', async () => {
  const graph = idoFakeGraph({ seed: { ...appsInTarget('new-main', 'new-dep'), '/deviceAppManagement/mobileAppRelationships/l1': { ...link, id: 'l1' } } });
  const outcome = await wave(graph, [{
    ...linkResource, verb: 'update', targetId: 'l1', live: { state: 'present', targetId: 'l1', payload: { ...link, id: 'l1', dependencyType: 'detect' } },
  }], { appliedIds: new Map([['mobileApp:KEEL-RT-app-main', 'new-main'], ['mobileApp:KEEL-RT-app-dep', 'new-dep']]) });
  assert.deepEqual(outcome.failed, []);
  assert.match(outcome.skipped[0].reason, /a link is never changed into another one/);
  assert.equal(graph.calls.some((call) => call.method !== 'GET'), false);
});
