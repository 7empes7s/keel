# The Value report's backups card was plain sentences, and hid a partial run (2026-10-22)

"What we backed up" was three sentences with no colour or status. The content line read
"0 of 1 areas backed up, 0 good runs; 4094 new items stored", which looked like a
contradiction. The counts were right by their own rules but said the wrong thing:
the first whole-tenant content run read mail only in part, then stopped before the
other four areas, so no run counted as good while its items were stored.

| Mistake | Rule now |
| --- | --- |
| A report card was only text lines. | Every Value report card has a status badge in its head and a visual (tiles, meter, ring, chart, figures or a table). `portal/test/value-report-view.test.ts` fails on a text-only card, and on any component that maps sentences into muted list items. |
| A run that read an area in part was counted nowhere. | The engine reports each area's state (`good`, `partial`, `failed`, `not-run`); partial areas show as "Backed up in part" (amber), and stored items say they include them. |
| The content total counted only areas that had ever recorded a run (1). | Every content run reads all five content areas, so once any content run exists all five are expected. |
