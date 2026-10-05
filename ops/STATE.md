# KEEL handoff state

**Read this first if you are a new or reconnected session.** It says where every workstream
stands and where to pick up. It lives on branch `claude/operator-queue` (never merged to master, so
edits don't deploy), next to the work queue `ops/operator-queue.md`.

- **Maintainer:** each task thread sends updates for its own row in **Tasks** to the KEEL
  coordinator thread in the "Keel" Claude project, which owns the rest of this file. If you are a
  cold session without that thread, update this file yourself and say so in the change log.
- **Last updated:** 2026-10-04 22:35 UTC

## How the work is organized

| Who | What | Where |
|---|---|---|
| Coordinator (cloud, project thread) | Gate plan, queue items, PR review and merge, this file | `ops/operator-queue.md` items; this file |
| **keel-operator** (Remote Control session on the VPS, `claude-keel-operator.service`, workspace `/opt/rc-keel-operator`) | All tenant, host and ServiceNow work. It polls the queue every 20 min and writes only `Status`/`Result` | `ops/operator-queue.md` |
| **vps-deployer** (always-on VPS session) | Verifies every master auto-deploy (health, Access gate, schema). Daily notes at `/opt/ai-vault/daily/` | — |
| Human operator (Marouane) | Decisions in the queue's **Operator decisions** section, merges the classifier blocks for Claude, UI-only steps | — |

- **Repo:** `7empes7s/keel`. Every green push to master auto-deploys to `keel.techinsiderbytes.com`
  (Cloudflare Access, team `teibytes`), which moves `/opt/keel-live`. Don't merge to master while
  keel-operator is running a same-build chain (120 → 123).
- **Old coordinator session** `session_01HgPnSVHKzzdtK4mY2PEVox` ("KEEL Developer") ran the
  overnight roadmap run and set up the queue. It is superseded; don't resume it.

## Tasks

One GitHub issue per task (label `task`), one project thread per issue, one branch and PR per
issue with `Closes #N`. Tenant and host steps are still Q-items in `ops/operator-queue.md`; each
Q-item names its issue. Plan: `/mnt/project-files/notes/keel-project-management-plan.md`.
**Master is unfrozen (2026-10-05 12:55 UTC).** Gates 120 → 123 all verified at `248b12c`; evidence in PR #110. #109
(LabelActions reader) will need one more full chain rerun at its build, so the freeze returns briefly then.

| Task | Issue | Thread | PR | State | Blocker |
|---|---|---|---|---|---|
| Gates 120 → 123 same-build chain | #84 | [Continue earlier session](https://claude.ai/code/project/chan_01UnkUEPVPkFeErfJUUirWJZ?thread=cmsg_01UnkUEPVPkFeErfJUUirWJZVsbWJRxWn9A9AMnkNVwCUk) | #106–#108 merged; evidence PR #110 merged 13:01 | **Chain passed at `248b12c`** (Q10): 120 60683a5, 121 211a372, 122 da8a341, 123 eeac328, all verify --require-live side by side. 123 lists 10 label action fields as notQualified | keel-powershell rebuild (Marouane go to vps-deployer); #109 LabelActions reader after Q34, then a chain rerun |
| Gate 116 drill | #85 | [Gate 116 drill live acceptance](https://claude.ai/code/project/chan_01UnkUEPVPkFeErfJUUirWJZ?thread=cmsg_01UnkUEPVPkFeErfJUUirWJZW3FgPouVRVvqwWbHs3ALBQ) | #96 (doc fixes + Global Administrator satisfies the PIM setup step), merged as `36fc2b3` | #96 merged; read setup run cbd974b9ef10… complete (Entra only, ffa05cd); Q27 done | After Q10: Q33 (keel-operator runs the fresh restore setup and removes Intune Administrator from the Collector, per Marouane 07:15), then Q32 (onboarding check, then Q6) |
| Gate 124 release ledger | #86 | [Gate 124 release ledger](https://claude.ai/code/project/chan_01UnkUEPVPkFeErfJUUirWJZ?thread=cmsg_01UnkUEPVPkFeErfJUUirWJZ78W5MeDY3yc4Wg5ejWzEB4) | #102 (tests and docs), merged as `6fee591` | Merged; first checkbox done (ledger code b81a41d) | Recapture of every gate at one frozen build and ledger verification wait on #84 and #85 |
| CLAUDE.md with brain markers | #87 | [CLAUDE.md with brain markers](https://claude.ai/code/project/chan_01UnkUEPVPkFeErfJUUirWJZ?thread=cmsg_01UnkUEPVPkFeErfJUUirWJZCa2V6KyBhYrHTm5E3V12tA) | #95 (supersedes #80, closed), merged as `702b1ee` | Done (issue closed) | None. `adopt.sh` run twice still unverified against the real brain script (needs a brain-side session) |
| Status test temp dir | #88 | [Status test temp repo cleanup](https://claude.ai/code/project/chan_01UnkUEPVPkFeErfJUUirWJZ?thread=cmsg_01UnkUEPVPkFeErfJUUirWJZVCPMsKvDN3LrLbaz9mMJaZ) | #94 (supersedes #76, closed), merged as `c4e24ac` | Merged | None |
| Offsite backup unreachable | #89 | [Offsite backup unreachable](https://claude.ai/code/project/chan_01UnkUEPVPkFeErfJUUirWJZ?thread=cmsg_01UnkUEPVPkFeErfJUUirWJZ6zVkB3Qz4cxyHC1zVLpizB) | #100 merged as `c99a9f2`; docs PR #112 (automerge) | **Done** (Q31, 13:12): offsite ships to vol2 daily at 05:00 UTC; first copy byte-identical | #112 merge (waits on Actions billing) |
| Prune timer review | #90 | [Prune timer review](https://claude.ai/code/project/chan_01UnkUEPVPkFeErfJUUirWJZ?thread=cmsg_01UnkUEPVPkFeErfJUUirWJZAoaKxKpgCH9bFBkK8S5L1g) | #99, merged as `b2b805e` | Merged; dry run reviewed (154 old tier1, none cited by evidence) | Q29 (enable prune schedule) on hold until Q10 and Q24 |
| Install scheduler and backup tiers on host | #91 | [Scheduler and backup tiers on host](https://claude.ai/code/project/chan_01UnkUEPVPkFeErfJUUirWJZ?thread=cmsg_01UnkUEPVPkFeErfJUUirWJZ4gUNdfJyPJbfk8jRZCp3aX) | #97, merged as `aeff999` | **Done** (Q24, 14:15): stale jobs cancelled via #111; worker + scheduler installed; run-now tiers 1-3 succeeded; health ok | deploy.sh worker restart (Q24 step 4) with vps-deployer |
| `restorer-target.json` default path | #92 | [Restorer config default path](https://claude.ai/code/project/chan_01UnkUEPVPkFeErfJUUirWJZ?thread=cmsg_01UnkUEPVPkFeErfJUUirWJZY5AVuWPES3U92Knng5WyA2) | #98, merged as `76e503e` | Merged; portal and worker default to `/etc/keel/restorer.json` | Q30 (on hold until Q10): remove the Q19 override and confirm Setup still reads the Restorer config |
| Restorer least-privilege review | #93 | [Restorer least-privilege review](https://claude.ai/code/project/chan_01UnkUEPVPkFeErfJUUirWJZ?thread=cmsg_01UnkUEPVPkFeErfJUUirWJZYGhJ3mTtztP3RYusGMSxb3) | #101 (review doc; `groupSetting` declares GroupSettings.ReadWrite.All), merged as `796f3a4` | Merged | Q26 inventory (on hold until Q10); operator decisions D-93a, D-93b |

### Gate evidence

Records bind to one build; task 124 recaptures every live gate at one frozen release-candidate build.

- 113 deployed-acceptance: verify ok at `33ad2a9`, `claude/live-evidence-113` @ 48d37ca (on master via #75).
- 114 storage: verify ok at `df0de36`, `claude/live-evidence-114` @ 4b1d3da (copy on `/mnt/keel-copy`).
- 115 native: verify ok at `33ad2a9`, `claude/live-evidence-115` @ b965a66.
- 116 drill: Setup host deployed (2e8a5b9, Q19 canCheck true, no writes enabled); recovery key enrolled (Q20, key id `officer-2026-10`, trust store `/etc/keel/recovery-authenticators.json`).
- 117 sentinel: descoped by the operator (12:36 UTC).
- 118 ServiceNow: verify ok at `87e366e`, `claude/live-evidence-118` @ 4ec37c1.
- 119, 126 (NIST, ScubaGear): already qualified.
- 120 → 123: at `df4082a`, 120 passed (`claude/live-evidence-120` @ 12d3547); 121 exit 3 on Teams roster lag (restore real, no residual). Earlier: at `ffa05cd` 121 refused on a residual owner from the 2b2c338 run. **`claude/live-evidence-121` @ 9ec0e2f is void; never merge it.** The 120 and 121 records merge together.

Committed evidence rule (#75 → `359ec7c`): a committed live record must be live-qualified, bind its
raw capture's sha256, carry no credential material, and fail verification without the HMAC key
(`engine/test/committedEvidence.mjs`).

## Waiting on the human operator

1. Restorer least privilege (#93): D-93a and D-93b in the queue.

## Infrastructure facts

- **VPS** (Hetzner): root disk was 91% full (14 GB free) on 2026-10-03. Second volume
  `/dev/sdb` (97.9 GB, ext4) mounted at `/mnt/keel-copy` (fstab, `nofail`) for gate 114.
- Scheduled collection and the tier-1/2/3 backup services from `ops/` are **not installed** on the host
  (only `keel-portal`, `keel-deploy` and the status generator). The nightly DB dump comes from a
  separate host script. The deploy never rebuilds the PowerShell image (Q12 report).
- The Restorer app holds ~52 write permissions plus 9 directory roles, far more than needed. A
  least-privilege review is a suggested follow-up, not started.
- keel-operator hasn't been tested through a crash or reboot.
- The nightly DB dump (`mimule-backup`, outside KEEL) overwrites its file in place: the 14:21 rerun on
  2026-10-04 replaced the 04:04 dump (Q23). No owning issue yet.

## ServiceNow (gate 118)

- Instance `dev426571.service-now.com` (non-production; `glide.installation.production` set to
  `false` with operator authorization, 11:22 UTC). Credentials in `/etc/keel/servicenow.env`;
  auth is the OAuth password grant.
- Created: table `u_keel_change` (approved state `gate_passed`; rejected `gate_blocked` and
  `gate_withdrawn`), table `u_keel_callback_relay`, property `x_keel.callback_signing_key_b64`,
  business rules `keel-callback-relay` and `keel-qualification-approver`, role
  `u_keel_change_user` with two ACLs (read, write; made by the operator in the UI), test users
  `keel-rt-sn-one` and `keel-rt-sn-two`.
- Host: `/etc/keel/servicenow-qualification.env`, `/etc/keel/servicenow-qualification/`
  (config, test users, record template, docs.json), and Postgres DB `keel_servicenow_qualification`.
- 4 `u_keel_change` records from the capture are left in place (deletable).

## AWS

- New account (new AWS experience) on the $100 free-credit tier, Region `eu-north-1`. **Create
  nothing billable without saying so first.** No AWS resources exist yet.
- **Set up on the VPS (as root), 2026-10-04 12:45 UTC:**
  - AWS CLI 2.37.9 in `/root/.local/bin`. Profile `keel` is signed in (account ending 5390, role
    `AccountFullAccessRole`). Login lasts 12 h and auto-renews for 90 days; after that run
    `aws login --profile keel --remote`.
  - aws-mcp in `~/.claude.json` uses `AWS_MCP_PROXY_PROFILES=keel` (backup `~/.claude.json.bak-aws`).
  - 24 AWS skills installed for Claude Code (`~/.claude/skills`), Codex/Gemini/OpenCode
    (`~/.agents/skills`) and OpenClaw (`~/.openclaw/skills`). AWS rules sit in `/root/.claude/CLAUDE.md`
    between `BEGIN/END AWS Agent Toolkit rules` markers (not the repo CLAUDE.md).
- **Open:**
  1. Budget guard `keel-monthly` **created** (Q22, 16:50): $25/month, alerts at 50/80/100% actual and 100% forecast. AWS may send a subscription-confirmation email to accept.
  2. keel-operator needs a restart to load the AWS MCP server; do it between gate chains.
  3. Decide whether OpenClaw keeps the AWS skills.
- Scripts live in the project shared files `/mnt/project-files/aws/` (not the repo).
- Owned by the "AWS Agent Toolkit setup" project thread, which sends changes here.

## Hard limits (don't try to route around them)

The auto-mode classifier blocks these for Claude, even with the operator's chat approval: editing
tests that pin evidence as pending, writing permission-grant decisions, secret-store writes, merging
PRs ("Merge Without Review"). Never fabricate or hand-edit evidence; never print or commit secrets;
tenant fixtures are only `KEEL-RT-*` or `keel-rehearsal-*`.

## Change log

Last 24 hours only; git history keeps the rest.


- 2026-10-04 12:40: file created by the coordinator. Q16–Q18 done (gate 118 captured); Q17 needed
  two operator-made ACLs; Q15 mounted the second volume and finished gate 114.
- 2026-10-04 12:45: D-117 answered: Sentinel scratched, gate 117 descoped. D-118 confirmed (ServiceNow OAuth + ACLs done).

- 2026-10-04 12:50: AWS section updated from the AWS thread (budget name, MCP profile env, verify commands).
- 2026-10-04 12:55: PR #73 author notes added (Collector read grants needed for Setup checks).
- 2026-10-04 13:00: AWS setup done on the VPS; budget guard still to run; keel-operator restart pending.
- 2026-10-04 13:35: PR #73 merged (`2e8a5b9`); master deploy and Q19 next.
- 2026-10-04 13:50: D-120b given in keel-operator's session and grants made; Q10 blocked on dead doc URLs; PR #74 opened.
- 2026-10-04 13:55: gate 116 recovery key handed to keel-operator as Q20 at the operator's request.
- 2026-10-04 14:00: Q19 done (Setup can check; no writes enabled), Q20 done (recovery key enrolled), Q21 queued; PR #75 opened for the evidence + test change.
- 2026-10-04 14:30: PR #75 merged (`359ec7c`, by the operator; Claude's merge was blocked again). Master CI running; #74 next.
- 2026-10-04 14:32: PR #74 merged (`124fbc6`) a few seconds after #75. Q10 told to run at `124fbc6` once deployed; master frozen until the chain is done.
- 2026-10-04 15:05: Q10 at `124fbc6`: 120 passed, 121 refused (Graph omits team `tenantId`). PR #77 opened with the tool fix; chain reruns after it deploys.
- 2026-10-04 15:22: PR #77 merged (`2b2c338`). Q10 told to rerun 120 → 123 at `2b2c338` once deployed.
- 2026-10-04 16:50: Q10 at `2b2c338`: 120, 121 passed; 122 refused (EXO org id empty). PR #82 opened. Master moved to `34f550b` (#78, #79, another thread). keel-operator asked to message the coordinator thread on every Q10 status change (the coordinator missed the 15:35 result for an hour).
- 2026-10-04 16:55: Q22 queued (AWS budget guard via `ops/aws/budget-guard.sh`, operator-directed).
- 2026-10-04 17:13: PR #82 merged (`ffa05cd`). Q10 told to rerun 120 → 123 at `ffa05cd` once deployed.
- 2026-10-04 17:30: Q22 done (AWS budget `keel-monthly` created). Q10 in progress at `ffa05cd`.
- 2026-10-04 18:00: Q10 at `ffa05cd`: 120 passed; 121 refused on a residual group owner from the 2b2c338 run, whose 121 record is void. PR #83 opened (owner-link fix).
- 2026-10-04 18:07: PR #83 CI green; waiting for the operator's merge.
- 2026-10-04 20:30: tasks moved to GitHub issues #84–#93 (label `task`, operator-approved 20:19). "Open PRs" and the gates free-text column replaced by the Tasks table. Infrastructure, ServiceNow and AWS sections move to a docs file on master after the freeze.
- 2026-10-04 20:35: thread links filled for #85–#93. #88: PR #94 replaces #76. #89: Q23 queued (read-only offsite diagnosis).
- 2026-10-04 20:40: rows #85 (PR #96), #86, #87 (PR #95 replaces #80) updated from their threads. Collector read grants decision dropped: Q21 found them already held.
- 2026-10-04 20:45: #91 row (PR #97). Q24 (install scheduled collection) added on hold until #84 finishes and #97 deploys.
- 2026-10-04 20:50: #92 row (PR #98). Drop the `restorer-target.json` infrastructure fact when #98 merges.
- 2026-10-04 20:55: #90 row (PR #99); Q25 meant to be queued (landed 21:05). Q23 done (#89: offsite host unreachable, timer never enabled).
- 2026-10-04 21:00: #89 row (PR #100, blocked on the offsite host). Dump-overwrite finding added to infrastructure facts.
- 2026-10-04 21:05: #93 row (PR #101); Q26 (Restorer grants inventory) on hold; D-93a/D-93b added to Operator decisions.
- 2026-10-04 21:10: Q27 queued (#85: set onboarding operator id; Entra-only read setup chosen by the operator). Not to run during Q10.
- 2026-10-04 21:15: #85 read setup complete (Entra only); restore setup waits on Q27.
- 2026-10-04 21:20: #85: operator has no PIM (permanent Global Administrator); PR #96 accepts that. Restore setup waits on #96 deploy and Q27.
- 2026-10-04 21:05: Q25 done (prune dry run; #90 thread reviewing). Q27 done (#85 operator id set; read setup complete).
- 2026-10-04 21:10: #90: Q28 queued (read-only breakdown of the 154 snapshots the dry run would prune).
- 2026-10-04 21:15: #89: operator chose vol2 (`/mnt/keel-copy`) as the offsite target; PR #100 updated.
- 2026-10-04 21:20: master moved to b81a41d (operator commit: gate 117 recorded as an accepted gap). Q10 was not running (blocked on #83), so no evidence is affected; the chain build stays "#83's merge commit", which will include b81a41d.
- 2026-10-04 21:35: Q28 done; #90 dry run reviewed. Q29 (enable prune schedule) added on hold.
- 2026-10-04 21:45: PR #83 merged by the operator as `df4082a`. Q10 told to rerun 120 → 123 at that build once deployed. Master stays frozen until the chain finishes.
- 2026-10-04 22:35: Q10 at `df4082a`: 120 passed; 121 exit 3 (owner-link fix worked, but the roster lagged ~60-90 s past the tool's window). PR #103 widens the window to ~3 min. Freeze continues.
- 2026-10-05 02:00: #103 merged as `5a7f58c`. Q10 rerun at that build once master CI is green and it deploys. Freeze continues.
- 2026-10-05 02:05: #98 (`76e503e`) and #94 (`c4e24ac`) merged. Chain runs at the deployed master head. Q30 (#92) added on hold. Dropped the `restorer-target.json` fact.
- 2026-10-05 02:10: operator merged #95 (#87 done), #96, #97, #99, #100. Chain now runs at `c99a9f2` or later. Host Q-items (Q24, Q26, Q29, Q30, #89's) all wait for Q10.
- 2026-10-05 02:15: #101 and #102 merged; master `6fee591`, no open PRs. Q31 (#89 offsite enable) added on hold.
- 2026-10-05 02:20: Q32 (#85 onboarding check, then Q6) added on hold.
- 2026-10-05 02:55: Q10 at `6fee591`: 120 passed; 121 exit 3 (Teams created the group owner link after the tool's DELETE). Operator cleaned up. PR #104 re-deletes the link whenever seen. Freeze continues.
- 2026-10-05 05:45: #104 merged as `94ddb0a`. Q10 reruns at that build. Freeze continues.
- 2026-10-05 06:35: at `94ddb0a` 120 and 121 passed; 122 refused (alice's mailbox timeZone is null). Q10 re-queued: set timeZone UTC on the fixture, then 122 and 123.
- 2026-10-05 07:20: Q33 (#85 restore setup + Collector Intune role removal, by keel-operator per Marouane 07:15) added on hold until Q10; Q32 now waits on Q33.
- 2026-10-05 07:40: at `94ddb0a` 120-122 passed (alice timeZone set to UTC); 123 refused before writing (pwsh warnings ahead of JSON). PR #105 fixes the parse. Freeze continues.
- 2026-10-05 08:10: #105 merged as `38979f6`; Q10 reruns at that build. Freeze continues.
- 2026-10-05 09:10: at `38979f6` 120-122 passed; 123 refused before writing (Get-LabelPolicy location entries are objects). PR #106 fixes the check. Image rebuild agreed for after the chain. Freeze continues.
- 2026-10-05 09:15: #106 merged as `c3bd35d`; Q10 queued to rerun at that build. Freeze continues.
- 2026-10-05 10:10: at `c3bd35d` 120 passed; 121 left the fixture user's group member link (operator removed it). PR #107 fixes the restore. Freeze continues.
- 2026-10-05 11:12: #107 merged as `4d8c1ec`; Q10 queued to rerun at that build. Freeze continues.
- 2026-10-05 12:20: at `4d8c1ec` 120-122 passed; 123 failed verify on label fields Get-Label doesn't return. PR #108 records them as not qualified. Freeze continues.
- 2026-10-05 12:28: #108 merged as `248b12c`; Q10 queued to rerun at that build. Freeze continues.
- 2026-10-05 12:45: Marouane chose that KEEL reads LabelActions (issue #109). Q34 (protected fixture label, read-only dump) on hold until Q10 finishes. The 248b12c rerun continues.
- 2026-10-05 12:55: **Q10 passed: 120 → 123 verified at 248b12c.** Evidence combined in PR #110. Master unfrozen. Q34, Q30, Q33, Q26, Q24, Q31 released to queued (Q29 after Q24, Q32 after Q33). keel-powershell rebuild can go.
- 2026-10-05 13:01: PR #110 (120-123 evidence at 248b12c) merged.
- 2026-10-05 13:15: GitHub Actions jobs refused (account payment/spending limit) since the 13:01 master push; nothing auto-deploys until fixed. PR #111 (job cancel, unblocks Q24) waiting on CI. Asked Marouane to check billing.
- 2026-10-05 13:17: #89 done (Q31). Q30 and Q33 done; Q32 queued after Q34.
- 2026-10-05 13:45: PR #111 merged as `b9e5f6b` (job cancel, gate tests accept live 120-123 records, LabelActions reader #109). Next: deploy, Q24 resume, then Q35 (120-123 rerun).
- 2026-10-05 13:59: Merge gate merges nothing: its automerge listing gets HTTP 403 (no `issues: read` in merge-gate.yml) and still reports success. Fix PR to come from the #85 thread; until then Marouane merges by hand. #116 (reconstruct imports real pg_dump) green, awaiting review + merge.
- 2026-10-05 14:13: #89: the schedules installer (Q24 step 3) disables keel-offsite.timer; fixed in #112 (awaiting CI + Marouane's merge). Q37 re-enables the timer after Q24.
- 2026-10-05 14:22: Q24 done (#91): worker and scheduler live, health ok; tier1 hourly. Q37 re-enabled keel-offsite.timer (next 2026-10-06 05:00). ab074dc deployed; worker still on b9e5f6b until restarted. Q35/Q36 wait for #117.
- 2026-10-05 14:30: #117, #113 (Teams pin) and #112 (offsite installer) merged. deploy.sh now restarts keel-worker (vps-deployer, Marouane 14:17). **Master frozen** for Q35 (120→123) + Q36 (gate 116 drill) at 76ee9b5.
