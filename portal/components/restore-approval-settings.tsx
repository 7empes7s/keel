"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Icon } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Person } from "@/components/ui/person";
import { postAction } from "@/lib/action-client";
import { ago, formatTimestamp } from "@/lib/presentation";
import type { RestoreApprovalSetting } from "@/lib/restore-approvals";
import { serviceFor, serviceOrder } from "@/lib/services";
import { toast } from "@/lib/toast";

// Approvals page: whether a high-impact restore change waits for a second person, per
// service. On for every service until someone with `policies` turns it off. Each change
// is written to the audit record, so Activity shows who changed it and when.
export function RestoreApprovalSettingsCard({ settings, canChange, now }: {
  settings: RestoreApprovalSetting[] | null;
  canChange: boolean;
  now: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Services with approvals off first: they are the ones to look at.
  const rows = [...(settings ?? [])].sort((a, b) => Number(a.approvalRequired) - Number(b.approvalRequired) || serviceOrder(a.service) - serviceOrder(b.service));
  const off = rows.filter((row) => !row.approvalRequired);

  async function change(service: string, approvalRequired: boolean) {
    setBusy(service);
    setError(null);
    try {
      await postAction("/api/restore-approvals", { service, approvalRequired }, crypto.randomUUID());
      toast({
        title: approvalRequired ? `Approvals on for ${serviceFor(service).name}` : `Approvals off for ${serviceFor(service).name}`,
        detail: "The change is in the audit record.",
      });
      router.refresh();
    } catch {
      setError("Keel could not change this setting. Try again, or check that you can manage policies.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="restore-approvals-heading" className="ra-card" data-off={off.length ? "" : undefined}>
      <div className="ra-card-head">
        <span aria-hidden="true" className="ra-card-icon"><Icon name={off.length ? "alert" : "check-circle"} /></span>
        <div>
          <h2 id="restore-approvals-heading">
            Restore approvals
            {settings === null
              ? <Badge tone="soon">Could not check</Badge>
              : off.length
                ? <Badge tone="soon">Off for {off.length} of {rows.length}</Badge>
                : <Badge tone="fine">On for every service</Badge>}
          </h2>
          <p>
            Some restores do more than change a setting: they shorten how long content is kept, release a hold, widen
            sharing, delete content, run scripts on devices or shorten group lifetimes. With approvals on, a second person
            approves these first. With approvals off, Keel makes them with the restore and still lists them in the plan.
            Lockout checks stay on either way.
          </p>
        </div>
      </div>
      {settings !== null ? (
        <ul className="ra-list">
          {rows.map((row) => {
            const service = serviceFor(row.service);
            return (
              <li className="ra-row" data-off={row.approvalRequired ? undefined : ""} key={row.service}>
                <span aria-hidden="true" className="ra-service-icon"><Icon name={service.icon} /></span>
                <span className="ra-name">
                  <strong>{service.name}</strong>
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
                    cancelLabel="Keep approvals"
                    size="sm"
                    confirmLabel="Turn off"
                    description={<p>High-impact restore changes in {service.name} will be made without a second person approving them. Content that is deleted or shared because of them cannot be brought back by Keel. The change is written to the audit record with your name.</p>}
                    disabled={busy !== null}
                    onConfirm={() => change(row.service, false)}
                    title={`Turn off approvals for ${service.name}?`}
                    tone="danger"
                  >Turn off</ConfirmButton>
                ) : (
                  <button aria-busy={busy === row.service || undefined} className="btn btn-sm btn-primary" disabled={busy !== null} onClick={() => void change(row.service, true)} type="button">Turn on</button>
                )) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {error ? <p className="ra-error" role="alert">{error}</p> : null}
    </section>
  );
}
