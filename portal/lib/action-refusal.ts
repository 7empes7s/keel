// The plain reason an action route gave for a refusal people should read, or null.
// Only a restore settings path refusal carries words meant for the page; every other
// refusal keeps the caller's own wording. Not a "use client" module, so server and
// client code can both import it.
export function plainRefusal(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const { error, message } = payload as { error?: unknown; message?: unknown };
  return error === "restore_settings_path" && typeof message === "string" ? message : null;
}
