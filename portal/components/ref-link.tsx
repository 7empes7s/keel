import Link from "next/link";

import { refLabel, type EngineRef } from "@/lib/sentences";

// Portal experience contract, rule 2 and mechanical check 4: a reference renders as
// its name, linked to its page when it has one. data-ref marks it for the check.
export function RefLink({ refValue, href, fallback }: { refValue: EngineRef | null | undefined; href?: string | null; fallback?: string }) {
  const label = refLabel(refValue, fallback);
  if (!refValue || !refValue.readable || !href) return <span data-ref={refValue?.kind ?? "none"}>{label}</span>;
  return <Link data-ref={refValue.kind} href={href}>{label}</Link>;
}
