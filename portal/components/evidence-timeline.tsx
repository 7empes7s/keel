import Link from "next/link";
import type { ChainIntegrity, EvidenceData } from "@/lib/evidence";

export function ChainIndicator({ integrity }: { integrity: ChainIntegrity | null }) {
  return <section role="status" className={`evidence-integrity ${integrity === null ? "" : integrity.ok ? "evidence-intact" : "evidence-broken"}`}>
    <h2>{integrity === null ? "Chain integrity unavailable" : integrity.ok ? "Chain integrity verified" : "Chain integrity failed"}</h2>
    <p>Verification covers the entire tenant evidence chain, regardless of timeline filters.</p>
    {integrity && !integrity.ok ? <pre className="job-payload">{JSON.stringify(integrity, null, 2)}</pre> : null}
  </section>;
}

export function EvidenceTimeline({ data, query }: { data: EvidenceData; query: string }) {
  const next = new URLSearchParams(query);
  if (data.nextBefore) next.set("before", data.nextBefore);
  const first = new URLSearchParams(query);
  first.delete("before");
  return <section aria-label="Evidence timeline">
    {data.entries.length === 0 ? <p>No evidence matches these filters.</p> : <ol className="evidence-timeline">
      {data.entries.map((entry) => <li key={entry.seq}>
        <h2>#{entry.seq} · {entry.kind}</h2>
        <p><time dateTime={entry.occurred_at}>{entry.occurred_at}</time> · {entry.actor}</p>
        <pre className="job-payload">{JSON.stringify(entry.subject, null, 2)}</pre>
      </li>)}
    </ol>}
    <nav aria-label="Evidence pagination">
      {new URLSearchParams(query).has("before") ? <Link className="secondary-action" href={`/evidence?${first}`}>Newest entries</Link> : null}
      {data.nextBefore ? <Link className="secondary-action" href={`/evidence?${next}`}>Older entries</Link> : null}
    </nav>
  </section>;
}
