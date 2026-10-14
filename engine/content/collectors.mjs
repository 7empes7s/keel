/**
 * The content collector registry: every collector `keel-content-collect run` runs, in
 * run order (Wave 1 CONT). MAIL, DRIVE, SITES, TEAMS and PLANNER each add one import
 * and one entry, each in file-name order, so entries added in parallel land on
 * different lines.
 *
 * An entry is { workload, collect }:
 * - workload is one of CONTENT_WORKLOADS in ./store.mjs.
 * - collect(client, { tenantRef, store, transport, scope, sleep, now, logger }) backs up
 *   one workload and returns { outcome: 'succeeded' | 'partial' | 'failed', items, bytes,
 *   reasons }. `store` is the content store (putItem, getItem, listItems), `transport`
 *   the read-only content transport (./transport.mjs), `scope` the content scope file.
 *   A collector keeps its own delta state; it never writes to the tenant.
 */
export const CONTENT_COLLECTORS = Object.freeze([
]);
