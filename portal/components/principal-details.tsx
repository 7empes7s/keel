import { PrincipalControls, RemoveRoleButton } from "@/components/principal-controls";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
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
  const role = displayEnum("role", grant.role);
  const from = DATE.format(new Date(grant.active_from));
  if (grant.active_until && new Date(grant.active_until).valueOf() <= new Date(now).valueOf()) return `${role}, ended ${DATE.format(new Date(grant.active_until))}`;
  if (new Date(grant.active_from).valueOf() > new Date(now).valueOf()) return `${role} from ${from}${grant.active_until ? ` until ${DATE.format(new Date(grant.active_until))}` : ""}`;
  return `${role} since ${from}${grant.active_until ? ` until ${DATE.format(new Date(grant.active_until))}` : ""}`;
}

export function PrincipalDetails({ principal, now, canRoles = false, canUsers = false }: {
  principal: PrincipalView; now: string; canRoles?: boolean; canUsers?: boolean;
}) {
  const name = principal.display_name || principal.email;

  const active = principal.role_grants.filter((grant) => isGrantActive(grant, now));
  const past = principal.role_grants.filter((grant) => !isGrantActive(grant, now));
  return (
    <section className={`item-card principal-card${principal.disabled_at ? " principal-disabled" : ""}`}>
      <div className="item-card-head">
        <h2>{name}</h2>
        <span className={principal.disabled_at ? "inactive-indicator" : "active-indicator"}>
          {principal.disabled_at ? <>Disabled <time dateTime={principal.disabled_at} title={formatTimestamp(principal.disabled_at)}>{ago(principal.disabled_at, now)}</time></> : "Active"}
        </span>
      </div>
      {name !== principal.email ? <p className="principal-email">{principal.email}</p> : null}
      <p>{principal.disabled_at ? "Can no longer use KEEL." : `${accessSummary(principal.capabilities)}.`}</p>
      {principal.role_grants.length === 0 ? <p className="field-help">No roles.</p> : (
        <ul className="grant-list">
          {[...active, ...past].map((grant) => (
            <li className={isGrantActive(grant, now) ? "grant-active" : "grant-past"} key={grant.id}>
              <span>{grantSentence(grant, now)}</span>
              {canRoles && isGrantActive(grant, now) && !principal.disabled_at ? (
                <RemoveRoleButton grantId={grant.id} name={name} principalId={principal.id} role={displayEnum("role", grant.role)} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {!principal.disabled_at && (canRoles || canUsers) ? (
        <PrincipalControls canRoles={canRoles} canUsers={canUsers} name={name} principalId={principal.id} />
      ) : null}
      <TechnicalDetails>
        <RecordField label="Principal ID" usage={<>use with <code>POST /api/principals/&lt;id&gt;/grant</code></>} value={principal.id} />
        <RecordField copy={false} label="Effective capabilities" value={principal.capabilities.join(", ") || "none"} />
        <RecordField copy={false} label="Disabled at" value={principal.disabled_at ?? "not disabled"} />
        {principal.role_grants.map((grant) => (
          <RecordField key={grant.id} label={`Grant ID (${grant.role})`} usage={`active ${grant.active_from} → ${grant.active_until ?? "open-ended"}`} value={grant.id} />
        ))}
      </TechnicalDetails>
    </section>
  );
}
