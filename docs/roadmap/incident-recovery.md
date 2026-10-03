# Incident-qualified recovery points and retention pins (roadmap task-71)

During a compromise, the newest snapshot is the one most likely to contain the
attacker's changes, so "restore the latest backup" is the wrong default. KEEL
therefore qualifies recovery points per incident, and a restore made during an
incident has to use a qualified point.

The engine code is in `engine/govern/incidents.mjs`, prune is in
`engine/store/retention.mjs`, plan binding is in
`engine/restore/dryRunArtifact.mjs` and `cli/keel-restore.mjs`, and the portal
view is in `portal/components/incident-recovery.tsx` (`/incidents`).

The portal view follows `docs/roadmap/portal-experience.md`:

- It opens with one sentence naming the snapshot to restore from (the newest
  one cleared for the incident), with one action.
- Below that, snapshots, people and resources appear by name ("Snapshot of
  30 Sept 2026, 06:00 UTC", "Helpdesk Tier 0 (group)"), with plain status words
  (Cleared, Unsafe, Not checked).
- Every ID, fingerprint and resource key sits under a labelled "Technical
  details" disclosure, with a copy control and where the value is used.
- On screen the feature says "cleared" and "checked" rather than "qualified"
  and "assessed".
- Incidents belong to Restore in the contract's seven-entry map. The page is
  reached from the Restore page, not from a new navigation entry.

## Who can do what

A new `investigator` role grants one capability, `investigate`. It is added to
the closed role matrix in `engine/authz/permissions.mjs`, and the
`role_grant_role_check` constraint is widened to match. Every incident write
re-checks the actor's **current** `investigate` grant against the database
clock, so a grant revoked after the page loaded refuses on the next write.
Every row is tenant-scoped, and every transition is appended to the evidence
chain (kind `incident-recovery`).

| Action | Who | Notes |
| --- | --- | --- |
| Open or close an incident | investigator | The person who opens it becomes its owner |
| Record a compromise interval | investigator | `[startsAt, endsAt)`; leave the end empty while the compromise is ongoing |
| Assess a snapshot | investigator | Each assessment is a new version: `clean` (optionally with exclusions) or `compromised` |
| Authorize a recovery override | investigator | Needs a reason. Only for an unsuitable or unassessed point |
| Pin or release a snapshot | investigator | Release needs a reason |
| Restore under an incident | restorer, then approver | Normal dry run, approval and promotion |

## Qualifying a recovery point

`qualifyRecoveryPoint` is pure. The loaders feed it tenant-scoped rows.

- **qualified**: the current (newest) assessment version for this incident and
  snapshot says `clean`.
- **unsuitable**: the current assessment says `compromised`.
- **unassessed**: there is no assessment, or the current one is **stale**. An
  assessment records whether the snapshot was in a compromise window when it
  was made. If a later interval change moves the window across the snapshot,
  the assessment no longer counts and the snapshot must be reassessed.
- A snapshot is **in a compromise window** when its observation span
  `[started_at, completed_at]` overlaps any interval of the incident. A
  collection that straddles the start of an interval counts as in the window,
  because an observation covers a span of time and is never treated as one
  instant.
- An assessment row whose tenant, incident or snapshot does not match is
  ignored and can never qualify a point. An incident or snapshot from another
  tenant is refused outright.
- The **recommended** point is the newest *qualified* snapshot. The newest
  snapshot is never recommended just because it is newest.

The **assessment fingerprint** is a hash of the incident, snapshot, version,
verdict, the normalized (sorted) exclusions and the in-window flag. Changing any
exclusion changes the fingerprint.

## Exclusions

A clean assessment can exclude malicious items that the snapshot captured:

- `naturalKey` alone means the whole object is malicious, for example an
  attacker-created group that holds a Global Administrator grant.
- `naturalKey` with a dot-path `field` means one malicious field, for example a
  defaced description.

Each exclusion must exist in that snapshot when it is recorded, so an exclusion
can never silently match nothing. A `compromised` verdict cannot carry
exclusions, because it already refuses the whole point.

When a restore runs under the incident:

- If a whole-object exclusion falls inside the restore closure, the restore is
  refused. Restoring around the object would leave a dangling reference, and
  restoring it would bring back the malicious object.
- A field exclusion removes that field from what is written. KEEL works on a
  copy with a recomputed hash and never mutates the snapshot. Post-write
  verification in `applyEngine` leaves exactly those excluded paths out of the
  comparison, and every other field still verifies.
- Every exclusion becomes a **post-restore check**:
  - an excluded object must be absent from the target;
  - an excluded field must not hold the excluded value. Only a hash of the
    value is stored.

After an enforced incident restore, KEEL reads the target again and evaluates
these checks. The results go to the evidence chain (kind
`incident-recovery-check`). If any check fails, the run fails with
`incident-check-failed: …`. A malicious grant that is still live after recovery
is never reported as a clean restore. A field check whose value was outside the
restored scope is reported as `unverified`, never as passed.

## Restoring under an incident

`keel-restore --snapshot-id <id> --select <key> --incident <incidentId>`, worker
`params.incidentId`, or the portal: the **Restore from here** link on
`/incidents` opens the restore wizard with the incident attached.

- **Qualified point:** the restore proceeds.
- **Unsuitable or unassessed point:** the restore proceeds only under a valid
  override. An override is valid only if all of these hold:
  - it is bound to the current assessment fingerprint, or to "no assessment"
    when there is none;
  - it is bound to the snapshot's in-window state;
  - it has not been revoked;
  - it was authorized by someone other than the restore requester;
  - that person **currently** holds `investigate`.

  Otherwise the restore is refused with `incident-recovery-refused`, and no
  artifact is persisted.
- **The gate cannot be sidestepped.** A snapshot that falls inside an open
  incident's compromise interval can only be restored under that incident. This
  applies to every non-compensation scope: selection, plan and remediation. It
  also applies at promotion, so an incident detected after the dry run blocks
  promotion of the artifact.
- **What the plan binds:** the context is stored in
  `restore_dry_run.incident_recovery` and folded into the plan digest. It holds
  the incident, status, qualification, in-window flag, assessment id, version
  and fingerprint, the exclusions, the override and the post-restore checks.
  Promotion re-derives all of it from the database:
  - a new assessment version, an assessment edited in place, an interval
    change, a revoked override or an authorizer who lost `investigate` each
    refuses the promotion (`restore promotion refused: …`);
  - a promotion never takes its incident from the caller. It always comes from
    the artifact.
- Restores without an incident carry no context and keep their digest
  unchanged.

## Retention pins

`pruneSnapshots` treats an active pin (`retention_pin.released_at IS NULL`) as a
dependency, so a pinned snapshot and its resource versions survive routine
prune. An investigator can release a pin, with a reason. After release, the
snapshot is under routine retention again, and the pin's history does not block
a later prune.

A pin keeps data. It is never evidence of a clean state: qualification ignores
pins entirely, and the portal says so beside every pin.

## Migration and legacy reads

All changes are additive and retry-safe:

- new tables `incident`, `incident_compromise_interval`,
  `incident_snapshot_assessment`, `incident_recovery_override` and
  `retention_pin`;
- a nullable `restore_dry_run.incident_recovery` column;
- the widened role check, which every existing grant already satisfies.

`snapshot_id` in the new tables deliberately has no foreign key. Assessment,
override and pin history must outlive a snapshot that prune later removes, and
must never block that prune. Tenant scope is checked in code on every read.

Artifacts persisted before task-71 read as "no incident" and promote as before,
unless their snapshot now lies in an open incident's compromise interval.

## Limitations

- Qualification reflects the investigator's judgement. KEEL does not detect
  compromise or check a verdict against sign-in or audit data.
- Exclusions name objects and fields that exist in KEEL's configuration
  snapshots. A malicious change KEEL does not collect, such as content or an
  unsupported type, cannot be excluded or checked.
- A field exclusion means KEEL leaves that field untouched. It does not choose a
  safe replacement value. If the live object still holds the malicious value,
  the post-restore check fails and an operator must fix it.
- Post-restore checks use the same collection read as the rest of the restore.
  When that read does not cover an excluded object's type, the check is
  reported as `unverified`, because the object's absence proves nothing.
- Everything was tested with fixtures and a fake Graph writer only. No live
  tenant restore or incident drill was run.
