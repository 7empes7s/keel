# A new restore writer for protection settings must refuse the weakening direction (2026-10-22)

#543 declared Set- writes for the mail protection policies (anti-spam, anti-phish,
anti-malware, Safe Links) so that "Make it pass" could tighten one setting. Those
declarations are also used by every ordinary workload restore, whose source is a backup.
The content-effect rules only caught the strict direction (mail sent to quarantine), so a
tampered or old backup could add an allowed sender domain, turn on Safe Links
click-through or turn a filter off, and the restore would write it. The security review
caught it after merge. The PIM (#439), conditional access (#443) and Purview (#456)
writers already had this guard.

| Mistake | Rule now |
| --- | --- |
| A protection setting was made writable for one stricter use (a compliance fix), and the general restore inherited both directions. | When a write is declared for a security or protection setting, add a weakening rule for every written field (`WEAKENING_RULES` in restore/workloads/cmdletSettings.mjs). A weakening change is a manual entry with `weakensProtection: true`, and execution checks it again before the write. |
| A value KEEL cannot rank was treated as comparable. | An unknown value counts as weakening: it is listed, never guessed. |
