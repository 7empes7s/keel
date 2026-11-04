# Insights: risk flags

Changes › Every change ranks each change by its type of setting (`engine/insights/taxonomy.mjs`).
Risk flags (`engine/insights/flags.mjs`, insights track A6) also read what the change did. "A
Conditional Access policy was renamed" and "a Conditional Access policy was turned off" are now
two different things.

## How a flag works

- A rule has a key, a severity (critical or high), the sources and setting types it reads, a test,
  and a plain sentence built from the setting's own name ("Turned off: Require MFA for admins.").
- Every rule is directional. The reverse change, or a harmless one such as a rename, does not flag.
- Each feed row carries `flags: [{ key, severity, sentence }]`, most severe first.
  - A critical flag makes the row critical. Its sentence becomes the row's `priorityReason`.
  - A high flag raises a low or normal row to high. It leaves a row that is already high or
    critical as it is.
  - A row with no flags keeps the priority its type gives it.
- `evaluateFlags(input)` is pure: one change in, flags out. The alerts and Insights work can call
  it. `flagValues(type, payload)` turns a whole saved copy into the values the rules read.
- Names in sentences are the names the page shows. With "Hide people's names" on, they are code
  names. Sentences never carry an id.

## What each source gives a rule

| Source | What the rule sees |
|---|---|
| Approved setup (drift) | The before and after values of the JSON paths in `FLAG_PATHS`, selected in SQL (never the whole saved copy). For added links, the same backup also gives the role's name, whether the group can hold admin roles, and the app permission's name. |
| Service read | The changed fields the read recorded (`workload_drift.fields`), filtered in SQL to `SERVICE_FLAG_PATHS`. |
| Audit log | The activity, the operation, the target's type and the changed field names. **Never values.** |

## Rules

| # | Key | Severity | Source | Flags when | Does not flag |
|---|---|---|---|---|---|
| 1 | `ca-turned-off` | critical | Approved setup | A Conditional Access policy goes from on (or report-only) to off | Turned back on |
| 1 | `ca-report-only` | critical | Approved setup | A policy goes from on to report-only | Report-only turned on |
| 1 | `ca-deleted` | critical | Approved setup | A policy that was on or report-only is deleted | Deleting a policy that was already off |
| 1 | `ca-deleted-audit` | critical | Audit log | "Delete conditional access policy" | Any other policy activity |
| 2 | `ca-exclusions-added` | critical | Approved setup | A policy that was and stays on (or report-only) gains excluded users, groups, roles or locations | Exclusions removed; a policy that was off turned on with exclusions |
| 2 | `ca-mfa-removed` | critical | Approved setup | Grant controls of a policy that was and stays on asked for MFA or an authentication strength and now ask for neither | MFA swapped for an authentication strength or for a block |
| 3 | `admin-role-added` | critical | Approved setup | A role assignment is added: Entra (`roleAssignment`, `roleAssignmentSchedule`, `roleEligibilitySchedule`) or any `…RoleAssignment` type in `PRIVILEGED_DRIFT_TYPES` (`engine/govern/dispositionReview.mjs`). The sentence names the role from the backup, never the assignment's own name (some services name it after the person). | A role assignment removed |
| 3 | `role-group-member-added` | critical | Approved setup | Someone is added to a group whose `isAssignableToRole` is true | Added to an ordinary group |
| 3 | `role-group-member-added-service` | critical | Service read | An Exchange role group (`PRIVILEGED_SERVICE_WORKLOADS`) gains a member | A member removed |
| 3 | `admin-role-added-audit` | critical | Audit log | "Add (eligible / scoped) member to role", on the role's row | "Remove member from role"; the person's own row of the same record |
| 4 | `app-credential-added` | high | Approved setup | An app registration or enterprise app gains a client secret or certificate (a new `keyId`), or is created with one | A secret or certificate removed |
| 4 | `app-credential-added-audit` | high | Audit log | "Add service principal credentials" | "Remove service principal credentials"; "Update application – Certificates and secrets management", which Entra logs for removals too |
| 5 | `app-permission-tenant-write` | critical | Approved setup | An application permission is granted (`appRoleGrant` link added) that writes tenant-wide: `*.ReadWrite.All`, `Directory.*`, `RoleManagement.*`, `AppRoleAssignment.*` | The permission removed |
| 5 | `app-permission-granted` | high | Approved setup | Any other application permission granted, including one whose name the backup does not hold | The permission removed |
| 5 | `app-permission-granted-audit` | high | Audit log | "Add app role assignment to service principal" | "Remove app role assignment…" |
| 6 | `location-trusted` | high | Approved setup | A named location is marked trusted, or added as trusted | Trust taken away |
| 6 | `trusted-ranges-added` | high | Approved setup | A trusted location gains IP ranges | Ranges added to an untrusted location; ranges removed |
| 7 | `security-defaults-off` | high | Approved setup | Security defaults turned off | Turned on |
| 7 | `weak-method-on` | high | Approved setup | Text message, voice call or email one-time passcode turned on in the authentication methods policy | Turned off |
| 7 | `auth-strength-loosened` | high | Approved setup | An authentication strength accepts a method combination it did not before | Combinations removed |
| 8 | `cross-tenant-opened` | high | Approved setup | A cross-tenant access default for B2B collaboration or direct connect (users or apps, inbound or outbound) goes from blocked to allowed | Allowed to blocked |
| 8 | `guest-invites-opened` | high | Approved setup | `allowInvitesFrom` moves wider (nobody → admins and guest inviters → all members → everyone), or email-verified self sign-up is turned on | Narrower |
| 9 | `sharing-widened` | high | Service read | SharePoint or OneDrive tenant sharing moves toward anyone links (`Disabled` → existing guests → new and existing guests → anyone) | Narrower |
| 9 | `anyone-link-expiry-longer` | high | Service read | The anyone-link expiry (`RequireAnonymousLinksExpireInDays`) is removed or made longer | Made shorter, or added |

## What the rules cannot see

- **Audit rows give field names, not values.** An audit row cannot tell a policy turned off from
  one renamed, so "Update conditional access policy" never flags. Only activities that say what
  happened in their name flag. Today the audit ingest also stores no field names, so audit rules
  match on the activity alone.
- **App permissions from the audit log** are always high. The log does not say which permission was
  granted, so it cannot pick out the tenant-wide write ones.
- **Group membership from the audit log** does not flag. The log does not say whether the group can
  hold admin roles. The backup's link row does.
- **Every admin role counts as privileged.** A role assignment of any role flags, just as a decision
  on any of them needs a second person.
- **Enterprise app secrets** are read only where the backup keeps credentials. Service principals
  are read without them, so their new secrets are seen through the audit log.
- **App registration secrets from the audit log** do not flag. Entra logs adding and removing one
  under the same activity, so only the backup's before and after can tell them apart.
- **Anyone-link expiry** is read from the PnP tenant read (`sharepoint-tenant`). The Graph SharePoint
  read does not carry it.
- **Link rows (memberships, app permissions)** need the parent group or the API's app in the same
  backup to name the group or the permission. Without it, the flag still shows, with a general
  sentence.
