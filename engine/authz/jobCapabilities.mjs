// engine/authz/jobCapabilities.mjs
//
// The mapping from job kind to the capability that kind requires (plan task 25). This
// module is the single source of truth, shared by portal/lib/action.ts (checked at
// enqueue) and cli/keel-worker.mjs (checked again at execution) — a second copy that
// can drift is the same defect wearing a different hat. Deny by default: a kind not
// listed here has no capability mapping and must fail rather than default to allowed.
//
// prune and drift-detect map to 'collect': they are the engine's routine maintenance
// operations, run by the same operator role that runs collection, and the §3.2 role ->
// capability matrix (permissions.mjs) defines no narrower capability for them.
// baseline-activate requires 'baseline-create', matching the portal route that has
// guarded activation behind that capability since task 13.
export const JOB_KIND_CAPABILITIES = Object.freeze({
  collect: 'collect',
  prune: 'collect',
  offsite: 'configuration',
  'drift-detect': 'collect',
  // Task 62: read-only, anonymous metadata comparison run on the same operator
  // cadence as collection; it writes review candidates, never tenant state.
  'api-drift': 'collect',
  // Gap W1: read-only workload settings collection (SharePoint, Teams, Exchange,
  // OneDrive, Purview). It writes workload snapshots to the database, never tenant state.
  'workload-collect': 'collect',
  // Wave 1 CONT: read-only content backup as the content-reader identity. It writes
  // encrypted chunks and the item index, never tenant state. The operator role also
  // holds the narrower content-backup (Wave 2 RBAC), but the job stays on 'collect':
  // the scheduler identity that runs it nightly holds collect and configuration only.
  'content-collect': 'collect',
  // Wave 1 DISC: read-only tenant discovery. A GET-only Graph transport counts what the
  // tenant holds; it writes one discovery run to the database, never tenant state.
  discover: 'collect',
  backup: 'backup',
  'baseline-create': 'baseline-create',
  'baseline-activate': 'baseline-create',
  'policy-evaluate': 'policies',
  remediate: 'remediate',
  // Audit run 2, finding 3: an accept or ignore a second person approved (sign-in and
  // admin-access changes). Only an approval mints it; the requester still needs
  // dispose-accept when it runs.
  dispose: 'dispose-accept',
  restore: 'restore',
  // Channels and subscriptions are configuration; a delivery retains the principal
  // that dispatched its event, so the same configuration grant is checked again when
  // the notify job executes.
  notify: 'configuration',
});

export function capabilityForJobKind(kind) {
  return JOB_KIND_CAPABILITIES[kind] ?? null;
}
