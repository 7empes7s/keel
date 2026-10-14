# Every artifact a surface can create must be approvable from the portal

Live operator run Q45 (2026-10-13): a restore dry run made with `cli/keel-restore.mjs --persist-artifact` carried a
content effect (group expiry 400 → 365 days). Its restore was approved, then the job failed with
`blocked-content-effect`: the separate content-effect approval was only offered on a dry run made in the portal, so
nobody could give it. Gap B11 (a CLI-made artifact needing a CLI executor) was the same shape of mistake.

| Mistake | Rule now |
| --- | --- |
| An approval step existed only on the surface (portal) that usually creates the artifact. | Any approval a gate checks is reachable in the portal for every persisted artifact, whichever surface made it (CLI, portal, worker). Test it with an artifact that has no portal job. |
| The refusal said what was missing but not where to fix it. | A refusal that needs a human decision names the place to make it (the portal page and how to reach it). |
