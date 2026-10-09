# Restorer least-privilege review (issue #93)

Status 2026-10-04. Review only: no grant has been changed. Removing a grant is an
operator decision in `ops/operator-queue.md`; no Claude session changes grants.

## What the Restorer holds today

From the operator queue (Q3 and Q7, read-only inventories by keel-operator, 2026-10-04):

- Microsoft Graph: about 52 application permissions, nearly all `ReadWrite`. Named in
  the inventories: `Directory.ReadWrite.All`, `Application.ReadWrite.All`,
  `RoleManagement.ReadWrite.Directory`, `Policy.ReadWrite.ConditionalAccess`,
  `Group.ReadWrite.All`, `Files.ReadWrite.All`, `Sites.FullControl.All`,
  `MailboxSettings.ReadWrite`, `TeamSettings.ReadWrite.All`, `TeamMember.ReadWrite.All`,
  `ChannelMember.ReadWrite.All`. The full list was never written down; Q-item below asks
  for it.
- SharePoint Online: `Sites.FullControl.All`, `TermStore.ReadWrite.All`.
- Exchange Online: `Exchange.ManageAsApp`.
- 9 directory roles. Eight are named: Compliance Administrator, Compliance Data
  Administrator, Exchange Administrator, Intune Administrator, Knowledge Administrator,
  Security Administrator, SharePoint Administrator, Teams Administrator. The ninth is
  unidentified.

## What restore actually uses

Derived from the code, not from documentation of what could be restored. The Entra
surface is every type with a registered write capability
(`restoreScopeFor()` in `engine/coverage/qualification.mjs`, which reads
`engine/coverage/capabilities.mjs`); the workload surface is `WORKLOAD_WRITE_OPERATIONS`
in the same file. Gate tools are in `tools/qualification/`.

| Restore path | Code | Writes | Needs |
| --- | --- | --- | --- |
| Groups: create, update, delete, soft-delete restore; member and owner edges | `applyEngine.mjs`, `relationshipWriter.mjs`; gates 115, 116, 121 cleanup | `/groups`, `/directory/deletedItems/{id}/restore`, `/groups/{id}/members|owners/$ref` | `Group.ReadWrite.All` |
| Applications: create, update, soft-delete restore; service principal create | `applyEngine.mjs` (task-107) | `/applications`, `/servicePrincipals` | `Application.ReadWrite.All` |
| Directory role assignments: create, update, delete | `applyEngine.mjs` | `/roleManagement/directory/roleAssignments` | `RoleManagement.ReadWrite.Directory` |
| Conditional Access policies, named locations, custom authentication strengths | `applyEngine.mjs`, `policyOperations.mjs` | `/identity/conditionalAccess/*`, `/policies/authenticationStrengthPolicies` | `Policy.ReadWrite.ConditionalAccess` |
| Administrative unit: update name and description | `administrativeOperations.mjs` | `PATCH /directory/administrativeUnits/{id}` | `AdministrativeUnit.ReadWrite.All` |
| Tenant-wide group settings: update, delete | `administrativeOperations.mjs` | `/groupSettings/{id}` | `GroupSettings.ReadWrite.All` (see below) |
| Tenant-wide Entra policies (task-149) | `tenantPolicyOperations.mjs` | `/policies/authorizationPolicy`, `/policies/authenticationMethodsPolicy`, `/policies/identitySecurityDefaultsEnforcementPolicy`, `/policies/crossTenantAccessPolicy/*`, `/policies/adminConsentRequestPolicy` | `Policy.ReadWrite.Authorization`, `Policy.ReadWrite.AuthenticationMethod`, `Policy.ReadWrite.SecurityDefaults`, `Policy.ReadWrite.CrossTenantAccess`, `Policy.ReadWrite.ConsentRequest` (declared, not yet verified as granted) |
| Users: update, soft-delete restore; user and group licences (task-150) | `userOperations.mjs` | `PATCH /users/{id}`, `/directory/deletedItems/{id}/restore`, `POST /users|groups/{id}/assignLicense` | `User.ReadWrite.All`, `LicenseAssignment.ReadWrite.All` (declared, not yet verified as granted) |
| Intune compliance, device configuration and settings catalog policies, with their assignments (issue #155) | `intuneOperations.mjs`, `applyEngine.mjs` | `/deviceManagement/deviceCompliancePolicies`, `/deviceManagement/deviceConfigurations`, beta `/deviceManagement/configurationPolicies`, each with `/assign` | `DeviceManagementConfiguration.ReadWrite.All` (declared, not yet verified as granted) |
| SharePoint tenant sharing settings (gate 120) | `workloads/sharepoint.mjs` | `PATCH /admin/sharepoint/settings` | `SharePointTenantSettings.ReadWrite.All`, SharePoint Administrator (as declared) |
| Teams settings and membership (gate 121) | `workloads/teams.mjs` | `/teams/{id}`, `/teams/{id}/members` | `TeamSettings.ReadWrite.All`, `TeamMember.ReadWrite.All` |
| Mailbox settings (gate 122) | `workloads/exchange.mjs` | `PATCH /users/{id}/mailboxSettings` | `MailboxSettings.ReadWrite` |
| CAS mailbox and mailbox retention (gate 122) | `workloads/exchange.mjs` | `Set-CASMailbox`, `Set-Mailbox` | `Exchange.ManageAsApp`, Exchange Administrator (D-122a: keep) |
| Purview label and label policy (gate 123) | `workloads/purview.mjs` | `Set-Label`, `Set-LabelPolicy` | `Exchange.ManageAsApp`, Compliance Administrator (D-123a: keep) |

The writer's read-backs (`GraphWriter.read`) stay inside the same resources, so each
`ReadWrite` scope above covers them. Pre-restore observation runs on the Collector.

`groupSetting` was declared as needing `Directory.ReadWrite.All`, which the onboarding
registry itself lists as a forbidden broad grant. Microsoft Graph's least-privileged
application permission for updating and deleting a group setting is
`GroupSettings.ReadWrite.All` (groupsetting-update and permissions reference, read
2026-10-04 through the docs mirror). This PR corrects the declaration. One exception
from the same page: the Consent Policy Settings object is governed by a policy
permission instead, so a restore of that one setting would be refused by Graph under
the minimal set; it stays a manual step.

## Proposed minimal set

Graph application permissions (10):

1. `Group.ReadWrite.All`
2. `Application.ReadWrite.All`
3. `RoleManagement.ReadWrite.Directory`
4. `Policy.ReadWrite.ConditionalAccess`
5. `AdministrativeUnit.ReadWrite.All`
6. `GroupSettings.ReadWrite.All` (new grant, replacing `Directory.ReadWrite.All`)
7. `SharePointTenantSettings.ReadWrite.All`
8. `TeamSettings.ReadWrite.All`
9. `TeamMember.ReadWrite.All`
10. `MailboxSettings.ReadWrite`

Exchange Online: `Exchange.ManageAsApp`. SharePoint Online: none.

Directory roles (3): Exchange Administrator, Compliance Administrator, SharePoint
Administrator.

Everything else is a removal candidate, including `Directory.ReadWrite.All`,
`Files.ReadWrite.All` (both on the registry's forbidden list), `Sites.FullControl.All`
(Graph and SharePoint), `TermStore.ReadWrite.All`, `ChannelMember.ReadWrite.All`,
`User.ReadWrite.All` (user recovery is manual; if it is ever automated,
`User.DeleteRestore.All` is the narrower grant), and the Compliance Data, Intune,
Knowledge, Security and Teams Administrator roles plus the unidentified ninth.

Two grants in the minimal set still allow privilege escalation on their own:
`RoleManagement.ReadWrite.Directory` (the app can assign itself any role) and
`Application.ReadWrite.All` (the app can add credentials to any application). They back
role-assignment and application restore. Making those two restores manual and dropping
the grants is the operator's call (D-93b).

Things this would break, so they move elsewhere before removal:

- Fixture setup that keel-operator ran as the Restorer: the KEEL-RT communication site
  (Q8, `Sites.FullControl.All`). A recreated fixture site would be made by hand in the
  SharePoint admin center. Purview fixtures (D-123d) still work under Compliance
  Administrator.
- Inventory reads keel-operator ran as the Restorer because the Collector lacked the
  scope (Q7: SharePoint admin REST, `/users/{id}/drive`). Those become Collector reads
  or are dropped.

## Order

1. After the gates 120-123 chain finishes (master freeze), keel-operator writes the full
   grant list (Q-item below), so every one of the ~52 has a line.
2. The operator decides D-93a and D-93b.
3. keel-operator applies only what was decided, then reruns gate 115 and the 120-123
   chain as the regression check that restore still works.

## Proposed queue entries

Sent to the thread that owns `ops/operator-queue.md`:

- Q (read-only, after the 120-123 chain): list every application permission (Graph,
  SharePoint, Exchange and any other resource) and every directory role, with role
  template id, held by the Restorer app. Change nothing.
- D-93a: add `GroupSettings.ReadWrite.All` to the Restorer and remove every grant not in
  the minimal set above?
- D-93b: keep `RoleManagement.ReadWrite.Directory` and `Application.ReadWrite.All` (role
  assignment and application restore stay automated), or remove them and make both
  restores manual?

## Related, not in scope

The Collector also holds write-capable grants approved in D-123b (`Sites.FullControl.All`
with SharePoint Administrator, and Compliance Administrator). On 2026-10-04 it was also
given the Entra Intune Administrator role, because no read-only Intune role exists among
Entra directory roles. The Setup check (`engine/bootstrap/graphHost.mjs`) looks for the
Intune RBAC role Read Only Operator instead: it is assigned in the Intune admin center
(Tenant administration > Roles) to a security group the Collector is a member of. A
Collector review would be its own issue.
