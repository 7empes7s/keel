# Admin role restore: custom roles, PIM eligibility, PIM role settings (roadmap task-151)

## Status — 2026-10-09

Implemented and fixture-tested. **Nothing here is live-qualified.** The
production `applyWave()` writer and read-back ran against the in-memory fake
Graph (`engine/roadmap/admin-role-fidelity.test.mjs`). Live qualification follows
the operator gate in issue #148.

Microsoft's Graph reference was not reachable from the build container. Every
route, permission, rule id and field below is a declaration **to confirm against
the Graph v1.0 reference before live qualification**.

## What changed

### Three new catalogue types (57 in total)

| Type | Read | Why |
| --- | --- | --- |
| `unifiedRoleManagementPolicy` | `GET /policies/roleManagementPolicies?$filter=scopeId eq '/' and scopeType eq 'DirectoryRole'&$expand=rules` | PIM role settings (activation rules, approval, expiry) were never backed up. |
| `unifiedRoleManagementPolicyAssignment` | `GET /policies/roleManagementPolicyAssignments?$filter=scopeId eq '/' and scopeType eq 'DirectoryRole'` | Says which policy belongs to which role. Read-only; restore never changes it. |
| `roleAssignmentSchedule` | `GET /roleManagement/directory/roleAssignmentSchedules` | Time-bound active assignments. Collected only; restore is not built (research). |

All three are keyed by id: every directory role policy has the same display
name, so no name key exists. A policy restore therefore works in the same tenant
only; a cross-tenant policy restore is refused (a policy cannot be created).

### Operation records (`engine/restore/adminRoleOperations.mjs`)

| Type | Operation | Route | Writes | Permission |
| --- | --- | --- | --- | --- |
| roleDefinition (custom only) | create | `POST /roleManagement/directory/roleDefinitions` | display name, description, enabled, role permissions, template id | RoleManagement.ReadWrite.Directory |
| roleDefinition (custom only) | update | `PATCH /roleManagement/directory/roleDefinitions/{id}` | display name, description, enabled, role permissions | RoleManagement.ReadWrite.Directory |
| roleEligibilitySchedule | create | `POST /roleManagement/directory/roleEligibilityScheduleRequests` (`action: adminAssign`) | principal, role, directory scope, schedule, justification | RoleEligibilitySchedule.ReadWrite.Directory |
| unifiedRoleManagementPolicy | update | `PATCH /policies/roleManagementPolicies/{id}/rules/{ruleId}`, one call per changed rule | reviewed rules only | RoleManagementPolicy.ReadWrite.Directory |

Proof for all four: `engine/roadmap/admin-role-fidelity.test.mjs`. None of the
permissions is verified as granted to the KEEL Restorer.

## Rules

- **Built-in roles are refused.** Any write to a role with `isBuiltIn: true` is
  skipped before the journal or the writer runs. A role whose `isBuiltIn` is
  missing is refused, never guessed. Role delete is not registered.
- **A custom role keeps its key.** The template id is sent on create, so the
  recreated role has the same natural key. If the target id already exists, it
  is read and compared; a different role there is a conflict, not an overwrite.
- **Eligibility is requested, never forced.** A schedule request with
  `adminAssign` and the justification "Restored by KEEL from a backup snapshot".
  It starts now, or on the snapshot's own start date when that is still in the
  future, so a future-dated eligibility is never granted early. The snapshot's
  end date is kept (an "after duration" expiry becomes the same end date; a
  permanent one stays permanent). An expired eligibility is skipped.
  An unreadable schedule, an app scope or a missing principal or role fails.
- **Directory-wide eligibility only.** An eligibility scoped below the directory
  (an administrative unit or any `directoryScopeId` other than `/`) is refused
  with a clear reason: scoped eligibility is not qualified, and the scope id is
  never rewritten.
- **No duplicate requests.** Before requesting, the target is searched by
  principal, role and directory scope. A match is reported as applied with no
  write. A failed search is never read as "absent": nothing is requested.
- **Eligibility through a group is not copied** to the member; the group's own
  eligibility is restored instead.
- **A request that is not granted fails** (pending approval, denied, failed,
  cancelled or revoked), and the new schedule is read back and compared.
- **PIM role settings only get stronger or stay the same.** Reviewed rules:
  expiration (eligible and active admin assignment, end-user activation),
  enablement (MFA, justification, ticket on activation, and the same rule for
  admin assignments) and end-user approval. A change that would weaken
  protection is withheld and never written:
  - expiry no longer required, or a longer or uncomparable maximum duration;
  - a dropped enablement rule;
  - approval, approval for extension or requester justification switched off;
  - fewer approval stages;
  - a different approval mode with the same number of stages;
  - in any stage: approver justification or escalation switched off, or a
    primary or escalation approver removed.
  Only a strictly stronger change is written: more stages, added approvers, a
  flag switched on.
- **A withheld or manual rule shows as a gap.** The policy is reported in the
  run's `notRemediable` list (status `not-remediable`, with the withheld rules
  and their reasons, and the manual rules), next to whatever rules were applied.
  When every differing rule is withheld, nothing is reported as applied. The dry
  run reports the same gap.
- **Approvers must exist.** Each user or group named as an approver is read in
  the target before anything is written. Approval required with any stage that
  names no approver is refused. Notification and authentication-context rules
  are reported as manual.
- **Each rule is sent with the live rule's target.** A rule id's target is fixed
  by Entra, so the snapshot's copy is never written over it and references
  inside it are never resolved.
- **Only the policy for the whole directory** (`scopeId '/'`, scopeType
  `DirectoryRole`) is written, on both the snapshot and the live side.
- **Reference rewriting is limited to what is sent.** For eligibility, only
  the principal and role ids; for a policy, only ids inside the reviewed rules
  (outside their targets). A server field such as `lastModifiedBy` is never
  resolved and never blocks. A group or custom role recreated in the same run
  is remapped for eligibility (remapping proof recorded for eligibility create
  only).
- **Dry run makes no reads.** It reports the field and action changes for a role,
  the request for an eligibility, and the rules that would be written, withheld
  or left manual for a policy.

## Collection changes and consequences

- The collector now needs read access to PIM policies and schedules
  (`RoleManagement.Read.Directory` and the PIM read scopes, to confirm).
- **New types, not one-time drift.** No existing type's read path, hash or
  natural key changed. The first collection after this change adds the three
  new types to the snapshot; there is no drift on existing objects.
- **Eligibility id churn.** A restored eligibility gets a new schedule id, so the
  next snapshot shows the old id removed and a new id added once. Restoring the
  same old snapshot again finds the match and writes nothing.
- The policy query filter (`scopeType eq 'DirectoryRole'`) must be confirmed
  against the live tenant; Graph requires a filter on this list.

## Not included

- Deleting or updating an eligibility, and role delete.
- Active time-bound assignments (`roleAssignmentSchedule`): collected only.
- PIM for groups, administrative-unit or app-scoped eligibility.
- Writing the policy-to-role assignment, notification rules or
  authentication-context rules.
- Cross-tenant restore of PIM role settings.
