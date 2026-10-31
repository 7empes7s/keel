// engine/govern/approvalMode.mjs
//
// Approval mode: one setting per tenant that says who may approve a change.
//
//   two-person  a second person approves; the requester never approves their own
//               request. The default, and how Keel worked before the setting existed.
//   solo        the requester may approve their own request. For a business with one
//               admin, so Keel is usable without a second account for the same person.
//               Every such decision is recorded as self-approved, on the decision and
//               in the audit record.
//
// The mode applies the same way at every decision point: restore and undo requests,
// content restores, accepting or ignoring a change, content-effect approvals, emergency
// changes and using an older approved setup again (all approval requests go through
// approvals.mjs#approveRequest). It never lifts anything else: a two-person rule set for
// an action (approvalPolicy.mjs) still needs two people other than the requester, a
// standing policy never self-approves, and every technical safety check stays.
//
// The gates that run an approved change later re-read the mode: a self-approved
// decision stops counting once the mode is two-person again, so switching back is
// never undone by approvals made before it.
import { appendEvidence } from './evidence.mjs';

export const APPROVAL_MODES = Object.freeze(['two-person', 'solo']);
export const DEFAULT_APPROVAL_MODE = 'two-person';
export const APPROVAL_MODE_EVIDENCE_KIND = 'approval-mode';

export class ApprovalModeError extends Error {}

/** The tenant's approval mode: { mode, updatedBy, updatedAt }. Two-person unless set. */
export async function getApprovalMode(client, { tenantRef }) {
  if (typeof tenantRef !== 'string' || tenantRef.length === 0) {
    return { mode: DEFAULT_APPROVAL_MODE, updatedBy: null, updatedAt: null };
  }
  const { rows: [row] } = await client.query(
    'SELECT mode, updated_by, updated_at FROM approval_mode WHERE tenant_ref = $1',
    [tenantRef],
  );
  return {
    mode: APPROVAL_MODES.includes(row?.mode) ? row.mode : DEFAULT_APPROVAL_MODE,
    updatedBy: row?.updated_by ?? null,
    updatedAt: row?.updated_at ?? null,
  };
}

/** Whether the requester may approve their own request on this tenant now. */
export async function selfApprovalAllowed(client, { tenantRef }) {
  return (await getApprovalMode(client, { tenantRef })).mode === 'solo';
}

/**
 * Set the approval mode. The caller checks the actor holds `policies`. Switching to
 * solo needs the risk warning confirmed (`riskAcknowledged`), and the audit record says
 * it was. The audit record is written first, so a change is never made without one.
 * Returns { changed, setting }.
 */
export async function setApprovalMode(client, { tenantRef, mode, actor, riskAcknowledged = false }) {
  if (!APPROVAL_MODES.includes(mode)) {
    throw new ApprovalModeError(`unknown approval mode: ${mode} (one of ${APPROVAL_MODES.join(', ')})`);
  }
  if (typeof tenantRef !== 'string' || tenantRef.length === 0) throw new ApprovalModeError('an approval mode needs a tenant');
  if (typeof actor !== 'string' || actor.length === 0) throw new ApprovalModeError('a setting change needs an actor');
  if (mode === 'solo' && riskAcknowledged !== true) {
    throw new ApprovalModeError('switching to solo approval needs the risk warning confirmed');
  }
  const before = await getApprovalMode(client, { tenantRef });
  if (before.mode === mode && before.updatedAt) return { changed: false, setting: before };
  await appendEvidence(client, {
    tenantRef,
    kind: APPROVAL_MODE_EVIDENCE_KIND,
    subject: { mode, previous: before.mode, ...(mode === 'solo' ? { riskAcknowledged: true } : {}) },
    actor,
  });
  await client.query(
    `INSERT INTO approval_mode (tenant_ref, mode, updated_by, updated_at) VALUES ($1,$2,$3, now())
     ON CONFLICT (tenant_ref) DO UPDATE SET mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantRef, mode, actor],
  );
  return { changed: before.mode !== mode, setting: await getApprovalMode(client, { tenantRef }) };
}
