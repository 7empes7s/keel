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
  'drift-detect': 'collect',
  backup: 'backup',
  'baseline-create': 'baseline-create',
  'baseline-activate': 'baseline-create',
  'policy-evaluate': 'policies',
  remediate: 'remediate',
  restore: 'restore',
  // Channels and subscriptions are configuration; a delivery retains the principal
  // that dispatched its event, so the same configuration grant is checked again when
  // the notify job executes.
  notify: 'configuration',
});

export function capabilityForJobKind(kind) {
  return JOB_KIND_CAPABILITIES[kind] ?? null;
}
