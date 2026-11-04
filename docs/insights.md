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
| Content backup | One change in who can reach a site or OneDrive, as `context.exposure` (see "Site and OneDrive access" below). |
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
| 9 | `shared-wider` | high | Service read | "Shared wider than before": the default link type moves toward anyone links (specific people → organization → anyone), an anyone link to files or folders can now view or edit when it could not, or a OneDrive's own sharing level, default link type or anyone-link expiry opens up | Narrower; `None` (use the tenant's default) |
| 10 | `opened-to-everyone-edit` | critical | Content backup | "Opened to everyone in the company": Everyone or everyone-except-external gains edit (or full control) on a site or OneDrive | The grant removed, or lowered to view |
| 10 | `opened-to-everyone` | high | Content backup | The same, with view only | The grant removed |
| 10 | `anyone-links-added` | high | Content backup | "Anyone links added": a site's anyone-link count went up, or a OneDrive's files hold anyone links they did not before | Fewer links; organisation or specific-people links |

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

## Alerts from flags (#966)

Each backup drift run, service collection and audit page evaluates its exact new rows.
A critical flag raises a critical alert; a high flag raises a warning. Source row id plus
flag key identifies the observation, so replay adds no alert or transition. Audit pages
queue this work in the same transaction as the facts and cursor, then drain it after
commit; a failed alert write retries on the next ingest.

When the same object has active approved-setup drift, its flag sentences enrich that
alert instead. Notifications use the existing channels, routing, mute and escalation,
under the scheduler's existing notification capability. No new delivery channel exists.

A later complete backup, or a covered service read, clears a flag when it proves the
flagged state ended. Partial or missing fields prove nothing. In particular, an enterprise
app backup without credential lists cannot prove that an audited secret was removed:
that event remains for a person to review. Audit role and permission additions compare
with the last complete backup before the event; only observed membership sets can clear
them. Acting on the exact change also clears its flag. A rollback plan alone is not a
completed rollback; only its verified applied resources, its recorded disposition or a later
restored observation clear it.

From Alerts, **Mark reviewed** closes a change-flag alert with a resolved observation.
It needs `dispose-accept`; the reviewer and note commit with `alert-action` evidence.
Acknowledging still leaves the alert active. Source replay after review cannot reopen it;
a genuinely new flagged source row can.

Alerts and Overview name the object, show the flag sentence and attribution, and link
to Changes. The link selects the precise source row, including older rows outside the
feed's default window. Labels are read using the current "Hide people's names" setting;
source ids remain under Technical details. A pruned source falls back to a general flag
sentence without names.

In **Settings → Notifications → Flagged change alerts**, every key starts on. Changing
a key needs `policies` and writes `alert-action` evidence in the same transaction. Turning
a key off stops new firings and keeps existing alerts available for review.

## Site and OneDrive access (content backups)

`engine/insights/sharingExposure.mjs` compares who can reach a site between two content backups,
from the plain summary saved beside each site's `site/permissions` item (#963). Each change is
its own row in Changes › Every change, with the source "Content backup", the service SharePoint or
OneDrive, and the site's name as the object:

- an Everyone or everyone-except-external grant added or removed, with its level (view, edit,
  full control);
- anyone links added (the count went up);
- new guests (the guest count went up);
- the last owner removed.

What it cannot see:

- **A backup saved before the counts existed** (summary version 1, or a OneDrive record without
  `exposure`) compares as unknown, never as zero. It produces no row, so the upgrade never reads as
  "removed".
- **A backup that could not read a group's members** compares its Everyone grants, guests and
  owners as unknown, since all three come from group members. It produces no row for them, and
  neither does the next full backup. Anyone links still compare.
- **A site that inherits its roles** saves no Everyone list. Its Everyone grants are not compared.
- **A site's first backup** has nothing to compare with.
- **OneDrive** is compared file by file, from each file's record before and after. Only additions
  are listed: a grant or link gone from one file can still reach the drive through another. A new
  file shared with an anyone link has no record before, so it is not counted. Guests and owners
  are not read for OneDrive.

## Sharing settings: wider or narrower

`engine/govern/sharingDirection.mjs` says which way a sharing setting moved: the sharing level
(`sharingCapability`, tenant and site; `OneDriveSharingCapability`), the default link type, the
anyone-link type for files and folders, and the anyone-link expiry. Workload drift rates a change
that only narrows sharing as low priority (`cosmetic`, a notice). A widening, or a change that also
touches any setting without a direction, stays access-affecting. The flags above flag the
widenings.

## Insights page (A7 and A8)

`/insights` (Dashboards › Insights) answers "what changed this week, and where do I start?" from one
change feed read (`portal/lib/insights-view.ts`, `portal/components/insights/insights-body.tsx`).

- **Verdict:** "143 changes in the last 7 days; 4 need a look." or "…; none flagged." When the feed hit
  its limit the count reads "At least …" and the page says "Showing the newest 500 changes."
- **Period:** 7 (default), 30 or 90 days, kept in the address as `days`.
- **Where to start:** flagged changes, most severe then newest; then unflagged changes to critical or
  high priority settings. Each is a sentence (who, what, when) that opens the change in Every change.
- **Shape of the period:** changes per day, by service, the people or apps with the most changes
  (code names when names are hidden) and the services with none.
- **Record layer:** the window read, the count from each source and whether the limit was hit.
- **Access:** the same as Every change: tenant-wide readers. An entity-scoped reader gets one sentence
  and no feed read.
- **Overview:** one "Needs attention" row, "3 flagged changes this week", for flagged changes of the
  last 7 days that no open alert shows. An alert counts when it is open, reopened or acknowledged
  and its `resource_key` is the flagged row's object key (the key A10 is expected to use).
