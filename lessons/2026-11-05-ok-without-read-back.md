# A write marked ok without its read-back (2026-11-05)

The Purview writer capture of 2026-10-30 (`docs/release/qualifications/workload-writers-purview-retention-dlp-live-acceptance.json`)
logs three failed `Set-RetentionCompliancePolicy` calls, yet `purview.retention-policy.update` says
`ok: true`. Issue #1009.

What the review found:

- The record itself is honest. Purview saved the change and then threw `PolicyDeploymentException`
  (Q260). The re-read showed the unique `KEEL capture <time>` marker, and the put-back read back as
  the original. That is `readBackVerified: true` and `restoredToOriginal: true`. The ledger requires
  both, so the qualification stands.
- The code was not safe. `captureUpdate` in `tools/qualification/workloadWritesLive.mjs` set
  `ok = no error and no put-back error`, without the read-back. If a "saved, but deploying failed"
  write never landed, or a Set answered ok without applying, the write still said `ok: true`. Only
  the separate `readBackVerified: false` showed the truth. A `New-` add was marked ok the same way.
- The capture log kept only the error code and `[],Write-ErrorMessage` for each failed call. Nobody
  could tell from the log why three failures still made an ok.

| Mistake | Rule now |
| --- | --- |
| `ok` meant "the cmdlet answered without a definite error". | A write is ok only when the re-read shows the value. A failed or "successful" cmdlet whose value is not read back sets `error` (the cmdlet's message, secrets masked, plus "the re-read does not show …"). |
| A failed call in the capture log carried no message. | Every failed request in a capture log keeps the cmdlet's message, passed through `redactSecrets`. |

Checked for the same cause: the restore path (`runOperation`/`verify` in
`engine/restore/workloads/cmdletSettings.mjs`) already decides from the re-read. The Exchange,
Purview (including unpublish) and SharePoint-structure writers treat every `CMDLET_ERROR` as a
failure. Only this capture swallowed a cmdlet error (`isSavedButNotDeployed`).
