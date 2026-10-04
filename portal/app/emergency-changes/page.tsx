import { headers } from "next/headers";
import { connection } from "next/server";

import { GET as loadChangeIntents } from "@/app/api/change-intents/route";
import { ApproveIntentForm, IntentCard } from "@/components/change-intent";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { requireChangeIntentAccess } from "@/lib/change-intents";
import { changeIntentsVerdict, type ChangeIntentsData } from "@/lib/change-intents-view";

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
    return <><PageHeader description={DESCRIPTION} section="Changes" title="Emergency changes" /><DataUnavailable surface="Emergency changes" /></>;
  }
  const verdict = changeIntentsVerdict(data.intents, data.generatedAt);
  const live = data.intents.filter((intent) => intent.state === "active" || intent.state === "scheduled");
  const past = data.intents.filter((intent) => intent.state === "revoked" || intent.state === "ended");
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Changes" title="Emergency changes" />
      <Verdict text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <p className="capture-note">An approved change stays on the Changes page. KEEL only holds back rolling back exactly the approved fields, and checks the resource again when the approval ends.</p>
        <h2>Approved now</h2>
        {live.length === 0 ? <p className="empty-state">Nothing is approved right now.</p> : <ul className="change-intent-list">{live.map((intent) => <IntentCard intent={intent} key={intent.id} now={data.generatedAt} />)}</ul>}
        <h2>Approve an emergency change</h2>
        <ApproveIntentForm changes={data.changes} people={data.people} />
        {past.length > 0 ? <>
          <h2>Ended</h2>
          <ul className="change-intent-list">{past.map((intent) => <IntentCard intent={intent} key={intent.id} now={data.generatedAt} />)}</ul>
        </> : null}
      </div>
    </>
  );
}
