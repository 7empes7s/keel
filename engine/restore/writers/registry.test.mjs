import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

import { registerOperationCapability } from '../../coverage/capabilities.mjs';
import { applyWave } from '../applyEngine.mjs';
import { ThrottleGovernor } from '../throttleGovernor.mjs';
import { WRITER_FRAGMENTS, registerWriter, registeredWriterTypes, writerFor } from './registry.mjs';

const DIR = new URL('./', import.meta.url);
const governor = new ThrottleGovernor({ 'target/entra/write': { capacity: 100, refillPerSecond: 100 } });
const deletionGuardOptions = { breakGlassUserIds: ['break-glass-user-id'], keelAppIds: [], caPolicies: [] };
const graphWriter = {
  write: async () => { throw new Error('a registered writer type must not reach the built-in Graph path'); },
  read: async () => { throw new Error('a registered writer type must not reach the built-in Graph path'); },
};

// A fixture type only this test registers: a capability (a writer alone never makes a type writable) and a writer.
const TYPE = 'keelRtFixtureWriterType';
for (const operation of ['create', 'update', 'delete']) {
  registerOperationCapability({ resourceType: TYPE, operation, path: '/keelRtFixture', handler: 'engine/restore/writers/registry.test.mjs#apply', idOutcome: 'preserved' });
}
const calls = [];
registerWriter({
  resourceType: TYPE,
  handler: 'engine/restore/writers/registry.test.mjs#apply',
  apply: async (writer, resource, verb, ctx) => {
    calls.push({ writer, naturalKey: resource.naturalKey, verb, mode: ctx.mode, targetId: ctx.targetId, ctx });
    if (resource.payload?.silent) return {};
    return { applied: { naturalKey: resource.naturalKey, targetId: ctx.targetId ?? 'new-id' } };
  },
});

function resource(overrides = {}) {
  return { naturalKey: `${TYPE}:KEEL-RT-one`, resourceType: TYPE, verb: 'create', blastRadius: 'access-affecting', payload: { displayName: 'KEEL-RT-one' }, references: [], ...overrides };
}

const run = (wave, options = {}) => applyWave(graphWriter, governor, wave, { targetTenant: 'target', mode: 'enforce', deletionGuardOptions, ...options });

test('every writers/ fragment is imported by registry.mjs', () => {
  const source = readFileSync(new URL('./registry.mjs', import.meta.url), 'utf8');
  const imported = [...source.matchAll(/from '\.\/([^']+)'/g)].map((match) => match[1]).sort();
  const files = readdirSync(DIR).filter((name) => name.endsWith('.mjs') && name !== 'registry.mjs' && !name.endsWith('.test.mjs')).sort();
  assert.deepEqual(imported, files);
  assert.deepEqual(Object.keys(WRITER_FRAGMENTS).sort(), files.map((name) => name.replace(/\.mjs$/, '')));
  assert.deepEqual(registeredWriterTypes(), [...Object.values(WRITER_FRAGMENTS).flat().map((entry) => entry.resourceType), TYPE].sort());
});

test('applyWave calls the registered writer for its type with the shared context', async () => {
  calls.length = 0;
  const result = await run([resource(), resource({ naturalKey: `${TYPE}:KEEL-RT-two`, verb: 'update', targetId: 't-2' })]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.applied, [
    { naturalKey: `${TYPE}:KEEL-RT-one`, targetId: 'new-id' },
    { naturalKey: `${TYPE}:KEEL-RT-two`, targetId: 't-2' },
  ]);
  assert.deepEqual(calls.map(({ verb, mode, targetId }) => ({ verb, mode, targetId })), [
    { verb: 'create', mode: 'enforce', targetId: null },
    { verb: 'update', mode: 'enforce', targetId: 't-2' },
  ]);
  assert.equal(calls[0].writer, graphWriter);
  for (const name of ['retryOperation', 'journalBeforeMutation', 'noteOutcome', 'rewriteReferences']) {
    assert.equal(typeof calls[0].ctx[name], 'function', name);
  }
  assert.deepEqual(await calls[0].ctx.journalBeforeMutation({ operation: 'create', priorState: null, intendedState: {} }), { ok: true, entryId: null });
});

test('the shared gates still run before a registered writer', async () => {
  calls.length = 0;
  const unregistered = await run([resource({ verb: 'restore-soft-deleted' })]);
  assert.match(unregistered.failed[0].error, /unsupported operation/);
  const breakGlass = await run([resource({ verb: 'delete', targetId: 'break-glass-user-id' })]);
  assert.match(breakGlass.skipped[0].reason, /break-glass/);
  const lockout = await run([resource({ verb: 'delete', targetId: 't-3', blastRadius: 'tenant-lockout' })]);
  assert.match(lockout.skipped[0].reason, /tenant-lockout/);
  const synced = await run([resource({ verb: 'update', targetId: 't-4', payload: { onPremisesSyncEnabled: true } })]);
  assert.equal(synced.skipped.length, 1);
  assert.equal(calls.length, 0);
});

test('a writer that reports nothing fails the resource', async () => {
  const result = await run([resource({ payload: { silent: true } })]);
  assert.match(result.failed[0].error, /reported no outcome/);
});

test('a registered writer never replaces a built-in one', async () => {
  registerWriter({ resourceType: 'group', handler: 'engine/restore/writers/registry.test.mjs#group', apply: async () => assert.fail('called') });
  const result = await run([{ naturalKey: 'group:KEEL-RT-g', resourceType: 'group', verb: 'create', payload: { displayName: 'KEEL-RT-g' }, references: [] }]);
  assert.match(result.failed[0].error, /built-in writer/);
});

test('registerWriter refuses a malformed or repeated entry', () => {
  assert.throws(() => registerWriter({ resourceType: TYPE, handler: 'engine/x.mjs#y', apply: () => {} }), /already registered/);
  assert.throws(() => registerWriter({ resourceType: 'other', handler: 'nowhere', apply: () => {} }), /handler reference/);
  assert.throws(() => registerWriter({ resourceType: 'other', handler: 'engine/x.mjs#y' }), /apply function/);
  assert.equal(writerFor('other'), null);
});
