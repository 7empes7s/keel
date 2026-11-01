import type { EntityScope } from "@/lib/principal";

/** What the menu shows on every page: the approvals badge and the person's name. */
export interface ShellLookups {
  pendingApprovals: number | null;
  displayName: string | null;
}

export interface ShellLookupInputs {
  // Null when the person may not approve: no count is read and the badge is hidden.
  approverScope: EntityScope | null;
  // Null when the request carries no principal: no name is read.
  principalId: string | null;
}

export interface ShellLookupLoaders {
  // The count of requests this person can decide: their own requests are left out.
  pendingApprovalCount(scope: EntityScope, principalId: string | null): Promise<number>;
  displayName(principalId: string): Promise<string | null>;
}

// A failed read hides that one piece (no badge, or the email-derived label) rather than
// breaking every page's chrome or the other lookup.
async function orNull<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch {
    return null;
  }
}

/**
 * The layout's two database reads, run at the same time on separate pooled
 * connections. They are independent, so every page waits for the slower one only,
 * not for both one after the other.
 */
export async function loadShellLookups(
  { approverScope, principalId }: ShellLookupInputs,
  loaders: ShellLookupLoaders,
): Promise<ShellLookups> {
  const [pendingApprovals, displayName] = await Promise.all([
    approverScope ? orNull(() => loaders.pendingApprovalCount(approverScope, principalId)) : Promise.resolve(null),
    principalId ? orNull(() => loaders.displayName(principalId)) : Promise.resolve(null),
  ]);
  return { pendingApprovals, displayName };
}
