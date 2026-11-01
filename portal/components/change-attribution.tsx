import { DecisionStyles } from "@/components/decision-styles";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ago, formatTimestamp } from "@/lib/presentation";
import type { ChangeAttribution } from "@/lib/types";

type Actor = ChangeAttribution["actors"][number];

// Roadmap task-91: who made a change, as the audit log supports it, when, how sure Keel
// is, what to do when it cannot tell, and where a roll back would go. Sentences only; the attribution codes, audit entry ids and object ids stay
// in the record. "Exact" is said only when the engine found one account's audit entry
// for this very resource and the log is complete for the whole time it could have
// happened; everything weaker says so.
export const ATTRIBUTION_HEADLINES: Record<ChangeAttribution["verdict"], string> = {
  exact: "Confirmed by the Microsoft audit log",
  plausible: "Likely, not confirmed",
  unknown: "Not known",
};

// The badge beside the heading: colour and one or two words.
export const ATTRIBUTION_BADGES: Record<ChangeAttribution["verdict"], { label: string; tone: string }> = {
  exact: { label: "Confirmed", tone: "pill-ok" },
  plausible: { label: "Likely", tone: "pill-warn" },
  unknown: { label: "Not known", tone: "pill-neutral" },
};

// Where Microsoft keeps the record of a change, by the audit log KEEL read.
export const AUDIT_LOG_NAMES: Record<string, string> = {
  audit: "Microsoft Entra audit log",
  "intune-audit": "Intune audit log",
};

// The Collector permission each log needs, named when a read was refused.
const AUDIT_LOG_PERMISSIONS: Record<string, string> = {
  audit: "the Microsoft Graph permission AuditLog.Read.All",
  "intune-audit": "the Microsoft Graph permission DeviceManagementConfiguration.Read.All and an Intune read role",
};

const UNKNOWN_SENTENCES: Record<string, string> = {
  "resource-identity-unresolved": "Keel cannot tell which setting this is, so it cannot match it to the audit log.",
  "audit-log-not-configured": "Keel does not read this tenant's audit log, so it cannot say who made this change.",
  "audit-retention-gap": "The audit log for that time is no longer available, so Keel cannot say who made this change.",
  "audit-read-scope-revoked": "Keel lost permission to read the audit log, so it cannot say who made this change.",
  "audit-read-failed": "Keel could not read the audit log for that time, so it cannot say who made this change.",
  "audit-window-not-read": "Keel has not read the audit log for that time yet.",
  "audit-events-skipped": "Keel skipped some audit entries for that time because it could not store them safely, so it cannot be sure who made this change.",
  "audit-in-organization-archive": "This tenant's audit log is kept in your organization's archive, which Keel does not read.",
  "several-nearby-sign-ins": "No audit entry names this change, and several people signed in while it happened.",
  "no-audit-record-names-resource": "No audit entry names this change, so Keel cannot say who made it.",
};

function actorName(actor: Actor): string {
  if (actor.name) return actor.kind === "servicePrincipal" ? `the app ${actor.name}` : actor.name;
  if (!actor.id) return "an account outside your entities";
  return actor.kind === "servicePrincipal" ? "an app Keel does not back up" : "an account Keel does not back up";
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
    case "audit-source-not-read":
      return `Microsoft keeps ${attribution.service ?? "this service"}'s changes in the Purview audit log, which Keel does not read yet.`;
    case "audit-record-names-resource":
      return `${capitalized(who)} made this change, according to the audit log.`;
    case "audit-log-incomplete":
      return `Probably ${who}. The audit log names them, but part of that time is missing from it.`;
    case "several-actors-changed-resource":
      return `Probably ${who}. The audit log shows each of them changing it.`;
    case "sign-in-proximity-only":
      return `Possibly ${who}, who signed in while it changed. No audit entry names this change.`;
    default:
      return UNKNOWN_SENTENCES[attribution.reason] ?? "Keel cannot say who made this change.";
  }
}

function logName(attribution: ChangeAttribution): string {
  return (attribution.source && AUDIT_LOG_NAMES[attribution.source]) || "audit log";
}

function between(attribution: ChangeAttribution): string {
  return `between ${formatTimestamp(attribution.window.from)} and ${formatTimestamp(attribution.window.until)}`;
}

/** What a person can do when Keel cannot name who made the change, or null when it can. */
export function attributionNextStep(attribution: ChangeAttribution): string | null {
  if (attribution.verdict !== "unknown") return null;
  const log = logName(attribution);
  const search = `search the ${log} for this setting ${between(attribution)}`;
  switch (attribution.reason) {
    case "audit-source-not-read":
      return `To find out, search the Purview audit log (purview.microsoft.com, Audit) for this setting ${between(attribution)}. Keel needs the permission AuditLogsQuery.Read.All to read it.`;
    case "audit-log-not-configured":
    case "audit-window-not-read":
      return "Keel reads the audit log after each backup. Check again after the next backup.";
    case "audit-retention-gap":
      return `Microsoft no longer keeps that part of the ${log}. Ask the people who manage this setting, or check your own log archive.`;
    case "audit-read-scope-revoked":
      return `Microsoft refused the read. Give the Collector app ${(attribution.source && AUDIT_LOG_PERMISSIONS[attribution.source]) || "its audit log permission"}, then run a backup.`;
    case "audit-read-failed":
      return "Keel tries again after the next backup.";
    case "audit-in-organization-archive":
      return `To find out, search your archive for this setting ${between(attribution)}.`;
    case "no-audit-record-names-resource":
      return `A change Microsoft or a sync makes has no person behind it. To check, ${search}.`;
    default:
      return `To find out, ${search}.`;
  }
}

/** When it changed: the audit record's time when there is one, else the window Keel saw it in. */
export function attributionWhen(attribution: ChangeAttribution): { at: string | null; sentence: string } {
  const at = attribution.evidence.map((entry) => entry.occurredAt).sort().at(-1) ?? null;
  if (at) return { at, sentence: `Changed ${formatTimestamp(at)}, from the ${logName(attribution)}.` };
  return { at: null, sentence: `Changed ${between(attribution)}, between two backups.` };
}

/** One line for a summary row: who, and how sure. */
export function attributionSummary(attribution: ChangeAttribution): string {
  const who = names(attribution.actors);
  if (attribution.verdict === "exact" && who) return `${capitalized(who)}, confirmed by the ${logName(attribution)}.`;
  if (attribution.verdict === "plausible" && who) return `Probably ${who}, not confirmed.`;
  return "Not known.";
}

const CENTRAL_BECAUSE: Record<string, string> = {
  "cross-entity": "because it touches more than one entity",
  "shared-or-unattributed": "because this setting is shared or has no single owner",
  "ownership-expired": "because its owner record is out of date",
  "no-entity-approver": "because its owner has no approver",
  "no-captured-scope": "because Keel could not tell who owns it",
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
        <DecisionStyles />
        <h3 className="decision-heading">Who made this change</h3>
        <p className="change-attribution-headline">
          <span className="pill pill-warn">Not checked</span>{" "}
          Keel could not check who made this change. Reload the page; if this stays, the portal log says why.
        </p>
      </section>
    );
  }
  const badge = ATTRIBUTION_BADGES[attribution.verdict];
  const when = attributionWhen(attribution);
  const next = attributionNextStep(attribution);
  return (
    <section className={`change-attribution change-attribution-${attribution.verdict}`} aria-label="Who made this change">
      <DecisionStyles />
      <h3 className="decision-heading">Who made this change</h3>
      <p className="change-attribution-headline">
        <span className={`pill ${badge.tone}`}>{badge.label}</span>{" "}
        <strong>{ATTRIBUTION_HEADLINES[attribution.verdict]}.</strong>{" "}
        <span className="change-attribution-sentence">{attributionSentence(attribution)}</span>
      </p>
      <p className="change-attribution-when">
        {when.sentence}
        {when.at ? <> (<time dateTime={when.at} title={formatTimestamp(when.at)}>{ago(when.at, now)}</time>)</> : null}
      </p>
      {next ? <p className="change-attribution-next" role="note">{next}</p> : null}
      {attribution.route ? <p className="change-attribution-route">{routeSentence(attribution.route)}</p> : null}
      <TechnicalDetails summary="Technical details: attribution">
        <RecordField copy={false} label="Attribution" value={`${attribution.verdict} · ${attribution.reason}`} />
        {attribution.source ? <RecordField copy={false} label="Audit log read" value={attribution.source} /> : null}
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
        <RecordField label="Setting object ID" value={attribution.resourceObjectId} />
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
