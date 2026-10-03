"use client";

import { useState } from "react";

import { toast } from "@/lib/toast";

// Roadmap task-66: the content consequences of a reviewed dry run. Each effect
// says plainly that KEEL does not back up content and that restoring the old
// setting later does not bring back what was deleted or disclosed. Promotion
// needs a separate approval of exactly these effects by someone other than
// the requester.
export type ContentEffectName = "retention-reducing" | "hold-releasing" | "externally-sharing" | "irreversible";

export interface ContentEffect {
  naturalKey: string;
  resourceType: string;
  field: string;
  effect: ContentEffectName;
  before: unknown;
  after: unknown;
  disclosure: string;
}

const EFFECT_LABELS: Record<ContentEffectName, string> = {
  "retention-reducing": "Shortens retention",
  "hold-releasing": "Releases a hold",
  "externally-sharing": "Widens sharing",
  irreversible: "Destroys content",
};

export function contentEffectLabel(effect: ContentEffectName): string {
  return EFFECT_LABELS[effect] ?? effect;
}

const show = (value: unknown) => (value === null || value === undefined ? "—" : typeof value === "string" ? value : JSON.stringify(value));

export function ContentEffectList({ effects }: { effects: ContentEffect[] }) {
  return (
    <ul className="content-effect-list">
      {effects.map((effect) => (
        <li className={`content-effect content-effect-${effect.effect}`} key={`${effect.naturalKey}|${effect.field}`}>
          <div className="content-effect-head">
            <span className="content-effect-badge">{contentEffectLabel(effect.effect)}</span>
            <code className="natural-key">{effect.naturalKey}</code>
          </div>
          <p className="content-effect-change">
            <code>{effect.field}</code>: {show(effect.before)} → {show(effect.after)}
          </p>
          <p className="content-effect-disclosure">{effect.disclosure}</p>
        </li>
      ))}
    </ul>
  );
}

interface PanelProps {
  artifactId: string;
  effects: ContentEffect[];
  effectsDigest: string | null;
  approvals: { approvedBy: string; approvedAt: string | null }[];
  canApprove: boolean;
  onApproved?: () => void;
}

export function ContentEffectsPanel({ artifactId, effects, effectsDigest, approvals, canApprove, onApproved }: PanelProps) {
  const [justification, setJustification] = useState("");
  const [busy, setBusy] = useState(false);
  if (effects.length === 0) return null;

  async function approve() {
    setBusy(true);
    try {
      const response = await fetch("/api/actions/restore/content-effects", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `content-effects:${artifactId}:${effectsDigest}` },
        body: JSON.stringify({ artifactId, effectsDigest, justification }),
      });
      const payload = (await response.json().catch(() => ({}))) as { message?: string };
      if (!response.ok) {
        toast({ tone: "warning", title: "Content effects not approved", detail: payload.message ?? `Request failed (${response.status})` });
        return;
      }
      toast({ title: "Content effects approved", detail: "This approval covers exactly the effects listed here." });
      onApproved?.();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="content-effects" role="region" aria-labelledby={`content-effects-${artifactId}`}>
      <p className="severity-label" id={`content-effects-${artifactId}`}>CONTENT EFFECTS · SEPARATE APPROVAL REQUIRED</p>
      <ContentEffectList effects={effects} />
      {approvals.length ? (
        <p className="content-effect-approved">
          Approved for exactly these effects by {approvals.map((approval) => approval.approvedBy).join(", ")}.
        </p>
      ) : (
        <p className="content-effect-pending">
          Not yet approved. The restore will be refused at execution until someone other than the requester approves these effects.
        </p>
      )}
      {canApprove && approvals.length === 0 ? (
        <div className="filter-bar">
          <label className="filter-field">
            <span>High-impact justification</span>
            <input onChange={(event) => setJustification(event.target.value)} placeholder="Why are these content effects acceptable?" value={justification} />
          </label>
          <button
            aria-busy={busy || undefined}
            className="btn btn-danger btn-sm"
            disabled={busy || justification.trim().length === 0 || !effectsDigest}
            onClick={() => void approve()}
            type="button"
          >
            Approve content effects
          </button>
        </div>
      ) : null}
    </div>
  );
}
