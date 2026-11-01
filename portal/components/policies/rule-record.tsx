import { RecordField, RecordGroup } from "@/components/technical-details";
import type { Policy, PolicyAction } from "@/lib/policies";

// The record of one rule: every id and code the page shows in words. Rendered inside a
// TechnicalDetails (data-layer="record"), never in a visible row.
export function RuleRecord({ policy, actions = [] }: { policy: Policy; actions?: PolicyAction[] }) {
  const runAs = policy.run_as_principal;
  return <>
    <RecordField label="Policy ID" usage={<>use with <code>keel-policy-evaluate --policy &lt;id&gt;</code> and <code>GET /api/policies/&lt;id&gt;</code></>} value={policy.id} />
    <RecordField label="Run-as account ID" usage={runAs ? [runAs.readable ? runAs.name : "no longer readable", runAs.email].filter(Boolean).join(" · ") : undefined} value={runAs?.id ?? policy.run_as_principal_id ?? null} />
    <RecordField copy={false} label="Action code" value={policy.action} />
    <RecordField copy={false} label="Largest reach allowed" value={policy.max_blast_radius} />
    <RecordField copy={false} label="Matches setting type" value={policy.resource_type ?? "any"} />
    <RecordField copy={false} label="Matches reach" value={policy.blast_radius ?? "any"} />
    <RecordField copy={false} label="Matches key pattern" value={policy.natural_key_glob ?? "*"} />
    <RecordField copy={false} label="Matches change type" value={policy.change_type ?? "any"} />
    <RecordField copy={false} label="Rate limit" value={policy.max_actions_per_window == null ? "none" : `${policy.max_actions_per_window} per ${policy.window_seconds} seconds`} />
    <RecordField copy={false} label="Enabled" value={policy.enabled} />
    <RecordField copy={false} label="Paused at" value={policy.paused_at} />
    <RecordField copy={false} label="Run-as needs repair" value={policy.run_as_repair_required} />
    <RecordField copy={false} label="Actions in the last 7 days" value={policy.actions_last_7_days} />
    {policy.last_action_at ? <>
      <RecordField copy={false} label="Last action" usage={[policy.last_action_name, policy.last_action_resource_type].filter(Boolean).join(" · ") || undefined} value={`${policy.last_action_status ?? "unknown"} at ${policy.last_action_at}`} />
      <RecordField label="Last action key" value={policy.last_action_natural_key} />
      {policy.last_action_job_id ? <RecordField label="Last action job ID" usage={<>use with <code>GET /api/jobs/&lt;id&gt;</code></>} value={policy.last_action_job_id} /> : null}
    </> : null}
    <RecordField copy={false} label="Created" value={policy.created_at} />
    <RecordField label="Created by (account ID)" value={policy.created_by} />
    {actions.map((action) => (
      <RecordGroup key={action.job_id} note={`automatic action · ${action.status}`} title={action.name ?? action.natural_key ?? "Unnamed change"}>
        <RecordField label="Action job ID" usage={<>use with <code>GET /api/jobs/&lt;id&gt;</code></>} value={action.job_id} />
        <RecordField copy={false} label="Status" value={action.status} />
        <RecordField copy={false} label="Queued" value={action.queued_at} />
        <RecordField copy={false} label="Finished" value={action.finished_at} />
        <RecordField label="Change ID" value={action.drift_id} />
        <RecordField label="Key" value={action.natural_key} />
        <RecordField copy={false} label="Setting type" value={action.resource_type} />
        <RecordField copy={false} label="Change type" value={action.change_type} />
        <RecordField copy={false} label="Reach" value={action.blast_radius} />
        {action.error ? <RecordField label="Error" value={action.error} /> : null}
      </RecordGroup>
    ))}
  </>;
}
