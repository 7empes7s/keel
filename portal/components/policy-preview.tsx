"use client";

import { useState } from "react";

import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { AlertList } from "@/components/ui/alert-list";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { StatTiles } from "@/components/ui/stat-tiles";
import type { ActivationPreview } from "@/lib/policies";
import {
  findingWords, previewAlerts, previewGroups, previewTiles, refusedMatches,
  type PreviewTone,
} from "@/lib/policy-preview-view";
import { ago, formatTimestamp, words } from "@/lib/presentation";
import { personLabel } from "@/lib/sentences";
import { toast } from "@/lib/toast";

// Roadmap task-92: what turning an undo rule on would do, shown before
// it is turned on. The preview is frozen server-side; "Turn on" sends only its id, and
// the server refuses if the policy, the account's access, ownership or the changes it
// would act on moved since. Turning it on authorizes nothing: every undo is
// checked again when it runs.

/** "CREOS" -> "Creos": an owner code as a word. */
function titleCase(code: string): string {
  return code.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (letter) => letter.toUpperCase());
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

const CHANGED_WORDS: Record<string, string> = {
  policy: "the policy", grant: "the account's access", ownership: "who owns what it touches",
  projection: "the changes it would act on", preview: "the changes it would act on",
};

/** The preview's own one-line answer. Under 25 words, no codes. */
export function previewSentence(preview: ActivationPreview): string {
  if (preview.blockers.includes("automation-halted")) return "Cannot turn on while automation is halted.";
  if (preview.blockers.includes("run-as-not-authorized")) return "Cannot turn on: the account it acts as can no longer undo changes.";
  if (preview.blockers.includes("unknown-impact")) {
    const keys = new Set(preview.unknowns.flatMap((unknown) => unknown.naturalKeys));
    return `Cannot turn on: Keel cannot tell what undoing ${plural(Math.max(keys.size, 1), "change")} would affect.`;
  }
  if (preview.matched.length === 0) return "Ready to turn on. Nothing matches it right now.";
  const refused = refusedMatches(preview).length;
  const now = `Ready to turn on. It would undo ${plural(preview.matched.length, "change")} now`;
  return refused > 0 ? `${now}; Keel will refuse ${refused} that ${refused === 1 ? "depends" : "depend"} on something above its limit.` : `${now}.`;
}

/** "1 waiting to run, not yet undone · 5 undone · 1 failed or refused". */
export function outcomesSentence(outcomes: { queued: number; rolledBack: number; failed: number }): string {
  const parts = [
    outcomes.queued ? `${outcomes.queued} waiting to run, not yet undone` : null,
    outcomes.rolledBack ? `${outcomes.rolledBack} undone` : null,
    outcomes.failed ? `${outcomes.failed} failed or refused` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "It has not acted yet.";
}

/** Why "Turn on" was refused, in words. */
export function refusalSentence(code: string, changed: string[] = []): string {
  switch (code) {
    case "preview-stale": {
      const what = [...new Set(changed.map((key) => CHANGED_WORDS[key] ?? "what it would act on"))];
      return `${what.join(" and ").replace(/^./, (first) => first.toUpperCase())} changed since the preview. Preview again.`;
    }
    case "preview-expired": return "The preview expired. Preview again.";
    case "preview-used": return "This preview was already used. Preview again.";
    case "already-active": return "The rule is already on.";
    case "preview-blocked": return "Keel cannot turn it on now. Preview again to see why.";
    default: return "The rule could not be turned on.";
  }
}

function badgeTone(tone: PreviewTone): BadgeTone {
  return tone;
}

export function ActivationPreviewView({ preview, now }: { preview: ActivationPreview; now: string }) {
  const runAs = preview.runAs;
  const alerts = previewAlerts(preview);
  const groups = previewGroups(preview);
  const ready = preview.verdict === "ready";
  return (
    <section aria-label={`What turning on ${preview.policy.name} would do`} className="policy-preview">
      <p className={`policy-preview-sentence ${ready ? "is-ready" : "is-blocked"}`} role="status">
        <Badge tone={ready ? (alerts.length ? "soon" : "fine") : "urgent"}>{ready ? "Ready" : "Blocked"}</Badge>
        <span className="policy-preview-text">{previewSentence(preview)}</span>
      </p>

      {alerts.length ? <AlertList items={alerts} /> : null}

      <StatTiles tiles={previewTiles(preview)} />

      <div className="rs-table-wrap">
        <table className="rs-table pv-table">
          <caption className="visually-hidden">What turning it on would do to each item</caption>
          <thead>
            <tr><th scope="col">Item</th><th scope="col">What</th><th scope="col">Impact</th><th scope="col">Outcome</th></tr>
          </thead>
          {groups.map((group) => (
            <tbody data-group={group.key} key={group.key}>
              <tr className="rs-group"><th colSpan={4} scope="colgroup"><span><Icon name={group.icon} />{group.name}</span></th></tr>
              {group.rows.length === 0 ? (
                <tr data-tone="neutral"><th colSpan={4} scope="row"><span className="rs-row-name">Nothing matches it right now.</span></th></tr>
              ) : group.rows.map((row) => (
                <tr data-tone={row.tone} key={row.key}>
                  <th scope="row"><span className="rs-row-name">{row.name}</span>{row.note ? <small>{row.note}</small> : null}</th>
                  <td data-label="What">{row.what}</td>
                  <td data-label="Impact"><Badge icon={null} tone={row.impactTone}>{row.impact}</Badge></td>
                  <td data-label="Outcome"><Badge tone={badgeTone(row.tone)}>{row.outcome}</Badge></td>
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>

      <dl className="pv-facts">
        <div>
          <dt><Icon name="person" />Acting as</dt>
          <dd>
            <span>{runAs.readable
              ? personLabel({ kind: "person", id: runAs.principalId ?? "", name: runAs.name === runAs.email ? null : runAs.name, email: runAs.email, readable: true }, "An account without a name")
              : "An account that is no longer readable"}</span>
            <Badge tone={runAs.authorized ? "fine" : "urgent"}>{runAs.authorized ? "Can undo changes" : "Cannot undo changes"}</Badge>
            {runAs.grants.map((grant) => (
              <small key={grant.id}>{words(grant.role)}{grant.scope !== "*" ? ` for ${titleCase(grant.scope.replace(/^entity:/, ""))}` : ""}, granted <time dateTime={grant.activeFrom ?? undefined} title={formatTimestamp(grant.activeFrom)}>{ago(grant.activeFrom, now)}</time>{grant.activeUntil ? `, until ${formatTimestamp(grant.activeUntil)}` : ""}</small>
            ))}
          </dd>
        </div>
        {preview.benchmarkFindings.findings.length ? (
          <div>
            <dt><Icon name="baselines" />Security checks it affects</dt>
            <dd>
              <ul className="pv-checks">
                {preview.benchmarkFindings.findings.map((finding) => {
                  const verdict = findingWords(finding.verdict);
                  return (
                    <li key={finding.id}>
                      <span>{finding.title ?? "A security check"}</span>
                      <Badge tone={verdict.tone}>{verdict.label}</Badge>
                      <small>{finding.exposed ? "No exception · " : ""}{finding.link === "linked" ? "Same backup as this change" : "Different backup than this change"}</small>
                    </li>
                  );
                })}
              </ul>
            </dd>
          </div>
        ) : null}
        {preview.outcomes ? (
          <div>
            <dt><Icon name="restore" />So far</dt>
            <dd className="pv-outcomes">
              {preview.outcomes.queued + preview.outcomes.rolledBack + preview.outcomes.failed === 0 ? <span>{outcomesSentence(preview.outcomes)}</span> : <>
                {preview.outcomes.queued ? <Badge tone="soon">{`${preview.outcomes.queued} waiting to run, not yet undone`}</Badge> : null}
                {preview.outcomes.rolledBack ? <Badge tone="fine">{`${preview.outcomes.rolledBack} undone`}</Badge> : null}
                {preview.outcomes.failed ? <Badge tone="urgent">{`${preview.outcomes.failed} failed or refused`}</Badge> : null}
              </>}
            </dd>
          </div>
        ) : null}
      </dl>

      <p className="policy-preview-note">
        <Icon name="clock" /><span>Valid until <time dateTime={preview.expiresAt} title={formatTimestamp(preview.expiresAt)}>{formatTimestamp(preview.expiresAt)}</time>. Keel checks again before every undo.</span>
      </p>

      <TechnicalDetails summary="Technical details for this preview">
        <RecordField label="Preview ID" usage={<>use with <code>POST /api/policies/&lt;id&gt;/activate</code> as <code>previewId</code></>} value={preview.id} />
        <RecordField label="Policy ID" value={preview.policy.id} />
        <RecordField copy={false} label="Verdict and blockers" value={`${preview.verdict}${preview.blockers.length ? ` · ${preview.blockers.join(", ")}` : ""}`} />
        <RecordField label="Policy version" value={preview.versions.policy} />
        <RecordField label="Grant version" value={preview.versions.grant} />
        <RecordField label="Ownership version" value={preview.versions.ownership} />
        <RecordField label="Projection version" value={preview.versions.projection} />
        <RecordField label="Preview digest" value={preview.digest} />
        <RecordField copy={false} label="Max impact after closure" value={`${preview.impact.maxBlastRadius ?? "none"} · ceiling ${preview.impact.ceiling}`} />
        <RecordField copy={false} label="Matched drift" value={[...preview.matched, ...preview.matchedOverCeiling].map((drift) => `${drift.driftId} ${drift.naturalKey} ${drift.changeType} ${drift.blastRadius ?? "unrated"}`).join("\n") || "none"} />
        <RecordField copy={false} label="Operations" value={preview.operations.map((operation) => `${operation.naturalKey} ${operation.verb} ${operation.blastRadius ?? "unrated"} (${operation.role})`).join("\n") || "none"} />
        <RecordField copy={false} label="Expanded dependencies" value={preview.dependencies.map((dependency) => `${dependency.naturalKey} ${dependency.blastRadius ?? "unrated"}${dependency.overCeiling ? " over-ceiling" : ""} <- ${dependency.requiredBy.join(", ")}`).join("\n") || "none"} />
        {preview.unsupported.length ? <RecordField copy={false} label="Unsupported operations" value={preview.unsupported.map((entry) => `${entry.naturalKey} ${entry.operation} ${entry.claim}`).join("\n")} /> : null}
        {preview.unknowns.length ? <RecordField copy={false} label="Unknown impact" value={preview.unknowns.map((unknown) => `${unknown.reason}: ${unknown.naturalKeys.join(", ")} — ${unknown.detail}`).join("\n")} /> : null}
        <RecordField label="Run-as principal ID" value={preview.runAs.principalId} />
        {preview.runAs.grants.length ? <RecordField copy={false} label="Active grants" value={preview.runAs.grants.map((grant) => `${grant.id} ${grant.role} scope=${grant.scope} from ${grant.activeFrom ?? "?"} until ${grant.activeUntil ?? "open"}`).join("\n")} /> : null}
        {preview.ownership.resources.length ? <RecordField copy={false} label="Ownership evidence" value={preview.ownership.resources.map((entry) => `${entry.evidenceId} ${entry.naturalKey} ${entry.state}${entry.entityCode ? ` ${entry.entityCode}` : ""} until ${entry.expiresAt ?? "?"}`).join("\n")} /> : <RecordField copy={false} label="Ownership evidence" value={preview.ownership.state} />}
        {preview.benchmarkFindings.findings.length ? <RecordField copy={false} label="Benchmark evaluations" value={preview.benchmarkFindings.findings.map((finding) => `${finding.id} ${finding.controlId} ${finding.verdict} ${finding.link}`).join("\n")} /> : null}
        <RecordField copy={false} label="Created" value={`${preview.createdAt} by ${preview.requestedBy} · expires ${preview.expiresAt}`} />
      </TechnicalDetails>
    </section>
  );
}

/** Preview, then turn on from that preview. Rendered for an automatic policy that is off. */
export function PolicyActivation({ policyId, name, now, initialPreview = null }: { policyId: string; name: string; now: string; initialPreview?: ActivationPreview | null }) {
  const [preview, setPreview] = useState<ActivationPreview | null>(initialPreview);
  const [busy, setBusy] = useState<"preview" | "activate" | null>(null);

  async function post(path: string, body: Record<string, unknown>) {
    return fetch(`/api/policies/${encodeURIComponent(policyId)}/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify(body),
    });
  }

  async function loadPreview() {
    setBusy("preview");
    try {
      const response = await post("activation-preview", {});
      if (!response.ok) {
        toast({ tone: "warning", title: "No preview", detail: "Keel could not work out what this rule would do. Try again in a minute." });
        return;
      }
      setPreview(((await response.json()) as { preview: ActivationPreview }).preview);
    } finally {
      setBusy(null);
    }
  }

  async function activate(previewId: string) {
    setBusy("activate");
    try {
      const response = await post("activate", { previewId });
      if (!response.ok) {
        const refusal = (await response.json().catch(() => ({}))) as { error?: string; changed?: string[] };
        toast({ tone: "warning", title: "Not turned on", detail: refusalSentence(refusal.error ?? "", refusal.changed ?? []) });
        setPreview(null);
        return;
      }
      toast({ title: `${name} turned on`, detail: "Keel checks again before every undo." });
      // A full reload: these controls also render outside an app router (page tests).
      window.location.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="policy-activation">
      {preview ? <ActivationPreviewView now={now} preview={preview} /> : null}
      <div className="form-actions">
        {preview?.verdict === "ready" ? (
          <button aria-busy={busy === "activate"} className="btn btn-primary btn-sm" disabled={busy !== null} onClick={() => void activate(preview.id)} type="button">
            Turn on
          </button>
        ) : null}
        <button aria-busy={busy === "preview"} className={preview ? "btn btn-sm" : "btn btn-primary btn-sm"} disabled={busy !== null} onClick={() => void loadPreview()} type="button">
          <Icon name="show" />{preview ? "Preview again" : "Preview turning on"}
        </button>
      </div>
    </div>
  );
}
