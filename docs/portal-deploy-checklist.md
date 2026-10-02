# Portal redesign: deploy and verify

A checklist for shipping the portal design pass (design system, motion, grouped
navigation, posture dashboard, restore wizard, brand mark) to the live portal at
`/opt/keel-live/portal`, and checking it against real tenant data.

Nothing in this change alters the database schema, an API contract, an
authorization rule or the restore promotion flow. It adds one read query (drift
per day, for the dashboard trend) and one count query (pending approvals, for the
sidebar badge). Both are guarded and fail soft.

## Before you deploy

- [ ] You can sign in through Cloudflare Access and hold both `admin` and
      `viewer` grants (see `docs/portal-access-bootstrap.md`). Hold `approver`
      too if you want to see the Approvals badge and card.
- [ ] Record the currently deployed revision so you can roll back:
      `git -C /opt/keel-live rev-parse HEAD`
- [ ] Record the current readiness baseline (read-only):
      `node tools/release/readiness.mjs --portal-url http://localhost:3000 --deployed /opt/keel-live`

## Deploy

1. Merge the PR into `master` once you are happy with the preview.
2. Bring `/opt/keel-live` to the merged revision using your usual release
   procedure (the roadmap rule stands: no branch switching or force-pushes
   inside the deployed tree).
3. In `/opt/keel-live/portal`:
   ```sh
   npm ci
   npm run typecheck
   npm run build
   ```
   `npm run build` must report `Compiled successfully`. The single warning about
   dynamic filesystem access comes from `lib/runtime-config.ts` and predates
   this change.
4. Restart the portal service (the systemd unit or process manager that runs
   `next start` for `/opt/keel-live/portal`).
5. `curl -s http://localhost:3000/api/health` returns `{"status":"ok"}`.

## Verify on real data

Work through these signed in as yourself. Each line names what to look at and
what "right" looks like.

### Shell and navigation
- [ ] Sidebar shows groups (Posture, Recovery, Operations, Governance,
      Settings) and only the pages your grants allow.
- [ ] Approvals shows a number badge if requests are pending (approvers only).
      If the count cannot be read, the badge is simply absent, never an error.
- [ ] ⌘K / Ctrl K opens the palette; typing `re` puts Restore first; Enter
      navigates.
- [ ] Theme toggle: Light and Dark persist across a reload with no flash of the
      other theme; System follows the OS.
- [ ] The boat mark tips and rights itself once on first load; the browser tab
      shows the same mark.
- [ ] Below ~1000px wide the nav collapses behind a menu button.

### Dashboard
- [ ] The headline matches the alerts below it: any critical alert gives
      "Action needed", warnings only give "Degraded", none gives "No issues
      detected".
- [ ] Open drift total matches the Drift page count.
- [ ] The 30-day trend looks plausible against what you know of recent
      collections. Hover shows per-day counts. A flat line at zero with open
      drift present usually means drift was detected more than 30 days ago,
      not a bug.
- [ ] Coverage ring percentage matches the Coverage page totals.

### Restore wizard (dry run only; do not confirm unless you mean to)
- [ ] Selecting a resource shows its added dependencies with the reason.
- [ ] Trying to deselect something another selection requires is refused
      with the requiring resource named.
- [ ] Start a dry run: step 2 shows progress and the job id; it completes to
      step 3 with counts and planned changes. Then press Discard.
- [ ] Long natural keys wrap inside the table and the closure list instead of
      widening the page.

### Write surfaces
- [ ] Approve and Reject each show the spinner on the pressed button only.
- [ ] Disable channel, Delete subscription and Pause destination each ask for
      confirmation, with Cancel focused by default.
- [ ] Back up now: only the pressed tier's button shows a spinner.

### Accessibility spot checks
- [ ] Tab through the sidebar and a page: every control shows a visible focus
      ring.
- [ ] With "reduce motion" enabled in the OS, pages appear without entrance
      animation and the boat mark does not move.

## Record and roll back

- [ ] Re-run the readiness recorder and commit the updated
      `docs/release/readiness.json` with the new deployed revision.
- Rollback: check out the revision recorded before deploying in
  `/opt/keel-live`, rebuild the portal, restart the service. No data migration
  needs reversing.
