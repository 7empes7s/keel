// Names for the settings whose saved copy carries no name of its own. Some point to
// apps, people, groups and roles by id: app consent (oauth2PermissionGrant), app
// permissions granted to an app (appRoleGrant edges), app and enterprise app owners,
// provisioning jobs, site access for an app, and every kind of admin role assignment
// (Entra, PIM schedules, Exchange, Defender, entitlement management). This module turns
// those ids into names, from a lookup the server builds from the backup
// (lib/saved-names.ts). Others carry a readable field under another name (a device's
// deviceName, a token's organization) or a value that says what they are (a group
// expiration policy's lifetime). Pure, so it is tested directly. It never returns
// text that holds an id. test/unnamed-kinds.test.ts checks that every kind Keel backs
// up has a name.
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
  // Admin role assignments: "Global Administrator → Ada Lovelace".
  "roleAssignment",
  "roleAssignmentSchedule",
  "roleEligibilitySchedule",
  "exchangeRoleAssignment",
  "defenderRoleAssignment",
  "entitlementManagementRoleAssignment",
  "unifiedRoleManagementPolicyAssignment",
  // Entitlement management.
  "accessPackageAssignment",
  "accessPackageResourceRoleScope",
  // Cross-tenant partners are identified only by the partner's tenant id.
  "crossTenantAccessPolicyPartner",
  "crossTenantIdentitySyncPolicyPartner",
  "authenticationEventListener",
  // Named from a value of their own.
  "groupLifecyclePolicy",
  "organizationalBrandingLocalization",
  "permissionGrantPreApprovalPolicy",
  "mobileThreatDefenseConnector",
  "microsoftTunnelHealthThreshold",
  "mobileAppRelationship",
  // Named by a field other than displayName.
  "managedDevice",
  "windowsAutopilotDeviceIdentity",
  "deviceManagementExchangeConnector",
  "vppToken",
  "depOnboardingSetting",
  "enterpriseCodeSigningCertificate",
  "deviceTemplate",
  "signInIdentifier",
  "crossTenantM365Capability",
  "lifecyclePolicy",
  // A group under PIM for Groups is saved as the group's id only.
  "privilegedAccessGroupResource",
] as const;

// Edge drift keys: edge:<edgeType>:<parent object id>:<edge identity>.
const EDGE_TYPES: Record<string, string> = {
  appRoleGrant: "appRoleGrant",
  appOwner: "applicationOwnership",
  servicePrincipalOwner: "servicePrincipalOwnership",
};

const UNKNOWN_APP = "an app Keel does not back up";
const UNKNOWN_ROLE = "an admin role Keel has no name for";

// The kinds shaped like a Graph role assignment: a role, who holds it, and where.
const ROLE_ASSIGNMENT_TYPES = new Set([
  "roleAssignment", "roleAssignmentSchedule", "roleEligibilitySchedule", "exchangeRoleAssignment",
  "defenderRoleAssignment", "entitlementManagementRoleAssignment",
]);

// Kinds named by the first readable value among these fields.
const FIELD_NAMES: Record<string, string[]> = {
  managedDevice: ["deviceName", "managedDeviceName", "serialNumber"],
  windowsAutopilotDeviceIdentity: ["displayName", "serialNumber"],
  deviceManagementExchangeConnector: ["serverName", "exchangeAlias", "primarySmtpAddress"],
  vppToken: ["displayName", "organizationName", "appleId"],
  depOnboardingSetting: ["tokenName", "appleIdentifier"],
  enterpriseCodeSigningCertificate: ["subjectName", "subject", "issuerName"],
  // Beta kinds whose name field is not documented: a readable id ("email",
  // "calendarSharing") names them, else their Graph type.
  signInIdentifier: ["displayName", "name", "id"],
  crossTenantM365Capability: ["displayName", "name", "id"],
  lifecyclePolicy: ["displayName", "name", "id"],
};

// Who an Exchange or Defender assignment names by path ("/RoleGroups/…"), when the
// path's last part has no name Keel can look up.
const UNKNOWN_PRINCIPAL: Record<string, string> = {
  rolegroups: "an Exchange role group",
  users: "a user Keel does not back up",
  groups: "a group Keel does not back up",
  serviceprincipals: UNKNOWN_APP,
};

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readable(value: unknown): string | null {
  const text = str(value);
  return text && !holdsObjectId(text) ? text : null;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

/**
 * A reference as Graph writes it in a role assignment: a bare id, or a path such as
 * "/RoleGroups/Organization Management", "/ServicePrincipals/<id>" or
 * "/administrativeUnits/<id>". The last part is either an id to look up or, for an
 * Exchange role group, its name. "/" (the whole tenant) is no reference.
 */
function parseRef(value: unknown): { kind: string | null; id: string | null; literal: string | null } | null {
  const text = str(value);
  if (!text || text === "/") return null;
  const path = /^\/([^/]+)\/(.+)$/.exec(text);
  const kind = path ? path[1].toLowerCase() : null;
  const last = path ? path[2] : text.replace(/^\//, "");
  return holdsObjectId(last) ? { kind, id: last.toLowerCase(), literal: null } : { kind, id: null, literal: last };
}

function refName(value: unknown, names: IdNames): string | null {
  const ref = parseRef(value);
  if (!ref) return null;
  return ref.literal ?? nameOf(ref.id, names);
}

function principalsOf(type: string, record: Record<string, unknown>): unknown[] {
  if (type === "defenderRoleAssignment" && Array.isArray(record.principalIds)) return record.principalIds;
  return [record.principalId];
}

function scopesOf(type: string, record: Record<string, unknown>): unknown[] {
  const scopes: unknown[] = [record.directoryScopeId, record.appScopeId];
  if (type === "defenderRoleAssignment" && Array.isArray(record.appScopeIds)) scopes.push(...record.appScopeIds);
  if (type === "unifiedRoleManagementPolicyAssignment") scopes.push(record.scopeId);
  return scopes;
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
  const addRef = (value: unknown) => {
    const ref = parseRef(value);
    if (ref?.id) ids.push(ref.id);
  };
  const type = edgeKeyType(naturalKey) ?? resourceType ?? "";
  const record = recordOf(payload);
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
  } else if (ROLE_ASSIGNMENT_TYPES.has(type) || type === "unifiedRoleManagementPolicyAssignment") {
    addRef(record.roleDefinitionId);
    for (const principal of principalsOf(type, record)) addRef(principal);
    for (const scope of scopesOf(type, record)) addRef(scope);
  } else if (type === "accessPackageAssignment") {
    add(ids, record.targetId);
    add(ids, recordOf(record.target).objectId);
    add(ids, record.accessPackageId);
  } else if (type === "accessPackageResourceRoleScope") {
    add(ids, record.accessPackageId);
  } else if (type === "privilegedAccessGroupResource") {
    add(ids, record.id ?? naturalKey);
  } else if (type === "crossTenantAccessPolicyPartner" || type === "crossTenantIdentitySyncPolicyPartner") {
    add(ids, record.tenantId ?? naturalKey);
  } else if (type === "authenticationEventListener") {
    const apps = recordOf(recordOf(record.conditions).applications).includeApplications;
    for (const app of Array.isArray(apps) ? apps as Record<string, unknown>[] : []) add(ids, app?.appId);
  }
  return { ids, roles };
}

// "Global Administrator → Ada Lovelace (scope: Paris office)".
function roleAssignmentName(type: string, record: Record<string, unknown>, names: IdNames): string | null {
  const role = refName(record.roleDefinitionId, names);
  const principals = principalsOf(type, record).flatMap((value) => {
    const ref = parseRef(value);
    if (!ref) return [];
    return [{ name: ref.literal ?? nameOf(ref.id, names), kind: ref.kind }];
  });
  const known = principals.filter((entry) => entry.name);
  if (!role && !known.length) return null;
  const who = principals.length
    ? principals.map((entry) => entry.name ?? UNKNOWN_PRINCIPAL[entry.kind ?? ""] ?? "someone Keel has no name for").join(", ")
    : null;
  const scopes = scopesOf(type, record).flatMap((value) => {
    if (!parseRef(value)) return [];
    return [refName(value, names) ?? "part of the tenant"];
  });
  const scope = scopes.length ? ` (scope: ${[...new Set(scopes)].join(", ")})` : "";
  return `${role ?? UNKNOWN_ROLE}${who ? ` → ${who}` : ""}${scope}`;
}

// "Groups expire after 180 days (selected groups)".
function lifecycleName(record: Record<string, unknown>): string | null {
  const days = Number(record.groupLifetimeInDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  const which = str(record.managedGroupTypes)?.toLowerCase();
  const groups = which === "all" ? " (all Microsoft 365 groups)" : which === "selected" ? " (selected groups)" : which === "none" ? " (turned off)" : "";
  return `Groups expire after ${days} days${groups}`;
}

function words(text: string): string {
  return text.replace(/[_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim().toLowerCase();
}

/**
 * The name of a setting that carries none, built from what it points to or holds:
 * - app consent: "Contoso HR to Microsoft Graph", or "… for Ada Lovelace" when one user consented;
 * - app permission: "Contoso HR can use Microsoft Graph: User.Read.All";
 * - owner: "Ada Lovelace as owner of Contoso HR";
 * - provisioning job: "Contoso HR provisioning";
 * - site access for an app: "Contoso HR";
 * - admin role assignment (any provider): "Global Administrator → Ada Lovelace";
 * - access package assignment: "Ada Lovelace → Sales access";
 * - group expiration policy: "Groups expire after 180 days (selected groups)";
 * - a device, token or connector: its device, token or server name.
 * Null for other types, or when nothing it points to has a name.
 */
export function derivedName(resourceType: string | null | undefined, naturalKey: string, payload: unknown, names: IdNames): string | null {
  const type = edgeKeyType(naturalKey) ?? resourceType ?? "";
  const record = recordOf(payload);
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
  } else if (ROLE_ASSIGNMENT_TYPES.has(type)) {
    name = roleAssignmentName(type, record, names);
  } else if (type === "unifiedRoleManagementPolicyAssignment") {
    const role = refName(record.roleDefinitionId, names);
    if (role) name = `Activation settings for ${role}`;
  } else if (type === "accessPackageAssignment") {
    const target = recordOf(record.target);
    const who = readable(target.displayName) ?? readable(target.email) ?? nameOf(record.targetId ?? target.objectId, names);
    const pack = readable(recordOf(record.accessPackage).displayName) ?? nameOf(record.accessPackageId, names);
    if (who || pack) name = `${who ?? "someone Keel has no name for"} → ${pack ?? "an access package Keel has no name for"}`;
  } else if (type === "accessPackageResourceRoleScope") {
    const role = recordOf(record.role);
    const roleName = readable(role.displayName);
    const resource = readable(recordOf(role.resource).displayName) ?? readable(recordOf(record.scope).displayName);
    const pack = nameOf(record.accessPackageId, names);
    if (roleName || resource) {
      name = `${roleName ?? "A role"}${resource && resource !== "Root" ? ` of ${resource}` : ""}${pack ? ` in ${pack}` : ""}`;
    }
  } else if (type === "crossTenantAccessPolicyPartner" || type === "crossTenantIdentitySyncPolicyPartner") {
    const partner = nameOf(record.tenantId ?? naturalKey, names);
    if (partner) name = partner;
  } else if (type === "authenticationEventListener") {
    const ids = referencedIds(type, naturalKey, payload).ids;
    const apps = [...new Set(ids.map((id) => nameOf(id, names)).filter((entry): entry is string => Boolean(entry)))];
    const event = readable(record["@odata.type"])?.replace(/^#?microsoft\.graph\./, "");
    const what = event ? words(event).replace(/^on /i, "").replace(/ listener$/i, "") : "Sign-in event";
    name = apps.length ? `${what[0].toUpperCase()}${what.slice(1)} for ${apps.join(", ")}` : event ? `${what[0].toUpperCase()}${what.slice(1)}` : null;
  } else if (type === "groupLifecyclePolicy") {
    name = lifecycleName(record);
  } else if (type === "organizationalBrandingLocalization") {
    const language = readable(record.id) ?? readable(naturalKey);
    if (language) name = language === "0" ? "Default language" : `Language ${language}`;
  } else if (type === "permissionGrantPreApprovalPolicy") {
    const conditions = Array.isArray(record.conditions) ? record.conditions as Record<string, unknown>[] : [];
    const scopes = [...new Set(conditions.map((entry) => readable(entry?.scopeType)).filter((entry): entry is string => Boolean(entry)))];
    name = scopes.length ? `Pre-approved permissions for ${scopes.map((scope) => words(scope)).join(", ")}` : "Pre-approved permissions";
  } else if (type === "mobileThreatDefenseConnector") {
    const state = readable(record.partnerState);
    name = `Mobile threat defense connector${state ? ` (${words(state)})` : ""}`;
  } else if (type === "microsoftTunnelHealthThreshold") {
    const metric = readable(record.id) ?? readable(naturalKey);
    if (metric) name = `Tunnel health: ${words(metric)}`;
  } else if (type === "mobileAppRelationship") {
    const source = readable(record.sourceDisplayName);
    const target = readable(record.targetDisplayName);
    if (source || target) name = `${source ?? "An app"} → ${target ?? "an app"}`;
  } else if (type === "privilegedAccessGroupResource") {
    name = nameOf(record.id ?? naturalKey, names);
  } else if (type === "deviceTemplate") {
    const model = [readable(record.manufacturer), readable(record.model)].filter(Boolean).join(" ");
    name = readable(record.displayName) ?? (model || null);
  } else if (FIELD_NAMES[type]) {
    // An id that reads as words ("calendarSharing") is spaced out; a name stays as typed.
    const field = FIELD_NAMES[type].find((entry) => readable(record[entry]));
    const graphType = readable(record["@odata.type"])?.replace(/^#?microsoft\.graph\./, "");
    const value = field ? readable(record[field])! : null;
    const text = value ? (field === "id" ? words(value) : value) : graphType ? words(graphType) : null;
    name = field && field !== "id" ? value : text ? text.replace(/^./, (letter) => letter.toUpperCase()) : null;
  }
  return name && !holdsObjectId(name) ? name : null;
}
