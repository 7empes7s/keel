import { RecordField } from "@/components/technical-details";
import { personName } from "@/lib/people-view";
import type { PrincipalView } from "@/lib/principals";

// One person's ids and codes, for the page's one Technical details: the principal id
// with how to use it, the engine's capability answer, and each grant id with its window.
export function PersonRecord({ person }: { person: PrincipalView }) {
  const name = personName(person);
  return <>
    <RecordField label={`${name}: principal ID`} usage={<>use with <code>POST /api/principals/&lt;id&gt;/grant</code></>} value={person.id} />
    <RecordField copy={false} label={`${name}: effective capabilities`} value={person.capabilities.join(", ") || "none"} />
    {Object.entries(person.entity_capabilities ?? {}).map(([entity, capabilities]) => (
      <RecordField copy={false} key={entity} label={`${name}: capabilities for ${entity} only`} value={capabilities.join(", ")} />
    ))}
    {person.system_kind ? <RecordField copy={false} label={`${name}: system account`} value={person.system_kind} /> : null}
    <RecordField copy={false} label={`${name}: disabled at`} value={person.disabled_at ?? "not disabled"} />
    {person.role_grants.map((grant) => (
      <RecordField key={grant.id} label={`${name}: grant ID (${grant.role}, scope ${grant.scope ?? "*"})`} usage={`active ${grant.active_from} → ${grant.active_until ?? "open-ended"}${grant.granted_by ? ` · granted by ${grant.granted_by}` : ""}`} value={grant.id} />
    ))}
  </>;
}
