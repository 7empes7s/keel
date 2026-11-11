// Issue #1076: the recovery window of each deleted setting, worked out on the server
// from its deleted date (engine/restore/recoveryMechanism.mjs recoveryWindow).
import { SOFT_DELETABLE } from "../../engine/reconcile/liveState.mjs";
import { recoveryWindow } from "../../engine/restore/recoveryMechanism.mjs";
import { currentDeletedItems } from "../../engine/store/deletedItems.mjs";
import type { RecoveryWindow } from "@/components/recovery-window";
import type { DriftRecord } from "@/lib/types";

interface QueryClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const sourceIdOf = (item: DriftRecord): string | null => {
  const id = (item.before as { id?: unknown } | null)?.id;
  return typeof id === "string" && id.length > 0 ? id.toLowerCase() : null;
};

/** Each removed user, group, app or Conditional Access policy that the latest backup
 * still found in the recycle bin gets its window. One query, however many changes. */
export async function withRecoveryWindows(client: QueryClient, tenantRef: string, items: DriftRecord[], now = new Date()): Promise<DriftRecord[]> {
  const removed = items.filter((item) => item.changeType === "removed" && SOFT_DELETABLE.has(item.resourceType) && sourceIdOf(item));
  if (removed.length === 0) return items;
  const deleted = await currentDeletedItems(client, { tenantRef, sourceIds: removed.map(sourceIdOf) }) as Map<string, string>;
  return items.map((item) => {
    const deletedDateTime = item.changeType === "removed" ? deleted.get(`${item.resourceType}|${sourceIdOf(item)}`) : undefined;
    return deletedDateTime ? { ...item, recovery: recoveryWindow({ deletedDateTime }, { now }) as RecoveryWindow } : item;
  });
}

/** A dry run's mechanisms, each with the window of its recycle bin deadline. */
export function mechanismsWithWindows<T extends { deadline?: string | null }>(mechanisms: T[] | null | undefined, now = new Date()): (T & { window?: RecoveryWindow })[] | null {
  if (!mechanisms) return null;
  return mechanisms.map((entry) => {
    const window = entry.deadline ? recoveryWindow({ deadline: entry.deadline }, { now }) as RecoveryWindow | null : null;
    return window ? { ...entry, window } : entry;
  });
}
