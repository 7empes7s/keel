# Portal UI harness

The portal's real client components rendered with fixture data into one static
HTML file. No database, no Cloudflare Access, no network: fonts are inlined from
the `@fontsource` packages, and the `next/navigation` and `next/link` imports are
swapped for hash-routing shims (`shims/`).

It exists so the design can be checked without a live tenant:

| Command | What it does |
|---|---|
| `npm run ui:build` | Builds `ui-harness/dist/index.html`. Open it in a browser to click through. |
| `npm run test:ui` | Builds, then runs `ui.spec.ts`: axe WCAG 2.1 A/AA checks on every page in both themes, screenshot comparisons, and interaction checks (palette, confirmations, toasts, restore wizard). |
| `npm run test:ui:update` | Same, but rewrites the screenshot baselines in `__screenshots__/`. Run it after an intended visual change and review the image diff in the PR. |

Fixtures live in `app.tsx`. API calls the components make are answered by a stub
`fetch` there, so write flows (dry run, confirm, approve) walk their real states.
When you add a page or component, add a fixture route for it and, if it matters
visually, a `visual ·` test.
