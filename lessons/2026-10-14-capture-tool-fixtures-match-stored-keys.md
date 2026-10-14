# Capture tools must read keys as KEEL stores them (2026-10-14)

Q48 ran 15 Entra writes on the test tenant. KEEL wrote them correctly, but the
capture tool could not record four of them and the evidence for three more was
held back from the public branch.

| Mistake | Rule now |
| --- | --- |
| The fixture check took an edge's parent symbol (`group:KEEL-RT-148-g5`) as its name, so no group edge matched `^KEEL-RT-` (steps 5–8). The test fixtures used an untyped parent, which the journal never writes. | `entraLive.mjs` strips the parent's type before the anchored check and accepts the checklist's bare name or the typed symbol. The test builds the key as `relationshipWriter.mjs` does. |
| A delete was checked against the restore's snapshot, which by definition never holds the deleted object (step 37). | A by-reference delete reads its role, principal and scope from its composed key (`roleAssignment:<role>@<principal>@<scope>`). Every other case still needs the object in its snapshot. |
| The application create body kept `createdByAppId`, which Graph sets and refuses (step 11). Update was safe only because its projection drops unknown fields. | `CREATE_EXCLUDED_FIELDS.application` lists it, with a test that the POST body never carries it. |
| A role assignment id is base64url of two GUIDs, not text, so the pseudonymizer left it raw (step 35). | `pseudonymize.mjs` maps it through the GUIDs it encodes, and the capture guard refuses it raw. |
| A pseudonymized group SID is still `S-1-12-1-…`, so a shape grep reads it as a leak (steps 1 and 3, as in Q45). | Run `node tools/qualification/pseudonymize.mjs check FILE...` before publishing: every pseudonym GUID is version 8, so it tells pseudonyms from raw ids without the tenant. |
| Q51 (#232): the delete fallback read the scope as a symbol, but the composed key holds an administrative unit as a raw `/administrativeUnits/<id>` path, and the fixture role was matched by one exact name (`KEEL-RT-148-role`) while queue items recreate fixtures under a fresh prefix. | A scope path is resolved by the object id in the snapshot's payloads. Any `KEEL-RT-` custom role passes; a role the snapshot marks `isBuiltIn` is refused. Never pin a fixture check to one fixture's exact name. |
| Q52 (#235): the deleted role assignment's own id still reached the step 37 capture log raw (`targetId`, `priorState.id`), and neither the capture guard nor `pseudonymize.mjs check` saw it, because both only know the id shapes they were taught. | Role assignment ids match with any `-<suffix>` parts (`-1`, `-1-e`) and in the three-GUID scoped form, and a GUID without dashes counts as an id. A by-reference capture also refuses when its target's own id survives unchanged, whatever its shape, so an unknown shape stops the capture instead of being published. |
