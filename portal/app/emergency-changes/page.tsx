import { headers } from "next/headers";
import { connection } from "next/server";

import { GET as loadChangeIntents } from "@/app/api/change-intents/route";
import { EmergencyChangesView } from "@/components/change-intent";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { requireChangeIntentAccess } from "@/lib/change-intents";
import { changeIntentsVerdict, intentAlerts, intentsStatus, type ChangeIntentsData } from "@/lib/change-intents-view";

const DESCRIPTION = "Changes made outside the baseline on purpose, approved for a limited time.";

export default async function EmergencyChangesPage() {
  // Roadmap task-93: like the approval inbox, this surface requires a central approve
  // grant, checked before connection() and the loader.
  await requireChangeIntentAccess();
  await connection();
  let data: ChangeIntentsData;
  try {
    const response = await loadChangeIntents(new Request("http://localhost/api/change-intents", { headers: await headers() }));
    if (!response.ok) throw new Error("Emergency changes unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Automation center" title="Emergency changes" /><DataUnavailable surface="Emergency changes" /></>;
  }
  const verdict = changeIntentsVerdict(data.intents, data.generatedAt);
  const alerts = intentAlerts(data);
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Automation center" status={intentsStatus(data.intents)} title="Emergency changes" />
      <Verdict action={alerts.some((alert) => alert.tone !== "low") ? { label: "See what to fix", href: "#ec-attention" } : null} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <EmergencyChangesView data={data} />
      </div>
    </>
  );
}
