// Q48: the organization's directorySizeQuota counter moves with every create or
// delete in the tenant. It must never read as a change, including against a
// snapshot whose stored hash was computed before the field was classified.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { canonicalHash } from '../cir/canonicalHash.mjs';
import { decideVerb } from '../reconcile/verb.mjs';
import { restoreCandidates } from './dryRunArtifact.mjs';

const organization = (used, displayName = 'Contoso') => ({
  id: '11111111-2222-4333-8444-555555555555',
  displayName,
  directorySizeQuota: { used, total: 300000 },
  technicalNotificationMails: ['admin@contoso.com'],
});

test('a moved directory quota counter is not a change to the organization', () => {
  assert.equal(canonicalHash(organization(1093), 'organization'), canonicalHash(organization(1095), 'organization'));
  // A real configuration change still is.
  assert.notEqual(canonicalHash(organization(1093), 'organization'), canonicalHash(organization(1093, 'Fabrikam'), 'organization'));
});

test('a snapshot stored with the old hash plans a noop against a live organization whose counter moved', () => {
  const stored = organization(1095);
  // The hash the snapshot was stored with, before the counter was server-owned.
  const staleHash = 'f'.repeat(64);
  const [candidate] = restoreCandidates([{
    id: 'v1', natural_key: 'organization:Contoso', resource_type: 'organization', payload: stored,
    payload_hash: staleHash, blast_radius: 'tenant',
  }], []);
  assert.equal(candidate.payloadHash, canonicalHash(stored, 'organization'));
  const decision = decideVerb({
    desired: { payloadHash: candidate.payloadHash },
    live: { payloadHash: canonicalHash(organization(1093), 'organization') },
    softDeleted: false,
  });
  assert.equal(decision.verb, 'noop');
});
