import {
  BreakGlassAuthorizationError, findBreakGlassCandidate, recordBreakGlassLifecycle, registerBreakGlassAccount, retireBreakGlassAccount,
} from "../../../../../engine/safety/breakGlassReadiness.mjs";

import { guarded, readActionParams } from "@/lib/action";
import { requireOptionalReason, refuseWeakReason } from "@/lib/written-reason";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "cache-control": "no-store" } as const;

type Params = Record<string, unknown>;
type Client = Parameters<typeof registerBreakGlassAccount>[0];

class NotFound extends Error {}

// Emergency access: register, edit and retire emergency accounts, and record what a
// person did with one (a test sign-in, a credential change, its sign-in methods). The
// route checks `configuration`; each engine write checks the actor's CURRENT grant
// again. Everything is written to KEEL's own database as evidence; nothing here signs
// in, changes a credential or writes to the tenant.
const OPERATIONS: Record<string, (client: Client, tenantRef: string, actor: string, params: Params) => Promise<unknown>> = {
  register: async (client, tenantRef, actor, { accountId, signInName, label, validationIntervalDays, rotationIntervalDays }) => {
    let id = typeof accountId === "string" ? accountId : null;
    let name = typeof label === "string" && label.trim() ? label.trim() : null;
    if (!id) {
      const found = await findBreakGlassCandidate(client, { tenantRef, signInName: signInName as string });
      if (!found) throw new NotFound("No account with that sign-in name is in the latest backup of accounts. Back up accounts, then try again.");
      id = found.accountId;
      name ??= found.signInName;
    }
    const account = await registerBreakGlassAccount(client, {
      tenantRef, actor, accountId: id, label: name ?? id,
      validationIntervalDays: (validationIntervalDays ?? 90) as number, rotationIntervalDays: (rotationIntervalDays ?? null) as never,
    });
    return { account: { accountId: account.account_id } };
  },
  retire: async (client, tenantRef, actor, { accountId, reason }) => {
    const account = await retireBreakGlassAccount(client, { tenantRef, actor, accountId: accountId as string, reason: refuseWeakReason(reason) as string });
    return { account: { accountId: account.account_id } };
  },
  record: async (client, tenantRef, actor, { accountId, kind, occurredAt, note, methods }) => {
    const event = await recordBreakGlassLifecycle(client, {
      tenantRef, actor, accountId: accountId as string, kind: kind as string,
      occurredAt: (occurredAt ?? new Date().toISOString()) as never,
      note: requireOptionalReason(note, "note") as never,
      methods: (methods ?? null) as never,
    });
    return { event: { kind: event.kind, occurredAt: new Date(event.occurred_at).toISOString() } };
  },
};

// The engine's refusals, in words a person can act on. An error not listed here is
// not a refusal and goes on as a failure.
const REFUSALS: [RegExp, string][] = [
  [/must be \d+ to \d+ days/, "Pick a number of days in the allowed range."],
  [/past instant/, "The time must be in the past."],
  [/no active emergency account/, "That account is not an emergency account any more. Reload the page."],
  [/reason is required/, "Write why. It is kept with the record."],
  [/note must be/, "Keep the note under 500 characters."],
  [/method/, "Choose the sign-in methods from the list."],
  [/object id|short plain name|kind must be/, "Keel could not read that request. Reload the page and try again."],
];

export const POST = guarded(
  { action: "breakglass", capability: "configuration", recordAttempt: true },
  async ({ client, principalId, tenantRef, request }) => {
    const params = (await readActionParams(request)) as Params;
    const operation = typeof params.op === "string" && Object.hasOwn(OPERATIONS, params.op) ? OPERATIONS[params.op] : null;
    if (!operation) return Response.json({ error: "invalid_request" }, { status: 400, headers: NO_STORE });
    try {
      return Response.json(await operation(client as Client, tenantRef, principalId, params), { headers: NO_STORE });
    } catch (error) {
      if (error instanceof BreakGlassAuthorizationError) return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
      if (error instanceof NotFound) return Response.json({ error: "not_found", message: error.message }, { status: 404, headers: NO_STORE });
      const message = error instanceof Error ? error.message : "";
      const words = REFUSALS.find(([pattern]) => pattern.test(message))?.[1];
      if (words) return Response.json({ error: "refused", message: words }, { status: 409, headers: NO_STORE });
      throw error;
    }
  },
);
