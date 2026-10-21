import { changeRefusal } from "@/lib/policy-view";

// The calls the Policies pages make, in one place, so a test can check the control
// reaches the route without a React harness. Turning a rule on or off and resuming it
// go through the guarded routes (POST /api/policies/<id>/enabled and /clear-pause),
// which re-check the policies capability and, for an undo rule, the run-as account.
// Roadmap task-92: an undo rule that is off is turned on only from an activation
// preview; the enabled route refuses it with 409 and the words say so.

export type RuleChange = "turn-off" | "turn-on" | "resume";

export type ChangeResult = { ok: true } | { ok: false; reason: string };

function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify(body),
  });
}

export async function changeRule(policyId: string, change: RuleChange): Promise<ChangeResult> {
  const base = `/api/policies/${encodeURIComponent(policyId)}`;
  try {
    const response = change === "resume" ? await post(`${base}/clear-pause`, {}) : await post(`${base}/enabled`, { enabled: change === "turn-on" });
    if (response.ok) return { ok: true };
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    return { ok: false, reason: changeRefusal(response.status, body.error, change) };
  } catch {
    return { ok: false, reason: changeRefusal(0, undefined, change) };
  }
}

/** The body POST /api/policies takes (lib/policies.ts, guardedPolicyCreate). */
export interface NewRule {
  name: string;
  action: "alert" | "require_approval" | "auto_remediate";
  maxBlastRadius: "cosmetic" | "access-affecting" | "tenant-lockout";
  resourceType?: string | null;
  naturalKeyGlob?: string | null;
  changeType?: string | null;
  blastRadius?: string | null;
  maxActionsPerWindow?: number | null;
  windowSeconds?: number | null;
  runAsPrincipalId?: string | null;
}

export type CreateResult = { ok: true; id: string } | { ok: false; reason: string };

export async function createRule(rule: NewRule): Promise<CreateResult> {
  try {
    const response = await post("/api/policies", rule as unknown as Record<string, unknown>);
    if (response.ok) {
      const body = (await response.json()) as { policy: { id: string } };
      return { ok: true, id: body.policy.id };
    }
    if (response.status === 403) return { ok: false, reason: "You do not have the policies permission." };
    if (response.status === 409) return { ok: false, reason: "Undo rules are created off and turned on from a preview." };
    return { ok: false, reason: rule.action === "auto_remediate" ? "Keel could not create the rule. The account it acts as must hold the restorer role now." : "Keel could not create the rule. Check the name and the limits." };
  } catch {
    return { ok: false, reason: "Keel could not create the rule. Try again in a minute." };
  }
}
