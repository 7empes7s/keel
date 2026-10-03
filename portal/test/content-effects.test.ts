import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ContentEffectList, contentEffectLabel, type ContentEffect } from "@/components/content-effects";

const effect: ContentEffect = {
  naturalKey: "retentionLabel:Finance",
  resourceType: "retentionLabel",
  field: "retentionDuration.days",
  effect: "retention-reducing",
  before: 2555,
  after: 30,
  disclosure: "Content older than the new retention period can be permanently deleted. KEEL backs up configuration, not content.",
};

test("effects have plain-language labels", () => {
  assert.equal(contentEffectLabel("retention-reducing"), "Shortens retention");
  assert.equal(contentEffectLabel("hold-releasing"), "Releases a hold");
  assert.equal(contentEffectLabel("externally-sharing"), "Widens sharing");
  assert.equal(contentEffectLabel("irreversible"), "Destroys content");
});

test("each effect shows the field change and its not-backed-up disclosure", () => {
  const html = renderToStaticMarkup(createElement(ContentEffectList, { effects: [effect] }));
  assert.match(html, /Shortens retention/);
  assert.match(html, /retentionDuration\.days<\/code>: 2555 → 30/);
  assert.match(html, /backs up configuration, not content/);
});
