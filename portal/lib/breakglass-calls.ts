// The one call the Emergency access page makes to change an emergency account, kept
// apart from the page so the control-to-route boundary is tested without a browser.
// Every change is a record in KEEL's own database; nothing here writes to the tenant.
export type BreakglassOp = "register" | "retire" | "record";
export type LifecycleKind = "validated" | "credential-rotated" | "methods-attested";

export const BREAKGLASS_ROUTE = "/api/actions/breakglass";

export interface BreakglassCallResult {
  ok: boolean;
  status: number;
  // A sentence for the person when it did not work.
  reason: string | null;
}

export async function breakglassCall(op: BreakglassOp, params: Record<string, unknown>): Promise<BreakglassCallResult> {
  let response: Response;
  try {
    response = await fetch(BREAKGLASS_ROUTE, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ op, ...params }),
    });
  } catch {
    return { ok: false, status: 0, reason: "Keel could not be reached. Try again." };
  }
  if (response.ok) return { ok: true, status: response.status, reason: null };
  const payload = (await response.json().catch(() => null)) as { message?: unknown } | null;
  const message = typeof payload?.message === "string" ? payload.message : null;
  return { ok: false, status: response.status, reason: breakglassCallWords(response.status, message) };
}

/** The API's answer in words. The route sends plain sentences for a refusal. */
export function breakglassCallWords(status: number, message: string | null): string {
  if (status === 403) return "Only people who manage configuration can change emergency accounts, or your sign-in has ended.";
  if ((status === 404 || status === 409) && message) return message;
  if (status === 400) return "Keel could not read that request. Try again.";
  return "Keel could not record that. Try again.";
}
