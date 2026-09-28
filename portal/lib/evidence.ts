import { verifyAnchoredChain } from "../../engine/govern/anchor.mjs";
import { guarded, InvalidActionRequest, type GuardDeps } from "@/lib/action";

const NO_STORE = { "cache-control": "no-store" };
export interface EvidenceEntry {
  seq: string;
  occurred_at: string;
  kind: string;
  subject: unknown;
  actor: string;
}
export interface EvidenceData {
  entries: EvidenceEntry[];
  nextBefore: string | null;
  generatedAt: string;
}
export type ChainIntegrity = {
  ok: boolean;
  status: "verified" | "broken-at-sequence" | "truncated" | "unanchored";
  brokenAtSeq?: string;
  reason?: string;
  anchoredThroughSeq?: string;
  unanchoredRecords?: number;
};

export function guardedEvidenceList(deps: GuardDeps = {}) {
  return guarded({ action: "evidence:list", capability: "read" }, async ({ client, tenantRef, request }) => {
    const params = new URL(request.url).searchParams;
    const limit = Number(params.get("limit") ?? 50);
    const before = params.get("before");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200
      || (before !== null && (!/^[1-9][0-9]*$/.test(before) || BigInt(before) > BigInt("9223372036854775807")))) {
      throw new InvalidActionRequest();
    }
    const from = params.get("from") || null;
    const to = params.get("to") || null;
    for (const date of [from, to]) {
      if (date !== null && (!/^\d{4}-\d{2}-\d{2}(?:T.*Z)?$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date.slice(0, 10))) throw new InvalidActionRequest();
    }
    if (from && to && Date.parse(from) > Date.parse(to)) throw new InvalidActionRequest();
    const { rows } = await client.query(`
      SELECT seq, occurred_at, kind, subject, actor FROM evidence
      WHERE tenant_ref = $1
        AND ($2::text IS NULL OR kind = $2)
        AND ($3::timestamptz IS NULL OR occurred_at >= $3)
        AND ($4::timestamptz IS NULL OR occurred_at <= $4)
        AND ($5::bigint IS NULL OR seq < $5)
      ORDER BY seq DESC LIMIT $6`,
    [tenantRef, params.get("kind") || null, from ? new Date(from).toISOString() : null, to ? new Date(to).toISOString() : null, before, limit + 1]);
    const entries = rows.slice(0, limit).map((row) => ({ ...row, seq: String(row.seq) }));
    return Response.json({ entries, nextBefore: rows.length > limit ? entries.at(-1)!.seq : null, generatedAt: new Date().toISOString() }, { headers: NO_STORE });
  }, deps);
}

export function guardedEvidenceVerify(deps: GuardDeps = {},
  anchorOptions: (tenantRef: string) => Promise<Record<string, unknown>> = async () => ({})) {
  return guarded({ action: "evidence:verify", capability: "read" }, async ({ client, tenantRef }) => {
    return Response.json(await verifyAnchoredChain(client, { ...await anchorOptions(tenantRef), tenantRef, authorize: async () => true }), { headers: NO_STORE });
  }, deps);
}
