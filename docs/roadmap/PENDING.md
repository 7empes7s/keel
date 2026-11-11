# KEEL: pending work

Date: 2026-11-11. Built from `master` at `01d7b3a84e`; the O1 live proof section is from #1083 at `ef793e66bd`. This file replaces
`COMPLETE-ROADMAP-PLAN.md` (2026-09-15) and `coverage-gap-register.md` (2026-10-12), which are kept
for history only.

It lists **only work that is not on master**. Each "not built" line cites where the code shows it.
When an item ships, delete its line in the same PR. When live proof lands, regenerate the numbers
below from the commands named here; never copy them by hand.

Each line: **objective** · **size** (S under a day, M a few days, L a week or more) · **kind**
(*code*, *live* = an operator or office run on the test tenant, *owner* = Marouane decides).

## O1: every backed-up type restores safely, proven live at one build

### Live proof at one build

Source: `node tools/release/readiness.mjs signoff --build ef793e66bd --accept-objective-gaps --fixture <journeys> --tenant <ref>`
run on Mulinux with the key on 2026-11-11 (#1083), at the candidate build `ef793e66bd` (plan and batches in
`live-proof-ef793e66bd.md`). The report is in `release-signoff.md`. Verdict **pending**. The fixture journeys passed
at the candidate.

**Live-qualified at `ef793e66bd`:** 43 of 49 gates (native recovery, NIST, ScubaGear, SharePoint, Teams, Exchange,
OneDrive/Purview, the 7 writer families, 23 of 24 Wave 2 reads and the 6 single-record writer gates), and 135 of
255 Entra writes (all 127 proven at `128b0e3b84`, plus 8 new: `configurationPolicy.delete`,
`accessPackageAssignmentPolicy.create`, `accessPackageResourceRoleScope.create`, `accessReviewScheduleDefinition.create`,
`securityZone.create/update` and `profileCardProperty.create/update`). Sentinel is the accepted gap.

Down from 45 at `128b0e3b84`: storage and the drill are held this time (below); every other gate that was
live-qualified there is live-qualified again.

Held at `ef793e66bd`, with the reason:

- Storage (task-114) and drill (task-116): their records are from `128b0e3b84`. A new recovery set has to be written
  to `/opt/backups` and the separate volume `/mnt/keel-copy`, plus scratch databases for the reconstruction and the
  drill: writes outside the office worktree, held by the manager for this window. O1 · S · owner
- Deployed acceptance (D1; stale, 35 days, limit 7): needs the owner's Cloudflare Access login for deployed
  acceptance on Mulinux (`cloudflared access login https://keel.techinsiderbytes.com`). O1 · S · owner
- ServiceNow (D6; stale, 35 days): needs the ServiceNow instance. The dev instance refuses the stored admin login;
  wake or re-provision it and update `/etc/keel/servicenow.env`. O1 · S · owner
- Defender endpoint indicators read (no record): needs the `Ti.Read.All` grant for the Collector (403). O1 · S · owner
- Entra, 120 with no record at this build (steps in `live-gate-plan.mjs`; results in `live-proof-ef793e66bd.md`):
  - Lockout rule (needs a second Global Administrator signed in): the 24 E5 writes. O1 · M · owner
  - Missing Restorer permission: the grants under "Waiting for the owner's grant" below (28 E3 writes), plus
    Defender custom detections (`CustomDetection.ReadWrite.All`), Copilot connectors (`ExternalConnection.*`) and
    attack simulations (`AttackSimulation.ReadWrite.All`). O1 · S · owner
  - By rule: `crossTenantIdentitySyncPolicyPartner` create/update, `oauth2PermissionGrant`, `exchangeRoleAssignment`
    and `user.create`. O1 · S · owner
  - Owner decision on tenant-wide settings: `mobileThreatDefenseConnector`, `deviceManagementPartner`,
    `complianceManagementPartner`, `deviceManagementDerivedCredentialSettings` and `defenderIdentitySensor` updates
    (not approved by name; the Defender for Identity sensor also needs the tenant onboarded). O1 · S · owner
  - KEEL gaps found live at the candidate, each needs a code fix and then a recapture: `schemaExtension.create`
    re-sends the generated `ext…_` id, which Graph refuses ("must own the namespace"); the
    `accessPackageCatalogResource.create` and `entitlementManagementRoleAssignment.create` captures refuse writes that
    succeeded ("no principal reference; no role reference", "the role is not the fixture role"); the snapshot held no
    access package assignment although one was delivered, so `accessPackageAssignment.create` could not run. O1 · S · code, then live
  - Microsoft limit at this build: `itemInsightsSettings.update` (the Restorer's write answers 403), `todoSettings.update`
    (the read answers 500), Windows driver and quality updates (403), Tunnel configuration (500), Autopilot and
    `cartToClassAssociation` (400), `mobileAppRelationship` create/update/delete (400 when making the fixture), `connectedOrganization` (404),
    `externalIdentitiesPolicy`, `directoryRoleAccessReviewPolicy`, the cross-tenant default,
    `exchangeCustomAppScope.update` and `notificationMessageTemplate.update` (no change takes), the group owner
    edge remove (a group keeps one owner), and the drift of `userExperienceAnalyticsBaseline`. O1 · M · live
  - Manual by design: the `defenderRoleAssignment`, `deviceManagementRoleAssignment` and
    `deviceManagementRoleDefinition` deletes. O1 · — · none
  - No fixture yet: ADMX upload, iOS provisioning, hardware configuration, on-premises CA settings, branding and its
    localization, group lifecycle, federated domain, device management settings, Engage, the MTO templates, and
    `crossTenantM365Capability.update` (granted, not run in this window). O1 · M · live
- Writer families: `sharepoint-structure.site-template.update` now sends its template (#1054) but the navigation put-back
  never reads back the same (the put-back rebuilds the whole navigation); needs a code fix. `hub-site.add` is skipped
  because it would leave a permanent hub. The other partial families are partial by design (#1032). O1 · S · code

### Waiting for the owner's grant

Declared in the code, not yet confirmed as granted in the test tenant. Each write is skipped live
until then (a 403 means skip and list it).

- `Agreement.ReadWrite.All` (Restorer, application grant) for `agreement.create/update` (`qualification.mjs:983`). O1 · S · owner
- `APIConnectors.ReadWrite.All` (Restorer) for `identityApiConnector.create/update` (`qualification.mjs:987`). O1 · S · owner
- `CustomAuthenticationExtension.ReadWrite.All` and `EventListener.ReadWrite.All` (Restorer) for `customAuthenticationExtension.create/update` and `authenticationEventListener.create/update` (#1072). O1 · S · owner
- `SignInIdentifier.ReadWrite.All`, `VerifiedId-Profile.ReadWrite.All`, `LifecyclePolicies-AgentId.ReadWrite.All` and `DeviceTemplate.ReadWrite.All` (Restorer) for `signInIdentifier.update`, `verifiedIdProfile.create/update`, `lifecyclePolicy.create/update` and `deviceTemplate.create`; `schemaExtension.create` uses `Application.ReadWrite.All` and `Directory.ReadWrite.All` (#1075). O1 · S · owner
- `Synchronization.ReadWrite.All` (Restorer) for `synchronizationJob.create/update` (`qualification.mjs:991`) and `Synchronization.Read.All` (Collector) for the job and schema reads (`docs/roadmap/restorer-least-privilege.md:53`). O1 · S · owner
- `Ti.Read.All` (Collector, WindowsDefenderATP) for the Defender endpoint indicators read. O1 · S · owner

### Restores not built yet

Backed up in full; restored by hand until a writer exists (`engine/coverage/coverageDoc.mjs`, the
`NOT_BUILT` entries, shown as "By hand (not built yet)" in `docs/coverage.md`). None are left: every
type has a writer or is listed below as manual by design (#1074, #1075). Trust, sign-in endpoint and
Logic App fields stay manual steps in any writer.

### Not restored by design (stay manual)

- Certificate sign-in settings: the trusted certificate authority list is never written; a restore lists what differs (`qualification.mjs:101`, #994). O1 · — · none
- Guest invitation domain restrictions: a restore never changes who can be invited (`qualification.mjs:237`, trust-field rule). O1 · — · none
- PIM custom extensions: KEEL choice, Graph creates one only with its Logic App endpoint and sign-in, which a restore never writes (#1072). PIM managed groups: Microsoft limit, a group comes back under PIM only through its first eligible member, which KEEL does not back up (#1072). O1 · — · none
- App certificate authority trust: KEEL choice, a configuration is only the trusted certificate authority list, which a restore never writes (#1075). O1 · — · none
- Windows code signing certificates: a restore never uploads a certificate devices trust (#1074, trust-field rule). Remote help partners: only the partner's name and onboarding URL, a sign-in endpoint, are writable (#1074). Managed e-books, Secure Score action states and Teams custom apps are Microsoft limits (#1074: books come from Apple Business Manager, Graph documents no state update, no app package). O1 · — · none
- Attack simulation automations, payloads, login pages, landing pages and notification emails: Microsoft limit, Graph lets tools read them but not create or change them (#1079; simulations themselves are restored as drafts). O1 · — · none

## O2: admins know which changes matter and act on them

- Audit rows carry no changed field names: both audit readers store `fields: []` (`engine/identity/auditSources.mjs:150`, `:172`), so audit flag rules match on the activity alone (`docs/insights.md:69`). Store the modified property names (never values). O2 · M · code
- Parked (permissions exposure): OneDrive guests and owners are not read, so OneDrive feed rows cover Everyone grants and anyone links only (`docs/insights.md:148`). O2 · M · code
- Parked (permissions exposure): unique permissions on single SharePoint items and folders are not read (`ITEM_PERMISSIONS_MISSING`, `engine/content/sharepointSites.mjs:89`). O2 · L · code (needs a decision on read cost first)

Shipped and dropped from the old lists: A9 names instead of ids (#965/#970: every route is in the harness, `CONTRACT_PENDING` is empty at `portal/ui-harness/ui.spec.ts:2578`), oversharing on Sites (#963, #971), sharing-link drift flags (#975), owner review (#964/#972), alerts from flags (#966), act on a flag (#979), weekly summary (#980), Insights scoped to the admin (#981).

## O3: the live portal stays healthy

- Prune: the #1024 dry run (2026-11-06) would delete 10 tier1 hourly snapshots, in line with the policy. Repoint `ExecStart` in `ops/keel-prune.service` from the stopped `/opt/keel` checkout to `/opt/keel-live`, then decide whether to enable `keel-prune.timer`. O3 · S · code, then owner
- Second, remote offsite copy: the Hostinger host (187.124.7.67) does not answer Mulinux on any port (#1024); once it does, decide whether to set `KEEL_OFFSITE_REMOTE` in `/etc/keel/offsite.env`. Offsite to the vol2 volume runs nightly. O3 · S · owner
- Terms of use PDFs in `agreement_file_blob` are never pruned (`engine/store/agreementFiles.mjs`; `cli/keel-prune.mjs` does not name the table). O3 · S · code
- Release readiness JSON (`docs/release/readiness.json`, task-45) is from 2026-09-15 and needs a server run (`release-signoff.md` "Limitations"). O3 · S · live

## Next milestone (not started): build on Microsoft's own tools

Describe only; no code until a plan is approved.

- **Entra Backup and Recovery** (GA 2026-06-30): Microsoft keeps 7 days of Entra object snapshots for P1/P2 tenants, with a beta Graph API under `/directory/recovery`. KEEL could read its snapshots as a second source, compare them with its own backups, and offer Microsoft's own recovery for the types it covers inside the 7 days, keeping KEEL's restore for older points and for the types it does not cover. Needs a licence check and the beta permissions first.
  [Announcement](https://techcommunity.microsoft.com/blog/microsoft-entra-blog/microsoft-entra-backup-and-recovery-is-now-generally-available/4521997) ·
  [Graph overview (beta)](https://learn.microsoft.com/en-us/graph/api/resources/entrarecoveryservices-backup-recovery-overview?view=graph-rest-beta). O1 · L · owner, then code
- **UTCM drift** (Tenant Configuration Management, beta): Microsoft's configuration snapshots and drift monitors. `tools/tenant-probe/utcm-probe.mjs` already checks access and takes a read-only sample snapshot. Next would be using it as a second reader for settings KEEL does not read itself, and its monitors as a drift source in the feed.
  [Overview](https://petri.com/microsoft-graph-utcm-apis-configuration-drift/). O2 · L · owner, then code

## Parked (not planned now)

- Guided-setup browser extension, training center and page Companion: nothing in `portal/` or `engine/` yet. Backlog after the redesign.
- Tracks E and F remainder: the Automation center section has Automatic rules and Emergency changes (`portal/lib/nav-sections.ts:91`) and notifications shipped with the weekly summary (#980); the rest waits on saved reports, which are not built.
- Permissions exposure beyond what shipped (Sites oversharing #963/#971, sharing flags #975, owner review #972): OneDrive guests and owners and item-level permissions (both listed under O2), sharing-link drift per file, a tenant-wide oversharing report.
- Content backup beyond what `engine/content/` does today: left to Microsoft 365 Backup.
- Cross-tenant reconstruction: non-goal here; it gets its own portal.
- Retention lock or immutability claims: non-goal.
- Sentinel export live proof (task-117): accepted gap (decisions 2026-09-30 and 2026-10-04).
