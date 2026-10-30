"use client";

import { useState } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { fieldWords } from "@/lib/changes-view";
import { type NamedKeys, namedResource } from "@/lib/job-names";
import { resourceLabel } from "@/lib/presentation";
import { refused, toast } from "@/lib/toast";

// Roadmap task-66: the content consequences of a reviewed dry run. Each effect
// says plainly that KEEL does not back up content and that restoring the old
// setting later does not bring back what was deleted or disclosed. Promotion
// needs a separate approval of exactly these effects by someone other than
// the requester.
export type ContentEffectName =
  | "retention-reducing"
  | "hold-releasing"
  | "externally-sharing"
  | "irreversible"
  | "runs-on-devices"
  | "weakens-protection"
  | "acts-on-accounts"
  | "blocks-sign-in";

export interface ContentEffect {
  naturalKey: string;
  resourceType: string;
  field: string;
  effect: ContentEffectName;
  before: unknown;
  after: unknown;
  disclosure: string;
  // "runs-on-devices" only: the script text a restore puts back, and the text now.
  script?: { before: string | null; after: string | null };
  // Who the restore's assignment write reaches that the item does not reach now.
  newAssignments?: string[];
}

const EFFECT_LABELS: Record<ContentEffectName, string> = {
  "retention-reducing": "Shortens retention",
  "hold-releasing": "Releases a hold",
  "externally-sharing": "Widens sharing",
  irreversible: "Destroys content",
  "runs-on-devices": "Runs on devices",
  "weakens-protection": "Weakens protection",
  "acts-on-accounts": "Acts on accounts",
  "blocks-sign-in": "Blocks sign-in",
};

export function contentEffectLabel(effect: ContentEffectName): string {
  return EFFECT_LABELS[effect] ?? effect;
}

const EFFECT_ICONS: Record<ContentEffectName, IconName> = {
  "retention-reducing": "clock",
  "hold-releasing": "link",
  "externally-sharing": "show",
  irreversible: "x-circle",
  "runs-on-devices": "alert",
  "weakens-protection": "hide",
  "acts-on-accounts": "person",
  "blocks-sign-in": "pause",
};

const show = (value: unknown) => (value === null || value === undefined ? "—" : typeof value === "string" ? value : JSON.stringify(value));

export function ContentEffectList({ effects, names }: { effects: ContentEffect[]; names?: NamedKeys }) {
  return (
    <ul className="content-effect-list">
      {effects.map((effect) => (
        <li className={`content-effect content-effect-${effect.effect}`} key={`${effect.naturalKey}|${effect.field}`}>
          <div className="content-effect-head">
            <span aria-hidden="true" className="content-effect-kind"><Icon name={EFFECT_ICONS[effect.effect] ?? "alert"} /></span>
            <strong className="resource-name">{names ? namedResource(effect.naturalKey, names, effect.resourceType) : resourceLabel(effect.naturalKey)}</strong>
            <Badge className="content-effect-badge" icon={null} tone="urgent">{contentEffectLabel(effect.effect)}</Badge>
          </div>
          <p className="content-effect-change">
            <span className="content-effect-field">{fieldWords(effect.field)}</span>
            <span className="change-values">
              <code className="value-before">{show(effect.before)}</code>
              <span aria-label="becomes">→</span>
              <code className="value-after">{show(effect.after)}</code>
            </span>
          </p>
          {effect.newAssignments?.length ? (
            <p className="content-effect-reach">
              <span className="content-effect-field">Newly assigned to</span> {effect.newAssignments.join("; ")}
            </p>
          ) : null}
          <p className="content-effect-disclosure">{effect.disclosure}</p>
          {effect.script ? <ScriptText script={effect.script} /> : null}
        </li>
      ))}
    </ul>
  );
}

// The script a restore would run on devices, and the one there now, so the person
// approving reads the code itself, not a fingerprint.
function ScriptText({ script }: { script: { before: string | null; after: string | null } }) {
  return (
    <details className="content-effect-script">
      <summary>Show the script</summary>
      <p className="content-effect-script-label">The backup puts back</p>
      <pre><code>{script.after ?? "—"}</code></pre>
      <p className="content-effect-script-label">On devices now</p>
      <pre><code>{script.before ?? "Not read: Keel could not read the script that is there now."}</code></pre>
    </details>
  );
}

interface PanelProps {
  artifactId: string;
  effects: ContentEffect[];
  effectsDigest: string | null;
  approvals: { approvedBy: string; approvedAt: string | null }[];
  canApprove: boolean;
  onApproved?: () => void;
  // Saved names by key; without them the list names each effect from its key.
  names?: NamedKeys;
}

export function ContentEffectsPanel({ artifactId, effects, effectsDigest, approvals, canApprove, onApproved, names }: PanelProps) {
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
        toast({ tone: "warning", title: "Content effects not approved", ...refused(response.status, payload.message ?? `HTTP ${response.status}`) });
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
      <p className="content-effects-head" id={`content-effects-${artifactId}`}>
        <Icon name="page" />
        <span>{effects.length === 1 ? "1 change to kept or shared content" : `${effects.length} changes to kept or shared content`} · needs its own approval</span>
      </p>
      <ContentEffectList effects={effects} names={names} />
      {approvals.length ? (
        <p className="content-effect-approved">
          <Icon name="check-circle" />Approved for exactly these effects by {approvals.map((approval) => approval.approvedBy).join(", ")}.
        </p>
      ) : (
        <p className="content-effect-pending">
          Not yet approved. The restore will be refused until someone other than the person who asked approves these changes.
        </p>
      )}
      {canApprove && approvals.length === 0 ? (
        <div className="content-effect-approve">
          <label className="content-effect-why">
            <span>Why is this acceptable? (required, kept in the audit log)</span>
            <input onChange={(event) => setJustification(event.target.value)} placeholder="Why are these content effects acceptable?" value={justification} />
          </label>
          <button
            aria-busy={busy || undefined}
            className="btn btn-primary"
            disabled={busy || justification.trim().length === 0 || !effectsDigest}
            onClick={() => void approve()}
            type="button"
          >
            <Icon name="check" />{effects.length === 1 ? "Approve this content change" : "Approve these content changes"}
          </button>
          <p className="content-effect-help">If the restore is planned again with different changes, this approval no longer counts.</p>
        </div>
      ) : null}
    </div>
  );
}
