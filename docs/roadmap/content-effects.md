# Content effects of configuration changes (roadmap task-66)

Some configuration writes change what happens to **content**, which KEEL does
not back up. `engine/safety/contentEffects.mjs` classifies those writes, puts
them in front of a separate approver, and binds that approval to exactly the
effects the approver reviewed.

| Effect | Meaning |
| --- | --- |
| `retention-reducing` | Content is kept for less time and may be deleted sooner |
| `hold-releasing` | Content leaves a legal hold and becomes deletable |
| `externally-sharing` | Content becomes visible beyond its current audience |
| `irreversible` | The change destroys content when it takes effect |

Every effect carries a disclosure:

> KEEL backs up configuration, not content: content deleted or disclosed while
> this setting is in effect is not recoverable by KEEL, and restoring the previous
> setting later does not bring it back.

An inverse setting never claims to recover lost or disclosed content.

## Classification rules

The rules are explicit before/after field rules per type (`CONTENT_EFFECT_RULES`):

| Type | Field | Effect when |
| --- | --- | --- |
| group | `visibility` | becomes `Public` → externally-sharing |
| groupSetting | `AllowGuestsToAccessGroups`, `AllowToAddGuests` | false → true → externally-sharing |
| authorizationPolicy | `allowInvitesFrom` | the invite scope widens → externally-sharing |
| crossTenantAccessPolicyPartner | B2B collaboration in/out and direct-connect out `accessType` | becomes `allowed` → externally-sharing |
| retentionLabel | `retentionDuration.days` | decreases → retention-reducing |
| retentionLabel | `actionAfterRetentionPeriod` | becomes `delete` → irreversible |
| retentionLabel | (object deleted) | retention-reducing |
| ediscoveryHoldPolicy | `isEnabled` | true → false → hold-releasing |
| ediscoveryHoldPolicy | (object deleted) | hold-releasing |
| conditionalAccessPolicy, namedLocation, roleAssignment | — | reviewed: access configuration only |

How a change is judged:

- **Unchanged or narrowing settings are benign.** A visibility change from
  Public to Private, or a longer retention, is not an effect.
- **Creates are benign.** A create starts from nothing, so no existing content
  changes reach.
- **Unknown dangerous transitions are refused.** On a type with no review, a
  changed field whose name looks content-bearing (retention, hold, preserve,
  share, guest, external, invite, wipe, purge, anonymous, public) is refused
  with `unclassified-content-effect` until a rule classifies it. Field names on
  reviewed types never trigger this; only their rules count.
- **Preservation lock.** An existing object marked `isPreservationLocked`,
  `preservationLock` or `restrictiveRetention` is never updated or deleted by
  KEEL. The plan refuses it with `preservation-locked`. If the platform itself
  refuses a write with a preservation-lock error, `applyWave` reports
  `preservation-lock:`. That write is sent once, never retried (only 429 and
  503 are), and no other path such as delete-and-recreate is tried.
- **Conditional Access is unchanged.** Writes stay forced to report-only by
  applyEngine.

## Plan binding and the separate approval

- Effects (with disclosures) are returned by preview, dry run and enforce,
  stored in the new nullable `restore_dry_run.content_effects` column, and
  folded into the plan digest. Plans with no effects keep their digest.
- At promotion, the effects are recomputed and must carry a **separate
  high-impact approval** (`content_effect_approval`). The approval is valid only
  if all of these hold:
  - it is bound to the digest of exactly these effects;
  - the approver is not the requester;
  - the approver **currently** holds `approve`, re-checked when the restore
    runs, so a revoked grant voids it;
  - it has not been revoked.
- Without such an approval the run refuses before any write with
  `blocked-content-effect`.
- A changed effect produces a different digest, so an old approval never
  carries over.
- Recording an approval checks the digest the approver saw against the
  artifact. A stale digest is refused, and the approval is written to the
  evidence chain.

## Portal

- The restore wizard's review step shows a **Content effects · separate
  approval required** panel: each effect with its field change and disclosure,
  plus the approval state.
- Principals holding `approve` can record the approval there with a
  justification, through `POST /api/actions/restore/content-effects`
  (capability `approve`, attempt recorded).
- The dry-run artifact read returns the effects digest and the matching
  approvals.

## Migration and legacy reads

The schema changes are additive: a new nullable column, plus the
`content_effect_approval` table created with `IF NOT EXISTS`. Artifacts
persisted earlier read as having no content effects. If a fresh recomputation
of such an artifact finds effects, the digest no longer matches, so a new dry
run is required.

## Limitations

- Field names and lock markers follow Microsoft Graph resource schemas, but were
  not measured against a tenant. learn.microsoft.com was unreachable from the
  build environment.
- Of the rule types, only `group` currently has a registered write capability.
  The other rules apply as soon as those types become writable, and until then
  they are exercised by the boundary tests.
- Classification sees configuration only. It does not count how much content an
  effect would touch.
