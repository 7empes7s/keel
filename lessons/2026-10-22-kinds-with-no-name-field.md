# Kinds with no name field read "Unnamed" (2026-10-22)

Exchange role assignments, PIM schedules, cross-tenant partners and about twenty
other kinds carry no displayName: a role assignment is only a role id, a holder id
and a scope. Only app settings had a rule that built a name from what they point
to, so every new kind keyed by id was listed as "Unnamed exchange role assignment"
and the like (22 of them on the Ask page at once).

| Mistake | Rule now |
| --- | --- |
| A kind keyed by its Graph id was added with no way to name it. | Every kind in the catalog is placed in `portal/test/unnamed-kinds.test.ts`: named by a name field, by another field (`engine/cir/objectName.mjs`), by its key, by its type, or by a rule in `portal/lib/app-names.ts` with a fixture. The test fails on a kind in none of them. |
| Role assignments were named only for one provider's shape. | One rule names every role assignment shape (Entra, PIM, Exchange `/RoleGroups/…` paths, Defender lists, entitlement management) as "Role → Holder (scope: …)", with ids looked up in the backup. |
