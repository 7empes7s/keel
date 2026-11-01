// Roadmap task-131: changes (drift), roll-back previews and guard refusals in words.
// Pure helpers shared by the Changes and Restore pages and the UI harness. Natural
// keys, change-kind codes, planned verbs, waves, deferred references and refusal codes
// stay in the record layer.
import { NAME_FIELDS, objectName } from "../../engine/cir/objectName.mjs";
import { HIDDEN } from "../../engine/safety/diffHygiene.mjs";
import { plainKind } from "@/lib/baselines-view";
import { holdsObjectId, isObjectId, objectIdsIn, replaceObjectIds } from "@/lib/object-ids";
import { ago, resourceLabel, words } from "@/lib/presentation";
import type { DriftRecord } from "@/lib/types";

/** A credential value (a password hint and the like) as a diff carries it, and how it reads. */
export const HIDDEN_VALUE: string = HIDDEN;
export const HIDDEN_WORDS = "hidden (part of a password or secret)";

/** "Block legacy auth" from "conditionalAccessPolicy:Block legacy auth". */
export function resourceName(naturalKey: string): string {
  const [, ...rest] = naturalKey.split(":");
  return rest.join(" · ") || naturalKey;
}

/** The readable name a saved copy carries, by the field its kind is named by, or null
 * (engine/cir/objectName.mjs). Never an object id. */
export function payloadName(payload: unknown, resourceType?: string | null): string | null {
  return objectName(payload, resourceType ?? null, { skip: holdsObjectId });
}

// Many types are stored under their id, or point to users, groups, roles, apps and app
// consents by id: each id found (a GUID, a long hex run or an opaque token such as an
// app consent grant id, lib/object-ids) is replaced by the name it points to.
/** Every object id written anywhere in the values, once each, lower case. */
export function objectIds(...values: unknown[]): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number) => {
    if (depth > 12 || value === null || value === undefined) return;
    if (typeof value === "string") {
      for (const match of objectIdsIn(value)) found.add(match.toLowerCase());
    } else if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1);
    } else if (typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>)) visit(entry, depth + 1);
    }
  };
  for (const value of values) visit(value, 0);
  return [...found];
}

type Named = Pick<DriftRecord, "naturalKey" | "resourceType"> & Partial<Pick<DriftRecord, "name" | "refNames">>;

/** What a change is about, by name: the name Microsoft holds, else the readable part of
 * the key with any ids named, else "Unnamed <kind>". Never an object id. */
export function changeName(item: Named): string {
  const name = item.name?.trim();
  const kind = kindOf(item.resourceType);
  // A name that is only the stored type code ("sharepointSettings") is not a name.
  if (name && !holdsObjectId(name) && !(kind && name === item.resourceType)) return name;
  // A tenant-wide setting is stored under its type: its kind is its name.
  if ((item.naturalKey === item.resourceType || resourceName(item.naturalKey) === item.resourceType) && kind) return kind;
  const names = item.refNames ?? {};
  const fromKey = replaceObjectIds(resourceName(item.naturalKey).replace(/\bunknown:/g, ""), (id) => names[id.toLowerCase()] ?? id);
  if (!holdsObjectId(fromKey)) return fromKey;
  return `Unnamed ${(kind ?? "setting").toLowerCase()}`;
}

// The plain kind of a type, or null when the "type" is itself an id (a bare-id key).
function kindOf(type: string): string | null {
  const kind = plainKind(type);
  return holdsObjectId(kind) ? null : kind;
}

/** "Block legacy auth (sign-in rule)": the change's name and its plain kind. */
export function changeLabel(item: Named): string {
  const name = changeName(item);
  const kind = kindOf(item.resourceType);
  return !kind || name === kind || name.startsWith("Unnamed ") ? name : `${name} (${kind.toLowerCase()})`;
}

/** "Block legacy auth (Conditional Access policy) was changed". */
export function changeSentence(item: Pick<DriftRecord, "naturalKey" | "changeType">): string {
  const verb = item.changeType === "added" ? "was added" : item.changeType === "removed" ? "was removed" : "was changed";
  return `${resourceLabel(item.naturalKey)} ${verb}`;
}

// Service setting changes: where their review stands. Acknowledged ones stay listed
// (someone has seen them; they are still open) until someone resolves them.
export type ReviewState = "waiting" | "seen";

export function reviewState(item: Pick<DriftRecord, "serviceRead">): ReviewState | null {
  if (!item.serviceRead) return null;
  return item.serviceRead.alertState === "acknowledged" ? "seen" : "waiting";
}

/** A service setting change nobody has acknowledged yet. */
export function isWaiting(item: Pick<DriftRecord, "serviceRead">): boolean {
  return reviewState(item) === "waiting";
}

export const REVIEW_WORDS: Record<ReviewState, string> = { waiting: "Waiting for review", seen: "Seen, not resolved" };

/** What acknowledging or resolving the chosen service setting changes does, before it runs. */
export function respondDetail(action: "acknowledge" | "resolve", count: number): string {
  const them = count === 1 ? "it" : "them";
  return action === "acknowledge"
    ? `Marks ${them} as seen. ${count === 1 ? "It stays" : "They stay"} on this list until someone resolves ${them}. Nothing in Microsoft 365 changes.`
    : `Closes ${count === 1 ? "its alert" : "their alerts"} and takes ${them} off this list, with your note. Nothing in Microsoft 365 changes.`;
}

/** The toast after acknowledging or resolving: how many worked and how many did not. */
export function respondResult(action: "acknowledge" | "resolve", done: number, failed: number): string {
  const verb = action === "acknowledge" ? "Acknowledged" : "Resolved";
  const head = `${verb} ${done} ${done === 1 ? "change" : "changes"}`;
  return failed ? `${head}; ${failed} could not be recorded` : head;
}

const formatCount = (value: number) => value.toLocaleString("en-GB");
const serviceWords = (waiting: number) => `${formatCount(waiting)} service setting ${waiting === 1 ? "change waits" : "changes wait"} for review`;

/** Open changes, the one number the Overview tile, the menu badge, the Changes page and
 * the Approved setup page all show: every open approved-setup change plus every open
 * service setting change (waiting for review or seen, not yet resolved). `service` is the
 * uncapped count (service-changes.ts countOpenServiceChanges), never the length of the
 * capped list. Its list is OPEN_CHANGES_HREF. */
export function openChangeCount(setupChanges: number, serviceChanges: number): number {
  return setupChanges + serviceChanges;
}

export const OPEN_CHANGES_HREF = "/changes";

/** Under the list, when it holds fewer service setting changes than are open. */
export function serviceListNote(listed: number, total: number): string | null {
  if (total <= listed) return null;
  return `Showing the newest ${formatCount(listed)} of ${formatCount(total)} open service setting changes. Acknowledge or resolve some to see the rest.`;
}

/** "37 changes since the approved setup of 2 days ago; 2 could lock out administrators."
 * The Changes page verdict. Service setting changes (`serviceRead`) have no approved
 * setup, so they are counted apart: they wait for review, they did not move away from it.
 * The page passes the changes its service, kind and find filters leave, so the verdict
 * and the tiles below it always count the same changes. */
export function changesVerdict(all: DriftRecord[], baselineSetAt: string | null, now: string, serviceTotal?: number): { text: string; tone: "good" | "attention" | "critical" } {
  const items = all.filter((item) => !item.serviceRead);
  const waiting = all.filter(isWaiting).length;
  // Every open service setting change: the uncapped count when the page has it.
  const service = Math.max(serviceTotal ?? 0, all.filter((item) => item.serviceRead).length);
  const services = service === waiting ? serviceWords(waiting) : `${formatCount(service)} service setting ${service === 1 ? "change is" : "changes are"} still open`;
  if (baselineSetAt === null) {
    return { text: `No setup is approved yet, so Keel cannot tell what changed${service ? `; ${services}` : ""}.`, tone: "critical" };
  }
  const since = `since the approved setup of ${ago(baselineSetAt, now)}`;
  if (items.length === 0) {
    return service
      ? { text: `Nothing has changed ${since}, but ${services}.`, tone: "attention" }
      : { text: `Nothing has changed ${since}.`, tone: "good" };
  }
  const lockout = items.filter((item) => item.blastRadius === "tenant-lockout").length;
  // With service setting changes, the sentence leads with the open-changes total, the
  // number the Overview and the menu show, then splits it.
  const total = openChangeCount(items.length, service);
  const changed = service
    ? `${formatCount(total)} open changes: ${formatCount(items.length)} ${since}, and ${services}`
    : `${formatCount(items.length)} ${items.length === 1 ? "change" : "changes"} ${since}`;
  if (lockout) return { text: `${changed}; ${formatCount(lockout)} could lock out administrators.`, tone: "critical" };
  const access = items.filter((item) => item.blastRadius === "access-affecting").length;
  return access
    ? { text: `${changed}; ${formatCount(access)} ${access === 1 ? "affects" : "affect"} access.`, tone: "attention" }
    : { text: `${changed}; none affects access.`, tone: "attention" };
}

/** Under a filtered verdict: which filters it counts, and the whole tenant's totals, so a
 * filter never hides that other services have changes waiting.
 * "Counts follow your filter: In Entra ID. Across all services: 1,271 open changes: 1,159
 * changes since the approved setup, and 112 service setting changes wait for review." */
export function changesScopeDetail(filters: string[], all: DriftRecord[], serviceTotal?: number): string {
  const items = all.filter((item) => !item.serviceRead).length;
  const waiting = all.filter(isWaiting).length;
  const service = Math.max(serviceTotal ?? 0, all.filter((item) => item.serviceRead).length);
  const services = service === waiting ? serviceWords(waiting) : `${formatCount(service)} service setting ${service === 1 ? "change is" : "changes are"} still open`;
  const parts = [
    ...(items ? [`${formatCount(items)} ${items === 1 ? "change" : "changes"}${service ? " since the approved setup" : ""}`] : []),
    ...(service ? [services] : []),
  ];
  const total = openChangeCount(items, service);
  const totals = parts.length > 1 ? `${formatCount(total)} open changes: ${parts.join(", and ")}` : parts.length ? parts[0] : "nothing to review";
  return `Counts follow your ${filters.length === 1 ? "filter" : "filters"}: ${filters.join(", ")}. Across all services: ${totals}.`;
}

/** "conditions.users.excludeGroups" → "Conditions › users › exclude groups". */
// Short forms and product names that keep their capitals inside a setting's name.
const FIELD_TERMS: [RegExp, (term: string) => string][] = [
  [/\bbit locker\b/g, () => "BitLocker"], [/\bshare point\b/g, () => "SharePoint"], [/\bone drive\b/g, () => "OneDrive"],
  [/\b(usb|ip|mfa|url|uri|dns|tls|ssl|vpn|pin|sms|api)\b/g, (term) => term.toUpperCase()],
];

export function fieldWords(path: string): string {
  if (path === "(value)") return "Value";
  return path.split(".").map((part, index) => {
    let spaced = part.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").toLowerCase();
    for (const [pattern, term] of FIELD_TERMS) spaced = spaced.replace(pattern, term);
    return index === 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : spaced;
  }).join(" › ");
}

/** A field value as a person reads it; an object or a list of objects reads as its
 * first few settings. With names, an object id reads as the name of what it points to; an id KEEL
 * has no name for is counted, never shown. */
export function valueWords(value: unknown, names?: Readonly<Record<string, string>>): string {
  if (value === undefined || value === null) return "not set";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") return value.toLocaleString("en-GB");
  if (typeof value === "string") {
    if (value === "") return "empty";
    if (value === HIDDEN_VALUE) return HIDDEN_WORDS;
    if (names) {
      if (isObjectId(value)) return names[value.toLowerCase()] ?? "a setting Keel has no name for";
      if (holdsObjectId(value)) return replaceObjectIds(value, (id) => names[id.toLowerCase()] ?? "(unnamed setting)");
    }
    // Stored enum-like codes ("enabledForReportingButNotEnforced") read as words.
    return /^[a-z]+[A-Z][A-Za-z]*$/.test(value) ? words(value).toLowerCase() : value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    if (value.every((entry) => typeof entry === "string" || typeof entry === "number")) {
      if (!names) return value.map((entry) => valueWords(entry)).join(", ");
      const unnamed = value.filter((entry) => typeof entry === "string" && isObjectId(entry) && !names[entry.toLowerCase()]).length;
      const named = value
        .filter((entry) => !(typeof entry === "string" && isObjectId(entry) && !names[entry.toLowerCase()]))
        .map((entry) => valueWords(entry, names));
      if (unnamed) named.push(`${named.length ? `${unnamed} other` : unnamed} ${unnamed === 1 ? "setting" : "settings"} Keel has no name for`);
      return named.join(", ");
    }
    // A list of objects (grants, rules, members): one short phrase per entry.
    if (value.every((entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry))) {
      const shown = value.slice(0, 3).map((entry) => entryWords(entry, names));
      return value.length > shown.length ? `${shown.join("; ")}; and ${value.length - shown.length} more` : shown.join("; ");
    }
  }
  return settingsWords(value, names);
}

// Keys that hold where an entry points: the name found under one says what it is.
const ENTRY_KINDS: Record<string, string> = {
  application: "App", applications: "App", app: "App", servicePrincipal: "App", servicePrincipals: "App",
  user: "Person", users: "Person", group: "Group", groups: "Group", device: "Device", devices: "Device", site: "Site", sites: "Site",
};
const ID_KEY = /(^id$|Id$|Ids$|^@|DateTime$)/;
const ROLE_WORDS: Record<string, string> = { read: "Read", write: "Write", owner: "Full control", fullcontrol: "Full control", manage: "Manage" };

/** The name an entry carries, and what kind of thing the name belongs to. */
function entryName(entry: Record<string, unknown>, names: Readonly<Record<string, string>> | undefined, depth = 0): { name: string; kind: string | null } | null {
  for (const field of NAME_FIELDS) {
    const value = entry[field];
    if (typeof value === "string" && value.trim() && !holdsObjectId(value)) return { name: value.trim(), kind: null };
  }
  if (depth < 3) {
    for (const [key, inner] of Object.entries(entry)) {
      const first = Array.isArray(inner) ? inner[0] : inner;
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const found = entryName(first as Record<string, unknown>, names, depth + 1);
        if (found) return { name: found.name, kind: found.kind ?? ENTRY_KINDS[key] ?? null };
      }
    }
  }
  if (depth === 0) {
    // A field named like "ruleName" names the entry when nothing else does.
    for (const [key, value] of Object.entries(entry)) {
      if (/Name$/.test(key) && typeof value === "string" && value.trim() && !holdsObjectId(value)) return { name: value.trim(), kind: null };
    }
    // An entry known only by ids: the name Keel has for one of them.
    for (const [key, value] of Object.entries(entry)) {
      if (!/(^id|Id)$/.test(key) || typeof value !== "string" || !names?.[value.toLowerCase()]) continue;
      const kind = /^(app|client|resource|servicePrincipal)/.test(key) ? "App" : /^(user|principal)/.test(key) ? "Person" : /^group/.test(key) ? "Group" : null;
      return { name: names[value.toLowerCase()], kind };
    }
  }
  return null;
}

/** One entry of a list (a grant, a rule, a member) as a short phrase: "App Contoso
 *  HR · Write access", or its first plain settings when it has no name. Ids never show. */
export function entryWords(entry: unknown, names?: Readonly<Record<string, string>>): string {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return valueWords(entry, names);
  const record = entry as Record<string, unknown>;
  const named = entryName(record, names);
  const parts: string[] = [];
  if (named) parts.push(named.kind ? `${named.kind} ${named.name}` : named.name);
  const roles = record.roles;
  if (Array.isArray(roles) && roles.length && roles.every((role) => typeof role === "string")) {
    parts.push(`${(roles as string[]).map((role) => ROLE_WORDS[role.toLowerCase()] ?? words(role)).join(" and ")} access`);
  }
  const used = new Set([...NAME_FIELDS, "roles"]);
  const extras = Object.keys(record).sort()
    .filter((key) => !used.has(key) && !ID_KEY.test(key) && !(named && /Name$/.test(key)))
    .filter((key) => { const value = record[key]; return value === null || typeof value !== "object" || (Array.isArray(value) && value.every((item) => item === null || typeof item !== "object")); })
    .filter((key) => !(typeof record[key] === "string" && isObjectId(record[key] as string) && !names?.[(record[key] as string).toLowerCase()]));
  for (const key of extras.slice(0, named ? 2 : 3)) parts.push(`${fieldWords(key)}: ${valueWords(record[key], names)}`);
  return parts.length ? parts.join(" · ") : "An entry Keel has no name for";
}

/** A list of objects or an object as its settings in a short line ("State: on; Users:
 *  all users; and 4 more"), so the value itself shows, not a pointer to the record. */
function settingsWords(value: object, names?: Readonly<Record<string, string>>, limit = 3): string {
  const leaves: string[] = [];
  let count = 0;
  const walk = (inner: unknown, path: string[]) => {
    const scalarList = Array.isArray(inner) && inner.every((entry) => entry === null || typeof entry !== "object");
    if (inner === null || typeof inner !== "object" || scalarList || (typeof inner === "object" && !Array.isArray(inner) && !Object.keys(inner).length)) {
      count += 1;
      if (leaves.length < limit) {
        const label = path.map((part, index) => (/^#\d+$/.test(part) ? part : index === 0 ? fieldWords(part) : fieldWords(part).toLowerCase())).join(" › ");
        const text = inner !== null && typeof inner === "object" && !Array.isArray(inner) ? "none" : valueWords(inner, names);
        leaves.push(label ? `${label}: ${text}` : text);
      }
      return;
    }
    if (Array.isArray(inner)) {
      inner.forEach((entry, index) => walk(entry, inner.length > 1 || path.length ? [...path, `#${index + 1}`] : path));
      return;
    }
    for (const key of Object.keys(inner).sort()) walk((inner as Record<string, unknown>)[key], [...path, key]);
  };
  walk(value, []);
  if (!count) return "none";
  return count > leaves.length ? `${leaves.join("; ")}; and ${count - leaves.length} more` : leaves.join("; ");
}

const VERB_WORDS: Record<string, string> = {
  update: "Put the approved settings back",
  create: "Recreate it as the approved setup has it",
  delete: "Remove it; the approved setup does not have it",
};

/** What a roll-back would do to one resource, without the planned-verb code. */
export function plannedActionWords(verb: string): string {
  return VERB_WORDS[verb] ?? "Bring it back in line with the approved setup";
}

// Reasons KEEL's safety checks give, keyed by the start of the stored reason.
const REFUSAL_REASONS: [RegExp, string][] = [
  [/^onPremisesSyncEnabled/i, "it is synced from on-premises Active Directory, which owns it"],
  [/report-only|enforce/i, "Conditional Access changes are only ever written in report-only mode"],
  [/lockout/i, "it could lock administrators out of the tenant"],
  [/required by|depends on|still references/i, "something else still depends on it"],
];

/** "Keel refused to change Finance (group) because it is synced from on-premises Active Directory." */
export function refusalSentence(refusal: { naturalKey: string; reason: string }, label?: string): string {
  const name = label ?? resourceLabel(refusal.naturalKey);
  const known = REFUSAL_REASONS.find(([pattern]) => pattern.test(refusal.reason))?.[1];
  // A reason that reads as plain words is quoted as is; a coded one stays in the record.
  const plain = !known && !/[=_:{}[\]]|\b[a-z]+[A-Z]/.test(refusal.reason) ? refusal.reason.replace(/\.$/, "") : null;
  const because = known ?? plain;
  return because
    ? `Keel refused to change ${name} because ${because}.`
    : `Keel refused to change ${name}; the reason is in Technical details.`;
}

export function changeKindWords(kind: "changed" | "added" | "removed"): string {
  return kind === "changed" ? "Changed" : kind === "added" ? "Added" : "Removed";
}

