import { RecordField } from "@/components/technical-details";
import type { Policy, PolicyAction } from "@/lib/policies";

// The record of one rule: every id and code the page shows in words. Rendered inside a
// TechnicalDetails (data-layer="record"), never in a visible row.
export function RuleRecord({ policy, actions = [] }: { policy: Policy; actions?: PolicyAction[] }) {
  return <>
    <RecordField label={`Policy ID: ${policy.name}`} usage={<>use with <code>keel-policy-evaluate --policy &lt;id&gt;</code> and <code>GET /api/policies/&lt;id&gt;</code></>} value={policy.id} />
    <RecordField label="Run-as principal ID" value={policy.run_as_principal?.id ?? policy.run_as_principal_id ?? null} />
    {policy.run_as_principal?.email ? <RecordField copy={false} label="Run-as account" value={policy.run_as_principal.email} /> : null}
    <RecordField copy={false} label="Action code" value={`${policy.action} · max blast radius ${policy.max_blast_radius}`} />
    <RecordField copy={false} label="Match" value={`resource_type=${policy.resource_type ?? "any"} · blast_radius=${policy.blast_radius ?? "any"} · natural_key_glob=${policy.natural_key_glob ?? "*"} · change_type=${policy.change_type ?? "any"}`} />
    <RecordField copy={false} label="Rate limit" value={policy.max_actions_per_window == null ? "none" : `${policy.max_actions_per_window} per ${policy.window_seconds} seconds`} />
    <RecordField copy={false} label="State" value={`enabled=${policy.enabled} · paused_at=${policy.paused_at ?? "null"} · run_as_repair_required=${policy.run_as_repair_required}`} />
    {policy.last_action_at ? <RecordField copy={false} label="Last action" value={`${policy.last_action_status ?? "unknown"} at ${policy.last_action_at} on ${policy.last_action_natural_key ?? "unknown"}${policy.last_action_job_id ? ` · job ${policy.last_action_job_id}` : ""}`} /> : null}
    <RecordField copy={false} label="Created" value={`${policy.created_at} by ${policy.created_by}`} />
    {actions.map((action) => (
      <RecordField key={action.job_id} label={`Action job ID (${action.status})`} usage={<>use with <code>GET /api/jobs/&lt;id&gt;</code> · drift {action.drift_id ?? "unknown"} · {action.natural_key ?? "unknown"} · queued {action.queued_at}{action.error ? ` · ${action.error}` : ""}</>} value={action.job_id} />
    ))}
  </>;
}
