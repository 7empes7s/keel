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
    // A rejection always has a reason; an approval has one only when the person approves
    // their own request (solo approval mode).
    headers: decision === "reject" || reason ? { "content-type": "application/json" } : undefined,
    body: decision === "reject" || reason ? JSON.stringify({ reason }) : undefined,
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, payload };
}
