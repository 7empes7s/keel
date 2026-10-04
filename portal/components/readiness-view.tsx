import Link from "next/link";
import type { ReactNode } from "react";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import {
  DIMENSION_LABELS,
  DIMENSION_ORDER,
  OVERALL_LABELS,
  STATUS_LABELS,
  SURFACE_LABELS,
  SURFACE_STATUS,
  alertSentence,
  canarySentence,
  dimensionSentence,
  reminderSentence,
  surfaceSentence,
  type ReadinessAccount,
  type ReadinessData,
} from "@/lib/readiness-view";

// Roadmap task-94: the Emergency access page's explanation and record layers. Each
// account shows its five checks separately; "Not known" is its own state and never
// reads as OK. Checks KEEL cannot make stay listed next to the verdict.

const CLI = "node cli/keel-breakglass.mjs";

function Pill({ tone, label }: { tone: string; label: string }) {
  return <span className={`pill pill-${tone}`}>{label}</span>;
}

function Card({ id, title, pill, children }: { id: string; title: string; pill: { tone: string; label: string }; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className={`item-card resilience-card readiness-card readiness-${id}`}>
      <div className="item-card-head">
        <h2 id={`${id}-heading`}>{title}</h2>
        <Pill label={pill.label} tone={pill.tone} />
      </div>
      {children}
    </section>
  );
}

function AccountCard({ account, index, now }: { account: ReadinessAccount; index: number; now: string }) {
  return (
    <Card id={`account-${index}`} pill={OVERALL_LABELS[account.overall]} title={account.label}>
      <ul className="resilience-list readiness-checks">
        {DIMENSION_ORDER.map((name) => {
          const dimension = account.dimensions[name];
          const status = STATUS_LABELS[dimension.status];
          return (
            <li className={`readiness-check readiness-check-${dimension.status}`} key={name}>
              <strong>{DIMENSION_LABELS[name]}</strong> <Pill label={status.label} tone={status.tone} />
              <br />
              {dimensionSentence(name, dimension, now)}
            </li>
          );
        })}
      </ul>
      <h3>Reminders</h3>
      <ul className="resilience-list readiness-reminders">
        {account.reminders.map((reminder) => <li key={reminder.kind}>{reminderSentence(reminder, now)}</li>)}
        {account.reminders.some((reminder) => reminder.kind === "rotation") ? null : <li>No credential review interval is set.</li>}
      </ul>
      <p className="field-help">KEEL never changes this account&apos;s credentials or the policies around it. A person records each test and change.</p>
      <TechnicalDetails>
        <RecordField label="Account object ID" value={account.accountId} usage={<><code>{CLI} record --account-id {account.accountId} --kind validated</code></>} />
        <RecordField copy={false} label="Overall" value={account.overall} />
        {DIMENSION_ORDER.map((name) => (
          <RecordField copy={false} key={name} label={`Check · ${name}`} value={`${account.dimensions[name].status} · ${account.dimensions[name].reason}`} />
        ))}
        {(account.dimensions.policyExclusions.evidence.policies ?? []).map((entry) => (
          <RecordField copy={false} key={entry.policy} label={`Policy · ${entry.policy}`} value={`${entry.treatment} · ${entry.reason}`} />
        ))}
        <RecordField copy={false} label="Method record" value={account.methodEvidence ? `${account.methodEvidence.basis} · ${account.methodEvidence.methods.join(", ") || "none"} · ${account.methodEvidence.occurredAt ?? "unknown"}` : null} />
        <RecordField copy={false} label="Last test" value={account.lastValidatedAt} />
        <RecordField copy={false} label="Last credential change" value={account.lastRotatedAt} />
        <RecordField copy={false} label="Intervals (days)" value={`test ${account.validationIntervalDays} · credential ${account.rotationIntervalDays ?? "not set"}`} />
        <RecordField label="Alert resource key" value={account.resourceKey} />
      </TechnicalDetails>
    </Card>
  );
}

export function ReadinessView({ data }: { data: ReadinessData }) {
  const now = data.generatedAt;
  const unchecked = data.surfaces.filter((surface) => surface.status !== "evaluated");
  return (
    <div className="resilience-grid readiness-grid">
      {data.accounts.length ? data.accounts.map((account, index) => (
        <AccountCard account={account} index={index} key={account.accountId} now={now} />
      )) : (
        <Card id="none" pill={{ tone: "warn", label: "None registered" }} title="Emergency accounts">
          <p className="resilience-sentence">
            {data.configured === false && data.reason === "not-migrated"
              ? "This KEEL database has not been updated for emergency accounts yet."
              : "No emergency accounts are registered. Register two cloud-only accounts with the command below."}
          </p>
          <TechnicalDetails>
            <RecordField copy={false} label="Reason" value={data.reason} />
            <RecordField label="Register" value={`${CLI} register --account-id <object id> --label <name>`} />
          </TechnicalDetails>
        </Card>
      )}

      <Card
        id="canary"
        pill={data.canary.status === "watching" ? { tone: "ok", label: "Watching" } : { tone: "warn", label: "Not watching" }}
        title="Emergency sign-in alerts"
      >
        <p className="resilience-sentence">{canarySentence(data, now)}</p>
        {data.alerts.length ? (
          <ul className="resilience-list readiness-alerts">
            {data.alerts.map((alert) => (
              <li key={alert.id}>
                <Pill label={alert.active ? (alert.severity === "critical" ? "Unplanned" : "Open") : "Closed"} tone={alert.active ? (alert.severity === "critical" ? "bad" : "warn") : "neutral"} />{" "}
                {alertSentence(alert, now)}
              </li>
            ))}
          </ul>
        ) : <p className="field-help">No emergency account has been used, and no test or review is overdue.</p>}
        <p className="field-help">Every use opens an alert, even a planned test, so each test also proves the alert works. <Link href="/alerts">Open the alerts inbox</Link></p>
        <TechnicalDetails>
          <RecordField copy={false} label="Watch state" value={`${data.canary.status} · ${data.canary.reason}`} />
          {Object.entries(data.canary.sources ?? {}).map(([source, entry]) => (
            <RecordField copy={false} key={source} label={`Log · ${source}`} value={`${entry.status} · read up to ${entry.readUntil ?? "never"}`} />
          ))}
          {data.alerts.map((alert) => (
            <RecordField
              key={alert.id}
              label={`Alert ID · ${alert.condition}`}
              value={`${alert.id} · ${alert.state} · occurrence ${alert.occurrence} · last event ${alert.lastEventId}${alert.detail.correlationId ? ` · correlation ${alert.detail.correlationId}` : ""}${(alert.detail.changes ?? []).map((change) => ` · change ${change.auditEventId} ${change.operation} ${change.targetType} ${change.targetId}`).join("")}`}
              usage={<><code>GET /api/alerts</code></>}
            />
          ))}
          <RecordField label="Sweep once" value={`${CLI} canary`} />
        </TechnicalDetails>
      </Card>

      <Card
        id="surfaces"
        pill={unchecked.length ? { tone: "warn", label: `${unchecked.length} not checked` } : { tone: "ok", label: "All checked" }}
        title="What can block an emergency sign-in"
      >
        <ul className="resilience-list readiness-surfaces">
          {data.surfaces.map((surface) => (
            <li className={`readiness-surface readiness-surface-${surface.status}`} key={surface.surface}>
              <strong>{SURFACE_LABELS[surface.surface] ?? "Another policy area"}</strong> <Pill label={SURFACE_STATUS[surface.status].label} tone={SURFACE_STATUS[surface.status].tone} />
              <br />
              {surfaceSentence(surface)}
            </li>
          ))}
        </ul>
        <TechnicalDetails>
          {data.surfaces.map((surface) => (
            <RecordField copy={false} key={surface.surface} label={`Area · ${surface.surface}`} value={`${surface.status} · ${surface.reason}${surface.missing?.length ? ` · missing ${surface.missing.join(", ")}` : ""}`} />
          ))}
          {Object.entries(data.inventory ?? {}).map(([type, entry]) => (
            <RecordField copy={false} key={type} label={`Backup · ${type}`} value={`${entry.status}${entry.observedAt ? ` · ${entry.observedAt}` : ""}`} />
          ))}
          <RecordField copy={false} label="Tenant verdict" value={`${data.overall} · ${data.reason}`} usage={<>from <code>{CLI} report</code></>} />
        </TechnicalDetails>
      </Card>
    </div>
  );
}
