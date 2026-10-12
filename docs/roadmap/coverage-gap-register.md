# Coverage gap register: what is missing, blocked or skipped, and how each one closes

Date: 2026-10-12. Build: `master` at `2269b50` (after #170). Live results: operator run Q43 on the
test tenant (2026-10-10 to 10-12, evidence on `claude/live-evidence-148` at `e7f2264`) and the
workload gates of 2026-10-07 at `fb1493e`.

Goal: everything Keel backs up is restored correctly, or the user is told exactly what Keel cannot
do and walked through it. This register is the single list. Each row says what the gap is, whose
fault it is, and how it closes. The three kinds:

- **Keel bug**: the code is wrong. We fix it.
- **Keel design choice**: the code refuses on purpose (safety). We keep the refusal and turn it into
  a guided step.
- **Microsoft limit**: Graph or the admin APIs cannot do it. We never try to work around it. We give
  the user the facts, the exact manual steps and the backed-up values to paste.

The order of work is in [Phases](#phases). Each phase lists its acceptance checks.

## 1. Where coverage stands

| Area | Backed up on a schedule | Restore in code | Proven live |
| --- | --- | --- | --- |
| Entra ID (48 types) | Yes, tiers 1–3 | 24 types automated, 10 manual by decision, 14 never classified | 13 operations (Q43) |
| Intune (15 types) | Yes, tiers 1–3 | 3 types automated, 12 manual by decision | 3 operations (Q43) |
| Group members and owners | Yes, tier 1, since #170 | Add and remove | No (Q43 ran before #170) |
| SharePoint, OneDrive | No | Tenant sharing settings only | Read and one write (10-07, expires ~11-06) |
| Teams | No | Team settings and membership | Read and write (10-07, expires ~11-06) |
| Teams org policies | No | None | Fixture reads only |
| Exchange mailbox settings | No | Mailbox settings, client access, retention (extend only) | Read and write (10-07, expires ~11-06) |
| Exchange org config, mail flow, Defender for Office | No | None | Fixture reads only |
| Purview labels | No | Label text, policy add-only | Read and write (10-07, expires ~11-06) |
| Purview retention and DLP | No | None | Fixture reads only |
| Content (mail, files, messages) | No, by design | No | Not in scope |

"Not backed up on a schedule" for the workloads means: the collector exists and works, but nothing
calls it in production. See [section 4](#4-workloads-built-but-not-connected).

## 2. Entra and Intune: every blocked or failed live step

The 52-step live gate ended with 16 promoted, 7 demoted and the rest blocked. Here is each one,
with its cause and its close.

### 2.1 Keel bugs (fix in code)

| # | Gap | Steps it blocks | Cause | Fix | Effort |
| --- | --- | --- | --- | --- | --- |
| B1 | Create bodies send read-only fields (`id`, `createdDateTime`, `securityIdentifier`, `assignedLicenses`, `@odata.context`) and Graph answers 400 | group create, named location create and update, Conditional Access create | `engine/restore/applyEngine.mjs:899` posts the raw snapshot payload for any type outside the policy-governed set. The strip list already exists (`engine/cir/serverOwned.mjs`) but is only applied to PATCH bodies. | In the generic create branch, drop every path classed `serverOwned`, recursively, and hash the same body for verification. Group licences then go through the existing `assignLicense` path. | S |
| B2 | A resource's own id is treated as a reference to itself, so the plan demands a "deferred patch" on `id` that no type can apply | role assignment create, auth flows policy update, probably branding localization update | `tools/tenant-probe/references.mjs:313` checks `ownIds.has(guid)` but `ownIds` is lowercased (`:186`), so mixed-case ids (base64 role assignment ids, `authenticationFlowsPolicy`) are missed. | Compare lowercased. Also drop any reference whose symbol equals the resource's own key in `engine/cir/canonicalize.mjs`, so stored snapshots stop failing too. | S |
| B3 | References that can never resolve stop the whole restore: `createdByAppId` (read-only), a partner's foreign `tenantId`, Intune `scheduledActionConfigurations[].id` | application update (and probably create and restore), cross-tenant partner update, Intune compliance update | `canonicalize.mjs:217` keeps `readOnly:` and `foreignTenant:` references as required; `engine/graph/resolver.mjs:10` only short-circuits `global:`; the Intune child id isn't in `CHILD_IDENTITY_FIELDS`. | Resolver passes `readOnly:` and `foreignTenant:` through untouched; `rewriteReferences` skips server-owned fields; add the Intune child-id pattern. | S |
| B4 | Deleted users can't be restored: "retention deadline unprovable (no deletedDateTime)" | user restore from deleted items | `engine/reconcile/liveState.mjs:14` lists deleted users with no `$select`; Graph's default user projection omits `deletedDateTime`. The match is also by UPN only. | Add `$select=id,userPrincipalName,displayName,deletedDateTime,onPremisesSyncEnabled` to every deleted-items route; match by snapshot `sourceId` before the natural key. | S |
| B5 | The update right after a restore from deleted items gets 404 (replication lag) and the step is recorded as failed, although the object is back | group restore from deleted items | `applyEngine.mjs:676` uses the plain retry (429/503 only). `writeAfterCreate`, the bounded 404 retry, is used only for Conditional Access. | Use `writeAfterCreate` for every type's post-restore write, and for users at `:1533`. | S |
| B6 | Group `description` is never collected, so a changed description is invisible and no restore happens | group update | The group `select` in `tools/tenant-probe/catalog.mjs:51` omits `description` (`classification` and `theme` too). | Add them. Expect a one-time hash change on the next snapshot. | S |
| B7 | PIM rule read-back fails with `CultureNotFoundException` under app tokens, so a correct write is recorded as unverified | PIM role rules update | `engine/restore/graphWriter.mjs` sends no `Accept-Language`. The collector already defaults to `en-US` for this exact error (`tools/tenant-probe/graph.mjs:76-94`). | Default `Accept-Language: en-US` in the writer's read and write, overridable (branding uses `0`). | S |
| B8 | A Conditional Access rename looks like a brand-new policy, so Keel tries a create instead of an update | Conditional Access update | The natural key is the display name (`engine/collect/descriptors.mjs:48`). The id fallback in `reconciliationPlan.mjs:18` maps live id to the *live* key, so it never links back to the snapshot. | For same-tenant restores, map snapshot `sourceId` to the snapshot key in `keyForLiveObject`; an object with the same id plans as `update`. | M |
| B9 | Branding update returns 400 | branding update | Not provable from code without the error body. Likely a null-valued field sent as `null` or a nested layout object (`tenantPolicyOperations.mjs:515`). | Log the 400 body in the journal. Omit null fields from branding PATCHes; treat `""` and null as equal. | S |
| B10 | Captures leak a security identifier (`S-1-12-1-…`), which encodes the object id | evidence privacy | `tools/qualification/pseudonymize.mjs` rewrites GUIDs, hosts and tokens only. | Add SID patterns (`S-1-12-1(-\d+){4}`, `S-1-5-21…`) and replace with a digest-derived SID of the same shape. | S |
| B11 | Approving a CLI dry run in the portal also queues a worker restore that fails ("requester no longer resolves to a principal") | every operator-run restore | `engine/govern/approvals.mjs:351` always mints a worker job; the CLI artifact carries `requestedBy: unknown`. | **Fixed** (branch `claude/fix-cli-approval-executor`): `requestApproval` refuses a requester that is not an enabled principal; `approval_request.executor` is `worker` or `cli`, set by the restore route from how the dry run was planned, and a `cli` approval mints no job. | M |
| B12 | Dynamic groups: a member `$ref` write is refused by Graph and the run stops | group member restore for dynamic groups | `relationshipWriter.mjs:109` plans member adds for every group. | When `groupTypes` has `DynamicMembership`, plan no member edges and emit a note ("membership comes from the rule"); still plan owners. | S |

### 2.2 Keel design choices (keep the refusal, guide the user)

| # | Gap | Steps it blocks | Why it refuses | Close | Effort |
| --- | --- | --- | --- | --- | --- |
| D1 | **Fixed (branch `claude/lockout-delete-evidence`).** Lockout delete guard needed `simulationPassed`, which nothing in production set | delete of role assignment, named location, Conditional Access policy | Was `applyEngine.mjs:496`. The What-If simulation needs delegated credentials, so the gate was never wired. | Done: `engine/safety/lockoutDeleteGate.mjs` decides from break-glass readiness after the delete plus the sign-in path gate replayed without the object. Any missing or unknown input refuses, and the refusal names it. | M |
| D2 | PIM eligibility only at tenant scope | PIM eligibility create at admin-unit scope | `adminRoleOperations.mjs:247` refuses to rewrite a scope id. | Resolve `/administrativeUnits/{id}` through the admin-unit natural key, same as other references. Until then, a completion item with the exact scope. | M |
| D3 | Group expiry can't be made shorter | group expiry restore when the drift lengthened it | `tenantPolicyOperations.mjs:88`: a shorter lifetime can expire and delete groups. | Keep. Offer it as a separate high-impact approval (same pattern as content effects), else a completion item with the value and the portal path. **Fixed by the `claude/group-expiry-shorten-approval` PR:** a shorter lifetime is a retention-reducing content effect; with its approval the write proceeds, without it the skip carries a completion item (target days and the Entra portal path). | S |
| D4 | Intune device profile create refused: "unclassified content effect" on `internetSharingBlocked`, `sharedUserAppDataAllowed` | Intune device configuration create | `contentEffects.mjs:180` matches any field named `shar(e|ing)`; Intune types have no reviewed rule set, and a create marks every field as changed. | Add reviewed (empty) rule sets for the three Intune types; hotspot and app-data settings are not content sharing. | S |
| D5 | Break-glass gate: fewer than two emergency accounts, and "policy exclusions unknown" | auth methods policy, security defaults, authorization policy update | `breakGlassReadiness.mjs:53` needs two accounts (Microsoft's own guidance). Exclusions need group membership; #170 adds direct members, but a direct read can't prove *non*-membership through nested groups. | **Exclusions fixed by PR `claude/breakglass-transitive-exclusions`:** every collection now reads `transitiveMembers` (read-only) for each group a Conditional Access policy names, so exclusions report pass or fail; a failed read stays unknown. The second account is still an operator step (see §6). | S/M |
| D6 | A superseded baseline can't be re-activated, and a baseline with no source snapshot can't be re-versioned | delete-step cleanup; any rollback of a baseline change | `baseline.mjs:416` refuses superseded versions. | Add `reinstateBaseline`: copy a superseded version's resources into a new latest version with evidence. | M |
| D7 | ~~Delete steps go through drift remediation with a temporary baseline~~ Fixed by PR `claude/restore-delete-scope` | every delete | A restore couldn't select an object absent from its snapshot. | Done: `keel-restore.mjs --snapshot-id <id> --delete <naturalKey>` plans the delete as a dry run, stored in the artifact and run only by promoting it, through the same delete guards. Refused for a key the snapshot holds or a type without delete. | M |
| D8 | Conditional Access restore lands report-only; turning it on is a separate gated step | CA turn-on (not run) | On purpose: a wrong CA policy locks the tenant out. | Keep. The portal must make the two steps one flow with a clear "now switch it on" prompt. | UI |

### 2.3 Microsoft limits (tell the user, give the manual path)

| # | Limit | What the user sees in Keel today | What Keel should do |
| --- | --- | --- | --- |
| M1 | Permanently deleting a Conditional Access policy from the recycle bin needs a signed-in admin (app-only is refused, 403) | Nothing. The operator purged by hand. | A completion item: "Purge KEEL-RT… in Entra → Protection → Conditional Access → Deleted policies, or let it age out in 30 days", with a one-click copy of the name. Optional later: a delegated sign-in helper for drills. |
| M2 | Deleted items are kept 30 days, then gone for good | A refusal with no date | Show the deadline per object on the restore page and in the drift list; warn at 7 days. |
| M3 | Replication lag: a restored object is readable before it is writable | A failed step (B5 fixes the record) | Retry with backoff (B5) and say "restored, verifying" rather than "failed". |
| M4 | Credentials are never readable: user passwords, app secrets and certificates, identity-provider secrets, Wi-Fi/VPN/certificate profile secrets | "Manual" with the reason in the ledger | Recreate the object without the secret and hand the user a checklist of the secrets to set, with their names and expiry dates from the backup. |
| M5 | Security defaults can't be on while any Conditional Access policy is on | Blocked | Say which CA policies are on and that one or the other must be chosen. |
| M6 | Branding images, favicon, custom CSS are binary uploads on separate routes | Fixed by `claude/branding-images`: each backup stores the background image, banner logo, square logos, favicon and custom stylesheet of the default branding and each language (by hash, at most 1 MB each); a restore uploads only the files that changed, with PUT and their own type, and reads each one back. Fixture-tested, not yet live. | Run the live gate on the test tenant to promote it. |
| M7 | Built-in roles, built-in auth strengths, directory role templates, licences (SKUs), domains (DNS proof), the organization object | "Manual" | Correct as manual. Show them as "Microsoft-managed, nothing to restore" rather than as gaps. |
| M8 | Terms-and-conditions acceptance, device enrollment, device categories, Autopilot hardware records | "Manual" | Correct. Show the backed-up values and the admin-center path. |
| M9 | Dynamic group membership is computed from a rule, never written | A failed edge (B12 fixes) | Restore the rule; say that membership follows. |

### 2.4 Never classified (14 Entra types)

OAuth grants, certificate-based auth, token lifetime/issuance, claims mapping, home realm discovery,
permission grant policies, auth contexts, access reviews, access packages, connected organizations,
PIM active schedules, and feature rollout policies are **backed up but marked `unknown`** in
`engine/coverage/qualification.mjs`. Each needs a one-paragraph decision: automated (then a writer and
a fixture test), manual (with a reason), or Microsoft-managed. OAuth grants and token/claims policies
are the likely automated ones; access packages and reviews are likely manual.

### 2.5 Known "not included" per Entra design doc

- Users: create, delete, manager; licence restore on group create.
- Admin roles: eligibility update/delete, role delete, PIM for groups, policy-to-role binding, notification and auth-context rules.
- Tenant policies: `permissionGrantPolicy` custom includes/excludes, partner delete, partner sync settings.
- Branding: content customization, add/remove a language, the groups a `Selected` expiry policy covers, user flows.
- Relationships: only direct members and owners; app and service-principal owners, app role grants not restored.
- Intune: policy delete, Intune role assignments not backed up.

## 3. Workloads: built but not connected

All eight collectors and four restores are finished library code, called only by tests and the
qualification tools. Three things are missing between them and production:

| # | Gap | Cause | Close | Effort |
| --- | --- | --- | --- | --- |
| W1 | No scheduled workload collection | The scheduler only knows `collect` tier 1–3 (`engine/schedules/cadence.mjs:66`), which walks the Entra/Intune catalogue only. The workload gate (`workloadContract.mjs:463`) needs a ledger built from live evidence and observed grants, and that ledger exists only in memory inside `tools/qualification/workloads.mjs`. | **Fixed by PR `claude/workload-schedule`:** ledger inputs stored in `workload_ledger_evidence` and `workload_ledger_grants` (`cli/keel-workload-collect.mjs import`, verified records only); `workload-collect` job kind runs `keel-workload-collect.mjs run`; daily 02:00 UTC seed row. Was: Persist the ledger inputs (evidence rows and grants). Add a `workload-collect` job kind (schema constraint, `jobCapabilities.mjs`, `cadence.mjs`, worker handler, `cli/keel-workload-collect.mjs`) and a daily seed row. | L |
| W2 | No way to run a workload restore | Workload artifacts store `collectorConfigPath = 'workload:<name>'` and `snapshot_id NULL`; `keel-restore.mjs:385` reads that path as a file and throws. | In `runRestore`, branch on `artifact.workloadRestore` beside the Conditional Access and compensation branches and dispatch to `execute*Restore`. Add `--workload` dry-run planning. Approvals and content effects already work. | M |
| W3 | Live proof expires after 30 days and nothing recaptures it | `WORKLOAD_WRITE_EVIDENCE_MAX_AGE_MS`; recapture is a manual operator run. | **Fixed by PR `claude/workload-schedule`:** the coverage report lists each stored proof as "expires in N days"; the daily run logs it; `keel-workload-collect.mjs proof` exits 1 inside 14 days, for a monthly check. Recapture stays an operator run. Was: A monthly operator queue item, or a `workload-recapture` schedule that runs the live gate against the test tenant. The four 10-07 records lapse about 2026-11-06. | S |
| W4 | No workload restore at all for OneDrive settings, mail flow and Defender for Office, Teams org policies, Purview retention and DLP | Read-only by design in the first pass. | Writers, in this order: mail flow (transport rules, connectors, accepted domains; highest recovery value), Teams org policies, retention and DLP (every shortening goes through the content-effect guard), OneDrive. | L |
| W5 | Backups don't say who a policy applies to | Mail flow policy scoping rules and Teams policy assignments are not read. | Add the rule cmdlets (`Get-*Rule`) and `Get-CsOnlineUser` policy assignments to the allowlists. | M |
| W6 | Not read at all | Outbound spam, connection filter, quarantine, journal rules, mobile device policies; Teams calling, voice, channels, live events; retention labels, adaptive scopes, auto-labeling, eDiscovery holds. | Add as reads first, then writers, behind the same gates. | L |
| W7 | Exchange org config write coded but never captured | Needs an explicit decision on which tenant-wide setting may be flipped and put back. | **Fixed in code by `claude/exchange-org-mailtips`:** the write is limited to `MailTipsLargeAudienceThreshold` (every other organization setting is refused), and the capture has an opt-in `--include-organization-config` step (25 → 26 → 25). Live capture is an operator run (`exchange-live-acceptance.md` step 9). | S |
| W8 | Docs say the Restorer lacks the Exchange and Purview app-only grants | Stale text (`exchange-live-acceptance.md:166`, `onedrive-purview-live-acceptance.md:244`); the 10-07 records show the grants present and the writes verified. | **Fixed by PR `claude/workload-schedule`.** Was: Fix the docs in the same PR as W1. | S |
| W9 | The portal never shows workload coverage | `engine/coverage/report.mjs` computes it; `portal/lib/portal-data.ts:367` drops it. | Keep the field; show it under Protect. Part of the UI rework. | S |

## 4. Content, by design

Keel backs up configuration, not content: no mail items, no files, no Teams messages or channels.
This is stated in code (`workloadContract.mjs:24`, `CONTENT_SEGMENTS`), in the forbidden-grants list
(`prerequisites.mjs:79`) and on the overview page. Keep the decision. The portal must say it in one
line next to every workload so no user expects a mailbox restore.

## 5. Proof and ledger plumbing

| # | Gap | Close |
| --- | --- | --- |
| P1 | The Q43 evidence (16 promoted, 7 demoted) is on `claude/live-evidence-148` with no PR. Master's ledger still says every Entra write is fixture-tested. | Open the PR, apply the 7 demotions to `capabilities.mjs` and `TYPE_DECISIONS` as the runbook requires, merge. |
| P2 | The portal and coverage report never load committed live records; they always show fixture-tested. | Load the signed records at startup. Needs the signing key available to the portal process (decision in §6). |
| P3 | Entra live acceptance is not a release-ledger gate. | **Fixed by the `claude/entra-live-ledger-gate` PR.** The ledger now has an Entra gate judged per registered write: a verified live record from the last 30 days passes it, and a demoted, expired, unverified or missing write is shown with why. Today the 7 committed demotions make the ledger report blocked; the ledger command still exits 0 (report only). |
| P4 | Every "manual" and "unknown" reason lives in code comments. | **Fixed by the `claude/generated-coverage-docs` PR.** `docs/coverage.md` is generated by `tools/coverage-doc.mjs` from `TYPE_DECISIONS`, the capability registry and the workload contract, with plain-English reasons and steps per type; `engine/coverage/coverageDoc.test.mjs` fails when the committed file is out of date or a type's decision changes without its text being reviewed. |

## 6. Decisions taken by Marouane (2026-10-12)

1. **Second break-glass account:** agreed. Registration runs on the host (`cli/keel-breakglass.mjs register`, by keel-operator); the Readiness page only reads. Marouane names the account: cloud-only, enabled, member, managed domain, strong method, excluded from the enabled Conditional Access policies. After registration he signs in once and the operator records the test.
2. **`KEEL-RT-148-ca`:** permanently deleted by Marouane. Cleanup complete.
3. **Exchange org config (W7):** the setting the operator may flip and put back is `MailTipsLargeAudienceThreshold` (25 → 26 → 25). It only changes when Outlook shows a large-audience tip.
4. **Signing key in the portal process (P2):** yes. The portal may hold the evidence signing key and show live status.
5. **Branding images (M6):** yes. Keel stores the branding image files in its backups and restores them through their upload routes.

## Phases

Each phase is one or a few PRs. A phase is done when its checks pass.

### Phase 1: make what exists true (1 week)

- P1 evidence PR merged; the 7 demotions applied.
- B1, B2, B3, B4, B5, B6, B7, B10 fixed, each with a fixture test that reproduces the live failure.
- D4 reviewed rule sets for the three Intune types.
- B12 dynamic-group skip.
- **Check:** `node tools/qualification/operations.mjs --live-evidence` lists 16 live-qualified; every demoted operation has a fixture test that fails on the old code and passes on the new.

### Phase 2: rerun the live gate (operator, 2 sittings)

- Q44: rerun the 7 demoted steps, the member/owner steps (now collected), and the reference-blocked steps (application, partner, Intune compliance).
- Marouane: second break-glass account first, so the lockout steps can run.
- **Check:** 35 or more operations live-qualified; every remaining block is either a design choice in §2.2 with a guided step, or a Microsoft limit in §2.3 with a completion item.

### Phase 3: guided steps for what Keel won't do (1 week)

- D1, D3, D5, D7, M1, M2, M4, M5: each refusal becomes a completion item with the exact object, the
  backed-up values and the admin-center path. One `completion` shape, rendered once in the portal.
- M6 branding file backup and restore.
- B8, B11, D2, D6.
- **Check:** a restore that hits any refusal ends with status "needs you" and a list, never "failed"
  with a log line; the fixture e2e test covers each item.

### Phase 4: connect the workloads (2 weeks)

- W1 scheduled collection, W2 restore entry point, W3 recapture schedule, W8 doc fix, W9 portal field.
- Recapture the four workload gates before 2026-11-06.
- **Check:** a daily `workload-collect` run on the host writes `complete` rows for the proven
  workloads; a SharePoint sharing-settings restore runs end to end through the portal with approval.

### Phase 5: classify the unknowns and widen (ongoing)

- §2.4 decisions, then writers for the automated ones.
- W4, W5, W6 in the stated order.
- P3 release gate, P4 generated coverage doc.

### Phase 6: UI/UX rework (after Phase 3)

Starts from the portal map in the first review and from one rule: every type shows one of four
states, **restores itself**, **needs you** (with the steps), **Microsoft-managed** (nothing to
restore), or **not backed up**. Workload coverage, deleted-item deadlines and the two-step
Conditional Access flow are the three biggest visible changes.
