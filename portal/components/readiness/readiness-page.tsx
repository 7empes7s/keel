"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BaselinesStyles } from "@/components/baselines/styles";
import { ConfirmSheet } from "@/components/incidents/confirm-sheet";
import { DatePicker } from "@/components/pickers/date-picker";
import { Icon, type IconName } from "@/components/shell/icons";
import { Popover } from "@/components/shell/popover";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { Verdict } from "@/components/verdict";
import { alertCall, alertCallWords, type AlertAction } from "@/lib/alert-calls";
import { isActive, isWaiting, type AlertState } from "@/lib/alerts-view";
import { breakglassCall, type BreakglassOp, type LifecycleKind } from "@/lib/breakglass-calls";
import type { DayRange } from "@/lib/date-range";
import { utcInstant } from "@/lib/incident-calls";
import { ago, formatTimestamp } from "@/lib/presentation";
import {
  DIMENSION_LABELS,
  DIMENSION_ORDER,
  METHOD_WORDS,
  OVERALL_LABELS,
  STATUS_LABELS,
  SURFACE_LABELS,
  SURFACE_STATUS,
  SURFACE_TERMS,
  accountInitials,
  accountName,
  accountSubName,
  alertAccountName,
  alertSentence,
  canarySentence,
  dimensionSentence,
  orderedChecks,
  reachingRules,
  readinessCounts,
  readinessNext,
  readinessVerdict,
  reminderRows,
  surfaceGroups,
  surfaceSentence,
  testDue,
  withRecordedTest,
  type ReadinessAccount,
  type ReadinessAlert,
  type ReadinessData,
} from "@/lib/readiness-view";
import { toast } from "@/lib/toast";
import { pushUrl } from "@/lib/url-history";
import { useLiveSearchParams, useViewState } from "@/lib/use-view-state";

// Emergency access (portal audit, one design): a verdict whose one amber action is the
// next thing to do (review a use, record a due test, or add an account); four tiles;
// one card per emergency account with its checks as rows, problems first; the
// emergency sign-ins with Acknowledge and Resolve in place; and what can block a sign-in,
// grouped. Each change opens a sheet from the address (`account=<id>&do=<step>`, or
// `do=add`, or `alert=<id>&do=resolve`), so Back closes it. KEEL only records what a
// person did: nothing here signs in, changes a credential or writes to the tenant.
// Ids stay in Technical details.

type Step = "record" | "rotated" | "methods" | "edit" | "retire" | "add" | "resolve";
const STEPS: Step[] = ["record", "rotated", "methods", "edit", "retire", "add", "resolve"];
const KEEL_RECORDS_ONLY = "KEEL never changes this account's credentials or the rules around it. A person records each test and change.";
const READ_ONLY = "Only people who manage configuration can change emergency accounts.";
const CLI = "node cli/keel-breakglass.mjs";

export function ReadinessPage({ data, canConfigure, canRespond }: {
  data: ReadinessData;
  canConfigure: boolean;
  canRespond: boolean;
}) {
  const router = useRouter();
  const view = useViewState();
  const pathname = usePathname() ?? "/readiness";
  const params = useLiveSearchParams();
  const now = data.generatedAt;
  const step = STEPS.find((value) => value === view.get("do")) ?? null;
  const accountId = view.get("account");
  const alertId = view.get("alert");

  // What this page recorded, until the server's next read says where things stand.
  const [tested, setTested] = useState<Record<string, string>>({});
  const [alertStates, setAlertStates] = useState<Record<string, AlertState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => { setTested({}); setAlertStates({}); }, [data]);

  const accounts = useMemo(() => data.accounts.map((account) => (tested[account.accountId] ? withRecordedTest(account, tested[account.accountId]) : account)), [data.accounts, tested]);
  const alerts = useMemo(() => data.alerts.map((alert) => {
    const state = alertStates[alert.id];
    return state ? { ...alert, state, active: state !== "resolved" } : alert;
  }), [data.alerts, alertStates]);
  const current: ReadinessData = useMemo(() => ({ ...data, accounts, alerts }), [data, accounts, alerts]);

  const verdict = readinessVerdict(current);
  const counts = readinessCounts(current);
  const next = readinessNext(current, { canConfigure, canRespond });
  const chosen = accounts.find((account) => account.accountId === accountId) ?? null;
  const chosenAlert = alerts.find((alert) => alert.id === alertId) ?? null;

  const href = (changes: Record<string, string | null>) => {
    const query = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) query.set(key, value); else query.delete(key);
    const text = query.toString();
    return text ? `${pathname}?${text}` : pathname;
  };
  const stepHref = (to: Step, account: string | null = null, alert: string | null = null) => href({ do: to, account, alert });
  const follow = (event: MouseEvent, to: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    pushUrl(to);
  };
  const close = () => view.set({ do: null, account: null, alert: null });

  async function change(op: BreakglassOp, body: Record<string, unknown>, done: string, detail?: string): Promise<string | null> {
    const result = await breakglassCall(op, body);
    if (!result.ok) return result.reason;
    toast({ title: done, detail });
    router.refresh();
    return null;
  }

  async function respond(alert: ReadinessAlert, action: AlertAction, note?: string): Promise<string | null> {
    setBusy(alert.id);
    try {
      const result = await alertCall(alert.id, action, note);
      const why = alertCallWords(result);
      if (why) {
        toast({ tone: "warning", title: "Not changed", detail: why });
        router.refresh();
        return why;
      }
      setAlertStates((states) => ({ ...states, [alert.id]: (result.state as AlertState) ?? (action === "acknowledge" ? "acknowledged" : "resolved") }));
      toast({ title: action === "acknowledge" ? "Alert acknowledged" : "Alert resolved", detail: alertAccountName(alert, accounts) });
      router.refresh();
      return null;
    } finally {
      setBusy(null);
    }
  }

  // A review opens the alert's own panel on the Alerts page; the other steps open here.
  const verdictAction = !next ? null : next.kind === "review"
    ? { label: next.label, href: `/alerts?open=${encodeURIComponent(next.alertId)}` }
    : { label: next.label, onClick: () => pushUrl(next.kind === "record" ? stepHref("record", next.accountId) : stepHref("add")) };

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  const firstDue = accounts.findIndex(testDue);
  const firstNotReady = accounts.findIndex((account) => account.overall !== "ready");
  const tiles: { key: string; label: string; icon: IconName; value: number; small: string; target: string; tone?: "urgent" | "soon" }[] = [
    { key: "accounts", label: "Emergency accounts", icon: "settings", value: counts.accounts, small: counts.accounts >= 2 ? "2 is the minimum" : "Add at least 2", target: "ea-accounts", tone: counts.accounts < 2 ? "urgent" : undefined },
    { key: "ready", label: "Ready", icon: "check-circle", value: counts.ready, small: counts.ready === counts.accounts && counts.accounts ? "Every account passes" : "Pass every check", target: firstNotReady > -1 ? `ea-account-${firstNotReady}` : "ea-accounts", tone: counts.accounts && counts.ready < counts.accounts ? "urgent" : undefined },
    { key: "due", label: "Tests due", icon: "clock", value: counts.testsDue, small: counts.testsDue ? "Record a test sign-in" : "Every test is in date", target: firstDue > -1 ? `ea-account-${firstDue}` : "ea-accounts", tone: counts.testsDue ? "soon" : undefined },
    { key: "uses", label: "Unplanned uses", icon: "alert", value: counts.unplanned, small: counts.unplanned ? "Check each one" : "None open", target: "ea-signins", tone: counts.unplanned ? "urgent" : undefined },
  ];

  const sheetOpen = Boolean(step);

  return (
    <div className="ea-page">
      <Verdict action={verdictAction} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <section aria-label="Emergency access at a glance" className="ea-tiles">
          {tiles.map((tile) => (
            <button className="ea-tile" data-tone={tile.tone} key={tile.key} onClick={() => jump(tile.target)} type="button">
              <span className="ea-tile-label"><Icon name={tile.icon} />{tile.label}</span>
              <b className="ea-tile-count">{tile.value}</b>
              <small>{tile.small}</small>
            </button>
          ))}
        </section>

        {canConfigure ? null : <p className="ea-note" role="note"><Icon name="info" /><span>{READ_ONLY}</span></p>}

        <section aria-labelledby="ea-accounts-heading" className="ea-section" id="ea-accounts">
          <div className="ea-section-head">
            <h2 id="ea-accounts-heading">Emergency accounts</h2>
            {canConfigure && accounts.length ? (
              <Link className="btn btn-sm" href={stepHref("add")} onClick={(event) => follow(event, stepHref("add"))}><Icon name="plus" />Add an emergency account</Link>
            ) : null}
          </div>
          {accounts.length ? (
            <div className="ea-accounts">
              {accounts.map((account, index) => (
                <AccountCard account={account} canConfigure={canConfigure} follow={follow} index={index} key={account.accountId} now={now} stepHref={stepHref} />
              ))}
            </div>
          ) : (
            <div className="ea-card ea-empty">
              <span aria-hidden="true" className="ea-empty-icon"><Icon name="settings" /></span>
              <p>
                {data.configured === false && data.reason === "not-migrated"
                  ? "This KEEL database has not been updated for emergency accounts yet."
                  : "No emergency accounts yet. Add two cloud-only accounts so one failure does not lock everyone out."}
              </p>
              <TechnicalDetails>
                <RecordField copy={false} label="Reason" value={data.reason} />
                <RecordField label="Register from the command line" value={`${CLI} register --account-id <object id> --label <name>`} />
              </TechnicalDetails>
            </div>
          )}
        </section>

        <section aria-labelledby="ea-signins-heading" className="ea-section" id="ea-signins">
          <div className="ea-section-head">
            <h2 id="ea-signins-heading">Emergency sign-ins</h2>
            <Badge tone={data.canary.status === "watching" ? "fine" : "soon"}>{data.canary.status === "watching" ? "Watching" : "Not watching"}</Badge>
          </div>
          <div className="ea-card ea-signins">
            <p className="ea-lead">{canarySentence(current, now)}</p>
            {alerts.length ? (
              <ul className="ea-alerts">
                {alerts.map((alert) => (
                  <AlertRow
                    accounts={accounts}
                    alert={alert}
                    busy={busy === alert.id}
                    canRespond={canRespond}
                    follow={follow}
                    key={alert.id}
                    now={now}
                    onAcknowledge={() => void respond(alert, "acknowledge")}
                    resolveHref={stepHref("resolve", null, alert.id)}
                  />
                ))}
              </ul>
            ) : <p className="ea-quiet"><Icon name="check-circle" />No emergency account has been used, and no test or review is overdue.</p>}
            <p className="field-help">Every use opens an alert, even a planned test, so each test also proves the alert works. <Link className="ea-inline-link" href="/alerts">Open the alerts inbox</Link></p>
            <TechnicalDetails>
              <RecordField copy={false} label="Watch state" value={`${data.canary.status} · ${data.canary.reason}`} />
              {Object.entries(data.canary.sources ?? {}).map(([source, entry]) => (
                <RecordField copy={false} key={source} label={`Log · ${source}`} value={`${entry.status} · read up to ${entry.readUntil ?? "never"}`} />
              ))}
              {data.alerts.map((alert) => (
                <RecordField
                  key={alert.id}
                  label={`Alert ID · ${alert.condition}`}
                  value={`${alert.id} · ${alert.state} · occurrence ${alert.occurrence} · last event ${alert.lastEventId}${alert.detail.correlationId ? ` · correlation ${alert.detail.correlationId}` : ""}${(alert.detail.changes ?? []).map((item) => ` · change ${item.auditEventId} ${item.operation} ${item.targetType} ${item.targetId}`).join("")}`}
                  usage={<><code>GET /api/alerts</code></>}
                />
              ))}
              <RecordField label="Sweep once" value={`${CLI} canary`} />
            </TechnicalDetails>
          </div>
        </section>

        <section aria-labelledby="ea-surfaces-heading" className="ea-section" id="ea-surfaces">
          <div className="ea-section-head">
            <h2 id="ea-surfaces-heading">What can block an emergency sign-in</h2>
          </div>
          <div className="ea-card ea-surfaces">
            {surfaceGroups(data.surfaces).map((group) => (
              <details className="ea-group" data-group={group.key} key={group.key} open={group.key !== "evaluated" || undefined}>
                <summary>
                  <Icon className="ea-group-chevron" name="chevron-down" />
                  <b>{group.label}</b>
                  <small>{group.items.length} · {group.about}</small>
                </summary>
                <ul className="ea-rows">
                  {group.items.map((surface) => {
                    const status = SURFACE_STATUS[surface.status];
                    return (
                      <li className="ea-row ea-surface" data-status={surface.status} key={surface.surface}>
                        <span aria-hidden="true" className="ea-row-icon" data-tone={status.tone}><Icon name={status.icon} /></span>
                        <span className="ea-row-body">
                          <b title={SURFACE_TERMS[surface.surface]}>{SURFACE_LABELS[surface.surface] ?? "Another policy area"}</b>
                          <small>{surfaceSentence(surface)}</small>
                          {surface.status === "unknown" ? <Link className="ea-inline-link" href="/protect">Back up now</Link> : null}
                        </span>
                        <Badge className="ea-row-badge" tone={status.tone}>{status.label}</Badge>
                      </li>
                    );
                  })}
                </ul>
              </details>
            ))}
            <TechnicalDetails>
              {data.surfaces.map((surface) => (
                <RecordField copy={false} key={surface.surface} label={`Area · ${surface.surface}`} value={`${surface.status} · ${surface.reason}${surface.missing?.length ? ` · missing ${surface.missing.join(", ")}` : ""}`} />
              ))}
              {Object.entries(data.inventory ?? {}).map(([type, entry]) => (
                <RecordField copy={false} key={type} label={`Backup · ${type}`} value={`${entry.status}${entry.observedAt ? ` · ${entry.observedAt}` : ""}`} />
              ))}
              <RecordField copy={false} label="Tenant verdict" value={`${data.overall} · ${data.reason}`} usage={<>from <code>{CLI} report</code></>} />
            </TechnicalDetails>
          </div>
        </section>
      </div>

      {sheetOpen ? <BaselinesStyles /> : null}

      {canConfigure && chosen && (step === "record" || step === "rotated") ? (
        <RecordSheet
          account={chosen}
          kind={step === "record" ? "validated" : "credential-rotated"}
          key={`${step}-${chosen.accountId}`}
          now={now}
          onClose={close}
          onSave={async (occurredAt, note) => {
            const kind = step === "record" ? "validated" : "credential-rotated";
            const failed = await change("record", { accountId: chosen.accountId, kind, occurredAt, note }, step === "record" ? "Test sign-in recorded" : "Credential change recorded", accountName(chosen));
            if (!failed) {
              if (kind === "validated") setTested((all) => ({ ...all, [chosen.accountId]: occurredAt }));
              close();
            }
            return failed;
          }}
        />
      ) : null}

      {canConfigure && chosen && step === "methods" ? (
        <MethodsSheet
          account={chosen}
          key={`methods-${chosen.accountId}`}
          onClose={close}
          onSave={async (methods) => {
            const failed = await change("record", { accountId: chosen.accountId, kind: "methods-attested", methods }, "Sign-in methods recorded", accountName(chosen));
            if (!failed) close();
            return failed;
          }}
        />
      ) : null}

      {canConfigure && chosen && step === "edit" ? (
        <EditSheet
          account={chosen}
          key={`edit-${chosen.accountId}`}
          onClose={close}
          onSave={async (validationIntervalDays, rotationIntervalDays) => {
            const failed = await change("register", { accountId: chosen.accountId, label: chosen.label, validationIntervalDays, rotationIntervalDays }, "Reminders saved", accountName(chosen));
            if (!failed) close();
            return failed;
          }}
        />
      ) : null}

      {canConfigure && chosen && step === "retire" ? (
        <ConfirmSheet
          confirmLabel="Retire account"
          effect="KEEL stops checking this account and stops watching its sign-ins. Its history stays. The account itself is not changed in Microsoft."
          kicker={accountName(chosen)}
          onClose={close}
          onConfirm={async (reason) => {
            const failed = await change("retire", { accountId: chosen.accountId, reason }, "Emergency account retired", accountName(chosen));
            if (!failed) close();
            return failed;
          }}
          placeholder="For example: replaced by a new emergency account"
          reasonLabel="Why retire it?"
          title="Retire this emergency account?"
        />
      ) : null}

      {canConfigure && step === "add" ? (
        <AddSheet
          onClose={close}
          onSave={async (signInName, validationIntervalDays) => {
            const failed = await change("register", { signInName, validationIntervalDays }, "Emergency account added", signInName);
            if (!failed) close();
            return failed;
          }}
        />
      ) : null}

      {canRespond && chosenAlert && step === "resolve" && isActive({ state: chosenAlert.state as AlertState }) ? (
        <ConfirmSheet
          confirmLabel="Resolve alert"
          effect="The alert closes now. A new sign-in with this account opens it again, and its history is kept."
          kicker={alertAccountName(chosenAlert, accounts)}
          onClose={close}
          onConfirm={async (reason) => {
            const failed = await respond(chosenAlert, "resolve", reason);
            if (!failed) close();
            return failed;
          }}
          placeholder="For example: planned test with the service desk"
          reasonLabel="Why is it resolved?"
          title="Resolve this alert?"
        />
      ) : null}
    </div>
  );
}

function AccountCard({ account, index, now, canConfigure, stepHref, follow }: {
  account: ReadinessAccount;
  index: number;
  now: string;
  canConfigure: boolean;
  stepHref: (to: Step, account?: string | null) => string;
  follow: (event: MouseEvent, to: string) => void;
}) {
  const overall = OVERALL_LABELS[account.overall];
  const sub = accountSubName(account);
  const link = (to: Step) => ({ href: stepHref(to, account.accountId), onClick: (event: MouseEvent) => follow(event, stepHref(to, account.accountId)) });
  const due = testDue(account);
  return (
    <article aria-labelledby={`ea-account-${index}-name`} className="ea-card ea-account" data-overall={account.overall} id={`ea-account-${index}`}>
      <header className="ea-account-head">
        <span aria-hidden="true" className="ea-avatar">{accountInitials(account)}</span>
        <span className="ea-who">
          <h3 id={`ea-account-${index}-name`}>{accountName(account)}</h3>
          {sub ? <small>{sub}</small> : null}
        </span>
        <Badge tone={overall.tone}>{overall.label}</Badge>
      </header>

      <ul className="ea-rows ea-checks">
        {orderedChecks(account).map((name) => {
          const dimension = account.dimensions[name];
          const status = STATUS_LABELS[dimension.status];
          const rules = name === "policyExclusions" && dimension.status === "fail" ? reachingRules(dimension) : [];
          return (
            <li className="ea-row ea-check" data-check={name} data-status={dimension.status} key={name}>
              <span aria-hidden="true" className="ea-row-icon" data-tone={status.tone}><Icon name={status.icon} /></span>
              <span className="ea-row-body">
                <b>{DIMENSION_LABELS[name]}</b>
                <small>{dimensionSentence(name, dimension, now)}</small>
                {rules.length ? (
                  <span className="ea-row-links">
                    {rules.map((rule) => <Link className="ea-inline-link" href={`/drift?q=${encodeURIComponent(rule)}`} key={rule}>Open {rule}</Link>)}
                    <small>Change the rule in Microsoft Entra, then back up again.</small>
                  </span>
                ) : null}
                {canConfigure && name === "phishingResistantCredential" && dimension.status !== "pass" ? (
                  <Link className="ea-inline-link" {...link("methods")}>Record sign-in methods</Link>
                ) : null}
              </span>
              <Badge className="ea-row-badge" icon={null} tone={status.tone}>{status.label}</Badge>
            </li>
          );
        })}
      </ul>

      <ul className="ea-reminders">
        {reminderRows(account, now).map((row) => (
          <li data-due={row.due || undefined} key={row.kind}>
            <Icon name="calendar" />
            <span>{row.text}</span>
            {canConfigure ? <Link className="ea-inline-link" {...link("edit")} aria-label={`Edit reminders for ${accountName(account)}`}>Edit</Link> : null}
          </li>
        ))}
      </ul>

      <footer className="ea-account-foot">
        {canConfigure ? (
          <div className="ea-account-actions">
            <Link className="btn btn-sm" data-due={due || undefined} {...link("record")}><Icon name="check" />Record a test sign-in</Link>
            <Popover
              button={<><Icon name="more" />More</>}
              buttonClassName="btn btn-sm btn-ghost"
              label={`More for ${accountName(account)}`}
              panelClassName="ea-more-panel"
              title={accountName(account)}
            >
              {(close) => (
                <ul className="ea-more-list">
                  <li><Link {...link("rotated")} onClick={(event) => { close(); follow(event, stepHref("rotated", account.accountId)); }}>Record a credential change</Link></li>
                  <li><Link {...link("methods")} onClick={(event) => { close(); follow(event, stepHref("methods", account.accountId)); }}>Record sign-in methods</Link></li>
                  <li><Link {...link("edit")} onClick={(event) => { close(); follow(event, stepHref("edit", account.accountId)); }}>Edit reminders</Link></li>
                  <li><Link {...link("retire")} onClick={(event) => { close(); follow(event, stepHref("retire", account.accountId)); }}>Retire…</Link></li>
                </ul>
              )}
            </Popover>
          </div>
        ) : null}
        <p className="field-help">{KEEL_RECORDS_ONLY}</p>
        <TechnicalDetails>
          <RecordField label="Account object ID" value={account.accountId} usage={<><code>{CLI} record --account-id {account.accountId} --kind validated</code></>} />
          <RecordField copy={false} label="Sign-in name" value={account.signInName ?? account.label} />
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
      </footer>
    </article>
  );
}

function AlertRow({ alert, accounts, now, canRespond, busy, onAcknowledge, resolveHref, follow }: {
  alert: ReadinessAlert;
  accounts: ReadinessAccount[];
  now: string;
  canRespond: boolean;
  busy: boolean;
  onAcknowledge: () => void;
  resolveHref: string;
  follow: (event: MouseEvent, to: string) => void;
}) {
  const state = alert.state as AlertState;
  const used = alert.condition === "emergency-account-used";
  const label = !alert.active ? "Closed" : used && !alert.detail.expectedTest ? "Unplanned" : state === "acknowledged" ? "Acknowledged" : "Open";
  const tone = !alert.active ? "neutral" : used && !alert.detail.expectedTest ? "urgent" : "soon";
  const changes = alert.detail.changes ?? [];
  return (
    <li className="ea-alert" data-active={alert.active || undefined}>
      <span aria-hidden="true" className="ea-row-icon" data-tone={tone}><Icon name={alert.active ? "alert" : "check-circle"} /></span>
      <span className="ea-row-body">
        <b>{alertAccountName(alert, accounts)}</b>
        <small>{alertSentence(alert, now, accounts)}</small>
        {changes.length ? (
          <ul className="ea-changes" aria-label="Changes made after the sign-in">
            {changes.map((item) => (
              <li key={item.auditEventId}>
                <span>{item.activity ?? "A change"}</span>
                {item.occurredAt ? <time dateTime={item.occurredAt} title={formatTimestamp(item.occurredAt)}>{ago(item.occurredAt, now)}</time> : null}
              </li>
            ))}
          </ul>
        ) : null}
        {canRespond && alert.active ? (
          <span className="ea-alert-actions">
            {isWaiting({ state }) ? <button aria-busy={busy || undefined} className="btn btn-sm" disabled={busy} onClick={onAcknowledge} type="button">Acknowledge</button> : null}
            <Link className="btn btn-sm btn-ghost" href={resolveHref} onClick={(event) => follow(event, resolveHref)}>Resolve</Link>
          </span>
        ) : null}
      </span>
      <Badge className="ea-row-badge" tone={tone}>{label}</Badge>
    </li>
  );
}

function SheetForm({ id, title, kicker, submitLabel, busy, error, onClose, onSubmit, children, help }: {
  id: string;
  title: string;
  kicker: string;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  children: ReactNode;
  help?: string;
}) {
  return (
    <DetailsSheet
      footer={<>
        <button aria-busy={busy || undefined} className="btn" disabled={busy} form={id} type="submit">{submitLabel}</button>
        <button className="btn btn-ghost" onClick={onClose} type="button">Cancel</button>
        {help ? <p className="bl-help">{help}</p> : null}
      </>}
      kicker={kicker}
      onClose={onClose}
      title={title}
    >
      <form className="ir-form ea-form" id={id} onSubmit={onSubmit}>
        {children}
        {error ? <p className="ir-error" role="alert">{error}</p> : null}
      </form>
    </DetailsSheet>
  );
}

function useSave<A extends unknown[]>(save: (...args: A) => Promise<string | null>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(...args: A) {
    setError(null);
    setBusy(true);
    try {
      const failed = await save(...args);
      if (failed) setError(failed);
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, setError, run };
}

function RecordSheet({ account, kind, now, onSave, onClose }: {
  account: ReadinessAccount;
  kind: Extract<LifecycleKind, "validated" | "credential-rotated">;
  now: string;
  onSave: (occurredAt: string, note: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const today = now.slice(0, 10);
  const [day, setDay] = useState<DayRange | null>({ from: today, to: today });
  const [time, setTime] = useState(now.slice(11, 16));
  const [note, setNote] = useState("");
  const { busy, error, setError, run } = useSave(onSave);
  const test = kind === "validated";

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!day) { setError("Pick the day."); return; }
    const at = utcInstant(day.from, time);
    if (!at) { setError("Write the time as hours and minutes, such as 09:30."); return; }
    if (Date.parse(at) > Date.parse(now) + 5 * 60_000) { setError("The time must be in the past."); return; }
    void run(at, note.trim());
  }

  return (
    <SheetForm
      busy={busy}
      error={error}
      help={test ? "KEEL only records it; it does not sign in." : "KEEL only records it; it does not change the credential."}
      id="ea-record"
      kicker={accountName(account)}
      onClose={onClose}
      onSubmit={submit}
      submitLabel={test ? "Save test sign-in" : "Save credential change"}
      title={test ? "Record a test sign-in" : "Record a credential change"}
    >
      <p className="ir-effect">{test
        ? `Someone signed in with this account to prove it works. The next test is due ${account.validationIntervalDays} days after it.`
        : "Someone changed this account's password or security key outside KEEL."}</p>
      <fieldset disabled={busy}>
        <legend>When</legend>
        <div className="ir-when">
          <DatePicker label="Day" mode="single" onChange={setDay} today={today} value={day} />
          <label className="filter-field ir-time">
            <span>Time (24-hour)</span>
            <span className="ir-time-box">
              <input autoComplete="off" inputMode="numeric" maxLength={5} onChange={(event) => setTime(event.target.value)} placeholder="09:30" value={time} />
              <span aria-hidden="true">UTC</span>
            </span>
          </label>
        </div>
      </fieldset>
      <label className="filter-field">
        <span>Note (optional)</span>
        <textarea disabled={busy} maxLength={500} name="note" onChange={(event) => setNote(event.target.value)} placeholder={test ? "For example: quarterly test with the service desk" : "For example: new security key issued"} rows={2} value={note} />
      </label>
    </SheetForm>
  );
}

const METHOD_CHOICES: { value: string; label: string; strong: boolean }[] = [
  { value: "fido2", label: "Security key or passkey", strong: true },
  { value: "windowsHelloForBusiness", label: "Windows Hello", strong: true },
  { value: "x509Certificate", label: "Certificate", strong: true },
  { value: "platformCredential", label: "Device-bound platform key", strong: true },
  { value: "password", label: "Password", strong: false },
  { value: "microsoftAuthenticator", label: "Authenticator app", strong: false },
  { value: "softwareOath", label: "One-time code app", strong: false },
  { value: "phone", label: "Phone", strong: false },
  { value: "email", label: "Email code", strong: false },
  { value: "temporaryAccessPass", label: "Temporary access pass", strong: false },
];

function MethodsSheet({ account, onSave, onClose }: {
  account: ReadinessAccount;
  onSave: (methods: string[]) => Promise<string | null>;
  onClose: () => void;
}) {
  const [methods, setMethods] = useState<string[]>(account.methodEvidence?.methods.filter((method) => method in METHOD_WORDS) ?? []);
  const { busy, error, setError, run } = useSave(onSave);
  const toggle = (value: string) => setMethods((list) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]));
  return (
    <SheetForm
      busy={busy}
      error={error}
      help="KEEL only records what you saw; it does not read or change the account."
      id="ea-methods"
      kicker={accountName(account)}
      onClose={onClose}
      onSubmit={(event) => { event.preventDefault(); if (!methods.length) { setError("Choose at least one sign-in method."); return; } void run(methods); }}
      submitLabel="Save sign-in methods"
      title="Record sign-in methods"
    >
      <p className="ir-effect">Tick every way this account can sign in, as Microsoft Entra shows it. Only the first four resist phishing.</p>
      <fieldset className="ea-methods" disabled={busy}>
        <legend className="visually-hidden">Sign-in methods</legend>
        {METHOD_CHOICES.map((choice) => (
          <label className="ea-method" data-strong={choice.strong || undefined} key={choice.value}>
            <input checked={methods.includes(choice.value)} name="methods" onChange={() => toggle(choice.value)} type="checkbox" value={choice.value} />
            <span>{choice.label}</span>
            {choice.strong ? <small>Resists phishing</small> : null}
          </label>
        ))}
      </fieldset>
    </SheetForm>
  );
}

function EditSheet({ account, onSave, onClose }: {
  account: ReadinessAccount;
  onSave: (validationIntervalDays: number, rotationIntervalDays: number | null) => Promise<string | null>;
  onClose: () => void;
}) {
  const [test, setTest] = useState(String(account.validationIntervalDays));
  const [review, setReview] = useState(account.rotationIntervalDays ? String(account.rotationIntervalDays) : "");
  const { busy, error, setError, run } = useSave(onSave);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const testDays = Number(test);
    if (!Number.isInteger(testDays) || testDays < 1 || testDays > 366) { setError("Test every 1 to 366 days."); return; }
    const reviewDays = review.trim() ? Number(review) : null;
    if (reviewDays !== null && (!Number.isInteger(reviewDays) || reviewDays < 1 || reviewDays > 730)) { setError("Review credentials every 1 to 730 days, or leave it empty."); return; }
    void run(testDays, reviewDays);
  }
  return (
    <SheetForm busy={busy} error={error} id="ea-edit" kicker={accountName(account)} onClose={onClose} onSubmit={submit} submitLabel="Save reminders" title="Edit reminders">
      <p className="ir-effect">KEEL opens an alert when a test sign-in or a credential review is due.</p>
      <label className="filter-field">
        <span>Test sign-in every (days)</span>
        <input disabled={busy} inputMode="numeric" max={366} min={1} name="validation" onChange={(event) => setTest(event.target.value)} type="number" value={test} />
      </label>
      <label className="filter-field">
        <span>Review credentials every (days, optional)</span>
        <input disabled={busy} inputMode="numeric" max={730} min={1} name="rotation" onChange={(event) => setReview(event.target.value)} placeholder="No review" type="number" value={review} />
      </label>
    </SheetForm>
  );
}

function AddSheet({ onSave, onClose }: {
  onSave: (signInName: string, validationIntervalDays: number) => Promise<string | null>;
  onClose: () => void;
}) {
  const [name, setName] = useState("");
  const [test, setTest] = useState("90");
  const { busy, error, setError, run } = useSave(onSave);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!/^[^\s@]+@[^\s@]+$/.test(name.trim())) { setError("Write the account's sign-in name, such as bg1@contoso.onmicrosoft.com."); return; }
    const testDays = Number(test);
    if (!Number.isInteger(testDays) || testDays < 1 || testDays > 366) { setError("Test every 1 to 366 days."); return; }
    void run(name.trim(), testDays);
  }
  return (
    <SheetForm
      busy={busy}
      error={error}
      help="KEEL finds the account in the latest backup of accounts and only records it; nothing changes in Microsoft."
      id="ea-add"
      kicker="Emergency account"
      onClose={onClose}
      onSubmit={submit}
      submitLabel="Add account"
      title="Add an emergency account"
    >
      <p className="ir-effect">Use a cloud-only account that holds Global Administrator and is left out of every sign-in rule. Keep at least two.</p>
      <label className="filter-field">
        <span>Sign-in name</span>
        <input autoCapitalize="off" autoComplete="off" disabled={busy} inputMode="email" name="signInName" onChange={(event) => setName(event.target.value)} placeholder="bg1@contoso.onmicrosoft.com" spellCheck={false} value={name} />
      </label>
      <label className="filter-field">
        <span>Test sign-in every (days)</span>
        <input disabled={busy} inputMode="numeric" max={366} min={1} name="validation" onChange={(event) => setTest(event.target.value)} type="number" value={test} />
      </label>
    </SheetForm>
  );
}
