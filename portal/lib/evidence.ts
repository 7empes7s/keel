import { verifyAnchoredChain } from "../../engine/govern/anchor.mjs";
import { getEvidenceIntegrity } from "../../status/queries.mjs";
import { evidenceChainCache } from "@/lib/evidence-chain-cache";
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
  // Only when there is no usable off-site checkpoint: the record's own chain checked
  // instead, so a broken chain is never shown as merely "not checked".
  ownChain?: "intact" | "broken";
};

/**
 * The check against the off-site checkpoint, and, when there is no usable checkpoint,
 * the record's own chain as well, so a broken chain still reads as failed.
 */
export async function checkAuditRecord(client: unknown, { tenantRef, anchor = {}, cache }: {
  tenantRef: string;
  anchor?: Record<string, unknown>;
  cache: Map<string, unknown>;
}): Promise<ChainIntegrity> {
  const result = await verifyAnchoredChain(client, { ...anchor, tenantRef, chainCache: cache, authorize: async () => true }) as ChainIntegrity;
  if (result.status !== "unanchored") return result;
  const own = await getEvidenceIntegrity(client, { tenantRef, chainCache: cache }) as { ok: boolean };
  return { ...result, ownChain: own.ok ? "intact" : "broken" };
}

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
    // Activity filters: `kind` and `actor` each take one value or a comma-separated list
    // (any of them matches). An actor is exactly as recorded (a principal id, an email,
    // or one of Keel's own accounts).
    const kinds = (params.get("kind") ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    if (kinds.some((kind) => !/^[a-z][a-z0-9.-]*$/.test(kind))) throw new InvalidActionRequest();
    const actors = [...new Set((params.get("actor") ?? "").split(",").map((value) => value.trim()).filter(Boolean))];
    if (actors.length > 50 || actors.some((actor) => actor.length > 320 || /[\s]/.test(actor))) throw new InvalidActionRequest();
    const { rows } = await client.query(`
      SELECT seq, occurred_at, kind, subject, actor FROM evidence
      WHERE tenant_ref = $1
        AND ($2::text[] IS NULL OR kind = ANY($2))
        AND ($3::timestamptz IS NULL OR occurred_at >= $3)
        AND ($4::timestamptz IS NULL OR occurred_at <= $4)
        AND ($5::bigint IS NULL OR seq < $5)
        AND ($7::text[] IS NULL OR actor = ANY($7))
      ORDER BY seq DESC LIMIT $6`,
    [tenantRef, kinds.length ? kinds : null, from ? new Date(from).toISOString() : null, to ? new Date(to).toISOString() : null, before, limit + 1, actors.length ? actors : null]);
    const entries = rows.slice(0, limit).map((row) => ({ ...row, seq: String(row.seq) }));
    return Response.json({ entries, nextBefore: rows.length > limit ? entries.at(-1)!.seq : null, generatedAt: new Date().toISOString() }, { headers: NO_STORE });
  }, deps);
}

// Security audit run 2, finding 10: the Activity page checks the chain on every load, so
// it uses the shared cache (lib/evidence-chain-cache.ts) and hashes only new records.
const chainCache = evidenceChainCache;

export function guardedEvidenceVerify(deps: GuardDeps = {},
  anchorOptions: (tenantRef: string) => Promise<Record<string, unknown>> = async () => ({}),
  cache: Map<string, unknown> = chainCache) {
  return guarded({ action: "evidence:verify", capability: "read" }, async ({ client, tenantRef }) => {
    return Response.json(await checkAuditRecord(client, { tenantRef, anchor: await anchorOptions(tenantRef), cache }), { headers: NO_STORE });
  }, deps);
}
