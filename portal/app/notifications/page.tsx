import { headers } from "next/headers";
import { connection } from "next/server";
import { GET as loadDeliveries } from "@/app/api/deliveries/route";
import { GET as loadChannels } from "@/app/api/channels/route";
import { GET as loadSubscriptions } from "@/app/api/subscriptions/route";
import { PageHeader } from "@/components/page-header";
import { DataUnavailable } from "@/components/data-unavailable";
import { DeliveryTable, NotificationConsole } from "@/components/notification-console";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import type { Channel, Subscription } from "@/lib/notifications";

export default async function NotificationsPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.notificationsPage);
  const canConfiguration = access.capabilities.includes("configuration");
  const requestHeaders = await headers();
  let history;
  try {
    const response = await loadDeliveries(new Request("http://localhost/api/deliveries", { headers: requestHeaders }));
    if (!response.ok) throw new Error("Delivery history unavailable");
    history = await response.json();
  } catch {
    return <><PageHeader section="Settings" title="Notifications" description="Notification delivery history and configuration." /><DataUnavailable surface="Delivery history" /></>;
  }
  let channels: Channel[] = [];
  let subscriptions: Subscription[] = [];
  let configurationUnavailable = false;
  if (canConfiguration) {
    try {
      const responses = await Promise.all([
        loadChannels(new Request("http://localhost/api/channels", { headers: requestHeaders })),
        loadSubscriptions(new Request("http://localhost/api/subscriptions", { headers: requestHeaders })),
      ]);
      if (responses.some((response) => !response.ok)) throw new Error("Configuration unavailable");
      channels = (await responses[0].json()).channels;
      subscriptions = (await responses[1].json()).subscriptions;
    } catch { configurationUnavailable = true; }
  }
  return <>
    <PageHeader section="Settings" title="Notifications" description="Notification delivery history and configuration." generatedAt={history.generatedAt} />
    <DeliveryTable deliveries={history.deliveries} />
    {configurationUnavailable ? <DataUnavailable surface="Notification configuration" /> : <NotificationConsole canConfiguration={canConfiguration} channels={channels} subscriptions={subscriptions} />}
  </>;
}
