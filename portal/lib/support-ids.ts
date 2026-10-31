// Microsoft support asks for the request-id, client-request-id and time of a failed
// call. The engine stores them on a failed read (operator queue Q301: To Do settings
// answered 500 UnknownError and Keel kept no id). Only GUIDs are kept.

export interface SupportIds {
  requestId?: string;
  clientRequestId?: string;
  requestAt?: string;
}

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The ids of a failed Microsoft call, as the engine stored them: GUIDs only, and a time. */
export function supportIds(entry: { requestId?: unknown; clientRequestId?: unknown; requestAt?: unknown } | null | undefined): SupportIds {
  const ids: SupportIds = {};
  if (typeof entry?.requestId === "string" && GUID_PATTERN.test(entry.requestId)) ids.requestId = entry.requestId;
  if (typeof entry?.clientRequestId === "string" && GUID_PATTERN.test(entry.clientRequestId)) ids.clientRequestId = entry.clientRequestId;
  if ((ids.requestId || ids.clientRequestId) && typeof entry?.requestAt === "string" && !Number.isNaN(Date.parse(entry.requestAt))) {
    ids.requestAt = new Date(entry.requestAt).toISOString();
  }
  return ids;
}

/** Plain lines for a Microsoft support case: the request ids and when Microsoft answered. */
export function supportLines(ids: SupportIds | null | undefined): string[] {
  if (!ids?.requestId && !ids?.clientRequestId) return [];
  return [
    ids.requestId ? `Microsoft request ID: ${ids.requestId}` : null,
    ids.clientRequestId ? `Client request ID: ${ids.clientRequestId}` : null,
    ids.requestAt ? `Microsoft answered at: ${ids.requestAt.replace("T", " ").replace(/\.\d+Z$|Z$/, "")} UTC` : null,
    "Quote these in a Microsoft support case.",
  ].filter((line): line is string => line !== null);
}
