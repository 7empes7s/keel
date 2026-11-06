# An unrelated read blocked every delete, a third time (2026-11-06)

A live dry run on the test tenant (build f1521256, dry run 6f07e792) refused all ten fixture deletes
(groups, service principals, Intune policies) with `blocked-incomplete-read: ... defenderIdentitySensor
could not be read`. The tenant is not onboarded to Defender for Identity, so the sensors read answers
403 there. Issue #1035.

This is the same cause as issue #666 (To Do settings answering 500) and Q220 (a PIM for Groups read
answering 403). `incompleteReadDeleteRefusals` in `cli/keel-restore.mjs` treats any unread kind as a
place a reference to the deleted object could hide, unless the catalogue says otherwise.

| Mistake | Rule now |
| --- | --- |
| A new catalogue kind was added without saying whether it can hold another object's id, so it blocked every delete once its read failed. | When you add a catalogue kind whose object holds no tenant object ids (only switches, names, DNS names), set `holdsNoReferences: true`. When it names only some kinds, set `refersOnlyTo`. Leave both off only when it can name anything. |

Checked for the same cause: `secureScoreControlProfile` (the other Defender XDR kind) keeps its block,
because each control's state records who it is assigned to and who changed it.
