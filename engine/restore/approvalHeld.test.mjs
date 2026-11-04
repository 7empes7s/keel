/**
 * Kinds held back for a privilege review, now written behind the restore approval
 * (restore/approvalHeld.mjs). These checks hold for every such kind, so one added
 * later is held to them too.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { SERVICES, typeInfo } from '../insights/taxonomy.mjs';
import { APPROVAL_HELD_FIELDS, CONTENT_EFFECTS, CONTENT_EFFECT_RULES, classifyContentEffects } from '../safety/contentEffects.mjs';
import { APPROVAL_HELD_KINDS, approvalHeldRefusal, unapprovedAccessEffects } from './approvalHeld.mjs';
import { IDENTITY_RECORDS } from './identityObjectOperations.mjs';
import { INTUNE_EXTENDED_RECORDS } from './intuneOperations.mjs';
import { writerFor } from './writers/registry.mjs';

const RECORDS = { ...IDENTITY_RECORDS, ...INTUNE_EXTENDED_RECORDS };

// One payload per kind that differs from its live state in every access field.
// A role keeps a permission either way, so its own refusal lets it reach the gate.
const value = (field, side) => {
  if (field === 'rolePermissions') return [{ resourceActions: [{ allowedResourceActions: [`Microsoft.Intune_${side}_Read`] }] }];
  // Batch 2: an Intune assignment names its role, and an Exchange one its principal by path.
  if (field === 'roleDefinition') return { id: `role-${side}` };
  if (field === 'principalId') return `/Users/${side === 'before' ? 'b' : 'a'}0000000-0000-0000-0000-000000000000`;
  return { kept: side };
};
const before = (field) => ({ [field]: value(field, 'before') });
const after = (field) => ({ [field]: value(field, 'after') });
// An update drifts the fields an update sends; one set only on create (an Intune
// assignment's role, an approval policy's kind) is the same on both sides.
const updatedFields = (resourceType) => APPROVAL_HELD_FIELDS[resourceType].filter((field) => !RECORDS[resourceType].createOnly.includes(field));
const changed = (resourceType) => {
  const same = APPROVAL_HELD_FIELDS[resourceType].filter((field) => !updatedFields(resourceType).includes(field));
  return {
    naturalKey: `${resourceType}:fixture`, resourceType, references: [],
    payload: Object.assign({ isBuiltIn: false }, ...same.map(after), ...updatedFields(resourceType).map(after)),
    live: { state: 'present', payload: Object.assign({ isBuiltIn: false }, ...same.map(after), ...updatedFields(resourceType).map(before)) },
  };
};

test('approval-held kinds: the kinds of batches 1 and 2, each in a service the restore approval setting knows', () => {
  assert.deepEqual([...APPROVAL_HELD_KINDS].sort(), [
    'defenderRoleAssignment', 'deviceManagementRoleAssignment', 'deviceManagementRoleDefinition', 'deviceRegistrationPolicy',
    'exchangeRoleAssignment', 'operationApprovalPolicy', 'tenantAppManagementPolicy',
  ]);
  assert.ok(CONTENT_EFFECTS.includes('access-changing'));
  for (const kind of APPROVAL_HELD_KINDS) assert.ok(SERVICES.includes(typeInfo(kind).service), kind);
});

test('approval-held kinds: each has a reviewed rule per access field, all "access-changing", and a writer that sends those fields', () => {
  for (const kind of APPROVAL_HELD_KINDS) {
    const review = CONTENT_EFFECT_RULES[kind];
    assert.equal(review?.reviewed, true, kind);
    assert.deepEqual(review.rules.map((rule) => rule.field), [...APPROVAL_HELD_FIELDS[kind]], kind);
    assert.ok(review.rules.every((rule) => rule.effect === 'access-changing'), kind);
    const record = RECORDS[kind];
    assert.ok(record, `${kind} has a record`);
    // A field set only when the object is made (an Intune assignment's role) is sent on create.
    for (const field of APPROVAL_HELD_FIELDS[kind]) assert.ok(record.writable.includes(field) || record.createOnly.includes(field), `${kind} writes ${field}`);
    for (const verb of record.operations) assert.ok(writerFor(kind, verb), `${kind} ${verb} has a registered writer`);
    // A delete is only the undo of an object this restore created.
    if (record.operations.includes('delete')) {
      assert.match(record.refusal({ ...changed(kind), payload: null }, 'delete', { mode: 'enforce' })?.reason ?? '', /deletes only an? .* it created itself/, kind);
      assert.equal(record.refusal({ ...changed(kind), undoes: 'create', compensates: ['entry-1'] }, 'delete', { mode: 'enforce' }), null);
    }
  }
});

test('approval-held kinds: every writer refuses an enforce write whose access effects were not approved', () => {
  for (const kind of APPROVAL_HELD_KINDS) {
    const resource = changed(kind);
    const effects = classifyContentEffects([{ ...resource, verb: 'update' }]).effects;
    assert.deepEqual(effects.map((effect) => effect.field), [...updatedFields(kind)].sort(), kind);
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
  // An update with no live object read is never written: nothing shows what it changes.
  for (const live of [undefined, { state: 'absent' }]) {
    assert.equal(approvalHeldRefusal({ ...resource, live }, 'update', { mode: 'enforce', approvedContentEffects: effects })?.outcome, 'failed');
  }
});

test('approval-held kinds: a write that changes no access field needs no approval', () => {
  const resource = {
    naturalKey: 'deviceManagementRoleDefinition:fixture', resourceType: 'deviceManagementRoleDefinition', references: [],
    payload: { isBuiltIn: false, description: 'New', rolePermissions: [{ resourceActions: [{ allowedResourceActions: ['a'] }] }] },
    live: { state: 'present', payload: { isBuiltIn: false, description: 'Old', rolePermissions: [{ resourceActions: [{ allowedResourceActions: ['a'] }] }] } },
  };
  assert.equal(approvalHeldRefusal(resource, 'update', { mode: 'enforce' }), null);
});
