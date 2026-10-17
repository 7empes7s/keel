import assert from "node:assert/strict";
import { test } from "node:test";

import { BACKUP_JOB_KINDS } from "@/app/protect/page";

test("What's protected lists on-demand backups and the scheduled tier runs", () => {
  assert.deepEqual(BACKUP_JOB_KINDS, ["backup", "collect"]);
});
