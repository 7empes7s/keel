// A known break in the audit record (31 Oct 2026): the old accept path wrote its record
// without the tenant lock and without moving the stored head (fixed in PR #876), so the
// next record chained onto the stale head. Old records are never edited. Instead one
// explanation record, appended through the normal writer, names the broken stretch; the
// check then passes it as a known break, while any other break still fails.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  CHAIN_BREAK_EXPLAINED, appendEvidence, explainChainBreaks, refreshChainCache, verifyChain,
} from './evidence.mjs';
import { getEvidenceIntegrity } from '../../status/queries.mjs';
import { canonicalize } from '../cir/canonicalHash.mjs';
import { createIsolatedTestDatabase } from '../test/dbTestHelper.mjs';
import { schemaSql } from '../store/loadSchema.mjs';

const database = await createIsolatedTestDatabase(import.meta.url);
let client;

function hashOf({ prevHash, tenantRef, occurredAt, kind, subject, actor }) {
  return createHash('sha256')
    .update(`${prevHash ?? ''}${tenantRef}${occurredAt.toISOString()}${kind}${JSON.stringify(canonicalize(subject, 'group'))}${actor}`)
    .digest('hex');
}

// The accept path as it was before PR #876: chain onto the last row, leave the head alone.
async function legacyAccept(tenantRef, n) {
  const { rows: [lastRow] } = await client.query(
    'SELECT record_hash FROM evidence WHERE tenant_ref = $1 ORDER BY seq DESC LIMIT 1', [tenantRef],
  );
  const occurredAt = new Date();
  const subject = { driftId: `d${n}`, naturalKey: `group:g${n}` };
  const prevHash = lastRow?.record_hash ?? null;
  const recordHash = hashOf({ prevHash, tenantRef, occurredAt, kind: 'disposition', subject, actor: 'tester' });
  const { rows: [row] } = await client.query(
    `INSERT INTO evidence (tenant_ref, occurred_at, kind, subject, actor, prev_hash, record_hash)
     VALUES ($1,$2,'disposition',$3,'tester',$4,$5) RETURNING seq::text`,
    [tenantRef, occurredAt, subject, prevHash, recordHash],
  );
  return row.seq;
}

const append = (tenantRef, kind, n) => appendEvidence(client, { tenantRef, kind, subject: { n }, actor: 'tester', eventSink: () => {} })
  .then((record) => String(record.seq));

async function brokenTenant(tenantRef) {
  for (let n = 0; n < 3; n += 1) await append(tenantRef, 'action-attempt', n);
  const breaks = [];
  // One accept, then a normal record: the normal record chains onto the stale head.
  await legacyAccept(tenantRef, 1);
  breaks.push(await append(tenantRef, 'action-attempt', 10));
  // Two accepts in a row, then two normal records: only the first normal one breaks.
  await legacyAccept(tenantRef, 2);
  await legacyAccept(tenantRef, 3);
  breaks.push(await append(tenantRef, 'action-attempt', 11));
  await append(tenantRef, 'benchmark-evaluation', 12);
  await legacyAccept(tenantRef, 4);
  breaks.push(await append(tenantRef, 'disposition', 13));
  return breaks;
}

try {
  client = await database.connect();
  await client.query(schemaSql());

  {
    const tenantRef = 'sha256:known-break';
    const breaks = await brokenTenant(tenantRef);
    const from = breaks[0];
    const through = breaks.at(-1);
    assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: false, brokenAtSeq: from }, 'the bug broke the chain');

    // Nothing is written without --confirm, and nothing for a stretch that misses a break.
    const plan = await explainChainBreaks(client, { tenantRef, fromSeq: from, throughSeq: through, cause: 'accept bypassed the head', fixRef: 'PR #876', actor: 'tester' });
    assert.equal(plan.ok, true);
    assert.equal(plan.written, false);
    assert.equal(plan.breaks, 3);
    assert.equal(plan.headCountShortBy, '4', 'the four bypassing records were never counted');
    const narrow = await explainChainBreaks(client, { tenantRef, fromSeq: from, throughSeq: breaks[1], cause: 'x', fixRef: 'y', actor: 'tester', write: true });
    assert.equal(narrow.refused, 'break-outside-range');
    assert.deepEqual(narrow.outside, [through]);
    const { rows: [{ n: none }] } = await client.query('SELECT count(*)::int AS n FROM evidence WHERE kind = $1', [CHAIN_BREAK_EXPLAINED]);
    assert.equal(none, 0, 'a refusal or a dry run writes nothing');

    const written = await explainChainBreaks(client, { tenantRef, fromSeq: from, throughSeq: through, cause: 'accept bypassed the head', fixRef: 'PR #876', actor: 'tester', write: true });
    assert.equal(written.written, true);
    const result = await verifyChain(client, { tenantRef });
    assert.equal(result.ok, true, 'the explained break passes');
    assert.equal(result.knownBreaks.length, 1);
    assert.deepEqual(
      { ...result.knownBreaks[0], explainedAt: undefined, firstBreakAt: undefined, lastBreakAt: undefined },
      { explainedBySeq: written.explainedBySeq, explainedAt: undefined, fromSeq: from, throughSeq: through, breakCount: 3, cause: 'accept bypassed the head', fixRef: 'PR #876', firstBreakAt: undefined, lastBreakAt: undefined },
    );
    assert.equal((await explainChainBreaks(client, { tenantRef, fromSeq: from, throughSeq: through, cause: 'x', fixRef: 'y', actor: 'tester', write: true })).refused, 'already-explained');

    // Later records keep passing, through the full walk, the cached walk and the Overview's query.
    await append(tenantRef, 'action-attempt', 20);
    assert.equal((await verifyChain(client, { tenantRef })).knownBreaks.length, 1);
    const cache = new Map();
    const cold = await refreshChainCache(client, { tenantRef, cache, now: 1 });
    assert.equal(cold.ok, true);
    assert.equal(cold.knownBreaks.length, 1);
    await append(tenantRef, 'action-attempt', 21);
    const warm = await refreshChainCache(client, { tenantRef, cache, now: 2 });
    assert.equal(warm.ok, true);
    assert.equal(warm.knownBreaks.length, 1, 'the cached prefix carries the known break');
    const overview = await getEvidenceIntegrity(client, { tenantRef, chainCache: cache });
    assert.equal(overview.ok, true);
    assert.equal(overview.knownBreaks.length, 1);

    // A new break after the stretch still fails, cached or not.
    await legacyAccept(tenantRef, 5);
    const fresh = await append(tenantRef, 'action-attempt', 22);
    assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: false, brokenAtSeq: fresh });
    assert.deepEqual(await refreshChainCache(client, { tenantRef, cache, now: 3 }), { ok: false, brokenAtSeq: fresh });
  }

  {
    // An edit inside the stretch is not a known break: the edited record fails, whether
    // or not it is one of the listed breaks.
    for (const which of ['listed', 'unlisted']) {
      const tenantRef = `sha256:known-break-edit-${which}`;
      const breaks = await brokenTenant(tenantRef);
      await explainChainBreaks(client, { tenantRef, fromSeq: breaks[0], throughSeq: breaks.at(-1), cause: 'c', fixRef: 'f', actor: 'tester', write: true });
      assert.equal((await verifyChain(client, { tenantRef })).ok, true);
      const target = which === 'listed' ? breaks[1] : String(BigInt(breaks[1]) + 1n);
      await client.query(`UPDATE evidence SET subject = '{"n":999}' WHERE seq = $1`, [target]);
      assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: false, brokenAtSeq: target }, `an edited ${which} record fails`);
    }
  }

  {
    // The accepts the bug wrote are orphans: nothing chains onto them. The explanation
    // pins every record in the stretch, so editing and re-hashing one, or deleting one
    // and lowering the head's count to match, still fails.
    for (const how of ['edit', 'delete']) {
      const tenantRef = `sha256:known-break-orphan-${how}`;
      const breaks = await brokenTenant(tenantRef);
      await explainChainBreaks(client, { tenantRef, fromSeq: breaks[0], throughSeq: breaks.at(-1), cause: 'c', fixRef: 'f', actor: 'tester', write: true });
      const orphan = String(BigInt(breaks[1]) - 1n);
      const { rows: [row] } = await client.query('SELECT occurred_at, kind, prev_hash FROM evidence WHERE seq = $1', [orphan]);
      assert.equal(row.kind, 'disposition', 'the record before a break is an accept');
      if (how === 'edit') {
        const subject = { driftId: 'someone-else' };
        await client.query('UPDATE evidence SET subject = $2, actor = $3, record_hash = $4 WHERE seq = $1', [
          orphan, subject, 'intruder', hashOf({ prevHash: row.prev_hash, tenantRef, occurredAt: row.occurred_at, kind: row.kind, subject, actor: 'intruder' }),
        ]);
      } else {
        await client.query('DELETE FROM evidence WHERE seq = $1', [orphan]);
        await client.query('UPDATE evidence_head SET record_count = record_count - 1 WHERE tenant_ref = $1', [tenantRef]);
      }
      const result = await verifyChain(client, { tenantRef });
      assert.equal(result.ok, false, `an ${how}ed orphan accept fails`);
      assert.equal(result.reason, 'explained-stretch-changed');
      assert.equal((await refreshChainCache(client, { tenantRef, cache: new Map(), now: 1 })).ok, false);
    }
  }

  {
    // A listed break whose record points at no earlier record in the stretch is not the
    // bug's shape: it still fails. (A forged row stands in for a hand-made gap.)
    const tenantRef = 'sha256:known-break-forged';
    const breaks = await brokenTenant(tenantRef);
    await explainChainBreaks(client, { tenantRef, fromSeq: breaks[0], throughSeq: breaks.at(-1), cause: 'c', fixRef: 'f', actor: 'tester', write: true });
    const { rows: [row] } = await client.query('SELECT occurred_at, kind, subject, actor FROM evidence WHERE seq = $1', [breaks[1]]);
    const prevHash = 'f'.repeat(64);
    await client.query('UPDATE evidence SET prev_hash = $2, record_hash = $3 WHERE seq = $1', [
      breaks[1], prevHash, hashOf({ prevHash, tenantRef, occurredAt: row.occurred_at, kind: row.kind, subject: row.subject, actor: row.actor }),
    ]);
    assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: false, brokenAtSeq: breaks[1] });
  }

  {
    // The explanation would chain onto a stale head while the last record bypassed it:
    // refuse rather than add a break of its own. And a whole chain needs no explanation.
    const tenantRef = 'sha256:known-break-stale-head';
    const breaks = await brokenTenant(tenantRef);
    await legacyAccept(tenantRef, 9);
    const refused = await explainChainBreaks(client, { tenantRef, fromSeq: breaks[0], throughSeq: breaks.at(-1), cause: 'c', fixRef: 'f', actor: 'tester', write: true });
    assert.equal(refused.refused, 'head-not-on-last-record');
    const whole = 'sha256:known-break-whole';
    await append(whole, 'action-attempt', 1);
    assert.equal((await explainChainBreaks(client, { tenantRef: whole, fromSeq: '1', throughSeq: '9', cause: 'c', fixRef: 'f', actor: 'tester', write: true })).refused, 'no-breaks');
  }

  {
    // A hand-written explanation with a malformed stretch is ignored: the break stays red.
    const tenantRef = 'sha256:known-break-malformed';
    const breaks = await brokenTenant(tenantRef);
    await appendEvidence(client, {
      tenantRef, kind: CHAIN_BREAK_EXPLAINED, actor: 'tester', eventSink: () => {},
      subject: { fromSeq: breaks[0], throughSeq: breaks.at(-1), earliestPrevSeq: breaks[0], breakSeqs: breaks, headCountShortBy: '4' },
    });
    assert.deepEqual(await verifyChain(client, { tenantRef }), { ok: false, brokenAtSeq: breaks[0] });
  }

  console.log('evidence-known-break.test.mjs: OK');
} finally {
  await client?.end();
  await database.cleanup();
}
