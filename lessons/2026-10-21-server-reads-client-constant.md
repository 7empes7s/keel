# A server component cannot read a "use client" constant (2026-10-21)

`components/page-header.tsx` (a server component) read `SECTION_ICONS` from
`components/nav-links.tsx`, a `"use client"` module. On the server that import is a
client reference, not the object, so `SECTION_ICONS[section]` was undefined and the
page actions icon was missing on every page. Unlike a helper call, nothing threw, so
no page failed and CI was green. The boundary check from the earlier helper lesson
only looked at lowercase names, so it missed this SCREAMING_CASE constant.

| Mistake | Rule now |
| --- | --- |
| Read a plain constant from a `"use client"` file in a server component. | Shared constants live in a plain module under `lib/` (here `lib/nav-sections.ts`). |
| The boundary check only flagged lowercase names. | `portal/test/client-boundary.test.ts` flags every imported value that is not a PascalCase component name. |
