// The calls the Alerts page makes, kept apart from the page so the control-to-route
// boundary is tested without a browser. Acknowledge and resolve post to the respond
// route (`dispose-accept`); mute and unmute post to the mute route (`policies`). One
// call per alert, each with its own idempotency key.
export type AlertAction = "acknowledge" | "resolve" | "mute" | "unmute";

export interface AlertCallResult {
  ok: boolean;
  status: number;
  state: string | null;
  // After an acknowledge: who owns the alert now (the acknowledger), when Keel named them.
  owner?: { id: string; name: string; pseudonym?: boolean } | null;
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
  const payload = (await response.json().catch(() => null)) as { alert?: { state?: unknown; owner?: unknown } } | null;
  const state = typeof payload?.alert?.state === "string" ? payload.alert.state : null;
  const owner = ownerOf(payload?.alert?.owner);
  return { ok: response.ok, status: response.status, state, ...(owner ? { owner } : {}) };
}

function ownerOf(value: unknown): AlertCallResult["owner"] {
  const owner = value as { id?: unknown; name?: unknown; pseudonym?: unknown } | null | undefined;
  if (typeof owner?.id !== "string" || typeof owner.name !== "string" || !owner.name) return null;
  return { id: owner.id, name: owner.name, ...(owner.pseudonym === true ? { pseudonym: true } : {}) };
}

/** The API's answer in words, for a toast. */
export function alertCallWords(result: AlertCallResult): string | null {
  if (result.ok) return null;
  if (result.status === 403) return "You need the right role for that, or your sign-in has ended.";
  if (result.status === 409) return "Someone else changed it first. The list now shows where it stands.";
  if (result.status === 400) return "Keel could not read that request. Try again.";
  return "Keel could not record that. Try again.";
}
