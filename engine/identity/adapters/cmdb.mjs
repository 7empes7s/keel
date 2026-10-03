/**
 * Task 89: the CMDB lookup contract and a configurable, synthetic fixture adapter.
 *
 * KEEL does not assume access to any employer CMDB. A real provider implements
 * the same contract and must be independently qualified before use:
 *
 *   adapter.tenantRef                 the managed tenant the adapter is bound to
 *   adapter.lookup({ resourceType, sourceId, signal })
 *     -> { status: 'found', recordRef, owners: [string], shared?: boolean, validUntil?: ISO }
 *     -> { status: 'not-found' }
 *     throws (any error, timeout or abort)  -> the caller records 'unresolved'
 *
 * Lookups are keyed by (resource type, source id) only. A display name or natural
 * key is never a lookup key: a recreated object that reuses a name is a different
 * resource and must not inherit the old record.
 */

const RECORD_REF = /^[A-Za-z0-9_:.\-]{1,128}$/;

function normalizedSourceId(sourceId) {
  return typeof sourceId === 'string' && sourceId.length > 0 ? sourceId.toLowerCase() : null;
}

/**
 * records: [{ resourceType, sourceId, recordRef, owners: [cmdb owner value], shared?, validUntil? }]
 * failures: [{ resourceType, sourceId }] — lookups that throw, to model an outage
 * for one resource; `unavailable: true` makes every lookup throw.
 * Records may be replaced with setRecords() to model a resource moving between
 * entities. The fixture is network-free and marked synthetic.
 */
export function createFixtureCmdbAdapter({ tenantRef, records = [], failures = [], unavailable = false }) {
  let byKey = new Map();
  const index = (list) => {
    byKey = new Map();
    for (const record of list) {
      if (!RECORD_REF.test(record.recordRef ?? '')) throw new Error('invalid CMDB record reference');
      byKey.set(`${record.resourceType}\u0000${normalizedSourceId(record.sourceId)}`, record);
    }
  };
  index(records);
  const failing = new Set(failures.map((f) => `${f.resourceType}\u0000${normalizedSourceId(f.sourceId)}`));
  return {
    tenantRef,
    synthetic: true,
    setRecords(list) { index(list); },
    async lookup({ resourceType, sourceId, signal } = {}) {
      if (signal?.aborted) throw new Error('CMDB lookup aborted');
      const key = `${resourceType}\u0000${normalizedSourceId(sourceId)}`;
      if (unavailable || failing.has(key)) throw Object.assign(new Error('CMDB unavailable'), { status: 503 });
      const record = byKey.get(key);
      if (!record) return { status: 'not-found' };
      return {
        status: 'found',
        recordRef: record.recordRef,
        owners: [...(record.owners ?? [])],
        shared: record.shared === true,
        validUntil: record.validUntil ?? null,
      };
    },
  };
}

export { RECORD_REF };
