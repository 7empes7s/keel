// Server loader for the change feed (insights track, IN-FEED). Read-only: it reads stored
// drift, service reads and audit facts (engine/insights/feed.mjs) and never calls
// Microsoft. People are named the way "Hide people's names" says. Tenant-wide, so
// callers admit central readers only.
import { readNamer } from "../../engine/insights/anonymity.mjs";
import { loadChangeFeed } from "../../engine/insights/feed.mjs";

import type { ChangeFeedData, FeedRow } from "@/lib/change-feed-view";
import { connect } from "@/lib/db";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export async function getChangeFeed({ days, limit, now = new Date() }: { days?: number; limit?: number; now?: Date } = {}): Promise<ChangeFeedData> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    const namer = await readNamer(client);
    const feed = (await loadChangeFeed(client, { tenantRef: tenantRef(), now, days, limit, namer })) as Omit<ChangeFeedData, "generatedAt"> & { rows: FeedRow[] };
    return { generatedAt: now.toISOString(), ...feed };
  } finally {
    await client.end();
  }
}
