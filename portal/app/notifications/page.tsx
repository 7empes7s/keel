import { headers } from "next/headers";
import { connection } from "next/server";

import { GET as loadChannels } from "@/app/api/channels/route";
import { GET as loadDeliveries } from "@/app/api/deliveries/route";
import { GET as loadEscalationRules } from "@/app/api/escalation-rules/route";
import { GET as loadPrincipals } from "@/app/api/principals/route";
import { GET as loadSubscriptions } from "@/app/api/subscriptions/route";
import { DataUnavailable } from "@/components/data-unavailable";
import { NotificationsPage as NotificationsBody, type PersonChoice } from "@/components/notifications/notifications-page";
import { PageHeader } from "@/components/page-header";
import type { Channel, Delivery, EscalationRule, Subscription } from "@/lib/notifications";
import { notificationCounts, notificationsStatus } from "@/lib/notifications-view";
import { DATA_SURFACES, requireReadAccess } from "@/lib/read";
import { AnonymityNote } from "@/components/anonymity-note";
import { getAnonymitySetting } from "@/lib/anonymity";

const TITLE = "Notifications";
const DESCRIPTION = "Where Keel sends alerts, who gets which alerts, and what was sent.";

export default async function NotificationsPage() {
  await connection();
  const access = await requireReadAccess(DATA_SURFACES.notificationsPage);
  const canConfiguration = access.capabilities.includes("configuration");
  const canUsers = access.capabilities.includes("users");
  const requestHeaders = await headers();
  const requestFor = (path: string) => new Request(`http://localhost${path}`, { headers: requestHeaders });
  const bodyOf = async (response: Response, path: string) => {
    if (!response.ok) throw new Error(`${path} unavailable`);
    return response.json();
  };
  const read = async (loader: (request: Request) => Promise<Response>, path: string) => bodyOf(await loader(requestFor(path)), path);

  let history: { deliveries: Delivery[]; generatedAt: string };
  try {
    history = await bodyOf(await loadDeliveries(requestFor("/api/deliveries?limit=200")), "/api/deliveries");
  } catch {
    return <><PageHeader description={DESCRIPTION} section="Settings" title={TITLE} /><DataUnavailable surface="Alert history" /></>;
  }

  let channels: Channel[] = [];
  let subscriptions: Subscription[] = [];
  let escalationRules: EscalationRule[] = [];
  let people: PersonChoice[] = [];
  let configurationUnavailable = false;
  if (canConfiguration) {
    try {
      // One request at a time: the loaders share the request's database connection.
      channels = (await read(loadChannels, "/api/channels")).channels;
      subscriptions = (await read(loadSubscriptions, "/api/subscriptions")).subscriptions;
      escalationRules = (await read(loadEscalationRules, "/api/escalation-rules")).escalationRules;
    } catch {
      configurationUnavailable = true;
    }
    if (canUsers) {
      try {
        const principals = (await read(loadPrincipals, "/api/principals")).principals as { id: string; display_name: string | null; email: string | null; disabled_at: string | null }[];
        people = principals.filter((principal) => !principal.disabled_at).map((principal) => ({ id: principal.id, name: principal.display_name, email: principal.email }));
      } catch {
        people = [];
      }
    }
  }

  const configured = canConfiguration && !configurationUnavailable;
  const status = configured ? notificationsStatus(notificationCounts({ channels, subscriptions, escalationRules, deliveries: history.deliveries }, history.generatedAt), { channels, subscriptions }) : undefined;
  return (
    <>
      <PageHeader description={DESCRIPTION} generatedAt={history.generatedAt} section="Settings" status={status} title={TITLE} />
      {configurationUnavailable ? <DataUnavailable surface="Notification settings" /> : null}
      <AnonymityNote setting={await getAnonymitySetting()} />
      <NotificationsBody
        canConfiguration={configured}
        channels={channels}
        deliveries={history.deliveries}
        escalationRules={escalationRules}
        now={history.generatedAt}
        people={people}
        subscriptions={subscriptions}
      />
    </>
  );
}
