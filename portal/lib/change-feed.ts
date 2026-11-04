// Server loader for the change feed (insights track, IN-FEED). Read-only: it reads stored
// drift, service reads and audit facts (engine/insights/feed.mjs) and never calls
// Microsoft. People are named the way "Hide people's names" says. A reader scoped to some
// entities gets only drift rows for settings those entities own, filtered in the engine's
// SQL with the same entity filter as Open changes (issue #981).
import { readNamer } from "../../engine/insights/anonymity.mjs";
import { loadChangeFeed } from "../../engine/insights/feed.mjs";

import type { ChangeFeedData, FeedRow } from "@/lib/change-feed-view";
import { connect } from "@/lib/db";
import type { EntityScope } from "@/lib/principal";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

const CENTRAL: EntityScope = { central: true, entities: [] };

export async function getChangeFeed({ days, limit, now = new Date(), scope = CENTRAL }: { days?: number; limit?: number; now?: Date; scope?: EntityScope } = {}): Promise<ChangeFeedData> {
  const client = (await connect(databaseUrl())) as KeelClient;
  try {
    const namer = await readNamer(client);
    const feed = (await loadChangeFeed(client, { tenantRef: tenantRef(), now, days, limit, namer, scope })) as Omit<ChangeFeedData, "generatedAt"> & { rows: FeedRow[] };
    return { generatedAt: now.toISOString(), ...feed, ...(scope.central ? {} : { scope: { central: false as const, entities: [...scope.entities] } }) };
  } finally {
    await client.end();
  }
}
