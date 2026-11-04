import assert from "node:assert/strict";
import { test } from "node:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RestoreFollowUpsAlert } from "@/components/restore-follow-ups";
import type { JobRecord } from "@/lib/portal-jobs";
import { pastRestoresVerdict } from "@/lib/restore-view";

// The Restore section's sub-pages each lead with one plain sentence. Times are set
// relative to a fixed "now" passed in, never the wall clock.
const NOW = "2026-10-02T12:00:00Z";

test("Past restores: the newest restore in one sentence, a failure linked to its page", () => {
  const job = (status: string, mode = "enforce") => ({ id: "j1", kind: "restore", status, params: { mode }, createdAt: "2026-10-02T09:00:00Z", startedAt: "2026-10-02T09:00:00Z", finishedAt: "2026-10-02T09:02:00Z" }) as unknown as JobRecord;
  assert.deepEqual(pastRestoresVerdict([], NOW), { text: "No restore has run on this tenant yet.", tone: "neutral", href: null });
  assert.deepEqual(pastRestoresVerdict([job("failed")], NOW), { text: "The newest restore failed. Open it to see why and plan it again.", tone: "urgent", href: "/jobs/j1" });
  const done = pastRestoresVerdict([job("succeeded", "dry-run")], NOW);
  assert.equal(done.tone, "fine");
  assert.match(done.text, /^The newest check before a restore: finished 2 hours ago/);
});

test("Restore settings: open follow-up steps show as one alert linking to their page, nothing when none are open", () => {
  const alert = renderToStaticMarkup(createElement(RestoreFollowUpsAlert, { work: { steps: 3, restores: 2, href: "/restore/follow-up-steps", cards: [] } }));
  assert.match(alert, /3 follow-up steps are still open from 2 past restores/);
  assert.match(alert, /href="\/restore\/follow-up-steps"/);
  const one = renderToStaticMarkup(createElement(RestoreFollowUpsAlert, { work: { steps: 1, restores: 1, href: "/restore/follow-up-steps", cards: [] } }));
  assert.match(one, /1 follow-up step is still open from a past restore/);
  assert.equal(renderToStaticMarkup(createElement(RestoreFollowUpsAlert, { work: { steps: 0, restores: 0, href: "/restore/follow-up-steps", cards: [] } })), "");
});
