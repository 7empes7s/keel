"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Person } from "@/components/ui/person";
import { postAction } from "@/lib/action-client";
import type { ApprovalMode, ApprovalModeView } from "@/lib/approval-mode";
import { ago, formatTimestamp } from "@/lib/presentation";
import { toast } from "@/lib/toast";

// Approvals page: who may approve a change. Two-person (Keel's default): a second
// person approves, never the one who asked. Solo: the person who asked may approve it
// themselves, for a business with one admin; each such approval is marked
// "Self-approved" here and in Activity. Switching to solo needs the risk ticked.

const MODES: { mode: ApprovalMode; name: string; icon: IconName; line: string }[] = [
  { mode: "two-person", name: "Two people", icon: "person", line: "Someone other than the person who asked approves restores, undos, accepted changes and emergency changes." },
  { mode: "solo", name: "Solo", icon: "check-circle", line: "The person who asked may approve it themselves. For a business with one admin. Each one is marked “Self-approved”." },
];

export function ApprovalModeCard({ setting, canChange, now }: { setting: ApprovalModeView | null; canChange: boolean; now: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = setting?.mode ?? null;

  async function change(mode: ApprovalMode) {
    setBusy(true);
    setError(null);
    try {
      await postAction("/api/approval-mode", { mode, ...(mode === "solo" ? { riskAcknowledged: true } : {}) }, crypto.randomUUID());
      toast({
        title: mode === "solo" ? "Approval mode is now Solo" : "Approval mode is now Two people",
        detail: mode === "solo" ? "You can approve your own requests. The change and your confirmation are in the audit record." : "Every request now needs someone other than the person who asked. The change is in the audit record.",
      });
      router.refresh();
    } catch {
      setError("Keel could not change the approval mode. Try again, or check that you can manage policies.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="approval-mode-heading" className="ra-card am-card" data-mode={current ?? undefined}>
      <div className="ra-card-head">
        <span aria-hidden="true" className="ra-card-icon am-icon"><Icon name={current === "solo" ? "person" : "check-circle"} /></span>
        <div>
          <h2 id="approval-mode-heading">
            Approval mode
            {current === null
              ? <Badge tone="soon">Could not check</Badge>
              : current === "solo"
                ? <Badge icon="person" tone="soon">Solo: you can approve your own</Badge>
                : <Badge tone="fine">Two people</Badge>}
          </h2>
          <p>
            Who approves a restore, an undo, an accepted change, an emergency change or switching back to an older approved setup.
            The same rule applies to all of them.
          </p>
          {setting?.changedAt ? (
            <p className="am-changed">
              Changed by <Person person={setting.changedBy} />{" "}
              <time dateTime={setting.changedAt} title={formatTimestamp(setting.changedAt)}>{ago(setting.changedAt, now)}</time>
            </p>
          ) : setting ? <p className="am-changed">Keel&apos;s default</p> : null}
        </div>
      </div>
      {setting ? (
        <ul aria-label="Approval modes" className="am-options">
          {MODES.map((option) => {
            const inUse = option.mode === current;
            return (
              <li className="am-option" data-current={inUse ? "" : undefined} key={option.mode}>
                <span aria-hidden="true" className="ra-service-icon"><Icon name={option.icon} /></span>
                <span className="ra-name">
                  <span className="ra-name-line"><strong>{option.name}</strong>{inUse ? <Badge tone={option.mode === "solo" ? "soon" : "fine"}>In use</Badge> : null}</span>
                  <small>{option.line}</small>
                </span>
                {canChange && !inUse ? (option.mode === "solo" ? (
                  <ConfirmButton
                    acknowledge="I understand that one person can now approve their own changes."
                    cancelLabel="Keep two people"
                    confirmLabel="Switch to Solo"
                    description={(
                      <div className="ra-risk-warning">
                        <p className="ra-risk-lead"><Badge tone="urgent" icon="alert">Less checking</Badge> Use this only when one admin runs Keel.</p>
                        <p>With Solo approval:</p>
                        <ul>
                          <li>The person who asks for a restore, an undo or an emergency change can approve it straight away.</li>
                          <li>A mistake or a stolen account is not caught by a second person.</li>
                        </ul>
                        <p>Each self-approval is marked “Self-approved” on Approvals and in Activity. Lockout checks still run, and a rule that needs two approvers for a kind of change still needs two. The switch and your confirmation are written to the audit record. You can switch back at any time.</p>
                      </div>
                    )}
                    disabled={busy}
                    onConfirm={() => change("solo")}
                    size="sm"
                    title="Switch to Solo approval?"
                    tone="danger"
                  >Switch to Solo</ConfirmButton>
                ) : (
                  <button aria-busy={busy || undefined} className="btn btn-sm btn-primary" disabled={busy} onClick={() => void change("two-person")} type="button">Switch to two people</button>
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
