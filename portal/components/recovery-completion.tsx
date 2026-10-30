"use client";

import { useEffect, useState } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { namedResource } from "@/lib/job-names";
import { formatTimestamp, words } from "@/lib/presentation";
import { refused, toast } from "@/lib/toast";

// Roadmap task-65: what a restore could not write back (secrets, certificates,
// consent, a new id's downstream integrations) and the service check after it.
// Each item closes only with a REFERENCE to evidence held elsewhere — the form
// never asks for, and the API refuses, the credential itself.
export type CompletionState = "configuration-restored" | "service-validation-pending" | "verified-complete";

export interface CompletionItem {
  id: string;
  kind: "credential" | "certificate" | "consent" | "integration" | "service-validation" | "enforcement" | "manual-setting";
  requirement: string;
  description: string;
  owner: string | null;
  state: "pending" | "verified";
  evidence: { type: string; reference: string; recordedBy?: string; recordedAt?: string }[];
  closedAt: string | null;
  reopenCount: number;
  // A later restore opened the same step for the same object; that one is the step
  // to close, so this one is no longer waiting on anyone.
  replacedBy?: string | null;
}

export interface CompletionResource {
  naturalKey: string;
  // The resource in words, by its saved name (never a key or id).
  label?: string;
  resourceType: string;
  mechanism: string;
  state: CompletionState;
  items: CompletionItem[];
}

const STATE_TONES: Record<CompletionState, BadgeTone> = {
  "configuration-restored": "soon",
  "service-validation-pending": "low",
  "verified-complete": "fine",
};

const KIND_ICONS: Record<CompletionItem["kind"], IconName> = {
  credential: "settings", certificate: "page", consent: "check", integration: "link", "service-validation": "check-circle", enforcement: "play",
  "manual-setting": "settings",
};

const STATE_LABELS: Record<CompletionState, string> = {
  "configuration-restored": "Configuration restored",
  "service-validation-pending": "Service validation pending",
  "verified-complete": "Verified complete",
};

export function completionStateLabel(state: CompletionState): string {
  return STATE_LABELS[state] ?? state;
}

// A restore that skipped an object (mechanism 'skipped') wrote nothing to it: its
// open items are the steps to do by hand. Its badge says so, never "restored".
export function completionBadge(resource: Pick<CompletionResource, "mechanism" | "state">): { label: string; tone: BadgeTone; key: string } {
  if (resource.mechanism === "skipped") {
    return resource.state === "verified-complete"
      ? { label: "Set by hand, verified", tone: "fine", key: "skipped-verified" }
      : { label: "Not restored: set it by hand", tone: "soon", key: "skipped" };
  }
  return { label: completionStateLabel(resource.state), tone: STATE_TONES[resource.state] ?? "neutral", key: resource.state };
}

function mechanismNote(mechanism: string): string {
  return mechanism === "skipped" ? "KEEL wrote nothing to it" : words(mechanism);
}

interface ChecklistProps {
  resources: CompletionResource[];
  canComplete: boolean;
  busyItem?: string | null;
  onComplete?: (item: CompletionItem, reference: string, type: string) => void;
  onReopen?: (item: CompletionItem) => void;
}

export function CompletionChecklist({ resources, canComplete, busyItem = null, onComplete, onReopen }: ChecklistProps) {
  const [openItem, setOpenItem] = useState<string | null>(null);
  if (resources.length === 0) {
    return <p className="ui-calm"><Icon name="check-circle" />Nothing to follow up: everything was restored in full.</p>;
  }
  const items = resources.flatMap((resource) => resource.items);
  const current = items.filter((item) => item.state === "verified" || !item.replacedBy);
  const open = current.filter((item) => item.state === "pending").length;
  return (
    <div className="completion-list">
      <p className="completion-summary">
        {open ? <Badge tone="soon">{`${open} ${open === 1 ? "needs" : "need"} evidence`}</Badge> : null}
        <Badge tone={open ? "neutral" : "fine"}>{`${current.length - open} of ${current.length} verified`}</Badge>
      </p>
      {resources.map((resource) => {
        const badge = completionBadge(resource);
        return (
          <section className={`completion-resource completion-${resource.state}`} key={resource.naturalKey}>
            <header className="completion-resource-head">
              <strong className="resource-name">{resource.label ?? namedResource(resource.naturalKey, {}, resource.resourceType)}</strong>
              <Badge className={`completion-badge-${badge.key}`} tone={badge.tone}>{badge.label}</Badge>
              <small className="completion-mechanism">{mechanismNote(resource.mechanism)}</small>
            </header>
            <ul className="completion-items">
              {resource.items.map((item) => {
                const evidence = item.evidence[item.evidence.length - 1];
                const replaced = item.state === "pending" && Boolean(item.replacedBy);
                const formOpen = openItem === item.id || busyItem === item.id;
                return (
                  <li className={`completion-item completion-item-${item.state}`} data-tone={item.state === "verified" ? "fine" : "soon"} key={item.id}>
                    <span aria-hidden="true" className="completion-kind"><Icon name={KIND_ICONS[item.kind] ?? "info"} /></span>
                    <div className="completion-item-text">
                      <strong>{words(item.kind)}</strong>
                      <span>{item.description}</span>
                      {item.state === "verified" && evidence ? (
                        <small className="completion-evidence">
                          Evidence: {evidence.type} {evidence.reference}
                          {item.closedAt ? ` · ${formatTimestamp(item.closedAt)}` : null}
                        </small>
                      ) : null}
                      {replaced ? (
                        <small className="completion-evidence">
                          A later restore of this item opened the same step, so this one no longer counts as waiting. You can still close it here.
                        </small>
                      ) : null}
                      {item.kind === "enforcement" && item.state === "pending" && !replaced ? (
                        <small className="completion-evidence completion-next-step">
                          Next: ask for the enforcement step. A second person approves it, and KEEL closes this once the policy reads back as on.
                        </small>
                      ) : null}
                    </div>
                    <Badge tone={item.state === "verified" ? "fine" : replaced ? "neutral" : "soon"}>
                      {item.state === "verified" ? "Verified" : replaced ? "Replaced" : "Needs evidence"}
                    </Badge>
                    <span className="completion-act">
                      {canComplete ? (
                        item.state === "pending" ? (
                          item.kind === "enforcement" || formOpen ? null : (
                            <button className="btn btn-secondary btn-sm" disabled={busyItem !== null} onClick={() => setOpenItem(item.id)} type="button">
                              Add evidence
                            </button>
                          )
                        ) : (
                          <button
                            aria-busy={busyItem === item.id || undefined}
                            className="btn btn-secondary btn-sm"
                            disabled={busyItem !== null}
                            onClick={() => onReopen?.(item)}
                            type="button"
                          >
                            Reopen
                          </button>
                        )
                      ) : null}
                    </span>
                    {canComplete && item.state === "pending" && item.kind !== "enforcement" && formOpen ? (
                      <form
                        className="completion-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          const data = new FormData(event.currentTarget);
                          onComplete?.(item, String(data.get("reference") ?? ""), String(data.get("type") ?? "ticket"));
                        }}
                      >
                        <div className="completion-field">
                          <label htmlFor={`type-${item.id}`}>Evidence type</label>
                          <select className="completion-control" defaultValue="ticket" id={`type-${item.id}`} name="type">
                            <option value="ticket">Ticket</option>
                            <option value="link">Link</option>
                            <option value="log-reference">Log reference</option>
                            <option value="attestation">Attestation</option>
                          </select>
                        </div>
                        <div className="completion-field">
                          <label htmlFor={`reference-${item.id}`}>Evidence reference</label>
                          <input
                            aria-describedby={`reference-hint-${item.id}`}
                            autoComplete="off"
                            autoFocus
                            className="completion-control"
                            id={`reference-${item.id}`}
                            name="reference"
                            placeholder="CHG-5120 or a link"
                            required
                          />
                        </div>
                        <button aria-busy={busyItem === item.id || undefined} className="btn btn-primary btn-sm" disabled={busyItem !== null} type="submit">
                          Mark verified
                        </button>
                        <button className="btn btn-sm" disabled={busyItem !== null} onClick={() => setOpenItem(null)} type="button">Cancel</button>
                        {/* Stays visible while typing: the moment a credential could be pasted. */}
                        <small className="completion-hint" id={`reference-hint-${item.id}`}>
                          Where the proof lives. Never the secret itself.
                        </small>
                      </form>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            <TechnicalDetails summary="Technical details for this resource">
              <RecordField label="Stored key" value={resource.naturalKey} />
              <RecordField copy={false} label="Type" value={resource.resourceType} />
              <RecordField copy={false} label="Recovery mechanism" value={resource.mechanism} />
              <RecordField copy={false} label="Completion state" value={resource.mechanism === "skipped" ? badge.label : resource.state} />
              {resource.items.map((item) => (
                <RecordGroup key={item.id} note={`${item.kind}, ${item.state}`} title={item.requirement}>
                  <RecordField label="Step ID" value={item.id} />
                  <RecordField copy={false} label="Kind" value={item.kind} />
                  <RecordField copy={false} label="Requirement" value={item.requirement} />
                  <RecordField copy={false} label="State" value={item.state} />
                  <RecordField label="Owner" value={item.owner} />
                  <RecordField copy={false} label="Closed" value={item.closedAt} />
                  <RecordField copy={false} label="Times reopened" value={item.reopenCount} />
                  {item.replacedBy ? <RecordField label="Replaced by restore" value={item.replacedBy} /> : null}
                  {item.evidence.map((evidence, index) => (
                    <RecordField
                      key={`${evidence.type}:${evidence.reference}:${index}`}
                      label={`Evidence (${evidence.type})`}
                      usage={[evidence.recordedBy ? `recorded by ${evidence.recordedBy}` : null, evidence.recordedAt ? `at ${evidence.recordedAt}` : null].filter(Boolean).join(" ") || undefined}
                      value={evidence.reference}
                    />
                  ))}
                </RecordGroup>
              ))}
            </TechnicalDetails>
          </section>
        );
      })}
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
      const payload = (await response.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!response.ok) {
        const words = refused(response.status, payload.message ?? payload.error ?? `HTTP ${response.status}`);
        toast({
          tone: "warning",
          title: "Not saved",
          ...words,
          ...(payload.error === "invalid_evidence" ? { detail: "That looks like a secret or key.", todo: "Paste a reference to the proof, such as a ticket number, never the credential itself." } : {}),
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
        <h2 className="job-section-head" id="completion-heading"><Icon name="check" />Follow-ups the restore could not do</h2>
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
