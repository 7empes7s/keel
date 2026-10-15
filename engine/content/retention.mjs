/**
 * Wave 2 RET: which stored content item versions a prune removes, and why.
 *
 * Each item (tenant, workload, container, item key) rotates its own versions under the
 * most specific policy covering it (engine/store/rotation.mjs). The newest version of
 * an item is always kept, so an item's last known content never goes; an item with
 * one version is never a candidate. A legal hold on the tenant, workload, container or
 * item keeps every version in its scope. A chunk goes only when no kept item, of any
 * tenant, still lists it (engine/content/index.mjs orphanedChunks).
 */
import { createPgContentIndex } from './index.mjs';
import { matchingHolds, reasonKind, resolvePolicy, rotationReasons } from '../store/rotation.mjs';

export async function planContentRetention(client, { tenantRef, now, policies = [], holds = [] }) {
  const at = new Date(now);
  // Only items with more than one version can lose any; newest first within an item.
  const { rows } = await client.query(
    `SELECT i.id, i.workload, i.container, i.item_key, i.version, i.created_at
     FROM content_item i
     WHERE i.tenant_ref = $1
       AND EXISTS (SELECT 1 FROM content_item j
                   WHERE j.tenant_ref = i.tenant_ref AND j.workload = i.workload AND j.container = i.container
                     AND j.item_key = i.item_key AND j.id <> i.id)
     ORDER BY i.workload, i.container, i.item_key, i.created_at DESC, i.id DESC`,
    [tenantRef],
  );
  const { rows: [{ n: singleVersionItems }] } = await client.query(
    `SELECT count(*)::int AS n FROM (
       SELECT 1 FROM content_item WHERE tenant_ref = $1 GROUP BY workload, container, item_key HAVING count(*) = 1
     ) AS single`,
    [tenantRef],
  );

  const groups = [];
  for (const row of rows) {
    const last = groups.at(-1);
    if (last && last[0].workload === row.workload && last[0].container === row.container && last[0].item_key === row.item_key) last.push(row);
    else groups.push([row]);
  }

  const deletions = [];
  const kept = {};
  let keptVersions = 0;
  for (const versions of groups) {
    const scope = { workload: versions[0].workload, container: versions[0].container, itemKey: versions[0].item_key };
    const { policy, label } = resolvePolicy(policies, scope);
    const holdReasons = matchingHolds(holds, scope).map((hold) => `legal hold: ${hold.reason}`);
    const rotation = rotationReasons(versions.map((v) => ({ id: v.id, at: new Date(v.created_at) })), policy, at);
    versions.forEach((v, index) => {
      const reasons = [...(index === 0 ? ['latest version'] : []), ...holdReasons, ...rotation.get(v.id)];
      if (reasons.length) {
        keptVersions += 1;
        const kind = reasonKind(reasons[0]);
        kept[kind] = (kept[kind] ?? 0) + 1;
        return;
      }
      deletions.push({
        id: v.id, workload: v.workload, container: v.container, itemKey: v.item_key, version: v.version,
        createdAt: new Date(v.created_at).toISOString(), reason: `outside policy (${label})`,
      });
    });
  }

  const ids = deletions.map(({ id }) => id);
  const chunks = ids.length ? await createPgContentIndex(client).orphanedChunks(ids) : [];
  return {
    delete: ids,
    deletions,
    keptVersions,
    kept,
    singleVersionItems,
    chunks,
    freedBytes: chunks.reduce((sum, chunk) => sum + chunk.storedBytes, 0),
  };
}
