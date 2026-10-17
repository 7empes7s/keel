// Names for the app settings whose saved copy carries no name of its own: app consent
// (oauth2PermissionGrant), app permissions granted to an app (appRoleGrant edges), app
// and enterprise app owners, provisioning jobs and site access for an app. Each points
// to apps, users and app roles by id; this module turns those ids into names, from a
// lookup the server builds from the backup (lib/saved-names.ts). Pure, so it is tested
// directly. It never returns text that holds an id.
import { holdsObjectId } from "@/lib/object-ids";

/** Names by lower-case id: object ids and app ids of apps and users, and app role ids. */
export interface IdNames {
  ids: Readonly<Record<string, string>>;
  roles: Readonly<Record<string, string>>;
}

export const NO_ID_NAMES: IdNames = { ids: {}, roles: {} };

/** The types this module names. A key of another type gets null. */
export const DERIVED_NAME_TYPES = [
  "oauth2PermissionGrant",
  "appRoleGrant",
  "applicationOwnership",
  "servicePrincipalOwnership",
  "synchronizationJob",
  "sharepointSiteAppGrant",
] as const;

// Edge drift keys: edge:<edgeType>:<parent object id>:<edge identity>.
const EDGE_TYPES: Record<string, string> = {
  appRoleGrant: "appRoleGrant",
  appOwner: "applicationOwnership",
  servicePrincipalOwner: "servicePrincipalOwnership",
};

const UNKNOWN_APP = "an app Keel does not back up";

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nameOf(id: unknown, names: IdNames): string | null {
  const key = str(id)?.toLowerCase();
  const name = key ? names.ids[key] : undefined;
  return name && !holdsObjectId(name) ? name : null;
}

function roleOf(id: unknown, names: IdNames): string | null {
  const key = str(id)?.toLowerCase();
  const name = key ? names.roles[key] : undefined;
  return name && !holdsObjectId(name) ? name : null;
}

/** The stored type of an edge drift key ("edge:appRoleGrant:…"), or null. */
export function edgeKeyType(naturalKey: string): string | null {
  if (!naturalKey.startsWith("edge:")) return null;
  return EDGE_TYPES[naturalKey.split(":")[1] ?? ""] ?? null;
}

/** Every id a key or saved copy names, so the server can look them up in one query. */
export function referencedIds(resourceType: string | null | undefined, naturalKey: string, payload?: unknown): { ids: string[]; roles: string[] } {
  const ids: string[] = [];
  const roles: string[] = [];
  const add = (list: string[], value: unknown) => {
    const id = str(value)?.toLowerCase();
    if (id) list.push(id);
  };
  const type = edgeKeyType(naturalKey) ?? resourceType;
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  if (naturalKey.startsWith("edge:")) {
    const [, , parent, ...rest] = naturalKey.split(":");
    add(ids, parent);
    if (type === "appRoleGrant") {
      add(ids, rest[0]);
      add(roles, rest[1]);
    } else {
      add(ids, rest[0]);
    }
  } else if (type === "oauth2PermissionGrant") {
    add(ids, record.clientId);
    add(ids, record.resourceId);
    add(ids, record.principalId);
  } else if (type === "synchronizationJob") {
    add(ids, record.servicePrincipalId);
  } else if (type === "sharepointSiteAppGrant") {
    const apps = Array.isArray(record.applications) ? record.applications as Record<string, unknown>[] : [];
    for (const app of apps) add(ids, app?.id);
    const keyApps = /^sharepoint:site-app-grant:[^:]*:(.*)$/.exec(naturalKey)?.[1] ?? "";
    for (const id of keyApps.split(",")) add(ids, id);
  }
  return { ids, roles };
}

/**
 * The name of an app setting that carries none, built from what it points to:
 * - app consent: "Contoso HR to Microsoft Graph", or "… for Ada Lovelace" when one user consented;
 * - app permission: "Contoso HR can use Microsoft Graph: User.Read.All";
 * - owner: "Ada Lovelace as owner of Contoso HR";
 * - provisioning job: "Contoso HR provisioning";
 * - site access for an app: "Contoso HR".
 * Null for other types, or when nothing it points to has a name.
 */
export function derivedName(resourceType: string | null | undefined, naturalKey: string, payload: unknown, names: IdNames): string | null {
  const type = edgeKeyType(naturalKey) ?? resourceType;
  const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  let name: string | null = null;
  if (naturalKey.startsWith("edge:")) {
    const [, , parent, target, role] = naturalKey.split(":");
    const parentName = nameOf(parent, names);
    if (type === "appRoleGrant") {
      const resource = nameOf(target, names);
      if (parentName || resource) {
        const permission = roleOf(role, names);
        name = `${parentName ?? UNKNOWN_APP} can use ${resource ?? UNKNOWN_APP}${permission ? `: ${permission}` : ""}`;
      }
    } else if (type === "applicationOwnership" || type === "servicePrincipalOwnership") {
      const owner = nameOf(target, names);
      if (parentName) name = `${owner ?? "Someone Keel has no name for"} as owner of ${parentName}`;
    }
  } else if (type === "oauth2PermissionGrant") {
    const client = nameOf(record.clientId, names);
    const resource = nameOf(record.resourceId, names);
    if (client || resource) {
      const person = record.consentType === "Principal" ? nameOf(record.principalId, names) : null;
      name = `${client ?? UNKNOWN_APP} to ${resource ?? UNKNOWN_APP}${person ? ` for ${person}` : ""}`;
    }
  } else if (type === "synchronizationJob") {
    const app = nameOf(record.servicePrincipalId, names);
    if (app) name = `${app} provisioning`;
  } else if (type === "sharepointSiteAppGrant") {
    const ids = referencedIds(type, naturalKey, payload).ids;
    const apps = [...new Set(ids.map((id) => nameOf(id, names)).filter((entry): entry is string => Boolean(entry)))];
    if (apps.length) name = apps.join(", ");
  }
  return name && !holdsObjectId(name) ? name : null;
}
