import { headers } from "next/headers";
import { connection } from "next/server";

import { GET as loadAlerts } from "@/app/api/alerts/route";
import { AlertInbox } from "@/components/alert-inbox";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { Verdict } from "@/components/verdict";
import { ALERT_RESPOND_CAPABILITY } from "@/lib/alerts";
import { alertsVerdict, type AlertInboxData } from "@/lib/alerts-view";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";

const DESCRIPTION = "Changes that need someone: who owns each one, when it must be acknowledged, and what happened so far.";

// Roadmap task-83: the alerts inbox. Viewing needs read; the acknowledge and resolve
// controls appear only for people who may use them, and the action route checks again.
export default async function AlertsPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.alertsPage);
  let data: AlertInboxData;
  try {
    const response = await loadAlerts(new Request("http://localhost/api/alerts", { headers: await headers() }));
    if (!response.ok) throw new Error("Alerts unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader section="Changes" title="Alerts" description={DESCRIPTION} /><DataUnavailable surface="Alerts" /></>;
  }
  const verdict = alertsVerdict(data.alerts, data.generatedAt);
  return <>
    <PageHeader section="Changes" title="Alerts" description={DESCRIPTION} generatedAt={data.generatedAt} />
    <Verdict text={verdict.text} tone={verdict.tone} />
    <div data-layer="explanation">
      <AlertInbox alerts={data.alerts} canRespond={access.capabilities.includes(ALERT_RESPOND_CAPABILITY)} now={data.generatedAt} />
    </div>
  </>;
}
