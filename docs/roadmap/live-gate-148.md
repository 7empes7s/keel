# Live gate #148: prove the Entra writes on the test tenant

Every registered Entra write (and the Intune writes added by #155) is fixture-tested, and none is
live-qualified yet. This gate runs each one once, for real, on the **test tenant**, through the normal
restore path. Then it promotes the result through `qualifyLiveEvidence`. An operation that fails live
is demoted, with the reason recorded in `TYPE_DECISIONS`.

Builders never run this. The keel-operator runs it from the operator queue (`ops/operator-queue.md`
on branch `claude/operator-queue`).

## The checklist is generated, never written by hand

```sh
node tools/qualification/live-gate-plan.mjs > ~/keel-148/plan.md   # the checklist
node tools/qualification/live-gate-plan.mjs --summary               # one line per step
```

It reads the operation ledger at run time, so it always matches the build you run it at. A write that
is registered later (for example branding and group expiry from #156) appears with no change to the
generator. A type with no reviewed guidance still gets a full step. If its blast radius is "can lock
the tenant out", it is treated as lockout-sensitive until someone reviews it.

At `master` today it lists **47 registered operations in 48 steps**. The extra step turns a
Conditional Access policy back on. For each step the checklist gives:

- the disposable test object;
- the exact commands;
- the cleanup;
- the evidence files;
- the promote command;
- the demote command for when the step fails.

Order: directory objects and their relationships first, then roles, policies and Intune. The
lockout-sensitive steps come last: authorization policy, PIM rules, authentication methods, security
defaults, then Conditional Access. Each of those names its break-glass precondition.

## Before you start

- **Test tenant only.** The capture tool works out the tenant from the Restorer config and refuses any
  tenant that isn't the test tenant. It also refuses a restore that was run in another tenant. The test
  tenant is the one every committed live gate was captured in, and a test checks that this stays true.
- **Pseudonymized.** Every id in a capture goes through `pseudonymize.mjs` (#138) before it is written.
  The tool refuses to write a file that still holds the raw tenant id or anything shaped like a
  credential. Don't copy ids into reports by hand.
- **Fixtures.** Use only `KEEL-RT-148-*` objects and the existing fixture user
  `keel-rt-20260908-carla`. Tenant-wide settings are touched only where decision D-148b allows it.
- **Build.** Run from your own checkout at the deployed build (`git -C /opt/keel-live rev-parse HEAD`),
  never in `/opt/keel`. `KEEL_QUALIFICATION_HMAC_KEY` must be set; it signs every record.
- **Approvals.** Every restore needs a second person's approval in the portal. The operator can never
  approve its own request. Steps that are not lockout-sensitive may share one snapshot and one restore
  (select several fixtures), so they need one approval. Lockout-sensitive steps each run alone.

## One step, start to finish

1. Collect a snapshot, change the tenant as the step says, then plan the restore as a dry run.
2. Marouane approves the dry run. Then run it with `--enforce`.
3. Capture:
   `entraLive.mjs capture --restore-ref A --resource-type T --operation O --fixture KEY ...`.
   This reads only what the restore wrote to KEEL's rollback journal (each write and whether its
   read-back matched). It never calls Graph. It writes a signed record and the pseudonymized journal
   entry that the record binds by sha256.
   - Exit 0: captured.
   - Exit 3: the write failed. Demote it (step 5).
   - Exit 4: the restore made no such write. Report the step as blocked.
4. Promote: `entraLive.mjs promote --evidence OUT/T.O.json`. First it checks the signature, the test
   tenant, the capture digest and that the write succeeded and read back. Then it calls
   `qualifyLiveEvidence`, which runs its own checks (tenant, operation, projection contract,
   freshness under 30 days, non-synthetic). For authentication strengths the policy family's own gate
   runs first. A synthetic or fixture-signed record is always refused.
5. On failure: `entraLive.mjs demote --resource-type T --operation O --reason '...' --out OUT` writes
   a demotion record. A builder then removes the registration in `capabilities.mjs` and adds the
   reason to `TYPE_DECISIONS`. `engine/roadmap/entra-live-gate.test.mjs` fails until both are done.
6. Clean up as the step says.

## After the run

- Commit every record, capture log and demotion file under `docs/release/qualifications/entra-live/`
  on branch `claude/live-evidence-148`, branched from `origin/master`. Run the secret scan first.
  A builder opens the pull request.
- On the host, with the key set, run
  `node tools/qualification/operations.mjs --live-evidence docs/release/qualifications/entra-live`.
  It shows each promoted row as `live-qualified`. Without the key nothing verifies, so nothing flips.
  This is the same rule as every other committed record.

## Decisions needed (asked once, in the queue entry)

- **D-148a, lockout-sensitive steps.** May the operator:
  - drift the authorization policy's guest-invitation setting;
  - turn off "MFA on activation" for the fixture role's PIM settings;
  - switch one authentication method the break-glass accounts don't use;
  - try security defaults;
  - create, change, delete and restore a report-only Conditional Access policy scoped to one fixture
    group;
  - turn that policy **on** for carla only, for the enforcement step?

  Marouane stays signed in as a second Global Administrator for these.
- **D-148b, tenant-wide settings.** May the operator drift and let KEEL restore:
  - the Group.Unified directory setting (and delete it, for the delete step);
  - the cross-tenant access defaults;
  - the admin consent request policy;
  - a cross-tenant partner entry for a tenant Marouane names?

  Without D-148b those steps are reported as blocked and stay fixture-tested.

## Known gaps (listed, not built)

- **Runtime registry.** The portal and the coverage report do not yet load the committed live records
  when they start. They still show `fixture-tested`. Wiring that in needs the signing key available to
  the portal process, which is a decision.
- **Delete steps** go through drift remediation, because a restore cannot select an object that is
  absent from its snapshot. That means a temporary baseline, which the step puts back afterwards. A
  restore scope for "delete this key" would make these steps shorter.
- **Security defaults** can't be turned on while any Conditional Access policy is on. If the test
  tenant has one, that step is blocked, not failed.
- **Release gate.** `entra-live-acceptance` is not a release-ledger gate. Adding one would turn the
  release label back to pending until the run is done.
- **Routes unchecked.** The Graph routes in the operation records were never checked against
  learn.microsoft.com, which the build container can't reach. This live run is that check.

## Files

| Piece | File |
| --- | --- |
| Checklist generator | `tools/qualification/live-gate-plan.mjs` |
| Capture, promote, demote | `tools/qualification/entraLive.mjs` |
| Ledger with committed live records | `tools/qualification/operations.mjs --live-evidence DIR` |
| Fixture-only end-to-end test | `engine/roadmap/entra-live-gate.test.mjs` |
