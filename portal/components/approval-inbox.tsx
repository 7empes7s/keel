"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ago, displayEnum, formatTimestamp, fromNow } from "@/lib/presentation";
import { approvalImpact, approvalSentence, refLabel } from "@/lib/sentences";
import { toast } from "@/lib/toast";
import type { ApprovalRequestRecord } from "@/lib/approval-inbox";

function displayParams(params: unknown): string {
  return JSON.stringify(params, null, 2) ?? "{}";
}

/** Where a reviewer checks what the request would change, by name. */
function subjectLink(request: ApprovalRequestRecord): { href: string; label: string } | null {
  const refs = request.references;
  if (refs?.plan?.readable && refs.plan.dryRunJobId) return { href: `/jobs/${refs.plan.dryRunJobId}`, label: "Review the dry run" };
  if (refs?.baseline?.readable) return { href: "/baselines", label: `View baseline “${refs.baseline.name ?? "unnamed"}”` };
  if (refs?.changes?.length) return { href: "/drift", label: "Review the changes" };
  return null;
}

function RequestRecord({ request }: { request: ApprovalRequestRecord }) {
  return (
    <TechnicalDetails>
      <RecordField label="Request ID" usage={<>use with <code>POST /api/approvals/&lt;id&gt;/approve</code></>} value={request.id} />
      <RecordField copy={false} label="Action code" value={`${request.action} · status ${request.status}`} />
      <RecordField copy={false} label="Params" value={displayParams(request.params)} />
      <RecordField label="Requested by (principal ID)" value={request.requestedBy} />
      {request.decidedBy ? <RecordField label="Decided by (principal ID)" value={request.decidedBy} /> : null}
      {request.references?.plan ? <RecordField label="Dry run ID" usage={request.references.plan.readable ? "the immutable plan this approval promotes" : "no longer readable"} value={request.references.plan.id} /> : null}
      <RecordField copy={false} label="Times" value={`created ${request.createdAt ?? "unknown"} · expires ${request.expiresAt ?? "unknown"}${request.decidedAt ? ` · decided ${request.decidedAt}` : ""}`} />
    </TechnicalDetails>
  );
}

export function ApprovalInbox({
  pending,
  history,
  now = new Date().toISOString(),
}: {
  pending: ApprovalRequestRecord[];
  history: ApprovalRequestRecord[];
  now?: string;
}) {
  const router = useRouter();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which button was pressed, so only that one shows the busy spinner; both stay
  // disabled while either decision for the request is in flight.
  const [submittingDecision, setSubmittingDecision] = useState<"approve" | "reject" | null>(null);

  async function decide(request: ApprovalRequestRecord, decision: "approve" | "reject") {
    const reason = reasons[request.id]?.trim() ?? "";
    if (decision === "reject" && reason.length === 0) {
      setError("A rejection reason is required and remains visible to the requester.");
      return;
    }

    setSubmittingId(request.id);
    setSubmittingDecision(decision);
    setError(null);
    try {
      const response = await fetch(
        `/api/approvals/${encodeURIComponent(request.id)}/${decision}`,
        {
          method: "POST",
          headers: decision === "reject" ? { "content-type": "application/json" } : undefined,
          body: decision === "reject" ? JSON.stringify({ reason }) : undefined,
        },
      );
      if (!response.ok) {
        throw new Error(`approval decision failed (${response.status})`);
      }
      toast({ tone: decision === "approve" ? "success" : "info", title: decision === "approve" ? "Request approved" : "Request rejected", detail: approvalSentence(request) });
      router.refresh();
    } catch {
      setError("The approval decision could not be completed. Refresh the inbox before retrying.");
    } finally {
      setSubmittingId(null);
      setSubmittingDecision(null);
    }
  }

  return (
    <>
      {error ? (
        <p className="data-error" role="alert">
          {error}
        </p>
      ) : null}

      <section aria-labelledby="pending-approvals-heading" className="report-section">
        <div className="section-heading-row report-heading">
          <div>
            <h2 id="pending-approvals-heading">Waiting for a decision</h2>
          </div>
          <span className="result-count">
            {pending.length} {pending.length === 1 ? "request" : "requests"}
          </span>
        </div>

        {pending.length ? (
          <ul className="item-list approval-list">
            {pending.map((request) => {
              const submitting = submittingId === request.id;
              const impact = approvalImpact(request);
              const link = subjectLink(request);
              return (
                <li className="item-card approval-card" key={request.id}>
                  <h3>{approvalSentence(request)}</h3>
                  <p>
                    Asked by {refLabel(request.references?.people.requested_by, "an unknown person")}{" "}
                    <time dateTime={request.createdAt ?? undefined} title={formatTimestamp(request.createdAt)}>{ago(request.createdAt, now)}</time>
                    {request.justification ? <>: “{request.justification}”</> : "."}
                  </p>
                  {impact ? <p className="approval-impact">Impact: {impact.toLowerCase()}.</p> : null}
                  <p>
                    Expires <time dateTime={request.expiresAt ?? undefined} title={formatTimestamp(request.expiresAt)}>{fromNow(request.expiresAt, now)}</time>. Nothing changes until someone other than the requester approves.
                  </p>
                  {link ? <a className="text-link" href={link.href}>{link.label}</a> : null}
                  <div className="decision-controls">
                    <button
                      aria-busy={(submitting && submittingDecision === "approve") || undefined}
                      className="btn btn-primary"
                      disabled={submitting}
                      onClick={() => decide(request, "approve")}
                      type="button"
                    >
                      Approve
                    </button>
                    <label className="filter-field">
                      <span>Why reject (shown to the requester)</span>
                      <input
                        disabled={submitting}
                        onChange={(event) =>
                          setReasons((current) => ({
                            ...current,
                            [request.id]: event.target.value,
                          }))
                        }
                        value={reasons[request.id] ?? ""}
                      />
                    </label>
                    <button
                      aria-busy={(submitting && submittingDecision === "reject") || undefined}
                      className="btn btn-danger"
                      disabled={submitting}
                      onClick={() => decide(request, "reject")}
                      type="button"
                    >
                      Reject
                    </button>
                  </div>
                  <RequestRecord request={request} />
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="empty-state">Nothing is waiting for a decision.</p>
        )}
      </section>

      <section aria-labelledby="approval-history-heading" className="report-section">
        <div className="section-heading-row report-heading">
          <div>
            <h2 id="approval-history-heading">Decided and expired</h2>
          </div>
          <span className="result-count">
            {history.length} {history.length === 1 ? "request" : "requests"}
          </span>
        </div>

        {history.length ? (
          <ul className="item-list approval-history">
            {history.map((request) => (
              <li className={`item-card approval-card approval-${request.status}`} key={request.id}>
                <h3>{approvalSentence(request)}</h3>
                <p>
                  {request.status === "expired"
                    ? <>Expired <time dateTime={request.expiresAt ?? undefined} title={formatTimestamp(request.expiresAt)}>{ago(request.expiresAt, now)}</time> without a decision.</>
                    : <>{displayEnum("approvalStatus", request.status)} by {refLabel(request.references?.people.decided_by, "an unknown person")}{" "}
                      <time dateTime={request.decidedAt ?? undefined} title={formatTimestamp(request.decidedAt)}>{ago(request.decidedAt, now)}</time>
                      {request.reason ? <>: “{request.reason}”</> : "."}</>}
                  {" "}Asked by {refLabel(request.references?.people.requested_by, "an unknown person")}.
                </p>
                <RequestRecord request={request} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">No request has been decided or has expired yet.</p>
        )}
      </section>
    </>
  );
}
