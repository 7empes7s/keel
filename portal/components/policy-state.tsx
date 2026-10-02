import type { Policy } from "@/lib/policies";

export function KillSwitchBadge({ disabled }: { disabled: boolean }) {
  return <span role="status" className={`state-badge kill-switch ${disabled ? "kill-switch-halted" : "kill-switch-inactive"}`}>{disabled ? "Automation globally halted" : "Automation kill switch inactive"}</span>;
}

export function PolicyState({ policy }: { policy: Policy }) {
  return <dl className="kv-grid">
    <dt>Enabled</dt><dd>{policy.enabled ? "Yes" : "No"}</dd>
    <dt>Paused at</dt><dd>{policy.paused_at ?? "Not paused"}</dd>
    <dt>Run-as repair required</dt><dd>{policy.run_as_repair_required ? "Yes" : "No"}</dd>
    <dt>Run-as principal</dt><dd>{policy.run_as_principal_id ?? "None"}</dd>
    <dt>Action</dt><dd>{policy.action}</dd>
    <dt>Maximum blast radius</dt><dd>{policy.max_blast_radius}</dd>
    <dt>Rate limit</dt><dd>{policy.max_actions_per_window == null ? "Not configured" : `${policy.max_actions_per_window} actions / ${policy.window_seconds} seconds`}</dd>
    <dt>Resource type</dt><dd>{policy.resource_type ?? "Any"}</dd>
    <dt>Blast radius match</dt><dd>{policy.blast_radius ?? "Any"}</dd>
    <dt>Natural key glob</dt><dd>{policy.natural_key_glob ?? "Any"}</dd>
    <dt>Change type</dt><dd>{policy.change_type ?? "Any"}</dd>
  </dl>;
}
