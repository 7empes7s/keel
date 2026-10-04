# KEEL handoff state

**Read this first if you are a new or reconnected session.** It says where every workstream
stands and where to pick up. It lives on branch `claude/operator-queue` (never merged to master, so
edits don't deploy), next to the work queue `ops/operator-queue.md`.

- **Maintainer:** the KEEL coordinator thread in the "Keel" Claude project. Other sessions send it
  their changes and it updates this file. If you are a cold session without that thread, update this
  file yourself and say so in the change log.
- **Last updated:** 2026-10-04 13:35 UTC

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

## Live qualification gates

Records bind to one build. The release ledger (task 124) needs **every** live gate verified at one
frozen release-candidate build, so each gate is recaptured at that build at the end. Captures before
then prove the path works.

| Gate | What | State | Evidence / blocker |
|---|---|---|---|
| 113 | deployed-acceptance | **Captured, verify ok** at `33ad2a9` | `claude/live-evidence-113` @ 48d37ca. Not mergeable: see "Evidence merge blocker" |
| 114 | storage-live-acceptance | **Captured, verify ok** at `df0de36` | `claude/live-evidence-114` @ 4b1d3da. Copy on the second volume `/mnt/keel-copy` |
| 115 | native-live-acceptance | **Captured, verify ok** at `33ad2a9` | `claude/live-evidence-115` @ b965a66 |
| 116 | drill-live-acceptance | **Blocked** | PR #73 merged 13:34; needs its deploy + Q19, a recovery key generated and enrolled, a Setup run (task-76 run id), then the reconstruction drill (Q6) |
| 117 | sentinel-live-acceptance | **Descoped** (operator, 12:36 UTC: "scratch it") | The release ledger still lists task-117 (`tools/release/acceptanceLedger.mjs:39`), so task 124 must drop it or record it as an accepted gap |
| 118 | servicenow-live-acceptance | **Captured, verify ok** at `87e366e` | `claude/live-evidence-118` @ 4ec37c1. Reviewed: live-qualified, no secrets |
| 119, 126 | NIST, ScubaGear | Already qualified | — |
| 120 → 123 | SharePoint, Teams, Exchange, OneDrive/Purview (one sitting, same build) | **Blocked on D-120b** | Queue Q10. Fixtures exist (Q8), PowerShell image rebuilt (Q9) |
| 124 | release ledger | Not started | Needs all live gates at one build |

**Evidence merge blocker:** `engine/roadmap/deployed-acceptance.test.mjs` (and probably the other
gates' tests) require the committed evidence file to stay a pending placeholder. Changing that test is
blocked for Claude by the auto-mode classifier ("Security Test Removal"); it needs the operator, or a
session the operator directs. Replacement checks were drafted in the old session: live record fields,
build match, capture checksum, no `eyJ…`/`CF_Authorization`, fails without the HMAC key.

## Open PRs

- None open. **#73** `claude/setup-host` was **merged 13:34 UTC as `2e8a5b9`** (operator approved in chat). Description: production Setup host for gate 116 (task-76). CI green; reviewed by the
  coordinator (writes disabled unless named with qualification + expiry; never creates app
  registrations). **Merge blocked for Claude** ("Merge Without Review"): the operator merges it.
  After deploy, queue Q19 points the portal at `/etc/keel/restorer.json`.
  Notes from the author session (`session_01E6SkVX9ZGScLQdWgjcBvbT`) for after it lands:
  - The setup checks need the Collector to hold `Application.Read.All` and
    `RoleManagement.Read.Directory`. The Intune role check also needs `DeviceManagementRBAC.Read.All`;
    without it, run read setup for Entra only (the first-collection gate accepts that). These are
    grants, so they need an operator decision before keel-operator adds them.
  - `keel.collect`/`keel.restore` count as satisfied when the app is configured as that role's
    credential. `qualificationMode` defaults to `live-qualified` as a label only. Excess scopes
    (e.g. the Restorer's `MailboxSettings.ReadWrite`) are reported, never removed.
  - Operator steps for gate 116: `docs/roadmap/bootstrap-ui.md` (status 2026-10-04).

## Waiting on the human operator

1. **D-120b** in the queue (Restorer `SharePointTenantSettings.ReadWrite.All`; Collector
   `SharePointTenantSettings.Read.All`, `Sites.Read.All`, `MailboxSettings.Read`): unblocks 120–123.
2. Decide on the Collector read grants it needs (`Application.Read.All`,
   `RoleManagement.Read.Directory`, optionally `DeviceManagementRBAC.Read.All`).
3. **Evidence-placeholder test change**, so 113, 114, 115 and 118 evidence can merge.
4. **Gate 116 recovery key:** `node tools/recovery/recovery-assertion.mjs keygen`, then `enroll`
   (details in `docs/roadmap/keel-recovery.md`). Blocked for Claude ("Secret-Store Writes").
5. **Rotate the Restorer key** `/etc/keel/keel-restorer.key`: a search printed part of it into
   vps-deployer's output.
6. **Run the AWS budget guard** script (below).

## Infrastructure facts

- **VPS** (Hetzner): root disk was 91% full (14 GB free) on 2026-10-03. Second volume
  `/dev/sdb` (97.9 GB, ext4) mounted at `/mnt/keel-copy` (fstab, `nofail`) for gate 114.
- Scheduled collection and the tier-1/2/3 backup services from `ops/` are **not installed** on the host
  (only `keel-portal`, `keel-deploy` and the status generator). The nightly DB dump comes from a
  separate host script. The deploy never rebuilds the PowerShell image (Q12 report).
- Portal, worker and CLI default to `/etc/keel/restorer-target.json`, which doesn't exist; the host
  file is `/etc/keel/restorer.json`.
- The Restorer app holds ~52 write permissions plus 9 directory roles, far more than needed. A
  least-privilege review is a suggested follow-up, not started.
- keel-operator hasn't been tested through a crash or reboot.

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
  1. Budget guard `keel-monthly` ($25/month) is probably **not** created. Run
     `bash /mnt/project-files/aws/budget-guard.sh` on the VPS (copy it there first).
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

- 2026-10-04 12:40: file created by the coordinator. Q16–Q18 done (gate 118 captured); Q17 needed
  two operator-made ACLs; Q15 mounted the second volume and finished gate 114.
- 2026-10-04 12:45: D-117 answered: Sentinel scratched, gate 117 descoped. D-118 confirmed (ServiceNow OAuth + ACLs done).

- 2026-10-04 12:50: AWS section updated from the AWS thread (budget name, MCP profile env, verify commands).
- 2026-10-04 12:55: PR #73 author notes added (Collector read grants needed for Setup checks).
- 2026-10-04 13:00: AWS setup done on the VPS; budget guard still to run; keel-operator restart pending.
- 2026-10-04 13:35: PR #73 merged (`2e8a5b9`); master deploy and Q19 next.
