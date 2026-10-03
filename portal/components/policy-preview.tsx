"use client";

import { useState } from "react";

import { RecordField, TechnicalDetails } from "@/components/technical-details";
import type { ActivationPreview, PreviewDrift } from "@/lib/policies";
import { ago, formatTimestamp, resourceLabel, words } from "@/lib/presentation";
import { toast } from "@/lib/toast";

// Roadmap task-92: what turning an automatic roll-back policy on would do, shown before
// it is turned on. The preview is frozen server-side; "Turn on" sends only its id, and
// the server refuses if the policy, the account's access, ownership or the changes it
// would act on moved since. Turning it on authorizes nothing: every roll back is
// checked again when it runs.

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

const IMPACT_WORDS: Record<string, string> = { cosmetic: "cosmetic", "access-affecting": "affects access", "tenant-lockout": "could lock out admins" };

function impactWords(blastRadius: string | null): string {
  return (blastRadius && IMPACT_WORDS[blastRadius]) || "not rated";
}

const CHANGE_WORDS: Record<string, string> = { modified: "was changed", added: "was added", removed: "was removed" };
const OPERATION_WORDS: Record<string, string> = {
  create: "Recreating", update: "Updating", delete: "Deleting", "restore-soft-deleted": "Restoring from the recycle bin",
};
const UNKNOWN_WORDS: Record<string, string> = {
  "scope-unresolved": "KEEL could not find the backup it would restore from",
  "not-in-backup": "it is not in the backup KEEL would restore from",
  "unresolved-reference": "it refers to something that is not in the backup",
  "impact-unknown": "its impact is not rated",
  "operation-unknown": "KEEL does not recognise the kind of change",
};
const FINDING_VERDICTS: Record<string, string> = {
  pass: "passing", fail: "failing", unknown: "not known", "not-applicable": "does not apply", exception: "excepted",
};
const CHANGED_WORDS: Record<string, string> = {
  policy: "the policy", grant: "the account's access", ownership: "who owns what it touches",
  projection: "the changes it would act on", preview: "the changes it would act on",
};

/** The preview's own one-line answer. Under 25 words, no codes. */
export function previewSentence(preview: ActivationPreview): string {
  if (preview.blockers.includes("automation-halted")) return "Cannot turn on while automation is halted.";
  if (preview.blockers.includes("run-as-not-authorized")) return "Cannot turn on: the account it acts as can no longer roll back changes.";
  if (preview.blockers.includes("unknown-impact")) {
    const keys = new Set(preview.unknowns.flatMap((unknown) => unknown.naturalKeys));
    return `Cannot turn on: KEEL cannot tell what rolling back ${plural(Math.max(keys.size, 1), "resource")} would affect.`;
  }
  if (preview.matched.length === 0) return "Ready to turn on. Nothing matches it right now.";
  const refused = refusedMatches(preview).length;
  const now = `Ready to turn on. It would roll back ${plural(preview.matched.length, "change")} now`;
  return refused > 0 ? `${now}; KEEL will refuse ${refused} that ${refused === 1 ? "depends" : "depend"} on something above its limit.` : `${now}.`;
}

/** Matched changes whose roll back depends on something above the policy's limit. */
function refusedMatches(preview: ActivationPreview): PreviewDrift[] {
  const blocked = new Set(preview.dependencies.filter((dependency) => dependency.overCeiling).flatMap((dependency) => dependency.requiredBy));
  return preview.matched.filter((drift) => blocked.has(drift.naturalKey));
}

/** "1 waiting to run, not yet rolled back · 5 rolled back · 1 failed or refused". */
export function outcomesSentence(outcomes: { queued: number; rolledBack: number; failed: number }): string {
  const parts = [
    outcomes.queued ? `${outcomes.queued} waiting to run, not yet rolled back` : null,
    outcomes.rolledBack ? `${outcomes.rolledBack} rolled back` : null,
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
    case "already-active": return "The policy is already on.";
    case "preview-blocked": return "KEEL cannot turn it on now. Preview again to see why.";
    default: return "The policy could not be turned on.";
  }
}

function limitSentence(preview: ActivationPreview): string {
  const ceiling = impactWords(preview.limits.maxBlastRadius);
  return `Acts only on changes whose impact is ${ceiling} or lower, and refuses a roll back if anything it depends on is rated higher.`;
}

function rateSentence(preview: ActivationPreview): string | null {
  const { maxActionsPerWindow: count, windowSeconds: seconds } = preview.limits;
  if (count == null) return null;
  const window = seconds === 3600 ? "an hour" : seconds === 86_400 ? "a day" : seconds === 60 ? "a minute" : `every ${seconds} seconds`;
  return `Up to ${count} ${window}, then it pauses itself until someone resumes it.`;
}

export function ActivationPreviewView({ preview, now }: { preview: ActivationPreview; now: string }) {
  const overLimit = preview.dependencies.filter((dependency) => dependency.overCeiling);
  const rate = rateSentence(preview);
  return (
    <section aria-label={`What turning on ${preview.policy.name} would do`} className="policy-preview">
      <p className={`policy-preview-sentence ${preview.verdict === "ready" ? "is-ready" : "is-blocked"}`} role="status">{previewSentence(preview)}</p>

      <h3>What it would roll back now</h3>
      <ul className="policy-facts">
        {preview.matched.length === 0 ? <li>Nothing matches it right now.</li> : null}
        {preview.matched.map((drift) => (
          <li key={drift.driftId}>{resourceLabel(drift.naturalKey)} {CHANGE_WORDS[drift.changeType] ?? "changed"}. Impact: {impactWords(drift.blastRadius)}.</li>
        ))}
        {preview.matchedOverCeiling.map((drift) => (
          <li key={drift.driftId}>Left alone: {resourceLabel(drift.naturalKey)} {CHANGE_WORDS[drift.changeType] ?? "changed"}, but its impact ({impactWords(drift.blastRadius)}) is above its limit.</li>
        ))}
      </ul>

      {preview.dependencies.length > 0 ? <>
        <h3>And everything it depends on</h3>
        <ul className="policy-facts policy-dependencies">
          {preview.dependencies.map((dependency) => (
            <li className={dependency.overCeiling ? "is-over-limit" : undefined} key={dependency.naturalKey}>
              {resourceLabel(dependency.naturalKey)}, needed by {dependency.requiredBy.map((key) => resourceLabel(key)).join(", ")}. Impact: {impactWords(dependency.blastRadius)}.
              {dependency.overCeiling ? " Above its limit, so KEEL will refuse these roll backs." : null}
            </li>
          ))}
        </ul>
      </> : null}

      {preview.unsupported.length > 0 ? <>
        <h3>Cannot be done automatically</h3>
        <ul className="policy-facts">
          {preview.unsupported.map((entry) => (
            <li key={`${entry.naturalKey}|${entry.operation}`}>{OPERATION_WORDS[entry.operation] ?? "Changing"} {resourceLabel(entry.naturalKey)} is not supported, so it stays manual.</li>
          ))}
        </ul>
      </> : null}

      {preview.unknowns.length > 0 ? <>
        <h3>What KEEL cannot tell</h3>
        <ul className="policy-facts">
          {preview.unknowns.map((unknown, index) => (
            <li key={`${unknown.reason}-${index}`}>{unknown.naturalKeys.map((key) => resourceLabel(key)).join(", ") || "A matched change"}: {UNKNOWN_WORDS[unknown.reason] ?? "its effect is not known"}.</li>
          ))}
        </ul>
      </> : null}

      <h3>Acting as</h3>
      <ul className="policy-facts">
        <li>
          {preview.runAs.readable ? preview.runAs.name ?? preview.runAs.email : "An account that is no longer readable"}
          {preview.runAs.authorized ? " can roll back changes now." : " cannot roll back changes now."}
        </li>
        {preview.runAs.grants.map((grant) => (
          <li key={grant.id}>{words(grant.role)}{grant.scope !== "*" ? ` for ${grant.scope.replace(/^entity:/, "")}` : ""}, granted <time dateTime={grant.activeFrom ?? undefined} title={formatTimestamp(grant.activeFrom)}>{ago(grant.activeFrom, now)}</time>{grant.activeUntil ? `, until ${formatTimestamp(grant.activeUntil)}` : ""}.</li>
        ))}
      </ul>

      <h3>Limits</h3>
      <ul className="policy-facts">
        <li>{limitSentence(preview)}</li>
        {rate ? <li>{rate}</li> : null}
        {preview.limits.automationHalted ? <li>Automation is halted. Nothing acts until the halt file is removed.</li> : null}
        {overLimit.length > 0 ? <li>{plural(overLimit.length, "resource")} it depends on {overLimit.length === 1 ? "is" : "are"} above its limit.</li> : null}
      </ul>

      {preview.benchmarkFindings.state === "unavailable" || preview.benchmarkFindings.findings.length > 0 ? <>
        <h3>Related benchmark findings</h3>
        <ul className="policy-facts">
          {preview.benchmarkFindings.state === "unavailable" ? <li>Benchmark results could not be read.</li> : null}
          {preview.benchmarkFindings.findings.map((finding) => (
            <li key={finding.id}>
              {finding.title ?? "A benchmark control"}: {FINDING_VERDICTS[finding.verdict] ?? "not known"}{finding.exposed ? ", with no exception" : ""}.
              {finding.link === "linked" ? " Checked against the same backup as this change." : " Checked against a different backup than this change."}
            </li>
          ))}
        </ul>
      </> : null}

      {preview.outcomes ? <>
        <h3>So far</h3>
        <p>{outcomesSentence(preview.outcomes)}</p>
      </> : null}

      <p className="policy-preview-note">
        This preview holds until <time dateTime={preview.expiresAt} title={formatTimestamp(preview.expiresAt)}>{formatTimestamp(preview.expiresAt)}</time>. Turning the policy on approves nothing in advance: KEEL checks again before every roll back.
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
        toast({ tone: "warning", title: "No preview", detail: "KEEL could not work out what this policy would do. Try again in a minute." });
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
      toast({ title: `${name} turned on`, detail: "KEEL checks again before every roll back." });
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
        <button aria-busy={busy === "preview"} className="btn btn-secondary btn-sm" disabled={busy !== null} onClick={() => void loadPreview()} type="button">
          {preview ? "Preview again" : "Preview turning on"}
        </button>
      </div>
    </div>
  );
}
