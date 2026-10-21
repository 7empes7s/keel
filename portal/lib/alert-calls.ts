// The calls the Alerts page makes, kept apart from the page so the control-to-route
// boundary is tested without a browser. Acknowledge and resolve post to the respond
// route (`dispose-accept`); mute and unmute post to the mute route (`policies`). One
// call per alert, each with its own idempotency key.
export type AlertAction = "acknowledge" | "resolve" | "mute" | "unmute";

export interface AlertCallResult {
  ok: boolean;
  status: number;
  state: string | null;
}

export const ALERT_ROUTES: Record<AlertAction, string> = {
  acknowledge: "/api/actions/alerts",
  resolve: "/api/actions/alerts",
  mute: "/api/actions/alerts/mute",
  unmute: "/api/actions/alerts/mute",
};

export async function alertCall(alertId: string, action: AlertAction, note?: string): Promise<AlertCallResult> {
  const body: Record<string, string> = { alertId, action };
  if (note?.trim()) body.note = note.trim();
  const response = await fetch(ALERT_ROUTES[action], {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as { alert?: { state?: unknown } } | null;
  const state = typeof payload?.alert?.state === "string" ? payload.alert.state : null;
  return { ok: response.ok, status: response.status, state };
}

/** The API's answer in words, for a toast. */
export function alertCallWords(result: AlertCallResult): string | null {
  if (result.ok) return null;
  if (result.status === 403) return "You need the right role for that, or your sign-in has ended.";
  if (result.status === 409) return "Someone else changed it first. The list now shows where it stands.";
  if (result.status === 400) return "Keel could not read that request. Try again.";
  return "Keel could not record that. Try again.";
}
