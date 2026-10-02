import type { Policy } from "@/lib/policies";

export function KillSwitchBadge({ disabled }: { disabled: boolean }) {
  return <span role="status" className={`state-badge kill-switch ${disabled ? "kill-switch-halted" : "kill-switch-inactive"}`}>{disabled ? "Automation globally halted" : "Automation kill switch inactive"}</span>;
}

function YesNo({ value, good }: { value: boolean; good: boolean }) {
  return <span className={value === good ? "active-indicator" : "inactive-indicator"}>{value ? "Yes" : "No"}</span>;
}

// Grouped by the question an operator asks: is it running, what may it do, and what
// does it match. Every field from the policy row is still shown.
export function PolicyState({ policy }: { policy: Policy }) {
  return <div className="policy-groups">
    <section aria-label="Status" className="policy-group">
      <h3>Status</h3>
      <dl className="kv-grid">
        <dt>Enabled</dt><dd><YesNo good value={policy.enabled} /></dd>
        <dt>Paused at</dt><dd>{policy.paused_at ?? "Not paused"}</dd>
        <dt>Run-as repair required</dt><dd><YesNo good={false} value={policy.run_as_repair_required} /></dd>
        <dt>Run-as principal</dt><dd>{policy.run_as_principal_id ?? "None"}</dd>
      </dl>
    </section>
    <section aria-label="Action and limits" className="policy-group">
      <h3>Action and limits</h3>
      <dl className="kv-grid">
        <dt>Action</dt><dd><span className="role-chip">{policy.action}</span></dd>
        <dt>Maximum blast radius</dt><dd>{policy.max_blast_radius}</dd>
        <dt>Rate limit</dt><dd>{policy.max_actions_per_window == null ? "Not configured" : `${policy.max_actions_per_window} actions / ${policy.window_seconds} seconds`}</dd>
      </dl>
    </section>
    <section aria-label="Match conditions" className="policy-group">
      <h3>Match conditions</h3>
      <dl className="kv-grid">
        <dt>Resource type</dt><dd>{policy.resource_type ?? "Any"}</dd>
        <dt>Blast radius match</dt><dd>{policy.blast_radius ?? "Any"}</dd>
        <dt>Natural key glob</dt><dd>{policy.natural_key_glob ?? "Any"}</dd>
        <dt>Change type</dt><dd>{policy.change_type ?? "Any"}</dd>
      </dl>
    </section>
  </div>;
}
