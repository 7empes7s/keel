import type { PrincipalView } from "@/lib/principals";

export function PrincipalDetails({ principal }: { principal: PrincipalView }) {
  return <section className={`item-card principal-card${principal.disabled_at ? " principal-disabled" : ""}`}>
    <div className="item-card-head">
      <h2>{principal.email}</h2>
      <span className={principal.disabled_at ? "inactive-indicator" : "active-indicator"}>{principal.disabled_at ? "Disabled" : "Active"}</span>
    </div>
    <div className="principal-meta">
      <p>Principal ID: {principal.id}</p>
      <p>Disabled at: {principal.disabled_at ?? "Not disabled"}</p>
      <p>Effective capabilities: {principal.capabilities.join(", ") || "None"}</p>
    </div>
    <h3>Role grants</h3>
    {principal.role_grants.length === 0 ? <p className="field-help">No role grants.</p> : <div className="table-scroll"><table className="data-table">
      <thead><tr><th scope="col">Grant ID</th><th scope="col">Role</th><th scope="col">Active from</th><th scope="col">Active until</th></tr></thead>
      <tbody>{principal.role_grants.map((grant) => <tr key={grant.id}><td className="wrap-value" data-label="Grant ID"><code className="item-id">{grant.id}</code></td><th data-label="Role" scope="row"><span className="role-chip">{grant.role}</span></th><td data-label="Active from"><time dateTime={grant.active_from}>{grant.active_from}</time></td><td data-label="Active until">{grant.active_until ?? "Open-ended"}</td></tr>)}</tbody>
    </table></div>}
  </section>;
}
