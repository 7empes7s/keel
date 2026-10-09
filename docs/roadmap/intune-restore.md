# Intune policy restore (issue #155)

Status 2026-10-09. Proven with fixtures only. **Not live-qualified:** no restore has been
run against a real tenant, and the routes below have not been checked against Microsoft's
live behaviour.

## What KEEL can restore

Three kinds of Intune policy can be created again or put back to their backed-up settings:

| Policy | Create | Update | Graph version |
| --- | --- | --- | --- |
| Compliance policies | yes | yes, changed fields only | v1.0 |
| Device configuration profiles | yes | yes, changed fields only | v1.0 |
| Settings catalog policies | yes | yes, whole policy replaced | **beta** |

For each one, KEEL also puts back **who the policy applies to** (its assignments) when
the backup holds a complete read of them. Assignments are restored only when you pick
policies for a restore (and when that restore's dry run is promoted). A drift fix or an
older saved plan leaves assignments as they are, and its plan says so for each policy.

### How a restore works

1. KEEL removes fields that Microsoft owns, such as the id, the created and modified
   dates and the version. It keeps the policy kind, because Microsoft needs it to create
   the right type of profile.
2. A compliance policy is always created with its actions for non-compliant devices
   (for example "mark as non-compliant after 0 days"). Microsoft refuses a compliance
   policy without them. If the backup has no actions, KEEL refuses to create it. A backup
   taken before actions were backed up can still update a policy: KEEL leaves the live
   actions as they are and the plan says so. A backup that lists no actions at all is
   refused, because an empty list would remove them.
3. A settings catalog policy is always written with its full list of settings, which
   replaces the whole policy. KEEL refuses when the backup has no settings list, or holds
   fewer settings than the policy's own count says it has, so that it never deletes
   settings. An empty list is accepted only when the policy says it has no settings.
4. Assignments are written with the documented "assign" action, which replaces the full
   list in one step. Groups are matched to the target tenant by natural key (the group's
   mail nickname), through the same matching used for every other restore. Groups
   created earlier in the same restore are found too. A group matched only through its
   history (renamed or recreated) is refused until someone reviews it.
5. The plan says what happens to each policy's assignments, in words: for example
   "replaces the 2 assignments the policy has now with the 3 in the backup", or "removes
   all 2 assignments the policy has now, because the backup has none".
6. After every write, KEEL reads the policy and its assignments back and checks that they
   match the backup.

### When KEEL refuses

KEEL stops before writing anything when:

- **A target group is missing.** The plan names the group. Restore the group first, then
  run the restore again.
- **An assignment filter is missing** in the target tenant. The dry run checks this too
  and refuses the same way. A preview, which has no write access, cannot check it.
- **The live policy is a different kind** from the backup (for example a Windows profile
  where the backup has an iOS one).
- **The backup's assignment read was incomplete.** KEEL then leaves the live assignments
  as they are, rather than guess.

### Secrets are never written

Microsoft hides passwords, pre-shared keys, certificates and similar values when a policy
is read, so a backup never holds them. A policy with any such field (Wi-Fi, VPN,
certificate, email and similar profiles, or any setting marked secret or encrypted) is
**manual**: KEEL shows it in the plan with the reason and never writes it with the
secret left blank.

## What is manual, and why

Every other Intune type is backed up, and has a plain reason for being restored by hand:

| Type | Why it is manual |
| --- | --- |
| Enrollment restrictions and settings | The defaults exist in every tenant and cannot be created, and custom ones are ordered through a separate priority action KEEL does not write. Their assignments are backed up. |
| Intune admin roles | They decide who can manage devices, so a change needs a privilege review. Their role assignments are not backed up. |
| Device categories | A category is only a name. Devices join one at enrollment, which a restore cannot redo. |
| Terms and conditions | A recreated policy asks every user to accept again. |
| Autopilot deployment profiles | Beta only, and a profile applies to registered devices whose hardware records are not backed up. Their assignments are backed up. |
| Security baseline intents | Beta only, replaced by the settings catalog, and their settings are a separate list that is not backed up. |
| Apps | App packages are content, not configuration, and are not backed up. |
| App protection policies | Each platform has its own write route, and the list of protected apps is not backed up. Their assignments are backed up. |
| App configuration policies (managed apps) | The apps they target are set through a separate action that is not backed up. |
| App configuration policies (managed devices) | Each one configures one specific app, and apps are not restored. |

## Where beta is used

Graph v1.0 has no route for these, so KEEL uses beta:

- Settings catalog policies: read, create, replace and assign.
- Assignment filters: checking that a filter exists before assignments are written.
- Reading assignments of Autopilot profiles, terms and conditions, and security baseline
  intents.

Beta can change without notice. A change there shows up as a failed read-back, not a
silent wrong write.

## Changes to backups

- Backups now read assignments for every Intune policy type that has an assignments
  route.
- Compliance policy backups now include their actions for non-compliant devices, and
  settings catalog backups now include their settings.
- Some fields Microsoft owns are no longer compared: the version on compliance policies
  and device configuration profiles, whether a device configuration profile supports
  scope tags, and the settings catalog's counts and flags.
- Because of both, the first backup after this change will show compliance policies,
  device configuration profiles and settings catalog policies as changed, once.
- Each backup logs how many assignment reads were complete, partial, failed or not
  supported (counts only), so a missing read permission is visible.

## Permission

Restore needs `DeviceManagementConfiguration.ReadWrite.All`. It is declared in
`restorer-least-privilege.md` and is not yet verified as granted.

## Technical details

- Code: `engine/restore/intuneOperations.mjs`, with dispatch in
  `engine/restore/applyEngine.mjs`.
- Decisions: `TYPE_DECISIONS` in `engine/coverage/qualification.mjs`.
- Proof: `engine/roadmap/intune-restore.test.mjs` and the fixture harness in
  `tools/qualification/operations.mjs`.
- Not confirmed against Microsoft docs in this change: `$expand` of the actions on the v1.0
  compliance list, `$expand=settings` on the beta settings catalog list, `PUT` as the
  settings catalog update method, the `scheduleActionsForRules` body, the exact `/assign`
  body shapes, the beta assignment filter path, the newly added assignment read routes,
  and the list of field names treated as secret.
