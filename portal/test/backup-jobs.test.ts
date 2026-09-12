import assert from "node:assert/strict";
import { test } from "node:test";

import { BACKUP_JOB_KINDS } from "@/app/backups/page";

test("the Backups page lists backup jobs, never collection jobs", () => {
  assert.deepEqual(BACKUP_JOB_KINDS, ["backup"]);
});
