# User and licence restore (roadmap task-150)

## Status — 2026-10-09

Implemented and fixture-tested. **Nothing here is live-qualified.** The
production `applyWave()` writer and read-back ran against the in-memory fake
Graph (`engine/roadmap/user-fidelity.test.mjs`). Live qualification follows the
operator gate in issue #148.

## What a user restore does

| Operation | Graph calls | Permission |
| --- | --- | --- |
| update | `PATCH /users/{id}` with changed reviewed attributes, then `POST /users/{id}/assignLicense` | User.ReadWrite.All, LicenseAssignment.ReadWrite.All |
| restore-soft-deleted | `POST /directory/deletedItems/{id}/restore`, then the same two steps against the restored user | User.ReadWrite.All, LicenseAssignment.ReadWrite.All |
| group licences (inside group update) | `POST /groups/{id}/assignLicense` after the group PATCH | LicenseAssignment.ReadWrite.All |

Create and delete stay unsupported. A password and MFA methods are never
readable, so a user rebuilt from nothing could not sign in as before.

Rules (`engine/restore/userOperations.mjs`):

- **Reviewed attributes only:** display name, given name,
  surname, job title, department, company, office, employee id and type,
  address fields, usage location, phones and preferred language. Never the
  sign-in name, mail, a password, an authentication method or a sync-owned
  field. Only attributes the snapshot holds are compared, so a field an older
  snapshot never captured is not cleared, and a usage location is never cleared.
- **Whether an account is enabled is reported, not written.** Restoring an
  older snapshot would otherwise re-enable a leaver or disable a break-glass
  account. A difference shows in the dry run as a manual step.
- **Users are now in restore selection** (the dry run and the portal's restore
  list), so a snapshot restore covers them.
- **Synced users are refused** before any write, on the snapshot's or the live
  object's evidence (`onPremisesSyncEnabled` or `onPremisesImmutableId`). A
  deleted user that turns out to be synced once restored gets no further write.
- **Licences are add-only.** A licence the snapshot held directly and the live
  user lacks, or holds with other disabled plans, is assigned again. Nothing is
  ever removed. A licence a user inherited from a group is not assigned
  directly; the group's own licences are restored on the group.
- **Read-back.** After the writes the user is read with an explicit `$select`;
  every written attribute and licence must match. A user's direct licence is
  checked against its own assignment state, not the merged licence list. A group
  update without a live read reads the group's licences first.
- **A deleted user keeps its id.** A restore that returns another id fails
  before anything else is written.

## Collection changes

- The user `$select` now includes the reviewed attributes and
  `licenseAssignmentStates` (how each licence was assigned). The group `$select`
  now includes `assignedLicenses`.
- Licences stay outside the configuration hash (server-owned), so a licence
  change alone does not move the hash. The reconciliation plan compares them
  separately and plans an update when a licence is missing.
- **One-time drift:** the new attributes are part of the user hash, so the first
  collection after this change reports every user as modified once. Group hashes
  are unchanged.
- A snapshot taken before this change has no licence assignment states, so its
  licences are not compared or restored.

## Not included

- Creating a user, deleting a user, manager and other relationships.
- Licence restore on a group's create or soft-delete restore (only group update).
- Whether the Restorer holds `User.ReadWrite.All` and `LicenseAssignment.ReadWrite.All`
  is not verified (see `restorer-least-privilege.md`).
