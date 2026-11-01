"use client";

import { useApprovalWords } from "@/components/approval-mode-context";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Person } from "@/components/ui/person";
import { postAction } from "@/lib/action-client";
import { ago, formatTimestamp } from "@/lib/presentation";
import { HIGH_RISK_INFO, isHighRiskRule, RESTORE_APPROVAL_RULE_INFO, ruleOrder } from "@/lib/restore-approval-rules";
import type { RestoreApprovalsView } from "@/lib/restore-approvals";
import { serviceFor, serviceOrder } from "@/lib/services";
import { toast } from "@/lib/toast";
import type { EngineRef } from "@/lib/sentences";

// Approvals page: whether a restore waits for a person, per service and per kind of
// restore (content restores, turning a Conditional Access policy on, compliance fixes,
// ...). On for every one until someone with `policies` turns it off. Each change is
// written to the audit record, so Activity shows who changed it and when. Three kinds
// are high risk (organization-wide changes, turning Conditional Access on, restores
// into another tenant): they carry a "High risk" badge, turning one off spells out what
// can go wrong and needs a tick that the admin understands, and while one is off a red
// notice at the top of the card says so, with who turned it off and when.

interface Row {
  key: string;
  body: { service: string } | { rule: string };
  name: string;
  detail: string | null;
  icon: IconName;
  approvalRequired: boolean;
  changedAt: string | null;
  changedBy: EngineRef | null;
  offWarning: ReactNode;
  highRisk: boolean;
  acknowledge?: string;
}

export function RestoreApprovalSettingsCard({ settings, canChange, now }: {
  settings: RestoreApprovalsView | null;
  canChange: boolean;
  now: string;
}) {
  const router = useRouter();
  const approvalWords = useApprovalWords();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Off first in each group: those are the ones to look at.
  const offFirst = (a: Row, b: Row) => Number(a.approvalRequired) - Number(b.approvalRequired);
  const services: Row[] = (settings?.services ?? []).map((row) => {
    const service = serviceFor(row.service);
    return {
      key: `service:${row.service}`, body: { service: row.service }, name: service.name, detail: null, icon: service.icon,
      approvalRequired: row.approvalRequired, changedAt: row.changedAt, changedBy: row.changedBy,
      offWarning: <p>Restores in {service.name}, and their high-impact changes, will be made without waiting for approval. Content that is deleted or shared because of them cannot be brought back by Keel. The change is written to the audit record with your name.</p>,
      highRisk: false,
    };
  }).sort((a, b) => offFirst(a, b) || serviceOrder((a.body as { service: string }).service) - serviceOrder((b.body as { service: string }).service));
  const kinds: Row[] = (settings?.rules ?? []).map((row) => {
    const info = RESTORE_APPROVAL_RULE_INFO[row.rule];
    const plain = <p>{info.name} will start without a person approving them when the services they touch have approvals off too. Lockout checks still run first. The change is written to the audit record with your name.</p>;
    const risk = isHighRiskRule(row.rule) ? HIGH_RISK_INFO[row.rule] : null;
    return {
      key: `rule:${row.rule}`, body: { rule: row.rule }, name: info.name, detail: info.detail, icon: info.icon,
      approvalRequired: row.approvalRequired, changedAt: row.changedAt, changedBy: row.changedBy,
      highRisk: risk !== null,
      acknowledge: risk?.acknowledge,
      offWarning: risk ? (
        <div className="ra-risk-warning">
          <p className="ra-risk-lead"><Badge tone="urgent" icon="alert">High risk</Badge> Keel recommends keeping approvals on for this.</p>
          <p>Without approvals, here is what can go wrong:</p>
          <ul>{risk.risks.map((line) => <li key={line}>{line}</li>)}</ul>
          <p>Lockout checks still run first. The change and your confirmation are written to the audit record with your name. You can turn approvals back on at any time.</p>
        </div>
      ) : plain,
    };
  }).sort((a, b) => offFirst(a, b) || ruleOrder((a.body as { rule: string }).rule) - ruleOrder((b.body as { rule: string }).rule));
  const all = [...services, ...kinds];
  const off = all.filter((row) => !row.approvalRequired);
  const riskyOff = kinds.filter((row) => row.highRisk && !row.approvalRequired);

  async function change(row: Row, approvalRequired: boolean) {
    setBusy(row.key);
    setError(null);
    try {
      const confirmed = row.highRisk && !approvalRequired;
      await postAction("/api/restore-approvals", { ...row.body, approvalRequired, ...(confirmed ? { riskAcknowledged: true } : {}) }, crypto.randomUUID());
      toast({
        title: approvalRequired ? `Approvals on for ${row.name}` : `Approvals off for ${row.name}`,
        detail: confirmed ? "The change and your confirmation of the risk are in the audit record." : "The change is in the audit record.",
      });
      router.refresh();
    } catch {
      setError("Keel could not change this setting. Try again, or check that you can manage policies.");
    } finally {
      setBusy(null);
    }
  }

  const list = (rows: Row[], label: string) => (
    <ul aria-label={label} className="ra-list">
      {rows.map((row) => (
        <li className="ra-row" data-high-risk={row.highRisk ? "" : undefined} data-off={row.approvalRequired ? undefined : ""} key={row.key}>
          <span aria-hidden="true" className="ra-service-icon"><Icon name={row.icon} /></span>
          <span className="ra-name">
            <span className="ra-name-line">
              <strong>{row.name}</strong>
              {row.highRisk ? <Badge tone="urgent" icon="alert">High risk</Badge> : null}
            </span>
            {row.detail ? <small>{row.detail}</small> : null}
            {row.changedAt ? (
              <small>
                Changed by <Person person={row.changedBy} />{" "}
                <time dateTime={row.changedAt} title={formatTimestamp(row.changedAt)}>{ago(row.changedAt, now)}</time>
              </small>
            ) : <small>Keel&apos;s default</small>}
          </span>
          {row.approvalRequired
            ? <Badge tone="fine">Approval needed</Badge>
            : <Badge tone="soon">No approval</Badge>}
          {canChange ? (row.approvalRequired ? (
            <ConfirmButton
              acknowledge={row.acknowledge}
              cancelLabel="Keep approvals"
              size="sm"
              confirmLabel="Turn off"
              description={row.offWarning}
              disabled={busy !== null}
              onConfirm={() => change(row, false)}
              title={`Turn off approvals for ${row.name}?`}
              tone="danger"
            >Turn off</ConfirmButton>
          ) : (
            <button aria-busy={busy === row.key || undefined} className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void change(row, true)} type="button">Turn on</button>
          )) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <section aria-labelledby="restore-approvals-heading" className="ra-card" data-off={off.length ? "" : undefined} data-risk={riskyOff.length ? "" : undefined}>
      {riskyOff.length ? (
        <div className="ra-risk" role="status">
          <span aria-hidden="true" className="ra-risk-icon"><Icon name="alert" /></span>
          <div>
            <strong>
              Approvals are off for {riskyOff.length === 1 ? "1 high-risk type" : `${riskyOff.length} high-risk types`} of restore
            </strong>
            <p>These restores now start without anyone checking them first. Keel recommends turning approvals back on unless you are sure.</p>
            <ul>
              {riskyOff.map((row) => (
                <li key={row.key}>
                  <strong>{row.name}</strong>
                  {row.changedAt ? (
                    <>
                      {": turned off by "}<Person person={row.changedBy} />{" "}
                      <time dateTime={row.changedAt} title={formatTimestamp(row.changedAt)}>{ago(row.changedAt, now)}</time>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
      <div className="ra-card-head">
        <span aria-hidden="true" className="ra-card-icon"><Icon name={off.length ? "alert" : "check-circle"} /></span>
        <div>
          <h2 id="restore-approvals-heading">
            Restore approvals
            {settings === null
              ? <Badge tone="soon">Could not check</Badge>
              : off.length
                ? <Badge tone={riskyOff.length ? "urgent" : "soon"}>Off for {off.length} of {all.length}</Badge>
                : <Badge tone="fine">On for everything</Badge>}
          </h2>
          <p>
            With approvals on, {approvalWords.approver} approves a restore before it starts. Some restores also shorten how long
            content is kept, release a hold, widen sharing, delete content, run scripts on devices or shorten group
            lifetimes; with approvals off, Keel makes these with the restore and still lists them in the plan. A restore
            starts without waiting only when every service and every type of restore it touches has approvals off.
          </p>
          <p>
            Lockout checks always run, Keel never writes sign-in trust or certificate settings, and a two-person rule you
            set up still applies, unless the approval mode on Approvals is Solo.
          </p>
        </div>
      </div>
      {settings !== null ? (
        <>
          <h3 className="ra-group">By service</h3>
          {list(services, "Restore approvals by service")}
          <h3 className="ra-group">By type of restore</h3>
          {list(kinds, "Restore approvals by type of restore")}
        </>
      ) : null}
      {error ? <p className="ra-error" role="alert">{error}</p> : null}
    </section>
  );
}
