import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { resolvePrincipals } from '../govern/references.mjs';
import { schemaSql } from '../store/loadSchema.mjs';
import { ANONYMITY_EVIDENCE_KIND, anonymityNamer, pseudonym, readAnonymity, setAnonymity } from './anonymity.mjs';
import { displayAccount, displayActor, displayPerson, personKey } from './people.mjs';

const CODE_NAME = /^Person [A-HJ-NP-Z2-9]{4}$/;

test('a code name is stable for one salt and person, and differs between people and salts', () => {
  const first = pseudonym('salt-a', 'amara.okafor@contoso.example');
  assert.match(first, CODE_NAME);
  assert.equal(pseudonym('salt-a', 'amara.okafor@contoso.example'), first);
  // Case and spaces around the key do not matter: an email is one person however typed.
  assert.equal(pseudonym('salt-a', '  Amara.Okafor@Contoso.example '), first);
  assert.notEqual(pseudonym('salt-a', 'lee.chen@contoso.example'), first);
  assert.notEqual(pseudonym('salt-b', 'amara.okafor@contoso.example'), first);
  // Across many people, code names rarely collide.
  const names = new Set(Array.from({ length: 200 }, (_, index) => pseudonym('salt-a', `person-${index}@contoso.example`)));
  assert.ok(names.size >= 195, `only ${names.size} distinct code names for 200 people`);
});

test('displayPerson code-names people only, drops their email and keeps their id', () => {
  const namer = anonymityNamer({ enabled: true, salt: 'salt-a' });
  const amara = { kind: 'person', id: '8c1e0000-0000-4000-8000-0000000000a1', name: 'Amara Okafor', email: 'amara.okafor@contoso.example', readable: true, system: false };
  const shown = displayPerson(amara, namer);
  assert.deepEqual(shown, { ...amara, name: pseudonym('salt-a', 'amara.okafor@contoso.example'), email: null, pseudonym: true });
  // The same person recorded by email only (an older audit entry) gets the same code name.
  const byEmail = displayPerson({ kind: 'person', id: 'Amara.Okafor@contoso.example', name: 'Amara.Okafor@contoso.example', email: 'Amara.Okafor@contoso.example', readable: true, system: false }, namer);
  assert.equal(byEmail.name, shown.name);
  assert.equal(byEmail.id, shown.name, 'an id that is an email address is not kept');
  // Technical details: a stored email gives way to the code name; an account id stays.
  assert.equal(displayAccount('Amara.Okafor@contoso.example', byEmail), shown.name);
  assert.equal(displayAccount(amara.id, shown), amara.id);
  assert.equal(displayAccount('amara.okafor@contoso.example', amara), 'amara.okafor@contoso.example');
  assert.equal(personKey(amara), 'amara.okafor@contoso.example');
  // Keel's own accounts, accounts that no longer exist, and the setting off: unchanged.
  const scheduler = { kind: 'person', id: 'scheduler', name: 'scheduler', email: null, readable: true, system: true };
  assert.equal(displayPerson(scheduler, namer), scheduler);
  const gone = { kind: 'person', id: amara.id, name: null, email: null, readable: false, system: false };
  assert.equal(displayPerson(gone, namer), gone);
  assert.equal(displayPerson(amara, null), amara);
  assert.equal(anonymityNamer({ enabled: false, salt: 'salt-a' }), null);
  // Audit-log actors: users are code-named by their Microsoft id, apps keep their names.
  const user = { kind: 'user', id: '1A2B0000-0000-4000-8000-000000000001', name: 'Lee Chen' };
  assert.deepEqual(displayActor(user, namer), { ...user, name: pseudonym('salt-a', user.id.toLowerCase()), pseudonym: true });
  const app = { kind: 'servicePrincipal', id: 'app-1', name: 'Contoso sync' };
  assert.equal(displayActor(app, namer), app);
});

async function withDb(run) {
  const db = await createIsolatedTestDatabase(import.meta.url);
  const client = await db.connect();
  try {
    await client.query(schemaSql());
    await run(client);
  } finally {
    await client.end();
    await db.cleanup();
  }
}

test('turning the setting on code-names people everywhere names resolve, writes the audit record, and keeps code names across off and on', async () => {
  await withDb(async (client) => {
    const { rows: [admin] } = await client.query("INSERT INTO principal(email, display_name) VALUES ('admin@test.example', 'Ada Admin') RETURNING id::text AS id");
    const { rows: [lee] } = await client.query("INSERT INTO principal(email, display_name) VALUES ('lee@test.example', 'Lee Chen') RETURNING id::text AS id");
    assert.deepEqual(await readAnonymity(client), { enabled: false, salt: null, changedAt: null, changedBy: null });

    // Off: real names, as before.
    let people = await resolvePrincipals(client, [lee.id, 'scheduler']);
    assert.equal(people.get(lee.id).name, 'Lee Chen');
    // Turning off what is already off changes nothing and records nothing.
    assert.equal((await setAnonymity(client, { tenantRef: 'tenant-a', enabled: false, actor: admin.id })).changed, false);
    assert.equal((await client.query('SELECT count(*)::int AS n FROM evidence')).rows[0].n, 0);

    const on = await setAnonymity(client, { tenantRef: 'tenant-a', enabled: true, actor: admin.id });
    assert.equal(on.changed, true);
    assert.equal(on.state.enabled, true);
    assert.equal(on.state.changedBy, admin.id);
    people = await resolvePrincipals(client, [lee.id, 'scheduler']);
    const code = people.get(lee.id).name;
    assert.match(code, CODE_NAME);
    assert.equal(people.get(lee.id).email, null);
    assert.equal(people.get(lee.id).pseudonym, true);
    assert.equal(people.get('scheduler').name, 'scheduler', "Keel's own accounts keep their names");

    await setAnonymity(client, { tenantRef: 'tenant-a', enabled: false, actor: admin.id });
    assert.equal((await resolvePrincipals(client, [lee.id])).get(lee.id).name, 'Lee Chen');
    await setAnonymity(client, { tenantRef: 'tenant-a', enabled: true, actor: admin.id });
    assert.equal((await resolvePrincipals(client, [lee.id])).get(lee.id).name, code, 'the same person keeps the same code name');

    const { rows } = await client.query('SELECT kind, actor, subject FROM evidence ORDER BY seq');
    assert.deepEqual(rows.map((row) => [row.kind, row.actor, row.subject.enabled, row.subject.previous]), [
      [ANONYMITY_EVIDENCE_KIND, admin.id, true, false],
      [ANONYMITY_EVIDENCE_KIND, admin.id, false, true],
      [ANONYMITY_EVIDENCE_KIND, admin.id, true, false],
    ]);
    await assert.rejects(setAnonymity(client, { tenantRef: 'tenant-a', enabled: 'yes', actor: admin.id }), TypeError);
  });
});
