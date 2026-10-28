# A generic writer sent named location trust from a backup (2026-10-28)

The security audit (run 1, finding 2) found that a named location restore went through the
generic create and update path. It sent `isTrusted`, `ipRanges`, `countriesAndRegions` and
`includeUnknownCountriesAndRegions` straight from the backup, with no manual step and no
lockout check. Only the delete was gated. The rule "restore writers never send trust fields"
(lesson of 2026-10-21) had been applied to the governed writers, but not to the types the
generic path writes. The sign-in path gate did not read named locations either, so its
closing comparison could not see the change.

| Mistake | Rule now |
| --- | --- |
| The trust rule was checked writer by writer, and the generic create and update path had no check. | A trust or sign-in field is withheld wherever it is written. For named locations, `namedLocationTrust.mjs` runs in `applyOne` before any writer, for every verb but delete. |
| Only the delete of a tenant-lockout type was gated. | Check the create and update of a tenant-lockout type too: what can each field change about who signs in from where? |
| The sign-in path snapshot left out an object that the policies in it depend on. | The snapshot reads named locations. A location this run wrote is left out of the closing comparison only when what it trusts reads back as before. |
| An update re-sent unchanged trust values. | An update body never carries the trust fields, so a change made after the plan read is kept. The one exception is a compliance fix's single declared setting. |
