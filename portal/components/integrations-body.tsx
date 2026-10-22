import { DataUnavailable } from "@/components/data-unavailable";
import { IntegrationConsole } from "@/components/integration-console";
import { ServiceNowPanel } from "@/components/servicenow-panel";
import { Icon } from "@/components/shell/icons";
import { AlertList, type AlertItem } from "@/components/ui/alert-list";
import { StatTiles } from "@/components/ui/stat-tiles";
import type { Destination, DestinationStatus } from "@/lib/integrations";
import { integrationTiles } from "@/lib/integrations-view";
import type { ServiceNowStatus } from "@/lib/servicenow";

/** Alerts, tiles, ServiceNow, then each destination and the add form. */
export function IntegrationsBody({ alerts, canConfiguration, destinations, servicenow, statuses }: {
  alerts: AlertItem[]; canConfiguration: boolean; destinations: Destination[]; servicenow: ServiceNowStatus | null; statuses: DestinationStatus[];
}) {
  return (
    <div className="pg-page">
      <section aria-labelledby="ig-attention-heading" id="ig-attention">
        <div className="rs-section-head"><h2 id="ig-attention-heading"><Icon name="alert" />Needs your attention</h2></div>
        <AlertList items={alerts} />
      </section>
      <StatTiles tiles={integrationTiles(destinations, statuses, servicenow)} />
      {servicenow ? <ServiceNowPanel status={servicenow} /> : <section className="pg-panel" id="ig-servicenow"><DataUnavailable service={{ name: "ServiceNow" }} surface="ServiceNow approvals" /></section>}
      <IntegrationConsole canConfiguration={canConfiguration} destinations={destinations} statuses={statuses} />
    </div>
  );
}
