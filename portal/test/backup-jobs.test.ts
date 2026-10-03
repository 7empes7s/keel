import assert from "node:assert/strict";
import { test } from "node:test";

import { BACKUP_JOB_KINDS } from "@/app/protect/page";

test("the Protect page lists backup jobs, never collection jobs", () => {
  assert.deepEqual(BACKUP_JOB_KINDS, ["backup"]);
});
