# The portal paid for a new database connection on every call, and for a full render per menu link

On 2026-10-20 the redesigned portal felt laggy on a phone. Measured locally against the production
build with a throttled phone browser (100 ms latency, 4x slower CPU): nothing in the browser was slow
(60 fps scrolling, zero idle work), but the server did far more than one page's worth of work per page.

- Every loader, the middleware and the layout opened its own `pg.Client` and closed it again: about
  eleven connections per page load, 6 ms each here, more on the VPS.
- Every `next/link` in the menu prefetched its route, and a prefetch of a dynamic route renders the
  whole layout (identity lookup, approvals count, display name) on the server. A desktop page load
  made 18 such renders before anyone clicked; each client-side navigation made 4 to 9 more.
- Content faded in over 320 ms plus up to 200 ms of stagger, and the loading skeleton faded in too,
  so a page was fully readable about half a second after its data arrived.

| Mistake | Rule now |
| --- | --- |
| `connect()` + `end()` per call in request handlers | Request code gets its client from `portal/lib/db.ts` (a pool); only CLIs open their own connection |
| Default prefetch on shell navigation that is always in view | Shell links (menu, tab bar, section tabs) are `prefetch={false}`; page-content links may keep it |
| Entrance animations longer than a frame or two of reading | Entrances use `--duration-base` with at most 90 ms of stagger; a loading skeleton never animates in |
| Judging "laggy" from the browser alone | Count server work per page (DB connections, prefetch renders) as well as frames and long tasks |
