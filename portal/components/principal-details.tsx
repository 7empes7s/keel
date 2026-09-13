import type { PrincipalView } from "@/lib/principals";

export function PrincipalDetails({ principal }: { principal: PrincipalView }) {
  return <section>
    <h2>{principal.email}</h2>
    <p>Principal ID: {principal.id}</p>
    <p>Disabled at: {principal.disabled_at ?? "Not disabled"}</p>
    <p>Effective capabilities: {principal.capabilities.join(", ") || "None"}</p>
    <h3>Role grants</h3>
    {principal.role_grants.length === 0 ? <p>No role grants.</p> : <table>
      <thead><tr><th>Grant ID</th><th>Role</th><th>Active from</th><th>Active until</th></tr></thead>
      <tbody>{principal.role_grants.map((grant) => <tr key={grant.id}><td>{grant.id}</td><td>{grant.role}</td><td>{grant.active_from}</td><td>{grant.active_until ?? "Open-ended"}</td></tr>)}</tbody>
    </table>}
  </section>;
}
