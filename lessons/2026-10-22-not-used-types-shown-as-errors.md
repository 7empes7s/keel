# Types the tenant does not use were shown as errors (2026-10-22)

The backup already recorded lifecycle workflows (no Entra ID Governance licence),
API connectors (self-service sign-up off) and Intune's Exchange connector (501) as
`unavailable`, not failed (#289, #309, #466). Discovery and Resilience did not use
that rule. Discovery said "9 types KEEL backs up were not found or could not be
read" and Resilience listed the same types as "never backed up successfully", so
real problems were buried among types the tenant simply does not have.

| Mistake | Rule now |
| --- | --- |
| Each page judged a refused read on its own. | One rule (`entraAdapter.unavailableOnTenant`) decides "not used in this tenant". Discovery applies it through `notUsedReason`, plus a 404 on a singleton marked `absentWhenNotFound`. |
| Resilience required every type, even one the tenant cannot have. | A type whose newest read is `unavailable` is listed as "Not used" and left out of the age, the gaps and the off-site copy check. A newer read of any other kind counts it again. |
| A stored discovery run kept its old verdict. | `loadLatestDiscovery` re-applies the rule from the run's own refusals, so the page is right without a new run. |
