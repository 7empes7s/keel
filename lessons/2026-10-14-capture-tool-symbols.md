# Live capture tool: typed symbols and writes journaled under their own key

Context: two live writes succeeded on the test tenant (Q45, Q46), but the capture tool refused to qualify them.
Its tests used reference symbols and journal entries made up by hand, not in the shape the collector and restore really write.

| Mistake | Rule now |
| --- | --- |
| `byReferenceProblems` removed the type prefix from a reference symbol and looked up the bare key. Real natural keys keep the prefix (`roleDefinition:<template id>`), so the role was never found. | Look up a reference symbol whole first. Test fixtures use natural keys and symbols shaped the way `engine/cir/canonicalize.mjs` builds them. |
| A write registered and journaled under its own key (`organizationalBranding#file`) had no reviewed fixture guidance, so the capture treated it as a named object. | Every registered key a restore journals needs a `FIXTURE_GUIDANCE` entry, and a capture test that uses a journal entry shaped like the one its handler writes. |
