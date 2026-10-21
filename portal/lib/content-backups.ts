import { loadServiceBackups } from "../../engine/coverage/serviceBackups.mjs";
import { connect } from "@/lib/db";

import type { ContentBackup, ContentBackupsData } from "@/lib/content-backups-view";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";

/** The content backup per stored workload for this tenant (engine/coverage/serviceBackups.mjs). */
export async function getContentBackups(now: Date = new Date()): Promise<ContentBackupsData> {
  const client = await connect(databaseUrl());
  try {
    const { content } = (await loadServiceBackups(client, { tenantRef: tenantRef() })) as { content: ContentBackup[] };
    return { generatedAt: now.toISOString(), content };
  } finally {
    await client.end();
  }
}
