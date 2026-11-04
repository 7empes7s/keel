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
- **Overview:** one "Needs attention" row, "3 flagged changes this week need a look", for flagged
  changes of the last 7 days that still need a look (see below). It counts exactly what the verdict
  counts.

## What happens after a flag

Every row of Every change and of "Where to start" says its next step, worked out by
`engine/insights/nextSteps.mjs` from the row's source and object key. One step per row, the first
that applies:

| Step | When | Shows |
|---|---|---|
| Decided | Accepted, ignored or undone under Changes › Open changes. An audit row takes the decision of the backup change that found the same object after it. | "Accepted by Amara Okafor on 3 Nov", "Ignored by …", "Undone on 3 Nov, approved by …" |
| Accept or undo | The change is still open under Open changes (approved-setup or service-setting change; an audit row whose object has an open change). | A link to `/changes?open=<id>`: the Open changes panel, with its own Accept, Ignore and Undo, approvals and capability checks. |
| Restore | A deleted object that a complete backup from before the change holds. | "Restore from the backup before this change", to `/restore?snapshot=<id>`. |
| Site | A content backup found a change in who can reach a site. | "See who can reach this site", to `/sites/<id>`. |
| OneDrive | The same for a OneDrive. Keel has no OneDrive page. | Where to look, no link. |
| Audit log | Only the audit log saw it. | "Seen in the Microsoft audit log. The next backup shows whether it is still in place." |
| No longer waiting | A backup or service change that left Open changes without a decision (a later change or a new approved setup replaced it). | One sentence. |

**Needs a look** means flagged and not dealt with yet. A change is dealt with when it is decided (or no
longer waiting), or when an alert whose `resource_key` is the row's object key was acknowledged or
resolved after the change. An open alert does not count. The rule lives in one place
(`needsLook` in `portal/lib/change-feed-view.ts`), and the Insights verdict, "Where to start", Every
change's Flagged tile and the Overview row all count with it. Flagged rows someone dealt with stay
listed with their state, below the open ones in "Where to start"; the Flagged tile counts only the open
ones and says how many more were dealt with.

Deciders are named the way "Hide people's names" says (code names when it is on). Ids appear only in
each row's Technical details ("Next step: decide (open change …)"). The states are read with a fixed
number of queries for the whole page (one per source, plus alerts, backups and names), never one per
row, and only on Every change, Insights and the Overview, so Open changes is not slowed.
