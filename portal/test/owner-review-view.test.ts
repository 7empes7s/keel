import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OWNER_TILES, itemLink, itemsInOrder, ownerReviewStatus, ownerReviewVerdict, problemWords, shapeOwnerReview, siteItems, unreadNotes,
  type EngineOwnerReview, type OwnerRead, type OwnerReviewItem,
} from "@/lib/owner-review-view";
import { withOwnerChecks, type OwnerDirectory } from "@/lib/site-permissions";
import { peopleStatus, sitePermissionsFrom, siteVerdict, sitesVerdict, type PeopleSummary, type SitePermissionsData } from "@/lib/site-permissions-view";

const NOW = "2026-11-04T07:00:00.000Z";
const id = (n: number) => `0e000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const read = (over: Partial<OwnerRead> = {}): OwnerRead => ({ family: "owner", permission: "Group.Read.All", snapshotId: "5a000000-0000-4000-8000-000000000001", readAt: NOW, failed: 0, refused: 0, notRead: 0, ...over });
const counts = (over: Partial<OwnerReviewItem["counts"]> = {}) => ({ total: 0, working: 0, disabled: 0, guests: 0, gone: 0, unknown: 0, ...over });

function item(over: Partial<OwnerReviewItem> & Pick<OwnerReviewItem, "kind" | "problem">): OwnerReviewItem & { kind: Exclude<OwnerReviewItem["kind"], "site"> } {
  return { id: id(1), appId: null, naturalKey: null, name: "Item", owners: [], counts: counts(), readFailure: null, readAt: NOW, ...over } as OwnerReviewItem & { kind: Exclude<OwnerReviewItem["kind"], "site"> };
}

function engine(items: EngineOwnerReview["items"], reads: Partial<EngineOwnerReview["reads"]> = {}): EngineOwnerReview {
  return {
    generatedAt: NOW,
    directory: { snapshotId: "5a000000-0000-4000-8000-000000000002", readAt: NOW, complete: true, users: 40 },
    reads: { group: read(), application: read({ family: "appOwner", permission: "Application.Read.All" }), servicePrincipal: read({ family: "servicePrincipalOwner", permission: "Application.Read.All" }), ...reads },
    skipped: { microsoft: 120, unknownPublisher: 3, otherType: 2 },
    completeness: "partial",
    items,
  };
}

const NO_OWNER = item({ kind: "group", problem: "no-owner", id: id(1), name: "Finance" });
const DISABLED = item({ kind: "team", problem: "only-disabled", id: id(2), name: "Project X", owners: [{ id: id(9), name: "Dan Disabled", state: "disabled" }], counts: counts({ total: 1, disabled: 1 }) });
const GUEST_APP = item({ kind: "application", problem: "guest-owner", id: id(3), appId: id(30), name: "Payroll connector", owners: [{ id: id(8), name: "Gail Guest", state: "guest" }], counts: counts({ total: 1, guests: 1 }) });
const HEALTHY = item({ kind: "group", problem: "fine", id: id(4), name: "Sales", counts: counts({ total: 2, working: 2 }) });
const FAILED = item({ kind: "application", problem: "read-failed", id: id(5), appId: id(50), name: "HR sync", readFailure: { outcome: "failed", httpStatus: 403, graphCode: "Authorization_RequestDenied", error: "denied" } });

test("the verdict counts groups and apps with no working owner, in one sentence", () => {
  const data = shapeOwnerReview(engine([NO_OWNER, DISABLED, GUEST_APP, HEALTHY]), null);
  const verdict = ownerReviewVerdict(data);
  assert.equal(verdict.text, "2 groups have no working owner.");
  assert.equal(verdict.tone, "critical");
  assert.equal(verdict.detail, "1 has a guest owner.");
  assert.ok(verdict.text.split(/\s+/).length <= 25);
  assert.deepEqual(ownerReviewStatus(data), { tone: "urgent", label: "2 need an owner" });

  const app = item({ kind: "servicePrincipal", problem: "no-owner", id: id(6), appId: id(60), name: "Portal" });
  assert.equal(ownerReviewVerdict(shapeOwnerReview(engine([NO_OWNER, DISABLED, app]), null)).text, "2 groups and 1 app have no working owner.");
});

test("a refused app owner read says owners could not be read, never no owner", () => {
  const data = shapeOwnerReview(engine([HEALTHY, FAILED], { application: read({ family: "appOwner", permission: "Application.Read.All", refused: 1 }) }), null);
  const verdict = ownerReviewVerdict(data);
  assert.equal(verdict.text, "No ownerless group, app or site found, but owners could not be read for app registrations.");
  assert.equal(verdict.tone, "attention");
  assert.doesNotMatch(verdict.text, /no owner\b/i);
  const [note] = unreadNotes(data);
  assert.equal(note.text, "Owners could not be read for app registrations");
  assert.equal(note.fix?.href, "/setup?perm-app=collector&perm-q=Application.Read.All#setup-permissions");
  assert.equal(problemWords(FAILED), "Owners could not be read: Microsoft refused the read.");
});

test("an owner family no backup has read is not yet read, not ownerless", () => {
  const data = shapeOwnerReview(engine([HEALTHY], { servicePrincipal: read({ snapshotId: null, readAt: null }) }), null);
  assert.equal(unreadNotes(data)[0].text, "Owners have not been read for enterprise apps yet");
  assert.equal(ownerReviewVerdict(data).tone, "attention");
});

test("nothing read at all, everything owned, and only guests read as such", () => {
  const none = engine([], { group: read({ snapshotId: null }), application: read({ snapshotId: null }), servicePrincipal: read({ snapshotId: null }) });
  assert.equal(ownerReviewVerdict(shapeOwnerReview(none, null)).text, "Keel has not read any owners yet. Owners are read with the backup.");
  assert.deepEqual(ownerReviewVerdict(shapeOwnerReview(engine([HEALTHY]), null)), { text: "Every group, app and site Keel checked has a working owner.", tone: "good" });
  assert.equal(ownerReviewVerdict(shapeOwnerReview(engine([HEALTHY, GUEST_APP]), null)).text, "Everything Keel checked has an owner, but 1 is owned by a guest.");
});

test("problems in words, filters and links", () => {
  assert.equal(problemWords(NO_OWNER), "Nobody owns it.");
  assert.equal(problemWords({ ...NO_OWNER, counts: counts({ total: 1, gone: 1 }) }), "No owner: its only owner no longer exists.");
  assert.equal(problemWords(DISABLED), "Every owner's account is turned off: Dan Disabled.");
  assert.equal(problemWords(GUEST_APP), "Only a guest from outside your organisation owns it: Gail Guest.");
  assert.equal(problemWords(HEALTHY), "2 owners, at least one working.");

  const tile = (key: string) => OWNER_TILES.find((entry) => entry.key === key)!;
  assert.equal(tile("no-owner").test(NO_OWNER), true);
  assert.equal(tile("only-disabled").test(DISABLED), true);
  assert.equal(tile("guest-owner").test(GUEST_APP), true);
  assert.equal(tile("unread").test(FAILED), true);
  assert.equal(tile("no-owner").test(FAILED), false);

  assert.match(itemLink(NO_OWNER)!.href, /GroupDetailsMenuBlade\/~\/Owners\/groupId\//);
  assert.match(itemLink(GUEST_APP)!.href, /ApplicationMenuBlade\/~\/Owners\/appId\//);
  assert.equal(itemLink({ ...GUEST_APP, appId: null }), null);
  assert.deepEqual(itemsInOrder([HEALTHY, FAILED, GUEST_APP, DISABLED, NO_OWNER]).map((entry) => entry.problem), ["no-owner", "only-disabled", "guest-owner", "read-failed", "fine"]);
});

const SITE = "contoso.sharepoint.com,5e170000-0000-4000-8000-000000000001,5e170000-0000-4000-8000-000000000002";
const people = (over: Partial<PeopleSummary> = {}): PeopleSummary => ({ inherits: false, groups: [], owners: ["Dan Disabled"], ownerCount: 1, people: 3, guests: 0, sharingLinks: 0, uniqueLists: 0, readAt: NOW, ...over });
function sites(...summaries: (PeopleSummary | null)[]): SitePermissionsData {
  return {
    generatedAt: NOW,
    run: { id: "run", outcome: "complete", observedTo: NOW },
    latest: null,
    contentRun: { outcome: "succeeded", completedAt: NOW, namePrefix: null, reasons: [] },
    sites: summaries.map((summary, index) => ({
      ...sitePermissionsFrom(`site:${SITE}${index}`, { displayName: `Site ${index}` }, {}),
      backup: { items: 1, bytes: 1, lastStoredAt: NOW },
      people: summary,
    })),
  };
}
const directory: OwnerDirectory = {
  snapshotId: "s", complete: true,
  users: new Map([
    ["1", { name: "Dan Disabled", disabled: true, guest: false }],
    ["2", { name: "Gail Guest", disabled: false, guest: true }],
    ["3", { name: "Ana Active", disabled: false, guest: false }],
  ]),
};

test("site owners known as users get the disabled and guest check", () => {
  const checked = withOwnerChecks(sites(people(), people({ owners: ["Gail Guest", "Ana Active"], ownerCount: 2 }), people({ owners: [], ownerCount: 0 }), null), directory);
  const [disabled, guest, orphan] = checked.sites;
  assert.equal(peopleStatus(disabled, checked.contentRun).key, "disabled-owners");
  assert.equal(peopleStatus(guest, checked.contentRun).key, "guest-owner");
  assert.equal(peopleStatus(orphan, checked.contentRun).key, "no-owner");
  assert.equal(siteVerdict(disabled, checked.contentRun).tone, "critical");
  assert.equal(sitesVerdict(checked).text, "1 site has no owner, and 1 site has only disabled owners.");

  const review = siteItems(checked);
  assert.deepEqual(review.items.map((entry) => entry.problem), ["only-disabled", "guest-owner", "no-owner"]);
  assert.equal(review.unread, 1);
  assert.deepEqual(itemLink(review.items[0]), { label: "Open the site", href: `/sites/${encodeURIComponent(`${SITE}0`)}`, external: false });

  const data = shapeOwnerReview(engine([HEALTHY]), checked);
  assert.equal(ownerReviewVerdict(data).text, "2 sites have no working owner.");
  // No users in any backup: nothing changes.
  assert.equal(withOwnerChecks(sites(people()), { snapshotId: null, complete: false, users: new Map() }).sites[0].people?.ownerCheck, undefined);
});
