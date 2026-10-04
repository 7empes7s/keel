# Teams configuration and structural membership adapter (task 104)

Date: 2026-10-03 UTC. Status: implemented and fixture-tested only. The read and every
write ship **disabled**. No tenant was read or written.

Task-120 merged only its code half: SharePoint is not live-qualified yet. Teams
activation requires SharePoint qualification first, so nothing in this task can be
enabled today, even with Teams evidence.

## What was built

### Declared reads (`engine/collect/workloadContract.mjs`)

Task-101 already declared `teams.settings` (`GET /teams/{team-id}`) and
`teams.membership` (`GET /teams/{team-id}/members`). This task adds two reads:

| Operation | Endpoint | Permission |
| --- | --- | --- |
| `teams.team-discovery` | `GET /teams` (paged) | `Team.ReadBasic.All` |
| `teams.group-membership` | `GET /groups/{group-id}/members` (paged) | `GroupMember.Read.All` |

Both pass the task-101 scope validator and start `disabled`. The fixture harness
(`tools/qualification/workloads.mjs`) has sample bodies for them.

### The reader (`engine/collect/workloads/teams.mjs`)

`readTeams` discovers teams, then reads three things for each in-scope team.

| Observation | Fields | Source operation |
| --- | --- | --- |
| Settings | `memberSettings`, `guestSettings`, `messagingSettings`, `funSettings`, `discoverySettings` | `teams.settings` |
| Properties | `displayName`, `description`, `visibility`, `isArchived`, `classification`, `specialization`, `webUrl`, `createdDateTime`, `tenantId` | `teams.settings` |
| Teams membership (`members`) | per member: membership id, `userId`, `tenantId`, roles, display name | `teams.membership` |
| Group membership (`groupMembers`) | per member: directory object id and type | `teams.group-membership` |

- **Messages are content.** `messagingSettings` is a setting about messaging and is
  read. No message, chat, channel, reply, hosted content, tab or file is ever
  requested. Every request must match one of `TEAMS_REQUEST_SHAPES` (exact paths, and
  only `$skiptoken`/`$top` query keys) before it is sent, or `assertTeamsRequest`
  throws. This sits on top of the task-101 scope validator. Content that a team body
  carries (`messages`, `channels` and so on) is never stored and never counted as a
  field.
- **Two memberships, two observations.** `members` and `groupMembers` each have their
  own coverage entry: `observed`, `denied`, `failed` or `unknown`. One being complete
  never makes the other complete. A failed Teams membership read leaves no member
  list at all; nothing is filled in from the group.
- **Tenant identity.** The caller gives the managed tenant id. A team whose settings
  name another tenant is recorded as out of scope, and its members are never read.
  Each member keeps its own `tenantId`, so a member from another tenant (shared
  channels, B2B direct connect) is never mistaken for a local user.
- **Per-field coverage, bounded, keyed by team id**, exactly like task-102. Runs are
  stored in the existing `workload_collection` and `workload_observation` tables
  (`team:{id}` rows). No schema change was needed.

### Activation (`teamsActivation`, `collectTeams`)

Live collection runs only when both of these hold:
1. SharePoint is qualified. Every SharePoint read in `sharePointActivation` is
   enabled.
2. Every Teams read (`teams.team-discovery`, `teams.settings`, `teams.membership` and
   `teams.group-membership`) is live-qualified and enabled on its own evidence.

Otherwise `collectTeams` records a `disabled` run that names what is missing, and sends
nothing. The workload is registered with `enabledByDefault: false` and appears in the
coverage report next to SharePoint.

### Writes (`engine/coverage/qualification.mjs`)

Four workload writes are declared in `WORKLOAD_WRITE_OPERATIONS`. Each has its own
proof.

| Operation | Request | Read-back | Permission |
| --- | --- | --- | --- |
| `teams.settings.update` | `PATCH /teams/{id}`, the five settings groups only | `teams.settings` | `TeamSettings.ReadWrite.All` |
| `teams.membership.add` | `POST /teams/{id}/members` | `teams.membership` | `TeamMember.ReadWrite.All` |
| `teams.membership.update` | `PATCH /teams/{id}/members/{membership-id}` (roles) | `teams.membership` | `TeamMember.ReadWrite.All` |
| `teams.membership.remove` | `DELETE /teams/{id}/members/{membership-id}` | `teams.membership` | `TeamMember.ReadWrite.All` |

Each entry has `requires: ['sharepoint.tenant-settings.update']`.
`workloadWriteQualification` now checks any required write as well. A Teams write is
enabled only when all of these hold:
- its own live write capture passes the task-103 checks (same tenant, non-synthetic,
  `v1.0`, no older than 30 days, read back);
- its Teams read-back is enabled in the ledger;
- the SharePoint write is itself enabled.

Evidence counts only for the `operationId` it names. A SharePoint capture is never
Teams proof, and a fixture pass is never live proof.

### The restore (`engine/restore/workloads/teams.mjs`)

One plan covers one team. `planTeamsRestore` builds a frozen plan holding:
- the source collection;
- the operations;
- manual and excluded items;
- the group membership status, for information only;
- content effects;
- a fingerprint of the live settings and of the live members;
- a digest over all of it.

The plan is stored as a `restore_dry_run` artifact (the task-103 `workload_restore`
column), so the task-66 approval and promotion checks are the existing ones.

| Source item | What happens |
| --- | --- |
| A settings group observed in the source and different from today | One PATCH with only the changed groups, then read back |
| A settings group `denied`, `failed` or `unknown` in the source | Manual: there is no value to restore from |
| A changed name, description, visibility, archive state or classification | Manual: a person changes it |
| `webUrl`, `createdDateTime`, `tenantId`, `specialization` | Excluded: server-owned |
| Messages, chats, channels, replies, hosted content, files, tabs | Excluded: content, never read or restored |
| A local member missing today | Add, with the source roles |
| A local member with different roles | Role update |
| A local member present today but not in the source | Remove, only if the live Teams membership read was complete |
| A member from another tenant | Manual: re-added or removed by a person |
| Teams membership not `observed` in the source | Manual: no member change at all, whatever the group read says |
| Group membership | Not restored here; it goes through the Entra group relationship path |

A plan that would leave the team with no owner is refused. Member operations run in
this order: adds, then role changes, then removals.

**Content effects** (`engine/safety/contentEffects.mjs`) are all `externally-sharing`,
and each needs the exact separate approval:
- guests gain the right to create or delete channels;
- the team becomes shown in search and suggestions;
- a guest is added.

**`executeTeamsRestore`** does this:
1. Checks that the artifact is promotable, the stored plan matches its digest, and the
   plan targets the same tenant. Otherwise the outcome is `refused` and nothing is
   sent.
2. Qualification, per operation. An operation whose write is not enabled is
   `disabled` and sends nothing. The other operations still run.
3. Content-effect approval. Without it, the runnable operations are
   `blocked-content-effect` and nothing is sent.
4. Re-reads the team. If the team no longer belongs to the planned tenant, every
   operation is `refused`. Changed settings make the settings operation `stale`.
   Changed or unreadable members make the member operations `stale`. Each check
   applies only to the operations it touches.
5. Writes and verifies each operation on its own:
   - **Settings:** one PATCH, then a read-back field by field. A preservation-lock
     refusal is `refused` and never retried.
   - **Members:** one request. A 429 means nothing was applied, so it is resent after
     `Retry-After` (at most 3 attempts). A thrown request or a 5xx is an ambiguous
     outcome: the members are re-read and the request is **never sent again**. A
     member counts as present only when both `userId` and `tenantId` match. A same-id
     user from another tenant is never accepted as restored, after a success or after
     an ambiguous outcome.

Every operation gets its own outcome and its own `workload-restore` evidence row
(operation, target, outcome, writes, attempts, reasons). A summary row follows. The
plan outcome is one of `verified`, `disabled`, `blocked-content-effect`, `partial`,
`no-change` or `refused`.

### Wave planner (`engine/restore/wavePlanner.mjs`)

`teamsTeam`, `teamsTeamSettings` and `teamsMembership` are refused by `planWaves` and
`planDeletionWaves`. They never run as an Entra wave.

## Proof

`engine/roadmap/teams-config.test.mjs` has 9 tests. They run against the isolated
database and an in-memory Graph that answers any message, chat or channel request
with content, so a single such call would show up.

- **Reads.** Settings, Teams membership and group membership come back as separate
  observations, and discovery pages. Zero content calls are made. Message text in the
  team body is never stored, and it is not counted in `fieldCounts` (5 settings + 9
  properties + 2 memberships). A team from another tenant is out of scope and its
  members are not read. Eight message, chat, channel, `$expand` and foreign-host shapes
  are refused before sending.
- **Completeness.** Group members denied while Teams members are observed: member
  operations are still planned. Teams members failed while group members are observed:
  no member operation is planned. An incomplete live read authorizes no removal.
- **Activation.** Reads stay off with SharePoint only, with Teams only, or with the
  group read missing, and send zero requests. For each Teams write, these are all
  disabled: SharePoint proof alone, a fixture pass, Teams proof without SharePoint,
  and a disabled read-back. Only both together enable it.
- **Zero writes.** With no qualification, SharePoint-only qualification, or Teams
  without SharePoint, the restore sends zero requests.
- **Separate outcomes.** The settings write is `verified` while the member add is
  `failed`, each with its own evidence row. With settings qualified and membership
  not, only the PATCH is sent.
- **Role change and removal.** Both verify, as PATCH then DELETE.
- **Retry and tenant identity.**
  - A lost response that was applied is `verified`, with one POST.
  - A 503 is `failed`, with one POST.
  - A 429 is resent after `Retry-After: 3` (two POSTs).
  - A same-id member in another tenant is `verification-failed` after a success, and
    `failed` after an ambiguous outcome. Neither is resent.
  - A team that moved to another tenant is `refused` with no write.
  - A plan run against another tenant id is `refused` with no request.
  - A source member from another tenant stays manual.
- **Concurrency and approval.** A member added after the plan makes only the member
  operation `stale`. A guest addition is blocked with no request until it is approved
  exactly, and the `guest` role is never sent. An ownerless plan is refused.
- **Integration.** Teams types never enter Entra waves. The coverage report lists the
  disabled Teams workload with its reasons.

Mutation checks, each caught by failing tests and then reverted:

| Mutation | Result |
| --- | --- |
| Count Teams messages as configuration: `messages` added to the read fields | 8 pass, 1 fail |
| Inherit SharePoint proof as Teams qualification: SharePoint captures accepted for a Teams write | 6 pass, 3 fail |
| Conflate group and Teams membership completeness: a group read stands in for a failed Teams read | 8 pass, 1 fail |

Validation command (39 tests, all pass):

```bash
set -a && . /etc/keel/db.env && set +a && node --test engine/roadmap/teams-config.test.mjs engine/restore/*.test.mjs engine/reconcile/*.test.mjs engine/safety/*.test.mjs engine/policy/*.test.mjs cli/keel-restore.test.mjs cli/keel-remediate.test.mjs cli/keel-worker.test.mjs
```

The suite is added to the CI engine step in `.github/workflows/portal.yml`.

## Limitations

- **No live proof, and blocked behind SharePoint.** Nothing was read or written in a
  tenant. The endpoints, bodies, permissions and the `aadUserConversationMember` shape
  were declared from Microsoft's Graph documentation, which could not be re-fetched
  from this environment, so no retrieval date is recorded (Global Constraint 8). Teams
  stays disabled until two things exist: the task-120 SharePoint qualification, and a
  Teams-specific live capture for each read and each write. No Teams capture tool or
  gate validator exists yet. That is the Teams counterpart of task-120, outside this
  task.
- **No worker job, CLI command or portal action.** Nothing outside tests calls
  `collectTeams` or `executeTeamsRestore`, as with task-103. A job kind would need a
  capability mapping and an approval flow, and it could not run anything before
  qualification. The only user-visible surface is the coverage report entry, which
  says the workload is disabled and why. The portal does not render workload coverage
  today.
- **Team-level settings only.** Channel settings, tabs, apps, meeting policies
  (`teams.meeting-policies` is a cmdlet read) and tenant-wide Teams policies are not
  restored. Team properties (name, description, visibility, archive state) stay
  manual.
- **Members from other tenants are manual.** Shared-channel and B2B direct-connect
  members are observed with their tenant id but never written.
- **Group membership is observed, not restored here.** It is reported beside Teams
  membership so a divergence is visible. Restoring it is the Entra group relationship
  path's job (task-61).
- **Membership ids.** A membership id that is not plain base64 (it contains `/`) cannot
  be addressed safely. That role change or removal is manual.
- **Does not recover content.** Restoring a member or a setting never recovers
  messages, files or channel content, and no content recovery is claimed.
