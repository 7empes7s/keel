// engine/govern/approvalPolicy.mjs
//
// Wave 2 RBAC: approval policies on top of approvals.mjs.
//
// 1. The two-person rule. A tenant can require two distinct approvers, neither of them
//    the requester, for each of these kinds of action:
//      content-restore-other-location  content restored somewhere other than where it came from
//      bulk-restore                     a restore of BULK_RESTORE_THRESHOLD or more objects
//      delete                           a restore or job that deletes objects
//      retention-shortening             content kept for less time than before
//      legal-hold-release               content released from a legal hold
//    The rule is OFF for every kind until someone turns it on (approval_policy rows,
//    schema.d/31-approval-policy.sql): today there is one human approver.
//
// 2. Standing policies. A named, pre-authorized basis for one approver's decision. The
//    only one is the operator's standing test-tenant approval: it covers restores on the
//    test tenant and nothing else. A decision made under it records the policy name on the
//    request and in the evidence, next to the request id (the approval id the operator
//    logs). It is still one approval: it never satisfies a two-person rule on its own and
//    never allows self-approval.
import { appendEvidence } from './evidence.mjs';
import { tenantRefFor } from '../store/tenantRef.mjs';

export const APPROVAL_POLICY_ACTIONS = Object.freeze([
  'content-restore-other-location', 'bulk-restore', 'delete', 'retention-shortening', 'legal-hold-release',
]);
export const APPROVAL_POLICY_EVIDENCE_KIND = 'approval-policy';
// A restore touching this many objects (closure plus member/owner edges) is a bulk restore.
export const BULK_RESTORE_THRESHOLD = 25;

// The test tenant. The same list as tools/qualification/entraLive.mjs#TEST_TENANT_REFS
// (a test keeps them equal); kept here so approvals does not load the qualification tools.
export const TEST_TENANT_REFS = Object.freeze(['sha256:f7b3959300856957']);

export const OPERATOR_TEST_TENANT_POLICY = 'operator-test-tenant';
export const STANDING_POLICIES = Object.freeze({
  [OPERATOR_TEST_TENANT_POLICY]: Object.freeze({
    description: 'keel-operator may approve restores on the test tenant (standing authorization, 2026-10-14)',
    actions: Object.freeze(['restore', 'content-restore']),
  }),
});

export class ApprovalPolicyError extends Error {}

function assertPolicyAction(actionClass) {
  if (!APPROVAL_POLICY_ACTIONS.includes(actionClass)) {
    throw new ApprovalPolicyError(`unknown approval policy action: ${actionClass} (one of ${APPROVAL_POLICY_ACTIONS.join(', ')})`);
  }
}

const CONTENT_EFFECT_CLASSES = Object.freeze({
  'retention-reducing': 'retention-shortening',
  'hold-releasing': 'legal-hold-release',
});

function hasDelete(value, depth = 0) {
  if (depth > 6 || value == null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((item) => hasDelete(item, depth + 1));
  if (value.verb === 'delete' || value.operation === 'delete') return true;
  return Object.values(value).some((item) => hasDelete(item, depth + 1));
}

/**
 * Which policy actions a request is. `declared` is what the caller says (a content
 * restore to another mailbox, a prune that deletes); for a restore, what its dry-run
 * artifact records adds to it: its size, any delete it plans, and its content effects.
 * Never narrows what the caller declared.
 */
export function classifyApprovalActions({ action, artifact = null, declared = [] }) {
  for (const actionClass of declared) assertPolicyAction(actionClass);
  const classes = new Set(declared);
  if (action === 'restore' && artifact) {
    const size = (artifact.closureKeys?.length ?? 0) + (artifact.relationshipOperations?.length ?? 0);
    if (size >= BULK_RESTORE_THRESHOLD) classes.add('bulk-restore');
    // A member/owner edge removal is a delete too (security audit run 2, finding 7).
    if (hasDelete([artifact.waves, artifact.reconciliationResources, artifact.compensation, artifact.relationshipOperations])
      || (artifact.relationshipOperations ?? []).some((op) => op?.action === 'remove')) {
      classes.add('delete');
    }
    for (const effect of artifact.contentEffects ?? []) {
      const actionClass = CONTENT_EFFECT_CLASSES[effect?.effect];
      if (actionClass) classes.add(actionClass);
    }
  }
  return APPROVAL_POLICY_ACTIONS.filter((actionClass) => classes.has(actionClass));
}

/** The tenant's policy for every action: { [action]: { twoPerson, updatedBy, updatedAt } }. Off unless set. */
export async function getApprovalPolicies(client, { tenantRef }) {
  const { rows } = await client.query(
    `SELECT action_class, two_person, updated_by, updated_at FROM approval_policy WHERE tenant_ref = $1`,
    [tenantRef],
  );
  const byAction = new Map(rows.map((row) => [row.action_class, row]));
  return Object.fromEntries(APPROVAL_POLICY_ACTIONS.map((actionClass) => {
    const row = byAction.get(actionClass);
    return [actionClass, { twoPerson: row?.two_person ?? false, updatedBy: row?.updated_by ?? null, updatedAt: row?.updated_at ?? null }];
  }));
}

/**
 * Turn the two-person rule on or off for one action. The caller checks the actor holds
 * `policies`. Every change is written to the evidence chain.
 */
export async function setApprovalPolicy(client, { tenantRef, actionClass, twoPerson, actor }) {
  assertPolicyAction(actionClass);
  if (typeof twoPerson !== 'boolean') throw new ApprovalPolicyError('twoPerson must be true or false');
  if (typeof actor !== 'string' || actor.length === 0) throw new ApprovalPolicyError('a policy change needs an actor');
  const { rows: [row] } = await client.query(
    `INSERT INTO approval_policy (tenant_ref, action_class, two_person, updated_by, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (tenant_ref, action_class)
       DO UPDATE SET two_person = EXCLUDED.two_person, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING *`,
    [tenantRef, actionClass, twoPerson, actor],
  );
  await appendEvidence(client, {
    tenantRef,
    kind: APPROVAL_POLICY_EVIDENCE_KIND,
    subject: { actionClass, twoPerson },
    actor,
  });
  return row;
}

/** How many distinct approvers these actions need under the tenant's current policy: 1 or 2. */
export async function requiredApprovalsFor(client, { tenantRef, classes }) {
  if (!classes?.length) return 1;
  const { rows } = await client.query(
    `SELECT 1 FROM approval_policy WHERE tenant_ref = $1 AND action_class = ANY($2::text[]) AND two_person LIMIT 1`,
    [tenantRef, classes],
  );
  return rows.length ? 2 : 1;
}

/**
 * Why a standing policy does not cover this request, or null when it does. The test
 * tenant is every tenant the action touches: the request's own tenant and, for a
 * restore, its dry run's source and target tenants.
 */
export function standingPolicyRefusal({ policy, tenantRef, request, artifact = null, testTenantRefs = TEST_TENANT_REFS }) {
  const standing = STANDING_POLICIES[policy];
  if (!standing) return `unknown standing policy: ${policy}`;
  if (!standing.actions.includes(request.action)) return `${policy} does not cover ${request.action}`;
  const touched = [tenantRef];
  if (request.action === 'restore') {
    if (!artifact) return `${policy} needs the restore's dry run to see which tenant it writes to`;
    touched.push(artifact.tenantRef);
    if (typeof artifact.targetTenantId !== 'string' || artifact.targetTenantId.length === 0) return `${policy} needs a target tenant`;
    touched.push(tenantRefFor(artifact.targetTenantId));
  }
  if (touched.some((ref) => !testTenantRefs.includes(ref))) return `${policy} covers only the test tenant`;
  // Issue #317: a workload restore made with the tenant-wide option writes beyond the
  // KEEL-RT- fixtures; a person approves it, never a standing policy.
  if (artifact?.workloadRestore?.allowTenantWide === true) return `${policy} does not cover a tenant-wide workload write; a person approves it`;
  // The same for an Entra or Intune tenant setting: a snapshot dry run made with the
  // tenant-wide option (keel-restore --allow-tenant-wide-test-writes).
  if (artifact?.allowTenantWide === true) return `${policy} does not cover a tenant-wide setting write; a person approves it`;
  return null;
}
