"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { formatTimestamp } from "@/lib/presentation";
import type { ApprovalRequestRecord } from "@/lib/approval-inbox";

function displayParams(params: unknown): string {
  return JSON.stringify(params, null, 2) ?? "{}";
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function ApprovalInbox({
  pending,
  history,
}: {
  pending: ApprovalRequestRecord[];
  history: ApprovalRequestRecord[];
}) {
  const router = useRouter();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(request: ApprovalRequestRecord, decision: "approve" | "reject") {
    const reason = reasons[request.id]?.trim() ?? "";
    if (decision === "reject" && reason.length === 0) {
      setError("A rejection reason is required and remains visible to the requester.");
      return;
    }

    setSubmittingId(request.id);
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
      router.refresh();
    } catch {
      setError("The approval decision could not be completed. Refresh the inbox before retrying.");
    } finally {
      setSubmittingId(null);
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
            <p className="section-kicker">Action required</p>
            <h2 id="pending-approvals-heading">Pending approvals</h2>
          </div>
          <span className="result-count">
            {pending.length} {pending.length === 1 ? "request" : "requests"}
          </span>
        </div>

        {pending.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Action and parameters</th>
                  <th scope="col">Requested by</th>
                  <th scope="col">Justification</th>
                  <th scope="col">Expires</th>
                  <th scope="col">Decision</th>
                </tr>
              </thead>
              <tbody>
                {pending.map((request) => {
                  const submitting = submittingId === request.id;
                  return (
                    <tr key={request.id}>
                      <th data-label="Action and parameters" scope="row">
                        <code className="natural-key">{request.action}</code>
                        <pre>{displayParams(request.params)}</pre>
                      </th>
                      <td className="wrap-value" data-label="Requested by">
                        {request.requestedBy}
                      </td>
                      <td className="wrap-value" data-label="Justification">
                        {request.justification ?? "—"}
                      </td>
                      <td data-label="Expires">
                        <time dateTime={request.expiresAt ?? undefined}>
                          {formatTimestamp(request.expiresAt)}
                        </time>
                      </td>
                      <td data-label="Decision">
                        <div className="decision-controls">
                          <button
                            aria-busy={submitting || undefined}
                            className="btn btn-primary"
                            disabled={submitting}
                            onClick={() => decide(request, "approve")}
                            type="button"
                          >
                            Approve
                          </button>
                          <label className="filter-field">
                            <span>Rejection reason</span>
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
                            className="btn btn-danger"
                            disabled={submitting}
                            onClick={() => decide(request, "reject")}
                            type="button"
                          >
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">No approval requests are pending.</p>
        )}
      </section>

      <section aria-labelledby="approval-history-heading" className="report-section">
        <div className="section-heading-row report-heading">
          <div>
            <p className="section-kicker">Closed requests</p>
            <h2 id="approval-history-heading">Decision history</h2>
          </div>
          <span className="result-count">
            {history.length} {history.length === 1 ? "request" : "requests"}
          </span>
        </div>

        {history.length ? (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Action and parameters</th>
                  <th scope="col">Status</th>
                  <th scope="col">Requested by</th>
                  <th scope="col">Decided by</th>
                  <th scope="col">Reason</th>
                  <th scope="col">Decided</th>
                </tr>
              </thead>
              <tbody>
                {history.map((request) => (
                  <tr key={request.id}>
                    <th data-label="Action and parameters" scope="row">
                      <code className="natural-key">{request.action}</code>
                      <pre>{displayParams(request.params)}</pre>
                    </th>
                    <td data-label="Status">{statusLabel(request.status)}</td>
                    <td className="wrap-value" data-label="Requested by">
                      {request.requestedBy}
                    </td>
                    <td className="wrap-value" data-label="Decided by">
                      {request.decidedBy ?? "—"}
                    </td>
                    <td className="wrap-value" data-label="Reason">
                      {request.reason ?? "—"}
                    </td>
                    <td data-label="Decided">
                      <time dateTime={request.decidedAt ?? undefined}>
                        {formatTimestamp(request.decidedAt)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">No approval requests have been decided or expired.</p>
        )}
      </section>
    </>
  );
}
