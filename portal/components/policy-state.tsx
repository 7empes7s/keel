import Link from "next/link";

import { PolicyControls } from "@/components/policy-controls";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import type { ActivationPreview, Policy } from "@/lib/policies";
import { ago, displayEnum, formatTimestamp, resourceLabel, resourceTypeLabel } from "@/lib/presentation";

// Roadmap task-130, the contract's worked example: a policy reads as what it does,
// acting as whom, and what it last did; every id and code is in the record.

const IMPACT_ORDER = ["cosmetic", "access-affecting", "tenant-lockout"];

/** "Automation is on." / "Automation is halted …" — the page banner, never "kill switch". */
export function automationSentence(halted: boolean): string {
  return halted ? "Automation is halted. No policy acts until the halt file is removed." : "Automation is on.";
}

export function AutomationBanner({ halted, haltedAt, haltFile, now }: { halted: boolean; haltedAt?: string | null; haltFile?: string; now: string }) {
  return (
    <p className={`state-badge automation-banner ${halted ? "automation-halted" : "automation-on"}`} role="status">
      {halted ? (
        <>Automation is halted{haltedAt ? <> since <time dateTime={haltedAt} title={formatTimestamp(haltedAt)}>{ago(haltedAt, now)}</time></> : null} by a halt file{haltFile ? <> at <code>{haltFile}</code></> : null}. No policy acts until it is removed.</>
      ) : "Automation is on."}
    </p>
  );
}

function rateWindow(seconds: number | null): string {
  if (seconds === 3600) return "an hour";
  if (seconds === 86_400) return "a day";
  if (seconds === 60) return "a minute";
  if (seconds && seconds % 3600 === 0) return `every ${seconds / 3600} hours`;
  if (seconds && seconds % 60 === 0) return `every ${seconds / 60} minutes`;
  return `every ${seconds ?? "?"} seconds`;
}

export function rateSentence(policy: Pick<Policy, "max_actions_per_window" | "window_seconds">): string | null {
  if (policy.max_actions_per_window == null) return null;
  return `up to ${policy.max_actions_per_window} ${rateWindow(policy.window_seconds)}`;
}

function resourcePhrase(policy: Policy): string {
  const glob = policy.natural_key_glob;
  const [globType, ...rest] = glob ? glob.split(":") : [];
  const type = policy.resource_type ?? (glob && rest.length ? globType : null);
  const pattern = glob ? (rest.length ? rest.join(":") : glob) : null;
  const subject = type ? `${resourceTypeLabel(type)}s` : "any resource";
  return pattern && pattern !== "*" ? `${subject} named like “${pattern}”` : subject;
}

const CHANGE_NOUNS: Record<string, string> = { added: "additions of", modified: "changes to", removed: "removals of" };
const IMPACT_ADJECTIVES: Record<string, string> = { cosmetic: "cosmetic", "access-affecting": "access-affecting", "tenant-lockout": "lockout-risk" };

/** What the policy matches, in words: "cosmetic changes to any resource". */
export function matchPhrase(policy: Policy): string {
  const noun = (policy.change_type && CHANGE_NOUNS[policy.change_type]) || "changes to";
  const impact = policy.blast_radius ? `${IMPACT_ADJECTIVES[policy.blast_radius] ?? displayEnum("blastRadius", policy.blast_radius).toLowerCase()} ` : "";
  return `${impact}${noun} ${resourcePhrase(policy)}`;
}

function runAsName(policy: Policy): string | null {
  const ref = policy.run_as_principal;
  if (!ref) return null;
  return ref.readable && ref.name ? ref.name : `account ${ref.id.slice(0, 8)} (no longer readable)`;
}

/** The worked example's one sentence: what it does, how often, acting as whom. */
export function policySentence(policy: Policy): string {
  const rate = rateSentence(policy);
  const actor = runAsName(policy);
  switch (policy.action) {
    case "auto_remediate":
      return `Rolls back ${matchPhrase(policy)} automatically${rate ? `, ${rate}` : ""}${actor ? `, acting as ${actor}` : ""}.`;
    case "require_approval":
      return `Asks for approval before ${matchPhrase(policy)} are rolled back${rate ? `, ${rate}` : ""}.`;
    case "alert":
      return `Alerts on ${matchPhrase(policy)}.`;
    default:
      return `${displayEnum("policyAction", policy.action)} for ${matchPhrase(policy)}.`;
  }
}

/** "Running" / "Paused 2 hours ago after reaching its limit" / "Turned off". */
export function policyStateSentence(policy: Policy, now: string): string {
  if (!policy.enabled) return "Turned off";
  if (policy.run_as_repair_required) return "Stopped: the account it acts as needs repair";
  if (policy.paused_at) return `Paused ${ago(policy.paused_at, now)} after reaching its limit`;
  return "Running";
}

function neverTouches(policy: Policy): string | null {
  const higher = IMPACT_ORDER.slice(IMPACT_ORDER.indexOf(policy.max_blast_radius) + 1);
  if (higher.length === 0) return null;
  return `Never acts on anything that ${higher.map((radius) => (radius === "tenant-lockout" ? "could lock out admins" : "affects access")).join(" or ")}.`;
}

function lastActionSentence(policy: Policy, now: string): string {
  if (!policy.last_action_at) return "Has not acted yet.";
  const target = policy.last_action_natural_key ? ` on ${resourceLabel(policy.last_action_natural_key)}` : "";
  return `Last acted ${ago(policy.last_action_at, now)}${target}.`;
}

export function PolicyRecord({ policy }: { policy: Policy }) {
  return (
    <TechnicalDetails>
      <RecordField label="Policy ID" usage={<>use with <code>keel-policy-evaluate --policy &lt;id&gt;</code> and <code>GET /api/policies/&lt;id&gt;</code></>} value={policy.id} />
      <RecordField label="Run-as principal ID" value={policy.run_as_principal?.id ?? policy.run_as_principal_id ?? null} />
      <RecordField copy={false} label="Action code" value={`${policy.action} · max blast radius ${policy.max_blast_radius}`} />
      <RecordField copy={false} label="Match" value={`resource_type=${policy.resource_type ?? "any"} · blast_radius=${policy.blast_radius ?? "any"} · natural_key_glob=${policy.natural_key_glob ?? "*"} · change_type=${policy.change_type ?? "any"}`} />
      <RecordField copy={false} label="Rate limit" value={policy.max_actions_per_window == null ? "none" : `${policy.max_actions_per_window} per ${policy.window_seconds} seconds`} />
      <RecordField copy={false} label="State" value={`enabled=${policy.enabled} · paused_at=${policy.paused_at ?? "null"} · run_as_repair_required=${policy.run_as_repair_required}`} />
      {policy.last_action_at ? <RecordField copy={false} label="Last action" value={`${policy.last_action_status ?? "unknown"} at ${policy.last_action_at} on ${policy.last_action_natural_key ?? "unknown"}`} /> : null}
      <RecordField copy={false} label="Created" value={`${policy.created_at} by ${policy.created_by}`} />
    </TechnicalDetails>
  );
}

/** One policy, as the worked example: name and state, the sentence, then sentences. */
export function PolicyCard({ policy, now, canEdit = false, linkName = true, preview = null }: { policy: Policy; now: string; canEdit?: boolean; linkName?: boolean; preview?: ActivationPreview | null }) {
  const limits = rateSentence(policy);
  return (
    <section className="item-card policy-card">
      <div className="item-card-head">
        <h2>{linkName ? <Link className="item-title-link" href={`/policies/${policy.id}`}>{policy.name}</Link> : policy.name}</h2>
        <span className={policy.enabled && !policy.paused_at && !policy.run_as_repair_required ? "active-indicator" : "inactive-indicator"}>{policyStateSentence(policy, now)}</span>
      </div>
      <p className="policy-sentence">{policySentence(policy)}</p>
      <ul className="policy-facts">
        <li>{lastActionSentence(policy, now)} {policy.actions_last_7_days ? `${policy.actions_last_7_days} actions this week.` : null}</li>
        {neverTouches(policy) ? <li>{neverTouches(policy)}</li> : null}
        {limits ? <li>Limit: {limits}, then it pauses itself until someone resumes it.</li> : null}
      </ul>
      {canEdit ? <PolicyControls automatic={policy.action === "auto_remediate"} enabled={policy.enabled} initialPreview={preview} name={policy.name} now={now} paused={Boolean(policy.paused_at) || policy.run_as_repair_required} policyId={policy.id} /> : null}
      <PolicyRecord policy={policy} />
    </section>
  );
}

/** "Automation is on. 3 policies, 1 paused." */
export function policiesVerdict(policies: Policy[], halted: boolean): string {
  const paused = policies.filter((policy) => policy.enabled && (policy.paused_at || policy.run_as_repair_required)).length;
  const off = policies.filter((policy) => !policy.enabled).length;
  const count = `${policies.length} ${policies.length === 1 ? "policy" : "policies"}`;
  const states = [paused ? `${paused} paused` : null, off ? `${off} off` : null].filter(Boolean).join(", ");
  return `${automationSentence(halted).replace(" No policy acts until the halt file is removed.", "")} ${count}${states ? `, ${states}` : ""}.`;
}

