import { PrincipalManage } from "@/components/principal-controls";
import { SettingsGroup, SettingsRow, SettingsSection } from "@/components/settings/parts";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { initials } from "@/components/ui/person";
import type { PrincipalView } from "@/lib/principals";
import { accessSummary, ago, displayEnum, formatTimestamp } from "@/lib/presentation";

// Roadmap task-130: each person by name and email, roles in words and since when,
// what they can do in words; grant, revoke and disable through the existing guarded
// routes (which re-check roles / users and refuse removing the last admin). Ids and
// raw timestamps are in the record.

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function isGrantActive(grant: PrincipalView["role_grants"][number], now: string): boolean {
  const at = new Date(now).valueOf();
  return new Date(grant.active_from).valueOf() <= at && (grant.active_until === null || new Date(grant.active_until).valueOf() > at);
}

/** "Admin since 1 Sept 2026" / "Viewer from 3 Oct 2026 until 10 Oct 2026" / "Restorer, ended 2 Oct 2026". */
export function grantSentence(grant: PrincipalView["role_grants"][number], now: string): string {
  // Task 90: an entity-scoped grant covers only that entity's resources.
  const entity = /^entity:(.+)$/.exec(grant.scope ?? "")?.[1];
  const role = entity ? `${displayEnum("role", grant.role)} for ${entity} resources only` : displayEnum("role", grant.role);
  const from = DATE.format(new Date(grant.active_from));
  if (grant.active_until && new Date(grant.active_until).valueOf() <= new Date(now).valueOf()) return `${role}, ended ${DATE.format(new Date(grant.active_until))}`;
  if (new Date(grant.active_from).valueOf() > new Date(now).valueOf()) return `${role} from ${from}${grant.active_until ? ` until ${DATE.format(new Date(grant.active_until))}` : ""}`;
  return `${role} since ${from}${grant.active_until ? ` until ${DATE.format(new Date(grant.active_until))}` : ""}`;
}

/** One person as a row: who, what they can do, their roles, and Manage for the rest. */
export function PrincipalDetails({ principal, now, canRoles = false, canUsers = false }: {
  principal: PrincipalView; now: string; canRoles?: boolean; canUsers?: boolean;
}) {
  const name = principal.display_name || principal.email;
  const active = principal.role_grants.filter((grant) => isGrantActive(grant, now));
  const roles = active.map((grant) => displayEnum("role", grant.role));
  const manage = !principal.disabled_at && (canRoles || canUsers);
  return (
    <SettingsRow
      actions={manage ? (
        <PrincipalManage
          canRoles={canRoles}
          canUsers={canUsers}
          grants={active.map((grant) => ({ id: grant.id, role: displayEnum("role", grant.role), sentence: grantSentence(grant, now) }))}
          name={name}
          past={principal.role_grants.filter((grant) => !isGrantActive(grant, now)).map((grant) => grantSentence(grant, now))}
          principalId={principal.id}
        />
      ) : null}
      icon={<span aria-hidden="true" className="person-avatar st-avatar" data-initials={initials(name)} data-system={principal.disabled_at || principal.system_kind ? "" : undefined} />}
      name={name}
      meta={name !== principal.email ? principal.email : principal.system_kind ? "KEEL's own account" : null}
      status={principal.disabled_at
        ? <Badge tone="neutral">Disabled</Badge>
        : <Badge tone={roles.length ? "fine" : "neutral"}>{roles.length ? roles.join(", ") : "No roles"}</Badge>}
      line={principal.disabled_at
        ? <>Disabled <time dateTime={principal.disabled_at} title={formatTimestamp(principal.disabled_at)}>{ago(principal.disabled_at, now)}</time>; can no longer use KEEL.</>
        : `${accessSummary(principal.capabilities)}.`}
    />
  );
}

/** What the engine answered for one person, with ids and raw times, for the record layer. */
export function PrincipalRecord({ principal }: { principal: PrincipalView }) {
  return (
    <div className="st-record">
      <RecordField label={`Principal ID (${principal.display_name || principal.email})`} usage={<>use with <code>POST /api/principals/&lt;id&gt;/grant</code></>} value={principal.id} />
      <RecordField copy={false} label="Effective capabilities" value={principal.capabilities.join(", ") || "none"} />
      {Object.entries(principal.entity_capabilities ?? {}).map(([entity, capabilities]) => (
        <RecordField copy={false} key={entity} label={`Capabilities for ${entity} only`} value={capabilities.join(", ")} />
      ))}
      <RecordField copy={false} label="Disabled at" value={principal.disabled_at ?? "not disabled"} />
      {principal.role_grants.map((grant) => (
        <RecordField key={grant.id} label={`Grant ID (${grant.role})`} usage={`active ${grant.active_from} → ${grant.active_until ?? "open-ended"}`} value={grant.id} />
      ))}
    </div>
  );
}

/** Everyone as grouped rows: people who can use KEEL, KEEL's own accounts, and people disabled. */
export function PrincipalList({ principals, now, canRoles = false, canUsers = false }: {
  principals: PrincipalView[]; now: string; canRoles?: boolean; canUsers?: boolean;
}) {
  const groups = [
    { key: "active", title: "Can use KEEL", about: "People with at least one role, or waiting for one.", icon: "settings" as const, items: principals.filter((principal) => !principal.disabled_at && !principal.system_kind) },
    { key: "system", title: "KEEL's own accounts", about: "Accounts KEEL runs scheduled work as.", icon: "clock" as const, items: principals.filter((principal) => !principal.disabled_at && principal.system_kind) },
    { key: "disabled", title: "Disabled", about: "They can no longer sign in. Their roles stay recorded.", icon: "pause" as const, items: principals.filter((principal) => principal.disabled_at) },
  ].filter((group) => group.items.length > 0);
  return (
    <SettingsSection about="Who can use KEEL, their roles and what each can do." id="people-heading" title="Who has access">
      {principals.length === 0 ? <p className="sel-empty">Nobody has been added yet.</p> : <>
        <div className="sel-groups">
          {groups.map((group) => (
            <SettingsGroup about={group.about} count={`${group.items.length} ${group.items.length === 1 ? "account" : "accounts"}`} icon={group.icon} key={group.key} title={group.title}>
              {group.items.map((principal) => <PrincipalDetails canRoles={canRoles} canUsers={canUsers} key={principal.id} now={now} principal={principal} />)}
            </SettingsGroup>
          ))}
        </div>
        <TechnicalDetails summary="Technical details for these accounts">
          {principals.map((principal) => <PrincipalRecord key={principal.id} principal={principal} />)}
        </TechnicalDetails>
      </>}
    </SettingsSection>
  );
}
