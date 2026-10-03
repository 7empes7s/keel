"use client";

import { useEffect, useState } from "react";

import { formatTimestamp, words } from "@/lib/presentation";
import { toast } from "@/lib/toast";

// Roadmap task-65: what a restore could not write back (secrets, certificates,
// consent, a new id's downstream integrations) and the service check after it.
// Each item closes only with a REFERENCE to evidence held elsewhere — the form
// never asks for, and the API refuses, the credential itself.
export type CompletionState = "configuration-restored" | "service-validation-pending" | "verified-complete";

export interface CompletionItem {
  id: string;
  kind: "credential" | "certificate" | "consent" | "integration" | "service-validation";
  requirement: string;
  description: string;
  owner: string | null;
  state: "pending" | "verified";
  evidence: { type: string; reference: string; recordedBy?: string; recordedAt?: string }[];
  closedAt: string | null;
  reopenCount: number;
}

export interface CompletionResource {
  naturalKey: string;
  resourceType: string;
  mechanism: string;
  state: CompletionState;
  items: CompletionItem[];
}

const STATE_LABELS: Record<CompletionState, string> = {
  "configuration-restored": "Configuration restored",
  "service-validation-pending": "Service validation pending",
  "verified-complete": "Verified complete",
};

export function completionStateLabel(state: CompletionState): string {
  return STATE_LABELS[state] ?? state;
}

interface ChecklistProps {
  resources: CompletionResource[];
  canComplete: boolean;
  busyItem?: string | null;
  onComplete?: (item: CompletionItem, reference: string, type: string) => void;
  onReopen?: (item: CompletionItem) => void;
}

export function CompletionChecklist({ resources, canComplete, busyItem = null, onComplete, onReopen }: ChecklistProps) {
  if (resources.length === 0) {
    return <p className="muted-value">This restore left no follow-up work: every recovered object was fully restored by configuration.</p>;
  }
  return (
    <div className="completion-list">
      {resources.map((resource) => (
        <section className={`completion-resource completion-${resource.state}`} key={resource.naturalKey}>
          <header className="completion-resource-head">
            <code className="natural-key">{resource.naturalKey}</code>
            <span className={`claim-badge completion-badge-${resource.state}`}>{completionStateLabel(resource.state)}</span>
            <small>{words(resource.mechanism)}</small>
          </header>
          <ul className="completion-items">
            {resource.items.map((item) => (
              <li className={`completion-item completion-item-${item.state}`} key={item.id}>
                <div>
                  <strong>{words(item.kind)}</strong> · {item.description}
                  {item.state === "verified" && item.evidence.length ? (
                    <small className="completion-evidence">
                      Evidence: {item.evidence[item.evidence.length - 1].type} {item.evidence[item.evidence.length - 1].reference}
                      {item.closedAt ? ` · ${formatTimestamp(item.closedAt)}` : null}
                    </small>
                  ) : null}
                </div>
                {canComplete ? (
                  item.state === "pending" ? (
                    <form
                      className="completion-form"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        onComplete?.(item, String(data.get("reference") ?? ""), String(data.get("type") ?? "ticket"));
                      }}
                    >
                      <label className="visually-hidden" htmlFor={`type-${item.id}`}>Evidence type</label>
                      <select defaultValue="ticket" id={`type-${item.id}`} name="type">
                        <option value="ticket">Ticket</option>
                        <option value="link">Link</option>
                        <option value="log-reference">Log reference</option>
                        <option value="attestation">Attestation</option>
                      </select>
                      <label className="visually-hidden" htmlFor={`reference-${item.id}`}>Evidence reference</label>
                      <input
                        autoComplete="off"
                        id={`reference-${item.id}`}
                        name="reference"
                        placeholder="Ticket or link — never the secret"
                        required
                      />
                      <button aria-busy={busyItem === item.id || undefined} className="btn btn-secondary btn-sm" disabled={busyItem !== null} type="submit">
                        Mark verified
                      </button>
                    </form>
                  ) : (
                    <button
                      aria-busy={busyItem === item.id || undefined}
                      className="btn btn-ghost btn-sm"
                      disabled={busyItem !== null}
                      onClick={() => onReopen?.(item)}
                      type="button"
                    >
                      Reopen
                    </button>
                  )
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function RecoveryCompletion({ restoreRef, canComplete }: { restoreRef: string; canComplete: boolean }) {
  const [resources, setResources] = useState<CompletionResource[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busyItem, setBusyItem] = useState<string | null>(null);

  async function load() {
    try {
      const response = await fetch(`/api/actions/restore/completion/${encodeURIComponent(restoreRef)}`, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      setResources(((await response.json()) as { resources: CompletionResource[] }).resources);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreRef]);

  async function submit(item: CompletionItem, body: Record<string, unknown>, success: string) {
    setBusyItem(item.id);
    try {
      const response = await fetch("/api/actions/restore/completion", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `${item.id}:${body.action}:${Date.now()}` },
        body: JSON.stringify({ itemId: item.id, ...body }),
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        toast({
          tone: "warning",
          title: "Not saved",
          detail: payload.message ?? (response.status === 403 ? "You no longer hold the restore capability" : "The change was not saved"),
        });
        return;
      }
      toast({ title: success });
      await load();
    } finally {
      setBusyItem(null);
    }
  }

  return (
    <section aria-labelledby="completion-heading" className="panel completion-panel">
      <div className="section-head">
        <p className="section-kicker">Recovery completion</p>
        <h2 id="completion-heading">Follow-up the restore could not do</h2>
      </div>
      {failed ? (
        <p className="data-error" role="alert">Completion items are unavailable right now.</p>
      ) : resources === null ? (
        <p className="muted-value">Loading completion items…</p>
      ) : (
        <CompletionChecklist
          busyItem={busyItem}
          canComplete={canComplete}
          onComplete={(item, reference, type) => void submit(item, { action: "complete", evidence: { type, reference } }, "Item verified")}
          onReopen={(item) => {
            const reason = window.prompt("Why is this item being reopened?");
            if (reason) void submit(item, { action: "reopen", reason }, "Item reopened");
          }}
          resources={resources}
        />
      )}
    </section>
  );
}
