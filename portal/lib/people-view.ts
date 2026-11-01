import type { IconName } from "@/components/shell/icons";
import type { BadgeTone } from "@/components/ui/badge";
import type { RiskTone } from "@/lib/menu-status";
import type { PrincipalView } from "@/lib/principals";
import { personAccess } from "@/lib/presentation";
import { type EngineRef, personLabel } from "@/lib/sentences";
import { csvLine } from "@/lib/csv";

// People (portal audit, one design): the words of the page. Who can use Keel, the
// roles each person holds and since when, and what each can do. Pure functions,
// shared by the page, the harness and the tests; the components only lay things out.
// Ids, capability codes and grant ids stay in Technical details.

export type Grant = PrincipalView["role_grants"][number];
export type Role = "admin" | "approver" | "restorer" | "operator" | "investigator" | "viewer";
export type GrantWhen = "active" | "scheduled" | "ended";
export type PersonState = "active" | "starts-later" | "no-role" | "disabled";

export const ROLE_ORDER: Role[] = ["admin", "approver", "restorer", "operator", "investigator", "viewer"];

export const ROLES: Record<Role, { label: string; plural: string; meaning: string; can: string }> = {
  admin: { label: "Admin", plural: "Admins", meaning: "Adds people, grants roles and changes Keel's settings and rules", can: "add people, grant roles and change Keel's settings and rules" },
  approver: { label: "Approver", plural: "Approvers", meaning: "Approves restores and changes before they run", can: "approve restores and changes before they run" },
  restorer: { label: "Restorer", plural: "Restorers", meaning: "Restores settings and content, and undoes changes", can: "restore settings and content, and undo changes" },
  operator: { label: "Operator", plural: "Operators", meaning: "Runs backups and decides on changes", can: "run backups and decide on changes" },
  investigator: { label: "Investigator", plural: "Investigators", meaning: "Investigates incidents and marks which backups are safe", can: "investigate incidents and mark which backups are safe" },
  viewer: { label: "Viewer", plural: "Viewers", meaning: "Sees backups, changes and reports, and changes nothing", can: "see backups, changes and reports" },
};

export const PERSON_STATES: Record<PersonState, { label: string; plural: string; tone: BadgeTone; icon: IconName }> = {
  active: { label: "Active", plural: "Active", tone: "fine", icon: "check-circle" },
  "starts-later": { label: "Starts later", plural: "Starting later", tone: "low", icon: "clock" },
  "no-role": { label: "No role", plural: "No role", tone: "neutral", icon: "info" },
  disabled: { label: "Disabled", plural: "Disabled", tone: "neutral", icon: "hide" },
};

export const LAST_ADMIN_WORDS = "Keel keeps at least one admin. Make someone else an admin first.";

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const date = (value: string) => DATE.format(new Date(value));

export function isRole(value: string | null | undefined): value is Role {
  return Boolean(value) && (ROLE_ORDER as string[]).includes(value as string);
}

export function roleLabel(role: string): string {
  return isRole(role) ? ROLES[role].label : role.replace(/^./, (letter) => letter.toUpperCase());
}

export function isSystem(person: Pick<PrincipalView, "system_kind">): boolean {
  return Boolean(person.system_kind);
}

export function personRef(person: Pick<PrincipalView, "id" | "email" | "display_name" | "system_kind">): EngineRef {
  return { kind: "person", id: person.id, name: person.display_name ?? null, email: person.email, readable: true, system: isSystem(person) || undefined } as EngineRef;
}

/** The person's name: their display name, else one read from their email. */
export function personName(person: Pick<PrincipalView, "id" | "email" | "display_name" | "system_kind">): string {
  return personLabel(personRef(person), "Someone");
}

export function grantWhen(grant: Pick<Grant, "active_from" | "active_until">, now: string): GrantWhen {
  const at = new Date(now).valueOf();
  const from = new Date(grant.active_from).valueOf();
  // A role cancelled before it started ends before its start: it never applies.
  if (grant.active_until !== null && new Date(grant.active_until).valueOf() <= Math.max(at, from)) return "ended";
  if (from > at) return "scheduled";
  return "active";
}

/** "Contoso FR" from the stored code CONTOSO_FR: short parts stay capitals. */
export function entityWords(code: string): string {
  return code.split("_").filter(Boolean).map((part) => (part.length <= 3 ? part : part[0] + part.slice(1).toLowerCase())).join(" ");
}

/** The part of the company a grant covers, or null for everywhere. */
export function grantEntity(grant: Pick<Grant, "scope">): string | null {
  return /^entity:(.+)$/.exec(grant.scope ?? "")?.[1] ?? null;
}

/** "Admin", "Operator, only for Contoso FR". */
export function grantRoleWords(grant: Pick<Grant, "role" | "scope">): string {
  const entity = grantEntity(grant);
  return entity ? `${roleLabel(grant.role)}, only for ${entityWords(entity)}` : roleLabel(grant.role);
}

/** "Since 1 Sept 2026", "From 3 Nov 2026 until 10 Nov 2026", "Ended 20 Sept 2026". */
export function grantWindowWords(grant: Pick<Grant, "active_from" | "active_until">, now: string): string {
  const when = grantWhen(grant, now);
  if (when === "ended") return new Date(grant.active_until as string).valueOf() <= new Date(grant.active_from).valueOf() ? `Cancelled before it started, ${date(grant.active_until as string)}` : `Ended ${date(grant.active_until as string)}`;
  const until = grant.active_until ? ` until ${date(grant.active_until)}` : "";
  return when === "scheduled" ? `From ${date(grant.active_from)}${until}` : `Since ${date(grant.active_from)}${until}`;
}

/** Who gave the role, by name; null when the record does not say or names nobody known. */
export function grantedByName(grant: Pick<Grant, "granted_by">, people: PrincipalView[]): string | null {
  const by = people.find((person) => person.id === grant.granted_by);
  return by ? personName(by) : null;
}

export function activeGrants(person: PrincipalView, now: string): Grant[] {
  return person.role_grants.filter((grant) => grantWhen(grant, now) === "active");
}

/** The roles a person holds now, highest first; none for a disabled person. */
export function liveRoles(person: PrincipalView, now: string): Role[] {
  if (person.disabled_at) return [];
  const held = new Set(activeGrants(person, now).map((grant) => grant.role));
  return ROLE_ORDER.filter((role) => held.has(role));
}

export function personState(person: PrincipalView, now: string): PersonState {
  if (person.disabled_at) return "disabled";
  if (liveRoles(person, now).length) return "active";
  if (person.role_grants.some((grant) => grantWhen(grant, now) === "scheduled")) return "starts-later";
  return "no-role";
}

/** The ids of people who are admins everywhere right now and not disabled. */
export function liveAdminIds(people: PrincipalView[], now: string): string[] {
  return people.filter((person) => !person.disabled_at && !isSystem(person)
    && activeGrants(person, now).some((grant) => grant.role === "admin" && !grantEntity(grant))).map((person) => person.id);
}

/** True when this person is the only live admin: Keel will not remove their admin role or disable them. */
export function isLastAdmin(person: PrincipalView, people: PrincipalView[], now: string): boolean {
  const admins = liveAdminIds(people, now);
  return admins.length === 1 && admins[0] === person.id;
}

/** Anyone who can approve something, everywhere or for one part of the company. */
export function canApprove(person: PrincipalView): boolean {
  return !person.disabled_at && !isSystem(person) && (person.capabilities.includes("approve")
    || Object.values(person.entity_capabilities ?? {}).some((held) => held.includes("approve")));
}

/** What the person can do, in one line about them (never "You can"). */
export function accessLine(person: PrincipalView, now: string): string {
  if (person.disabled_at) return "Can no longer use Keel. Their roles are kept for when they come back.";
  const entities = Object.keys(person.entity_capabilities ?? {});
  const central = person.capabilities;
  if (!central.length && !entities.length) {
    return personState(person, now) === "starts-later" ? "Can do nothing yet. Their first role starts later." : "Can do nothing yet. Give them a role.";
  }
  const base = central.length ? personAccess(central) : "Can work only in part of the company";
  return entities.length ? `${base}; more for ${entities.map(entityWords).join(", ")}` : base;
}

const ABILITY_GROUPS: { label: string; icon: IconName; capabilities: Record<string, string> }[] = [
  { label: "Look", icon: "show", capabilities: { read: "See backups, changes, reports and activity" } },
  { label: "Back up", icon: "backup", capabilities: { collect: "Run backups", backup: "Run backups", "content-backup": "Back up mail and files", discover: "Find what the tenant holds", export: "Export copies", "baseline-create": "Approve a setup to compare against", "dispose-accept": "Decide on changes" } },
  { label: "Restore", icon: "restore", capabilities: { restore: "Restore settings", "content-restore": "Restore mail and files", rollback: "Undo changes", remediate: "Fix changes", "template-apply": "Apply a saved setup" } },
  { label: "Approve", icon: "inbox", capabilities: { approve: "Approve restores and changes before they run" } },
  { label: "Investigate", icon: "search", capabilities: { investigate: "Investigate incidents and mark safe backups" } },
  { label: "Administer", icon: "settings", capabilities: { users: "Add and disable people", roles: "Grant and remove roles", policies: "Manage automatic rules", configuration: "Change settings", automation: "Change what runs on its own" } },
];

/** What a person can do, grouped by the work. Lines repeat nothing. */
export function abilityGroups(capabilities: string[]): { label: string; icon: IconName; lines: string[] }[] {
  return ABILITY_GROUPS.map((group) => ({
    label: group.label,
    icon: group.icon,
    lines: [...new Set(capabilities.filter((capability) => group.capabilities[capability]).map((capability) => group.capabilities[capability]))],
  })).filter((group) => group.lines.length > 0);
}

export interface PeopleCounts { canUse: number; admins: number; approvers: number; disabled: number; total: number }

export function peopleCounts(people: PrincipalView[], now: string): PeopleCounts {
  const humans = people.filter((person) => !isSystem(person));
  return {
    canUse: humans.filter((person) => personState(person, now) === "active").length,
    admins: liveAdminIds(humans, now).length,
    approvers: humans.filter(canApprove).length,
    disabled: humans.filter((person) => person.disabled_at).length,
    total: humans.length,
  };
}

/** The header's status pill. */
export function peopleStatus(counts: PeopleCounts): { tone: RiskTone; label: string } {
  if (counts.approvers === 0) return { tone: "urgent", label: "Nobody can approve" };
  if (counts.admins <= 1) return { tone: "soon", label: counts.admins === 1 ? "Only 1 admin" : "No admin" };
  return { tone: "fine", label: `${counts.admins} admins` };
}

export interface PeopleVerdict { text: string; detail?: string; tone: "urgent" | "soon" | "fine" | "neutral" }

export function peopleVerdict(counts: PeopleCounts): PeopleVerdict {
  const use = `${counts.canUse} ${counts.canUse === 1 ? "person can" : "people can"} use Keel`;
  if (counts.total === 0) return { text: "Nobody has been added yet.", tone: "neutral" };
  if (counts.approvers === 0) return { text: `${use}, and nobody can approve.`, detail: "Restores and changes that need approval wait until someone holds the approver role.", tone: "urgent" };
  const text = `${use}; ${counts.approvers} can approve.`;
  if (counts.admins <= 1) return { text, detail: "Only one person is an admin. Make a second admin so Keel is never left without one.", tone: "soon" };
  return { text, tone: "fine" };
}

// The tiles are one set and add up: `role=admin,approver&state=disabled` shows admins,
// approvers and disabled people together. Both keys take a comma list.
export type PeopleState = "active" | "disabled";
export interface PeopleFilters { roles: Role[]; states: PeopleState[] }

export function parseFilters(get: (key: string) => string | null): PeopleFilters {
  const roles = (get("role") ?? "").split(",");
  const states = (get("state") ?? "").split(",");
  return { roles: ROLE_ORDER.filter((role) => roles.includes(role)), states: (["active", "disabled"] as const).filter((state) => states.includes(state)) };
}

/** True when the person has the role now; Approver counts everyone who can approve. */
export function hasRole(person: PrincipalView, role: Role, now: string): boolean {
  return role === "approver" ? canApprove(person) : liveRoles(person, now).includes(role);
}

/** True when the person is in that state tile. */
export function inState(person: PrincipalView, state: PeopleState, now: string): boolean {
  return state === "active" ? personState(person, now) === "active" : Boolean(person.disabled_at);
}

export function personMatches(person: PrincipalView, filters: PeopleFilters, now: string): boolean {
  if (!filters.roles.length && !filters.states.length) return true;
  return filters.roles.some((role) => hasRole(person, role, now)) || filters.states.some((state) => inState(person, state, now));
}

/** "approvers", "disabled people", "admins or approvers". */
export function filterWords(filters: PeopleFilters): string {
  const parts = [...filters.states.map((state) => (state === "active" ? "people who can use Keel" : "disabled people")), ...filters.roles.map((role) => ROLES[role].plural.toLowerCase())];
  return parts.join(" or ") || "people";
}

/** The group a person sits in under "Role": their highest role now. */
export function mainRoleGroup(person: PrincipalView, now: string): string {
  if (person.disabled_at) return "disabled";
  return liveRoles(person, now)[0] ?? personState(person, now);
}

/** A person's roles as row chips: the live ones, then one for a role starting later. */
export function roleChips(person: PrincipalView, now: string): { label: string; tone: BadgeTone }[] {
  if (person.disabled_at) return [];
  const live = activeGrants(person, now).map((grant) => ({ label: grantRoleWords(grant), tone: "neutral" as BadgeTone }));
  const later = person.role_grants.filter((grant) => grantWhen(grant, now) === "scheduled").map((grant) => ({ label: `${grantRoleWords(grant)} from ${date(grant.active_from)}`, tone: "low" as BadgeTone }));
  const unique = new Map([...live, ...later].map((chip) => [chip.label, chip]));
  return [...unique.values()];
}

/** The row's second line: since when the person holds their oldest live role. */
export function sinceWords(person: PrincipalView, now: string): string {
  if (person.disabled_at) return `Disabled on ${date(person.disabled_at)}`;
  const live = activeGrants(person, now);
  if (live.length === 0) return personState(person, now) === "starts-later" ? "Nothing until their role starts" : "No role yet";
  const oldest = live.map((grant) => grant.active_from).sort()[0];
  // Access lasts until the last live role ends.
  const ending = live.map((grant) => grant.active_until).filter((value): value is string => Boolean(value)).sort().at(-1);
  return `Since ${date(oldest)}${ending && live.every((grant) => grant.active_until) ? `, until ${date(ending)}` : ""}`;
}

/** What one Keel account does, in words. */
export function systemWords(person: Pick<PrincipalView, "system_kind">): string {
  return person.system_kind === "scheduler" ? "Runs backups and change checks on schedule. Set by Keel." : "Acts for Keel itself. Set by Keel.";
}

/** Why a change was refused, in plain words. */
export function changeRefusal(status: number, error: string | undefined): string {
  if (status === 403 && error === "last_admin") return LAST_ADMIN_WORDS;
  if (status === 403) return "You do not have permission to change people or roles.";
  if (status === 409) return "Someone with this email is already in Keel.";
  if (status === 400) return "Check the email, the role and the dates. An end date must come after the start.";
  if (status === 404) return "This person is no longer in Keel. Reload the page.";
  if (status === 0) return "Keel could not be reached. Try again in a minute.";
  return "The change was not saved. Try again in a minute.";
}

/** The bulk bar's sentence for adding one role to the chosen people. */
export function addRoleDetail(role: Role, chosen: PrincipalView[], now: string): string {
  const already = chosen.filter((person) => liveRoles(person, now).includes(role)).length;
  const disabled = chosen.filter((person) => person.disabled_at).length;
  const parts = [`From now on they can ${ROLES[role].can}.`];
  if (already) parts.push(`${already === 1 ? "1 already holds" : `${already} already hold`} it and ${already === 1 ? "stays" : "stay"} as is.`);
  if (disabled) parts.push(`${disabled === 1 ? "1 is" : `${disabled} are`} disabled and ${disabled === 1 ? "is" : "are"} left out.`);
  return parts.join(" ");
}

/** The access review export: one line per role grant, people without a role on one line. */
export function accessReviewCsv(people: PrincipalView[], now: string): string {
  const lines = [["Name", "Email", "State", "Role", "Where", "From", "Until", "Granted by", "Why"].join(",")];
  for (const person of people.filter((entry) => !isSystem(entry))) {
    const state = PERSON_STATES[personState(person, now)].label;
    const grants = person.role_grants.length ? person.role_grants : [null];
    for (const grant of grants) {
      lines.push(csvLine([
        personName(person), person.email, state,
        grant ? roleLabel(grant.role) : "", grant ? (grantEntity(grant) ? entityWords(grantEntity(grant) as string) : "Everywhere") : "",
        grant ? grant.active_from.slice(0, 10) : "", grant?.active_until ? grant.active_until.slice(0, 10) : "",
        grant ? grantedByName(grant, people) ?? "" : "", grant?.reason ?? "",
      ]));
    }
  }
  return `${lines.join("\n")}\n`;
}
