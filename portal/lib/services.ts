import type { IconName } from "@/components/shell/icons";

// Under each cloud, lists group by the provider's own services, named as Microsoft
// names them (handoff/redesign/CHOICE.md, "Grouping"). `code` is the service code the
// engine's taxonomy uses (engine/insights/taxonomy.mjs SERVICES); "Keel" holds Keel's
// own records: backups, restores and jobs.
export interface CloudService {
  code: string;
  name: string;
  icon: IconName;
  // What lives there, in a few plain words: the tooltip under the name.
  about: string;
}

export const CLOUDS = [{ id: "microsoft-365", name: "Microsoft 365" }] as const;

export const SERVICES: readonly CloudService[] = Object.freeze([
  { code: "Entra", name: "Entra ID", icon: "service-entra", about: "People, groups, sign-in rules and app access" },
  { code: "Exchange", name: "Exchange Online", icon: "service-exchange", about: "Mailboxes, mail flow and calendars" },
  { code: "SharePoint", name: "SharePoint and OneDrive", icon: "service-sharepoint", about: "Sites, files and who can reach them" },
  { code: "Teams", name: "Teams", icon: "service-teams", about: "Teams, channels, meetings and chat rules" },
  { code: "Intune", name: "Intune", icon: "service-intune", about: "Devices, apps and their rules" },
  { code: "Power Platform", name: "Power Platform", icon: "service-power-platform", about: "Environments, flows and data rules" },
  { code: "Purview", name: "Purview", icon: "service-purview", about: "Retention, labels and data loss rules" },
  { code: "Defender", name: "Defender", icon: "service-defender", about: "Threat protection settings" },
  { code: "Microsoft 365 apps", name: "Microsoft 365 apps", icon: "service-m365-apps", about: "Org settings for To Do, Forms and the Office apps" },
  { code: "Keel", name: "Keel: backups and recovery", icon: "service-keel", about: "Keel's own backups, restores and jobs" },
]);

const BY_CODE = new Map(SERVICES.map((service) => [service.code.toLowerCase(), service]));

/** The service for a taxonomy code, or a plain fallback that never shows the code alone. */
export function serviceFor(code: string | null | undefined): CloudService {
  const known = code ? BY_CODE.get(code.toLowerCase()) : undefined;
  return known ?? { code: code ?? "other", name: "Other services", icon: "cloud", about: "Settings Keel has not placed in a service yet" };
}

/** Sort key: Microsoft's services in the order above, unknown ones last. */
export function serviceOrder(code: string | null | undefined): number {
  const index = SERVICES.findIndex((service) => service.code.toLowerCase() === (code ?? "").toLowerCase());
  return index === -1 ? SERVICES.length : index;
}

// SharePoint admin center makes Conditional Access policies named "[SharePoint admin
// center]..." when someone limits access from unmanaged devices (Policies > Access
// control). They are stored in Entra ID but are SharePoint settings, so every list that
// places a single setting under a service files them under SharePoint.
const SHAREPOINT_MADE = /^\s*\[SharePoint admin center\]/i;

export function madeInSharePoint(type: string, ...names: (string | null | undefined)[]): boolean {
  return type === "conditionalAccessPolicy" && names.some((name) => SHAREPOINT_MADE.test(name ?? ""));
}
