# Teams configuration workload qualification (task 121)

Date: 2026-10-03 UTC. Status: the code half is implemented and fixture-tested.
**The gate stays pending.** No live evidence exists, no tenant was read or written,
and every Teams read and write stays disabled.

The external admission gate needs things that cannot exist in a builder container:
- a disposable `KEEL-RT-*` Team and a membership fixture user;
- a verified task-120 SharePoint record (itself still pending);
- a live Teams capture from the real tenant, signed by the release runner.

This task builds everything else: the evidence contract, the gate validator, the
capture tool the operator runs, the import seam into the task-101 and task-103/104
ledgers, and the boundary tests. The checked-in record
`docs/release/qualifications/teams-live-acceptance.json` is a placeholder with
`status: "pending"`. It fails `verify --require-live`, and it is meant to.

## What was built

### Gate validator (`tools/qualification/teamsAcceptance.mjs`)

`validateTeamsLiveSubject` is registered additively in
`tools/release/qualification.mjs` as gate `teams-live-acceptance` (one entry in
`GATE_VALIDATORS`; the wrapper passes the runner-proof result and the release
`verifyEvidence`, so the module never imports the release verifier). It checks the
record against the production declarations it qualifies, not against a copy:
- the four task-104 reads (`WORKLOAD_DESCRIPTORS`): `teams.team-discovery`,
  `teams.settings`, `teams.membership` and `teams.group-membership`;
- the four task-104 writes (`WORKLOAD_WRITE_OPERATIONS`): `teams.settings.update`,
  `teams.membership.add`, `teams.membership.update` and `teams.membership.remove`.

On top of the generic verifier (schema, gate, tenant, freshness, `--require-live`),
a record passes only when all of these hold.

| Check | Rule |
| --- | --- |
| Identity | Operation `teams.configuration-qualification`. The build matches the expected build. Credential mode is `collector-read+restorer-write`. An expected tenant and build are both required. The record names the managed directory tenant id; the fixture team and the fixture user both belong to it. |
| Proof | Both proofs are needed: a trusted runner signature, and the SHA-256 of the raw capture log. The log digest is also inside the signed subject (`captureLogSha256`), so a log swapped together with its proof digest still fails. |
| Prerequisites | Tasks 104 and 120 are named, and the Teams declarations exist in this build. The task-120 SharePoint record named in `sharePointQualification` must sit beside this record and verify on its own with `--require-live`, for the same tenant and build, and its capture-log digest must be the one named. |
| SharePoint is not Teams proof | The SharePoint record is a prerequisite only. Every Teams read and write needs its own capture in this record; a SharePoint operation id in a Teams slot fails; the Teams log digest may not equal the SharePoint one; the SharePoint record fails this gate (gate mismatch) and the Teams import seam. |
| Reads | Each read has a successful, non-synthetic capture at its declared API version, with its page count recorded, taken no more than 24 hours before the record. All five settings groups were observed live. |
| Grants | The collector holds every permission the four reads declare. The restorer holds `TeamSettings.ReadWrite.All` and `TeamMember.ReadWrite.All`. The collector must **not** hold a write permission. The two credential references must differ. |
| Fixture | One team whose display name starts with `KEEL-RT-`, and one membership fixture user who was absent from the team before the capture and is absent after it. |
| Zero content calls | Every logged request is re-checked against the task-104 `assertTeamsRequest` shapes (no channel, chat, message, tab or file path; only `$top`/`$skiptoken`) and the task-101 scope validator. Only the fixture team and its group are addressed. The restorer reads only the fixture team and its members. The collector never writes. The only POST adds the fixture user; every membership PATCH or DELETE addresses the fixture user's membership. |
| Write counts | Exactly 2 settings PATCHes (change, put back), 1 POST, 2 membership PATCHes (promote, demote), 1 DELETE. A throttled (429/503) write was not applied and is not counted. |
| Settings post-state | Mode `reversible-change`, on a written settings group. The change read back as written, the group was put back, and the final settings fingerprint equals the starting one. |
| Membership post-state | Each of the three membership writes has its own capture: applied, read back, fresh. The final membership fingerprint equals the starting one. |
| Throttle | The number of 429 and 503 responses is recorded. A count of zero is valid. |
| Documentation | The record gives a retrieval date for each of the eight declared documentation URLs (Global Constraint 8). |
| No secrets | No key or value in the record looks like a token, secret, password, private key or JWT. |

A record with `status: "pending"` fails before any other check. A record that
claims `live-qualified` while synthetic, or signed by `keel-fixture-runner`, fails
even without `--require-live`.

### Capture tool (`tools/qualification/teamsLive.mjs`)

- **`plan` (the default)** is offline. It prints every request a capture would
  send.
- **`capture`** refuses to run (exit 2, nothing sent) without
  `--confirm-live-tenant-write`. It also refuses before any request when:
  - the team id, fixture user id or directory tenant id is not a GUID;
  - the two credential references are missing or the same;
  - the tokens are not in the environment;
  - the task-120 SharePoint record does not verify with `--require-live` for this
    tenant and build, or does not sit beside `--out`.
- **Requests, in order.** Every one is checked against the task-104 Teams request
  shapes before it is sent.
  1. The collector reads team discovery (all pages). Only the team count is kept.
     The fixture team must be listed and named `KEEL-RT-*`; otherwise nothing more
     is read or written.
  2. The collector reads the fixture team, its members and its group's members. A
     team in another tenant is never written.
  3. The restorer reads the team, PATCHes `funSettings` with `allowCustomMemes`
     flipped, reads it back (up to 5 reads, 2 s apart), PATCHes the original
     `funSettings` back, and reads that back.
  4. The restorer POSTs the fixture user as a member, reads it back, PATCHes its
     roles to `owner`, reads back, PATCHes them back to member, reads back, DELETEs
     the membership, and reads back.
- **Write legs.** They run only when every read succeeded, the fixture user is not
  already a member, and the team has an owner other than the fixture user.
  - Both writes are **team-scoped**. No tenant-wide setting is touched (unlike the
    task-120 SharePoint capture).
  - After an accepted first PATCH, the put-back is always attempted. After an
    accepted POST, the DELETE is always attempted, whatever failed in between.
  - If a put-back or the removal fails, the output says exactly what to fix by
    hand, and the exit code is 3.
- **Tokens and proof.** Tokens are read from `KEEL_TEAMS_COLLECTOR_TOKEN` and
  `KEEL_TEAMS_RESTORER_TOKEN` and never written. The record holds credential
  references only. The tool writes the record and its raw request log
  (`*.capture.json`) side by side and binds the log's digest as the artifact proof.
  With `KEEL_QUALIFICATION_HMAC_KEY` set, it signs the record as
  `keel-release-runner`. It then runs the gate verifier and prints the result.

### Import seam (`ledgerEvidenceFromTeamsAcceptance`)

A record that passes the gate with `--require-live` becomes:
- `live-capture` evidence for the four Teams reads in `buildWorkloadLedger`;
- one `live-write-capture` per Teams write for `workloadWriteQualification`;
- the collector's grants.

Anything that fails verification becomes nothing. The Teams writes stay disabled
unless SharePoint's own write is also qualified (the existing task-104 `requires`),
so Teams evidence alone never enables them. Nothing in production calls this seam
yet, so no read or write is enabled by this task.

## Server, CLI and UI integration

- **CLI:** the release CLI verifies the new gate
  (`node tools/release/qualification.mjs verify --gate teams-live-acceptance ...`).
  The capture tool is the operator CLI.
- **Server and UI:** none in this task. There is no evidence to show yet, and the
  existing coverage and workload views already show the Teams operations as
  disabled with their reason. Wiring the imported evidence into `collectTeams` and
  `executeTeamsRestore` is follow-up work once a verified record exists.

## Migration and legacy reads

- No schema change and no data change.
- The release CLI keeps its existing behaviour for every other gate. The Teams checks
  apply only when `gate` is `teams-live-acceptance`.
- No legacy Teams qualification record exists. Any record without the fields above
  fails closed.

## Operator steps

These are needed to clear the gate. Run them from `/opt/keel` at the build being
qualified. Builders must not run them.

1. **SharePoint first.** Complete the task-120 operator steps
   (`docs/roadmap/sharepoint-live-acceptance.md`) at this same build. Its record
   `docs/release/qualifications/sharepoint-live-acceptance.json` and its capture log
   must verify and stay where they are.
2. **Fixture team.** Create a disposable private team named `KEEL-RT-<yyyymmdd>`
   with no content. Its owner is the operator (or another account), never the
   fixture user. Note its id (the group id).
3. **Membership fixture.** Use a disposable member (not guest) account in the
   managed tenant, for example `keel-rt-member@<tenant>`. It must **not** be a member
   of the fixture team before the capture. Note its object id. Open decision for
   the operator: whether such an account may exist permanently, or is created for
   the capture and deleted after.
4. **Credentials.** Use two separate apps.
   - **Collector:** `Team.ReadBasic.All`, `TeamSettings.Read.All`,
     `TeamMember.Read.All`, `GroupMember.Read.All`.
   - **Restorer:** `TeamSettings.ReadWrite.All`, `TeamMember.ReadWrite.All`.

   These are tenant-wide application permissions (Graph has no per-team app
   consent for these operations). The capture only addresses the fixture team, and
   the record proves it, but granting them is an open operator decision. Put what
   each app actually holds into `grants.json`:
   `{ "collector": { "permissions": [...], "roles": [] }, "restorer": { ... } }`.
5. **Documentation.** Re-read the eight pages and record each URL with its retrieval
   time in `docs.json`: `[{ "url": "...", "retrievedAt": "<ISO time>" }]`. The URLs
   are printed by:
   ```bash
   node -e "import('./tools/qualification/teamsAcceptance.mjs').then(m => console.log(m.teamsRequiredDocumentation().join('\n')))"
   ```
6. **Preview, offline:**
   ```bash
   node tools/qualification/teamsLive.mjs plan --fixture-team-id <team id> --fixture-member-user-id <user id>
   ```
7. **Capture.** Tokens are acquired by the operator, and the HMAC key is the release
   runner's:
   ```bash
   KEEL_TEAMS_COLLECTOR_TOKEN=... KEEL_TEAMS_RESTORER_TOKEN=... KEEL_QUALIFICATION_HMAC_KEY=... \
   node tools/qualification/teamsLive.mjs capture --confirm-live-tenant-write \
     --tenant-ref <tenant_ref> --directory-tenant-id <tenant id> \
     --fixture-team-id <team id> --fixture-member-user-id <user id> \
     --collector-ref app:<collector app id> --restorer-ref app:<restorer app id> \
     --grants grants.json --docs docs.json --build "$(git rev-parse HEAD)" \
     --sharepoint-evidence docs/release/qualifications/sharepoint-live-acceptance.json \
     --out docs/release/qualifications/teams-live-acceptance.json
   ```
   This replaces the pending placeholder and writes
   `teams-live-acceptance.capture.json` next to it. Exit codes:
   - 0: verified;
   - 1: captured, but did not verify;
   - 2: refused before any request (including an unverified SharePoint record);
   - 3: check the fixture team's `funSettings` or membership by hand.
8. **Verify** (the task's final Validate step):
   ```bash
   KEEL_QUALIFICATION_HMAC_KEY=... KEEL_QUALIFICATION_TENANT_REF=<tenant_ref> \
   node tools/release/qualification.mjs verify --require-live --gate teams-live-acceptance \
     --evidence docs/release/qualifications/teams-live-acceptance.json
   ```
   The record is valid for 30 days, only for the build it names, and only while the
   SharePoint record beside it also verifies.

## Proof

`engine/roadmap/teams-live-acceptance.test.mjs` has 9 tests. They need no database.
Both capture tools run against in-memory Graphs. The SharePoint one produces the
verified task-120 prerequisite. The Teams one:
- throttles the first discovery page and pages discovery twice;
- serves a KEEL-RT team and a Finance team, an owner and a fixture user;
- applies settings PATCHes and membership POST/PATCH/DELETE.

Records are signed with a test-only key in a temporary directory and never kept.

- **A valid capture verifies.** The Finance team is never addressed, there are zero
  content calls, there are exactly the expected writes, and the team and its
  membership end where they started.
- **An altered signature, an edited field, an edited capture log, or a swapped log
  with its own digest** each fail.
- **Wrong tenant, build, operation, credential mode, gate, write operation, API
  version, shared credentials, a non-KEEL-RT team, or a team, user or directory in
  another tenant** each fail, even when re-signed by the trusted runner.
- **Stale evidence fails:** an old record (and its SharePoint prerequisite with
  it); a read, settings write or membership write captured long before the record;
  an undated documentation entry.
- **A missing prerequisite fails:** task-120 not named; no, absent, wrong-gate or
  wrong-digest SharePoint reference; a tampered SharePoint record; a SharePoint
  record for another build; a missing or failed read; unrecorded paging; a missing
  permission; a collector holding a write permission; an unobserved settings group;
  a missing settings or membership write capture.
- **SharePoint is not Teams proof:** the SharePoint record fails this gate and the
  Teams seam; SharePoint evidence alone leaves every Teams read and write
  unqualified; a Teams log digest equal to SharePoint's fails.
- **Missing external evidence fails.** The checked-in pending record fails, with or
  without `--require-live`, and the release CLI exits 1 on it. An absent file fails.
  So does a record without its capture log or without a runner signature.
- **Fixture evidence is never elevated:** a fixture-runner signature, a synthetic
  record, a `fixture-tested` level, a synthetic read, a synthetic write, or a
  same-value write each fail. The import seam yields nothing for them. A verified
  Teams record plus the verified SharePoint record enable every Teams write, each
  on its own Teams capture, for their own tenant only; Teams evidence without
  SharePoint's enables none.
- **Request-log checks.** A channel path, `/chats`, a `$expand=channels`, another
  team or group, a collector write, a restorer write to another team, a restorer
  group read, an extra settings PATCH, adding another user, removing another
  membership, or a second DELETE each fail. A throttled write resent after
  Retry-After does not. A token in the record fails.
- **The tool:** `plan` and an unconfirmed `capture` send nothing; non-GUID ids and
  a missing SharePoint reference are refused; the CLI refuses on an unverified
  SharePoint record with zero requests; a non-KEEL-RT team, a team in another
  tenant and an already-present fixture user each get zero writes; a platform that
  ignores settings or role writes does not verify; a failed put-back or removal is
  reported (exit 3) and never verifies.

Required mutations were each applied alone and then restored (2026-10-03):

| Mutation | Pass | Fail |
| --- | --- | --- |
| Accept missing external evidence (a pending Teams record verifies) | 8 | 1 |
| Accept missing external evidence (no capture log required) | 7 | 2 |
| Accept missing external evidence (no SharePoint prerequisite check) | 7 | 2 |
| Accept mismatched operation (no operation check) | 8 | 1 |
| Accept mismatched tenant (no cross-tenant check) | 7 | 2 |
| Accept mismatched tenant (fixture team in another directory) | 8 | 1 |
| Elevate fixture evidence to live-qualified (no fixture-claim check) | 8 | 1 |
| Elevate fixture evidence to live-qualified (import seam without `--require-live`) | 8 | 1 |

**Validation:** `node --test engine/roadmap/teams-live-acceptance.test.mjs
engine/authz/*.test.mjs engine/jobs/*.test.mjs engine/collect/*.test.mjs
engine/coverage/*.test.mjs engine/cir/*.test.mjs` gives 23 pass, 0 fail.
- The final `verify --require-live` step was run on the pending placeholder. It
  exits 1 with "teams-live-acceptance external runner evidence pending", as it must
  until the operator captures evidence.
- The CI restore-engine set, with the new suite added, gives 336 pass, 0 fail.
- Portal: `npm test` gives 142 pass, and `npm run build` is clean.

## Limitations

- **No live proof.** This task proves the gate's code behaviour only. Whether
  Microsoft accepts the PATCH and membership writes, what the team body really
  returns, how long read-back takes, and the real permissions are all unknown
  until a capture runs.
- **Blocked behind SharePoint.** The task-120 record is pending, so this gate
  cannot clear before it.
- **Documentation not re-fetched.** learn.microsoft.com is not reachable from this
  environment, so the declared URLs come from tasks 101 and 104. The capture
  requires the operator to re-read them.
- **One settings property.** The live write proves `funSettings.allowCustomMemes`
  round-trips. The other settings groups are qualified as observed by the live
  read only. The restore's own read-back (`verification-failed`) remains the
  per-run check for them.
- **Membership of one user, one tenant.** The capture proves add, role change and
  removal of one same-tenant member. Cross-tenant members (shared channels, B2B
  direct connect) and guests stay manual, as task-104 decided. Group membership is
  read only; it restores through the Entra group path, not here.
- **Open operator decisions:** the permanent or per-capture fixture user (step 3)
  and granting the tenant-wide Teams application permissions (step 4). No
  tenant-wide Teams setting is changed by the capture.
- **Nothing is wired yet.** No worker job or portal view consumes the import seam.
- **Teams meeting policies.** `teams.meeting-policies` (MicrosoftTeams module) is
  not part of this gate. It stays unqualified. Issue #154 moved it into the
  `teams-org-policies` workload ([teams-org-policy-reads.md](teams-org-policy-reads.md)).
