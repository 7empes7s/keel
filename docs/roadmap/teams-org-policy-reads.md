# Teams org-wide policy reads (issue #154)

Date: 2026-10-09 UTC. Status: implemented and fixture-tested only. Every read ships
**disabled**. No tenant was read, and nothing contacted Microsoft.

## Why

Teams coverage was per team: settings, Teams membership and group membership. The
org-wide policies that decide what every user can do in meetings and chats, which apps
they get, who they can talk to outside the tenant and what guests can do were not
backed up. Only `Get-CsTeamsMeetingPolicy` was declared, and nothing collected it.

## What is collected

A new workload, `teams-org-policies`, with nine declared reads in
`engine/collect/workloadContract.mjs`. Each is one `Get-` cmdlet with no parameters, in
the `MicrosoftTeams` session. Each needs the Teams Administrator role, like the meeting
policy read task-101 declared.

| Operation | Cmdlet | Stored under (identity) |
| --- | --- | --- |
| `teams.meeting-policies` | `Get-CsTeamsMeetingPolicy` | `meeting-policy:<identity>` |
| `teams.messaging-policies` | `Get-CsTeamsMessagingPolicy` | `messaging-policy:<identity>` |
| `teams.app-setup-policies` | `Get-CsTeamsAppSetupPolicy` | `app-setup-policy:<identity>` |
| `teams.app-permission-policies` | `Get-CsTeamsAppPermissionPolicy` | `app-permission-policy:<identity>` |
| `teams.federation-configuration` | `Get-CsTenantFederationConfiguration` | `federation-configuration:global` |
| `teams.client-configuration` | `Get-CsTeamsClientConfiguration` | `client-configuration:global` |
| `teams.guest-meeting-configuration` | `Get-CsTeamsGuestMeetingConfiguration` | `guest-meeting-configuration:global` |
| `teams.guest-messaging-configuration` | `Get-CsTeamsGuestMessagingConfiguration` | `guest-messaging-configuration:global` |
| `teams.guest-calling-configuration` | `Get-CsTeamsGuestCallingConfiguration` | `guest-calling-configuration:global` |

External access is the federation configuration. Guest access is the `AllowGuestUser`
switch in the client configuration plus the three guest configurations. Guest calling
was not in the issue's list; it is one field and fits the same shape, so it is included.

**The meeting policy read was moved, not copied.** Task-101 declared
`teams.meeting-policies` under the `teams-settings` workload, but nothing collected it
and the Teams team collector never used it. It is an org-wide policy, not a team
setting, so it now belongs to `teams-org-policies`. Its id is unchanged, so a probe row
for `Get-CsTeamsMeetingPolicy` maps to the same read as before. Its paging changed from
`none` to `cmdlet-unbounded`, like the other policy lists. The `teams-settings` workload
now has Graph reads only.

**Identity.**
- Policies are keyed by their `Identity`: `Global` (the org-wide default) or
  `Tag:<name>` (a named policy, including Microsoft's built-in ones such as
  `Tag:AllOn`). A Teams policy cannot be renamed, so the Identity is stable. The key is
  lower-cased, because Teams compares identities without case; the `Identity` field
  keeps the value as Teams answered it.
- Configurations are tenant singletons. Only an object whose Identity is `Global` is
  accepted.
- Anything else (no Identity, another scope, control characters) is not guessed at. It
  is counted as `unidentified`, and the run is `partial`.

**Fields.** Each family keeps a declared list of fields (`FAMILIES` in
`engine/collect/workloads/teamsPolicies.mjs`), and everything else is dropped unread.
That drops the module's internal `Key` and `XsAnyElements`. A declared field the answer
does not carry is recorded as `unknown`, not as false.

**Secrets.** No declared field holds a credential. They are switches, modes, app ids
and domain lists. Every kept value still goes through the shared redactor
(`redactPayload` in `engine/telemetry/events.mjs`). A credential-shaped value, typed
into a description for example, is stored as `[redacted]` with field status `redacted`.

## How it runs, and how it is enabled

- `readTeamsPolicies` reads the families through the bounded cmdlet job
  (`engine/powershell/jobQueue.mjs`). The container side, `ops/powershell/run-cmdlet.ps1`,
  now has a Teams session: it allows exactly these nine cmdlets with no parameters
  (`$AllowedTeamsPolicy`), only with module `MicrosoftTeams`, and connects with
  `Connect-MicrosoftTeams` and the collector certificate, as the probe does. A test
  checks that the Node and container lists match.
- A family that fails is `failed` or `denied`, with the structured error.
- A family that answers nothing is a gap, and the run is `partial`. Every tenant has
  its `Global` policies and configurations, so an empty answer is never "nothing to
  back up".
- **Disabled until qualified.** `collectTeamsPolicies` records a `disabled` run and
  sends nothing unless:
  - the Teams workload (team settings and membership) is qualified, which itself
    requires SharePoint. These reads follow Teams, as mail flow follows Exchange;
  - and all nine reads are each live-qualified and enabled in the task-101 ledger.
    There are no optional reads: none of these cmdlets needs an add-on licence.
- The workload is registered with `enabledByDefault: false` and appears in the coverage
  report. Runs are stored in the existing `workload_collection` and
  `workload_observation` tables. No schema change.
- There is no write capability: no write operation is declared, no `Set-`, `New-`,
  `Grant-` or `Remove-` cmdlet is allowed, and the `teamsOrgPolicy` type is refused as an
  Entra wave.

## Proof

`engine/roadmap/teams-org-policies.test.mjs` (4 tests) runs against the isolated test
database and a fake container behind the real job spawn path. It checks:
- the declarations, the move of the meeting policy read, the probe and the allowlists;
- that fixture proof never enables a read;
- identities, field filtering and redaction;
- the denied, crashed and empty cases;
- activation (including a MicrosoftTeams version change), persistence and the coverage
  entry.

Three mutations were run by hand and each failed the tests: accepting a non-`Global`
singleton, treating an empty family as complete, and dropping the Teams prerequisite.

The read-only probe (`ops/powershell/probe-workloads.ps1`) now runs all nine cmdlets in
its Teams block (the meeting policy and federation reads were already there).

## What an operator must do to live-qualify it

1. Qualify the Teams workload first (`docs/roadmap/teams-live-acceptance.md`). These
   reads cannot activate before it.
2. Make sure the collector app holds the Teams Administrator role.
3. On the host, run the read-only probe for Teams with the collector credential: a
   `run-job.sh` job `{ "mode": "probe", "workload": "teams" }` in the PowerShell
   container, or `probe-workloads.ps1 -Workloads teams` directly. Save its JSON output.
4. Import the capture and the observed grants:
   `node tools/qualification/workloads.mjs --tenant-ref sha256:... --capture probe.json --grants grants.json`.
   Each `teams.*` cmdlet row that read successfully becomes `live-qualified`. The
   capture is bound to the MicrosoftTeams version (pinned at 7.9.0 in the Dockerfile);
   a version bump needs a new capture.
5. Run one gated collection and compare the stored fields with the Teams admin center.
   Fields reported `unknown` are names the installed module does not return; correct
   the declared list in `FAMILIES` if needed.

## Not included

- **Restore.** Nothing here writes. Restoring policies and configuration is a separate
  task, once these reads are live-qualified.
- **Policy assignments.** Which users and groups each policy is granted to
  (`Get-CsOnlineUser`, group policy assignments) is not read. Without it, a backup says
  what a policy contains, not who it applies to.
- **Other Teams policies.** Calling, live events, channels, update management, voice
  routing, emergency and feedback policies, and app-centric management, are not read.
- **Live facts.** Field names come from Microsoft's documentation, which could not be
  fetched from this environment, and have not been measured live. The new Teams session
  in `run-cmdlet.ps1` uses the same connection as the probe but has not been run.
