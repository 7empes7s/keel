import assert from "node:assert/strict";
import { test } from "node:test";

import { BACKUP_JOB_KINDS } from "@/app/protect/page";

test("What's protected lists on-demand backups, the scheduled tier runs and the service settings runs", () => {
  assert.deepEqual(BACKUP_JOB_KINDS, ["backup", "collect", "workload-collect"]);
});
