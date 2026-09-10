"use client";

// Client-side POST against the guarded action API (plan task 16). Every call carries
// an idempotency key generated per logical operation by the caller, so a double-submit
// or retry dedupes server-side while a genuinely new action does not. The parsed body
// is returned alongside the status so callers can tell an enqueued job apart from an
// approval request without re-fetching.
export async function postAction(
  path: string,
  body: Record<string, unknown>,
  idempotencyKey: string,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotencyKey,
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`Action request failed (${response.status})`);
  }
  const payload = (await response.json()) as Record<string, unknown>;
  return { status: response.status, payload };
}
