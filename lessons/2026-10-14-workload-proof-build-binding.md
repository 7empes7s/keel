# A standing proof is bound to the code it proves, not to the running build (2026-10-14)

Found by the operator (Q47) after the scheduled workload collection shipped: `keel-workload-collect.mjs import`
stored nothing, because all four signed workload records name the build they were captured on and the import
compared that with the running build. Master deploys many times a day, so every workload stayed disabled.

| Mistake | Rule now |
| --- | --- |
| The import reused the release gate's exact-build check. That check answers "is this candidate build qualified?", not "does this proof still hold for the code running now?". | A proof that must keep counting across deploys is verified at the build it names, plus a check that the code it proved is still what runs: here, the gate validators compare the record with this build's read and write declarations (version, endpoint, written fields, grants). The Entra records already work this way. |
| The test for the import used stub seams only, so the build rule was never exercised across two builds. | `sharepoint-live-acceptance.test.mjs` imports a signed record at a newer running build (accepted) and with a changed write or a 31-day-old capture (refused). |
