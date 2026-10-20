// The one call a decision makes, kept apart from the page so the browser-control-to-
// route boundary is tested on its own: the request id and the rejection reason reach
// the right route with the right body.
export type Decision = "approve" | "reject";

export interface DecisionResult {
  ok: boolean;
  status: number;
  payload: Record<string, unknown> | null;
}

export async function decideRequest(id: string, decision: Decision, reason = ""): Promise<DecisionResult> {
  const response = await fetch(`/api/approvals/${encodeURIComponent(id)}/${decision}`, {
    method: "POST",
    headers: decision === "reject" ? { "content-type": "application/json" } : undefined,
    body: decision === "reject" ? JSON.stringify({ reason }) : undefined,
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, payload };
}
