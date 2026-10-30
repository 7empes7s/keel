/**
 * Kinds held back for a privilege review, now written behind the restore approval
 * (restore/approvalHeld.mjs). These checks hold for every such kind, so one added
 * later is held to them too.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { typeInfo } from '../insights/taxonomy.mjs';
import { APPROVAL_HELD_FIELDS, CONTENT_EFFECTS, CONTENT_EFFECT_RULES, classifyContentEffects } from '../safety/contentEffects.mjs';
import { APPROVAL_HELD_KINDS, approvalHeldRefusal, unapprovedAccessEffects } from './approvalHeld.mjs';
import { IDENTITY_RECORDS } from './identityObjectOperations.mjs';
import { INTUNE_EXTENDED_RECORDS } from './intuneOperations.mjs';
import { writerFor } from './writers/registry.mjs';

const RECORDS = { ...IDENTITY_RECORDS, ...INTUNE_EXTENDED_RECORDS };

// One payload per kind that differs from its live state in every access field.
// A role keeps a permission either way, so its own refusal lets it reach the gate.
const value = (field, side) => (field === 'rolePermissions'
  ? [{ resourceActions: [{ allowedResourceActions: [`Microsoft.Intune_${side}_Read`] }] }]
  : { kept: side });
const before = (field) => ({ [field]: value(field, 'before') });
const after = (field) => ({ [field]: value(field, 'after') });
const changed = (resourceType) => {
  const fields = APPROVAL_HELD_FIELDS[resourceType];
  return {
    naturalKey: `${resourceType}:fixture`, resourceType, references: [],
    payload: Object.assign({ isBuiltIn: false }, ...fields.map(after)),
    live: { state: 'present', payload: Object.assign({ isBuiltIn: false }, ...fields.map(before)) },
  };
};

test('approval-held kinds: the three kinds of the first batch, each in a service the restore approval setting knows', () => {
  assert.deepEqual([...APPROVAL_HELD_KINDS].sort(), ['deviceManagementRoleDefinition', 'deviceRegistrationPolicy', 'tenantAppManagementPolicy']);
  assert.ok(CONTENT_EFFECTS.includes('access-changing'));
  for (const kind of APPROVAL_HELD_KINDS) assert.ok(['Entra', 'Intune'].includes(typeInfo(kind).service), kind);
});

test('approval-held kinds: each has a reviewed rule per access field, all "access-changing", and a writer that sends those fields', () => {
  for (const kind of APPROVAL_HELD_KINDS) {
    const review = CONTENT_EFFECT_RULES[kind];
    assert.equal(review?.reviewed, true, kind);
    assert.deepEqual(review.rules.map((rule) => rule.field), [...APPROVAL_HELD_FIELDS[kind]], kind);
    assert.ok(review.rules.every((rule) => rule.effect === 'access-changing'), kind);
    const record = RECORDS[kind];
    assert.ok(record, `${kind} has a record`);
    for (const field of APPROVAL_HELD_FIELDS[kind]) assert.ok(record.writable.includes(field), `${kind} writes ${field}`);
    for (const verb of record.operations) assert.ok(writerFor(kind, verb), `${kind} ${verb} has a registered writer`);
    assert.ok(!record.operations.includes('delete'), `${kind} is never deleted by a restore`);
  }
});

test('approval-held kinds: every writer refuses an enforce write whose access effects were not approved', () => {
  for (const kind of APPROVAL_HELD_KINDS) {
    const resource = changed(kind);
    const effects = classifyContentEffects([{ ...resource, verb: 'update' }]).effects;
    assert.deepEqual(effects.map((effect) => effect.field), [...APPROVAL_HELD_FIELDS[kind]].sort(), kind);
    // The record's own refusal runs the gate (built-in and trust checks come first).
    const refused = RECORDS[kind].refusal(resource, 'update', { mode: 'enforce' });
    assert.equal(refused?.outcome, 'skipped', kind);
    assert.match(refused.reason, /changes admin access/, kind);
    // Approving all but one effect still refuses, naming the one left.
    const partial = RECORDS[kind].refusal(resource, 'update', { mode: 'enforce', approvedContentEffects: effects.slice(1) });
    assert.deepEqual(partial?.completion?.[0]?.fields, [effects[0].field], kind);
    // Exactly the approved effects let it through; a dry run is never refused.
    assert.equal(RECORDS[kind].refusal(resource, 'update', { mode: 'enforce', approvedContentEffects: effects }), null, kind);
    assert.equal(RECORDS[kind].refusal(resource, 'update', { mode: 'dry-run' }), null, kind);
  }
});

test('approval-held kinds: an approval binds the object, field and both values', () => {
  const resource = changed('deviceRegistrationPolicy');
  const effects = classifyContentEffects([{ ...resource, verb: 'update' }]).effects;
  const tamper = (patch) => effects.map((effect, index) => (index === 0 ? { ...effect, ...patch } : effect));
  for (const patch of [{ naturalKey: 'other' }, { field: 'other' }, { before: 'other' }, { after: 'other' }, { effect: 'irreversible' }, { resourceType: 'other' }]) {
    assert.equal(unapprovedAccessEffects(resource, 'update', tamper(patch)).length, 1, JSON.stringify(patch));
  }
  assert.equal(unapprovedAccessEffects(resource, 'update', effects).length, 0);
  assert.equal(approvalHeldRefusal(resource, 'delete', { mode: 'enforce' }), null, 'a delete carries no access effect here');
});

test('approval-held kinds: a write that changes no access field needs no approval', () => {
  const resource = {
    naturalKey: 'deviceManagementRoleDefinition:fixture', resourceType: 'deviceManagementRoleDefinition', references: [],
    payload: { isBuiltIn: false, description: 'New', rolePermissions: [{ resourceActions: [{ allowedResourceActions: ['a'] }] }] },
    live: { state: 'present', payload: { isBuiltIn: false, description: 'Old', rolePermissions: [{ resourceActions: [{ allowedResourceActions: ['a'] }] }] } },
  };
  assert.equal(approvalHeldRefusal(resource, 'update', { mode: 'enforce' }), null);
});
