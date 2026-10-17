"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { ago, displayEnum, formatTimestamp, fromNow } from "@/lib/presentation";
import { approvalImpact, approvalSentence, personLabel } from "@/lib/sentences";
import { toast } from "@/lib/toast";
import { usePoll } from "@/lib/use-poll";
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

/** Where a request leads back to what it concerns, such as the restore run, even once decided. */
function SubjectLink({ request }: { request: ApprovalRequestRecord }) {
  const link = subjectLink(request);
  return link ? <a className="text-link" href={link.href}>{link.label}</a> : null;
}

/**
 * Q45: a restore whose dry run carries content effects needs a separate approval of
 * them, whether the dry run was made in the portal or with the command line.
 */
export function contentEffectsLink(request: ApprovalRequestRecord): { href: string; label: string; count: number } | null {
  const plan = request.references?.plan;
  if (request.action !== "restore" || !plan?.readable || !plan.contentEffects) return null;
  return {
    href: `/approvals/content-effects/${encodeURIComponent(plan.id)}`,
    label: "Review content effects",
    count: plan.contentEffects,
  };
}

export function ContentEffectsNote({ request }: { request: ApprovalRequestRecord }) {
  const link = contentEffectsLink(request);
  if (!link) return null;
  return (
    <div className="approval-content-effects">
      <p>
        {link.count === 1
          ? "1 change in this restore affects content. It needs its own approval"
          : `${link.count} changes in this restore affect content. They need their own approval`}
        {" "}by someone other than the requester, or the restore is refused.
      </p>
      <a className="text-link" href={link.href}>{link.label}</a>
    </div>
  );
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

/**
 * An approved restore that cannot run yet: its content effects still need their own
 * approval. It waits for a decision like any request, with the way to make it.
 */
function AwaitingContentEffectsCard({ request, now, className }: { request: ApprovalRequestRecord; now: string; className: string }) {
  return (
    <li className={className}>
      <h3>{approvalSentence(request)}</h3>
      <p>
        Approved by {personLabel(request.references?.people.decided_by)}{" "}
        <time dateTime={request.decidedAt ?? undefined} title={formatTimestamp(request.decidedAt)}>{ago(request.decidedAt, now)}</time>.
        {" "}Asked by {personLabel(request.references?.people.requested_by)}.
        {" "}The restore cannot run until its content effects are approved too.
      </p>
      <SubjectLink request={request} />
      <ContentEffectsNote request={request} />
      <RequestRecord request={request} />
    </li>
  );
}

export function ApprovalInbox({
  pending,
  awaitingContentEffects = [],
  history,
  now = new Date().toISOString(),
}: {
  pending: ApprovalRequestRecord[];
  awaitingContentEffects?: ApprovalRequestRecord[];
  history: ApprovalRequestRecord[];
  now?: string;
}) {
  const waiting = pending.length + awaitingContentEffects.length;
  const router = useRouter();
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which button was pressed, so only that one shows the busy spinner; both stay
  // disabled while either decision for the request is in flight.
  const [submittingDecision, setSubmittingDecision] = useState<"approve" | "reject" | null>(null);

  // New requests appear without a reload: the page re-reads quietly, and a request that
  // was not on screen before is marked so it fades in.
  usePoll(() => router.refresh(), 5_000);
  const known = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    const ids = [...pending, ...awaitingContentEffects].map((request) => request.id);
    const seen = known.current;
    if (seen) {
      const added = ids.filter((id) => !seen.has(id));
      if (added.length) setFresh(new Set(added));
    }
    known.current = new Set(ids);
  }, [pending, awaitingContentEffects]);
  const cardClass = (base: string, id: string) => (fresh.has(id) ? `${base} approval-new` : base);

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
            {waiting} {waiting === 1 ? "request" : "requests"}
          </span>
        </div>

        {waiting ? (
          <ul className="item-list approval-list">
            {[...pending.map((request) => {
              const submitting = submittingId === request.id;
              const impact = approvalImpact(request);
              const link = subjectLink(request);
              return (
                <li className={cardClass("item-card approval-card", request.id)} key={request.id}>
                  <h3>{approvalSentence(request)}</h3>
                  <p>
                    Asked by {personLabel(request.references?.people.requested_by)}{" "}
                    <time dateTime={request.createdAt ?? undefined} title={formatTimestamp(request.createdAt)}>{ago(request.createdAt, now)}</time>
                    {request.justification ? <>: “{request.justification}”</> : "."}
                  </p>
                  {impact ? <p className="approval-impact">Impact: {impact.toLowerCase()}.</p> : null}
                  {request.executor === "cli" ? (
                    <p>This dry run was planned from the command line. Approving it starts nothing here: an operator runs it from the command line.</p>
                  ) : null}
                  <p>
                    Expires <time dateTime={request.expiresAt ?? undefined} title={formatTimestamp(request.expiresAt)}>{fromNow(request.expiresAt, now)}</time>. Nothing changes until someone other than the requester approves.
                  </p>
                  {link ? <a className="text-link" href={link.href}>{link.label}</a> : null}
                  <ContentEffectsNote request={request} />
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
            }), ...awaitingContentEffects.map((request) => (
              <AwaitingContentEffectsCard className={cardClass("item-card approval-card approval-content-effects-pending", request.id)} key={request.id} now={now} request={request} />
            ))]}
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
                    : <>{displayEnum("approvalStatus", request.status)} by {personLabel(request.references?.people.decided_by)}{" "}
                      <time dateTime={request.decidedAt ?? undefined} title={formatTimestamp(request.decidedAt)}>{ago(request.decidedAt, now)}</time>
                      {request.reason ? <>: “{request.reason}”</> : "."}</>}
                  {" "}Asked by {personLabel(request.references?.people.requested_by)}.
                </p>
                {request.action === "restore" ? <SubjectLink request={request} /> : null}
                {request.status === "approved" ? <ContentEffectsNote request={request} /> : null}
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
