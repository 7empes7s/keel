# A server component cannot call a "use client" helper (2026-10-21)

PR #401 made the job list (`components/job-table.tsx`, a server component) call
`refUsage()`, which was exported from `components/technical-details.tsx`, a
`"use client"` module. On the server that import is only a client reference, so
Next.js threw "Attempted to call refUsage() from the server but refUsage is on the
client". Restore, What's protected, Baselines and every job page showed "This page
could not be rendered" on the live portal. The unit tests and the UI harness render
everything as client code, so CI was green.

| Mistake | Rule now |
| --- | --- |
| Put a plain helper in a `"use client"` file and called it from a server component. | Shared helpers live in a plain module under `lib/` (here `lib/record-refs.ts`). A `"use client"` file exports components and types only for server callers. |
| No check covered the server/client boundary. | `portal/test/client-boundary.test.ts` fails when a module without `"use client"` imports a lowercase value from a `"use client"` module. |
