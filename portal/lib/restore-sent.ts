// What a person sees after sending a restore. It waits for an approver, unless restore
// approvals are off for every service it writes to: then it was approved as it was
// sent and starts on its own (or, when planned from the command line, an operator runs it).

export interface RestoreSentNotice {
  started: boolean;
  title: string;
  detail: string;
  href: string;
  hrefLabel: string;
}

function list(services: string[]): string {
  if (services.length <= 1) return services[0] ?? "";
  return `${services.slice(0, -1).join(", ")} and ${services[services.length - 1]}`;
}

/** The notice for one sent restore, from the approval request the server returned. */
export function restoreSentNotice(approvalRequest: unknown): RestoreSentNotice {
  const request = (approvalRequest ?? {}) as { status?: unknown; executor?: unknown; approvalSkippedFor?: unknown };
  const skipped = Array.isArray(request.approvalSkippedFor) ? request.approvalSkippedFor.map(String) : [];
  if (request.status === "approved" && skipped.length > 0) {
    const why = `Restore approvals are off for ${list(skipped)}, so it did not wait for an approver.`;
    return request.executor === "cli"
      ? { started: true, title: "Restore approved", detail: `${why} An operator runs it from the command line.`, href: "/approvals", hrefLabel: "Open approvals" }
      : { started: true, title: "Restore started", detail: why, href: "/activity", hrefLabel: "Open activity" };
  }
  return { started: false, title: "Sent to approvers", detail: "Nothing changes until one of them approves.", href: "/approvals", hrefLabel: "Open approvals" };
}
