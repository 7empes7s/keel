import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { ReadinessView } from "@/components/readiness-view";
import { Verdict } from "@/components/verdict";
import { getReadinessData } from "@/lib/portal-data";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { readinessVerdict, type ReadinessData } from "@/lib/readiness-view";

const DESCRIPTION = "Whether the emergency accounts would let an administrator in when everything else fails, and whether anyone has used them.";

// Roadmap task-94: emergency (break-glass) account readiness and the usage canary.
// Reading needs `read` held tenant-wide; the guard runs before any loader, and the
// engine reader is pinned to this tenant. The page only reads: registering accounts
// and recording tests go through cli/keel-breakglass.mjs.
export default async function ReadinessPage() {
  await connection();
  await requireReadAccess(DATA_SURFACES.readinessPage);
  let data: ReadinessData;
  try {
    data = await getReadinessData();
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Restore" title="Emergency access" /><DataUnavailable surface="Emergency account checks" /></>;
  }
  const verdict = readinessVerdict(data);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Restore" title="Emergency access" />
      <Verdict headline={verdict.headline} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <ReadinessView data={data} />
      </div>
    </>
  );
}
