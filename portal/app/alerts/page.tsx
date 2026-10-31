import { headers } from "next/headers";
import { connection } from "next/server";

import { GET as loadAlerts } from "@/app/api/alerts/route";
import { AlertsPage as AlertsBody } from "@/components/alerts/alerts-page";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { ALERT_MUTE_CAPABILITY, ALERT_RESPOND_CAPABILITY } from "@/lib/alerts";
import { alertCounts, alertsStatus, type AlertInboxData } from "@/lib/alerts-view";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { AnonymityNote } from "@/components/anonymity-note";
import { getAnonymitySetting } from "@/lib/anonymity";

const DESCRIPTION = "Changes that need someone, who owns each one, and when it is due.";

// Alerts (portal audit, one design). Viewing needs read; Acknowledge and Resolve show
// only for people who may use them (`dispose-accept`), Mute only with `policies`, and
// each route checks again.
export default async function AlertsPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> } = {}) {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.alertsPage);
  // A link that opens one alert (`?open=<id>`) asks for that alert too, however old.
  const open = (await searchParams)?.open;
  const wanted = typeof open === "string" && open ? `?open=${encodeURIComponent(open)}` : "";
  let data: AlertInboxData;
  try {
    const response = await loadAlerts(new Request(`http://localhost/api/alerts${wanted}`, { headers: await headers() }));
    if (!response.ok) throw new Error("Alerts unavailable");
    data = await response.json();
  } catch {
    return <><PageHeader section="Inbox" title="Alerts" description={DESCRIPTION} /><DataUnavailable surface="Alerts" /></>;
  }
  return <>
    <PageHeader description={DESCRIPTION} generatedAt={data.generatedAt} section="Inbox" status={alertsStatus(alertCounts(data.alerts, data.generatedAt))} title="Alerts" />
    <AnonymityNote setting={await getAnonymitySetting()} />
    <AlertsBody
      alerts={data.alerts}
      linked={data.linked}
      canMute={access.capabilities.includes(ALERT_MUTE_CAPABILITY)}
      canRespond={access.capabilities.includes(ALERT_RESPOND_CAPABILITY)}
      now={data.generatedAt}
    />
  </>;
}
