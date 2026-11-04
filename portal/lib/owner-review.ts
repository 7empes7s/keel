// Issue #964: the Owner review page's loader. Read only: it reads stored backups and
// never calls Microsoft. Callers check `read` first.
import { loadOwnerDirectory, ownerReview } from "../../engine/govern/ownerReview.mjs";
import { connect } from "@/lib/db";
import { shapeOwnerReview, type EngineOwnerReview, type OwnerReviewData } from "@/lib/owner-review-view";
import { databaseUrl, tenantRef } from "@/lib/runtime-config";
import { loadSitePermissions, withOwnerChecks, type OwnerDirectory } from "@/lib/site-permissions";

interface KeelClient {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

/** Groups, teams, apps and sites with their owners, from the newest complete backups. */
export async function getOwnerReview(now: Date = new Date()): Promise<OwnerReviewData> {
  const client = (await connect(databaseUrl())) as KeelClient;
  const tenant = tenantRef();
  try {
    // One after another, on the one connection (see loadSitePermissions).
    const directory = await loadOwnerDirectory(client, { tenantRef: tenant });
    const review = await ownerReview(client, { tenantRef: tenant, now, directory });
    const sites = withOwnerChecks(await loadSitePermissions(client, { tenantRef: tenant, now }), directory as OwnerDirectory);
    return shapeOwnerReview(review as EngineOwnerReview, sites);
  } finally {
    await client.end();
  }
}
