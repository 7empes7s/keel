import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { NAME_FIELDS, OWN_NAME_FIELDS, RELATIONSHIP_KINDS, nameFieldsFor, objectName, objectNameSql } from './objectName.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { FIXTURE_PAYLOADS } from '../../tools/qualification/operations.mjs';
import { nameFieldsFor as captureNameFieldsFor } from '../../tools/qualification/entraLive.mjs';
import { buildLiveGatePlan } from '../../tools/qualification/live-gate-plan.mjs';

// Kinds whose objects carry no name of their own, each with the reason. They are
// named from what they point to (portal/lib/app-names.ts), never by a name field.
const NAMELESS = Object.freeze({
  servicePrincipal: 'Graph copies an enterprise app\'s name from its app registration; the write body carries only the appId',
});

const DEFAULT_CAPTURE_FIELDS = captureNameFieldsFor('a kind with no own name field');
const namedKinds = () => [...new Set(buildLiveGatePlan().steps
  .filter((step) => step.fixtureKind === 'named-object' && !step.resourceType.includes('#'))
  .map((step) => step.resourceType))].sort();

test('every named kind is listed by a name its objects have', () => {
  const kinds = namedKinds();
  assert.ok(kinds.includes('intuneBrandingProfile'));
  for (const resourceType of kinds) {
    const payload = FIXTURE_PAYLOADS[resourceType];
    assert.ok(payload, `${resourceType}: no fixture write body to check its name against`);
    if (NAMELESS[resourceType]) {
      assert.equal(objectName(payload, resourceType), null, `${resourceType}: its objects now have a name; drop it from NAMELESS`);
      continue;
    }
    assert.ok(objectName(payload, resourceType),
      `${resourceType}: none of ${nameFieldsFor(resourceType).join(', ')} is in its objects; add its name field to OWN_NAME_FIELDS in engine/cir/objectName.mjs`);
  }
});

test('a kind the capture tool names by its own field is listed by that field too (#478)', () => {
  const own = Object.keys(FIXTURE_PAYLOADS).filter((type) => captureNameFieldsFor(type) !== DEFAULT_CAPTURE_FIELDS);
  assert.ok(own.includes('intuneBrandingProfile'));
  for (const resourceType of own) {
    // The object's own name fields hold the marker; displayName holds something else.
    const marked = Object.fromEntries(captureNameFieldsFor(resourceType).map((field) => [field, `KEEL-RT-${field}`]));
    const name = objectName({ ...FIXTURE_PAYLOADS[resourceType], displayName: 'Contoso IT', ...marked }, resourceType);
    for (const value of Object.values(marked)) {
      assert.ok(name?.includes(value), `${resourceType}: listed as "${name}", not by ${value}; add its name field to OWN_NAME_FIELDS in engine/cir/objectName.mjs`);
    }
  }
});

test('a branding profile is listed by its profile name, never the organization name it shows', () => {
  const profile = { profileName: 'Sales devices', displayName: 'Contoso IT' };
  assert.equal(objectName(profile, 'intuneBrandingProfile'), 'Sales devices');
  assert.equal(objectName({ displayName: 'Contoso IT' }, 'intuneBrandingProfile'), null);
  assert.equal(objectName(profile, 'group'), 'Contoso IT');
});

test('an imported ADMX file is listed by its file name', () => {
  assert.equal(objectName({ fileName: 'chrome.admx', displayName: null }, 'groupPolicyUploadedDefinitionFile'), 'chrome.admx');
});

test('an app relationship is listed by both apps, in the direction it points', () => {
  const dependency = { '@odata.type': '#microsoft.graph.mobileAppDependency', sourceDisplayName: 'Company app', targetDisplayName: '.NET runtime', targetType: 'child' };
  assert.equal(objectName(dependency, 'mobileAppRelationship'), 'Company app needs .NET runtime');
  assert.equal(objectName({ ...dependency, targetType: 'parent' }, 'mobileAppRelationship'), '.NET runtime needs Company app');
  const supersedence = { '@odata.type': '#microsoft.graph.mobileAppSupersedence', sourceDisplayName: 'Reader 2', targetDisplayName: 'Reader 1', targetType: 'child' };
  assert.equal(objectName(supersedence, 'mobileAppRelationship'), 'Reader 2 replaces Reader 1');
  assert.equal(objectName({ sourceDisplayName: 'Company app' }, 'mobileAppRelationship'), 'Company app needs an app with no name');
  assert.equal(objectName({ displayName: 'x' }, 'mobileAppRelationship'), null);
});

test('values that are not names are skipped', () => {
  assert.equal(objectName({ displayName: '  ', name: 'Second' }, 'group'), 'Second');
  assert.equal(objectName({ displayName: 'id-1', name: 'Second' }, 'group', { skip: (value) => value.startsWith('id-') }), 'Second');
  assert.equal(objectName(null, 'group'), null);
  assert.equal(objectName(['x'], 'group'), null);
});

const database = await createIsolatedTestDatabase(import.meta.url);
after(() => database.cleanup());

test('the SQL name is the same as the JavaScript name for every kind', async () => {
  const relationship = FIXTURE_PAYLOADS.mobileAppRelationship;
  const cases = [
    ...Object.entries(FIXTURE_PAYLOADS).map(([type, payload]) => [type, payload]),
    ['intuneBrandingProfile', { displayName: 'Contoso IT' }],
    ['group', { displayName: ' ', name: ' Second ', title: 'Third' }],
    ['user', { userPrincipalName: 'a@example.com' }],
    ['message', { subject: 'Hello' }],
    ['mobileAppRelationship', { ...relationship, targetType: 'parent' }],
    ['mobileAppRelationship', { ...relationship, '@odata.type': '#microsoft.graph.mobileAppSupersedence' }],
    ['mobileAppRelationship', { sourceDisplayName: 'Only source' }],
    ['mobileAppRelationship', {}],
    ...Object.keys(OWN_NAME_FIELDS).map((type) => [type, {}]),
    ...RELATIONSHIP_KINDS.map((type) => [type, { displayName: 'not its name' }]),
  ];
  const client = await database.connect();
  try {
    const { rows } = await client.query(
      `SELECT ${objectNameSql('c.payload', 'c.resource_type')} AS name
         FROM unnest($1::text[], $2::jsonb[]) WITH ORDINALITY AS c(resource_type, payload, n) ORDER BY c.n`,
      [cases.map(([type]) => type), cases.map(([, payload]) => JSON.stringify(payload))],
    );
    assert.equal(rows.length, cases.length);
    cases.forEach(([type, payload], index) => {
      assert.equal(rows[index].name, objectName(payload, type), `${type}: ${JSON.stringify(payload).slice(0, 120)}`);
    });
  } finally {
    await client.end();
  }
});

test('the default fields are the ones most kinds are named by', () => {
  assert.deepEqual(nameFieldsFor('group'), [...NAME_FIELDS]);
  assert.deepEqual(nameFieldsFor('intuneBrandingProfile'), ['profileName']);
});
