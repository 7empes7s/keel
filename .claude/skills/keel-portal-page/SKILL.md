---
name: keel-portal-page
description: Use when you add or change a portal page, API route or client component in portal/, including its auth, capability, cross-site and UI-harness checks.
---

# Portal page or API route

The portal is Next.js 16 in `portal/`. Pages are `portal/app/**/page.tsx`, routes are `portal/app/api/**/route.ts`,
and server logic lives in `portal/lib/*.ts`, which imports the engine directly (`../../engine/...`).

## 1. Auth comes from `portal/proxy.ts`

Every request goes through `proxy.ts` (its matcher skips only `_next/static/` and `icon.svg`):
- `GET /api/health` is the only public path.
- `isSameOriginRequest` (`portal/lib/same-origin.ts`) refuses a cross-site state change with 403.
- With no `cf-access-jwt-assertion`, or one that fails `verifyAccessAssertion`
  (`portal/lib/cloudflare-access.ts`), the answer is **401**.
- `resolveIdentity` (`portal/lib/principal.ts`) sets `x-keel-principal-id`, `x-keel-capabilities` and
  `x-keel-entity-capabilities`. Routes read these headers and never trust a caller's copy.

Never add a matcher exception or a second public path.

## 2. Capabilities

- **Reads.** Declare the surface in `DATA_SURFACES` (`portal/lib/read.ts`) as `{ capability, source }`. Wrap the
  route as `export const GET = guardedRead(DATA_SURFACES.x, handler)`, and gate the page with
  `requireReadAccess`. `portal/test/read-auth.test.ts` scans `app/**` and fails when a page or GET route is not
  declared, or declares the wrong capability.
- **Writes.** Use `guarded(spec, handler)` in `portal/lib/action.ts` with `GuardSpec` `{ action, capability,
  alsoRequires?, requiresApproval?, jobKind?, entityScoped? }`. Use `guardedAction` for a job (its capability
  comes from `capabilityForJobKind` in `engine/authz/jobCapabilities.mjs`).
  - A spec with no `capability` declares no check. Always set one.
  - `guarded` refuses a body that isn't `application/json` (`isJsonContentType`).
  - `requiresApproval` makes the request an `approval_request`. A second person approves it.
  - Capabilities and roles are in `engine/authz/permissions.mjs` (`ROLE_CAPABILITIES`).
- A tenant-wide write, a delete or a content effect from the portal still goes through the engine's restore
  approvals. The portal never writes to Graph itself.

## 3. Tests for a new route or page (`portal/test/*.test.ts`)

- **401 without an assertion.** Add the path to `portal/test/auth.test.ts`. Use the existing `request(path,
  undefined, method)` helper with `middleware(...)` and assert `response.status === 401`, once per method the
  route exports. Copy the loop shape at the end of that file.
- **Capability refusal**: a principal without the capability gets 403 before the handler runs (see
  `read-auth.test.ts`, `read-page-auth.test.ts`, `action.test.ts`).
- **Cross-site** for a state-changing route: `Sec-Fetch-Site: cross-site` or a foreign `Origin` gives 403 (see
  `cross-site.test.ts`).
- A server module never imports a plain value from a `"use client"` module (`client-boundary.test.ts`).
- Words: `one-word-vocabulary.test.ts` bans the words in the "One word per idea" table of
  `docs/roadmap/portal-experience.md`. No raw ids in visible text; put them under "Technical details".
- Colours come from the tokens at the top of `portal/app/globals.css` only. `design-tokens.test.ts` fails on a
  colour literal anywhere else.

## 4. UI harness (`portal/ui-harness/`)

Cloud sessions and the box cannot open live pages (Cloudflare Access), so UI is checked on fixtures.
- Add a fixture route for the page in `ui-harness/app.tsx` (the `Page` switch on the hash path). Answer its
  API calls in the stub `fetch` in the same file, so write flows walk their real states.
- Add the page to `PAGES` in `ui-harness/ui.spec.ts` (axe in both themes). If it matters visually, add it to
  `VISUAL` and create its baseline with `npm run test:ui:update`.
- `ui-harness/layout.spec.ts` finds pages from the router and checks 375, 390 and 1278 px: no sideways scroll,
  nothing cut off.
- Baselines in `ui-harness/__screenshots__/` change only for the intended change. Commit no other screenshots
  (lesson 2026-10-16-screenshots-and-debug-commits).
- Text dimmed with opacity fails contrast (lesson 2026-10-17-opacity-dims-text-contrast).

By hand: `npm run ui:build`, open `ui-harness/dist/index.html`, and check 375, 390 and 1278 px in light and
dark.

## 5. Commands (in `portal/`)

```bash
npm run typecheck
npm test                                      # node --import tsx --test test/*.test.ts (needs KEEL_DB_TEST_URL)
npm run build
npx playwright install --with-deps chromium   # once
npm run test:ui                               # builds the harness, then axe, screenshots, layout
```

Run Playwright and full builds in a cloud session or CI, never on Mulinux (it has no spare memory).

## 6. Before the PR

- A new table goes in a new `engine/store/schema.d/NN-topic.sql` fragment, additive only (no `DROP`,
  `TRUNCATE` or `DELETE FROM`: the deploy refuses them).
- Keep per-request cost flat: no query per row (lesson 2026-10-20-portal-per-request-cost).
- Then follow the **keel-pr-checklist** skill.
