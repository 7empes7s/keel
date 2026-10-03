import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ago, formatTimestamp } from "@/lib/presentation";
import type { ChangeAttribution } from "@/lib/types";

type Actor = ChangeAttribution["actors"][number];

// Roadmap task-91: who made a change, as the audit log supports it, and where a roll back
// would go. Sentences only; the attribution codes, audit entry ids and object ids stay
// in the record. "Exact" is said only when the engine found one account's audit entry
// for this very resource and the log is complete for the whole time it could have
// happened; everything weaker says so.
export const ATTRIBUTION_HEADLINES: Record<ChangeAttribution["verdict"], string> = {
  exact: "Confirmed by the Microsoft audit log",
  plausible: "Likely, not confirmed",
  unknown: "Not known",
};

const UNKNOWN_SENTENCES: Record<string, string> = {
  "resource-identity-unresolved": "KEEL cannot tell which object this is, so it cannot match it to the audit log.",
  "audit-log-not-configured": "KEEL does not read this tenant's audit log, so it cannot say who made this change.",
  "audit-retention-gap": "The audit log for that time is no longer available, so KEEL cannot say who made this change.",
  "audit-read-scope-revoked": "KEEL lost permission to read the audit log, so it cannot say who made this change.",
  "audit-read-failed": "KEEL could not read the audit log for that time, so it cannot say who made this change.",
  "audit-window-not-read": "KEEL has not read the audit log for that time yet.",
  "audit-in-organization-archive": "This tenant's audit log is kept in your organization's archive, which KEEL does not read.",
  "several-nearby-sign-ins": "No audit entry names this change, and several people signed in while it happened.",
  "no-audit-record-names-resource": "No audit entry names this change, so KEEL cannot say who made it.",
};

function actorName(actor: Actor): string {
  if (actor.name) return actor.kind === "servicePrincipal" ? `the app ${actor.name}` : actor.name;
  if (!actor.id) return "an account outside your entities";
  return actor.kind === "servicePrincipal" ? "an app KEEL does not back up" : "an account KEEL does not back up";
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function names(actors: Actor[]): string {
  const words = actors.map(actorName);
  return words.length <= 1 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

export function attributionSentence(attribution: ChangeAttribution): string {
  const who = names(attribution.actors);
  switch (attribution.reason) {
    case "audit-record-names-resource":
      return `${capitalized(who)} made this change, according to the audit log.`;
    case "audit-log-incomplete":
      return `Probably ${who}. The audit log names them, but part of that time is missing from it.`;
    case "several-actors-changed-resource":
      return `Probably ${who}. The audit log shows each of them changing it.`;
    case "sign-in-proximity-only":
      return `Possibly ${who}, who signed in while it changed. No audit entry names this change.`;
    default:
      return UNKNOWN_SENTENCES[attribution.reason] ?? "KEEL cannot say who made this change.";
  }
}

const CENTRAL_BECAUSE: Record<string, string> = {
  "cross-entity": "because it touches more than one entity",
  "shared-or-unattributed": "because this resource is shared or has no single owner",
  "ownership-expired": "because its owner record is out of date",
  "no-entity-approver": "because its owner has no approver",
  "no-captured-scope": "because KEEL could not tell who owns it",
};

export function routeSentence(route: NonNullable<ChangeAttribution["route"]>): string {
  const people = `${route.approverCount} ${route.approverCount === 1 ? "person" : "people"}`;
  if (route.route === "entity") return `A roll back goes to ${route.entityCode} approvers (${people}).`;
  if (route.route === "refused") return "Its owner changed, so a roll back must be asked for again.";
  const because = CENTRAL_BECAUSE[route.reason ?? ""] ?? "because it needs a central decision";
  return `A roll back goes to a central approver (${people}), ${because}.`;
}

export function ChangeAttributionPanel({ attribution, now }: { attribution: ChangeAttribution | null | undefined; now: string }) {
  if (!attribution) {
    return (
      <section className="change-attribution" aria-label="Who made this change">
        <p className="section-kicker">Who made this change</p>
        <p className="field-help">KEEL did not check who made this change.</p>
      </section>
    );
  }
  const when = attribution.verdict === "exact" ? attribution.evidence[0]?.occurredAt ?? null : null;
  return (
    <section className={`change-attribution change-attribution-${attribution.verdict}`} aria-label="Who made this change">
      <p className="section-kicker">Who made this change</p>
      <p className="change-attribution-headline">
        <strong>{ATTRIBUTION_HEADLINES[attribution.verdict]}.</strong>{" "}
        <span className="change-attribution-sentence">{attributionSentence(attribution)}</span>
        {when ? (
          <> Recorded <time dateTime={when} title={formatTimestamp(when)}>{ago(when, now)}</time>.</>
        ) : null}
      </p>
      {attribution.route ? <p className="change-attribution-route">{routeSentence(attribution.route)}</p> : null}
      <TechnicalDetails summary="Technical details: attribution">
        <RecordField copy={false} label="Attribution" value={`${attribution.verdict} · ${attribution.reason}`} />
        {attribution.actors.map((actor, index) => (
          <RecordField key={`actor-${index}`} label={`Account object ID (${actor.kind})`} value={actor.id ?? "withheld: outside your entities"} copy={Boolean(actor.id)} />
        ))}
        {attribution.evidence.map((entry) => (
          <RecordField
            key={entry.sourceEventId}
            label="Audit entry ID"
            usage={`${entry.occurredAt} · ${entry.operation}${entry.activity ? ` · ${entry.activity}` : ""}${entry.fields.length ? ` · fields ${entry.fields.join(", ")}` : ""}`}
            value={entry.sourceEventId}
          />
        ))}
        <RecordField label="Resource object ID" value={attribution.resourceObjectId} />
        <RecordField copy={false} label="Change window" value={`${attribution.window.from} to ${attribution.window.until}`} />
        <RecordField copy={false} label="Audit log coverage" value={`${attribution.coverage.audit} · sign-in log ${attribution.coverage.signIn}`} />
        {attribution.route ? (
          <RecordField
            copy={false}
            label="Approval route"
            value={`${attribution.route.route}${attribution.route.entityCode ? ` · ${attribution.route.entityCode}` : ""}${attribution.route.reason ? ` · ${attribution.route.reason}` : ""} · routed ${attribution.route.routedAt}`}
          />
        ) : null}
      </TechnicalDetails>
    </section>
  );
}
