// The calls the Notifications page makes, kept apart from the page so the control-to-
// route boundary is tested without a browser: each button reaches the right route with
// the right method and body.
export interface CallResult {
  ok: boolean;
  status: number;
  payload: Record<string, unknown> | null;
}

async function call(url: string, method: string, body?: unknown): Promise<CallResult> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  return { ok: response.ok, status: response.status, payload };
}

const id = (value: string) => encodeURIComponent(value);

export const notificationCalls = {
  addChannel: (kind: string, config: Record<string, string>) => call("/api/channels", "POST", { kind, config }),
  testChannel: (channelId: string) => call(`/api/channels/${id(channelId)}/test`, "POST"),
  turnChannelOff: (channelId: string) => call(`/api/channels/${id(channelId)}/disable`, "POST"),
  turnChannelOn: (channelId: string) => call(`/api/channels/${id(channelId)}/enable`, "POST"),
  addRule: (rule: { channelId: string; eventGlob: string; minSeverity: string }) => call("/api/subscriptions", "POST", rule),
  changeRule: (ruleId: string, rule: { channelId: string; eventGlob: string; minSeverity: string }) => call(`/api/subscriptions/${id(ruleId)}`, "PATCH", rule),
  deleteRule: (ruleId: string) => call(`/api/subscriptions/${id(ruleId)}`, "DELETE"),
  addEscalation: (rule: { minSeverity: string; ackWithinMs: number; channelId: string; ownerPrincipalId: string | null }) => call("/api/escalation-rules", "POST", rule),
  turnEscalationOff: (ruleId: string) => call(`/api/escalation-rules/${id(ruleId)}/disable`, "POST"),
  turnEscalationOn: (ruleId: string) => call(`/api/escalation-rules/${id(ruleId)}/enable`, "POST"),
};
