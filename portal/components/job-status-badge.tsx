const STATUS_LABEL: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
};

// Keyed by status so a refresh that changes it remounts the badge and replays its
// entrance — the change is seen, not just silently swapped.
export function JobStatusBadge({ status }: { status: string }) {
  return (
    <span className={`job-status job-status-${status}`} key={status}>
      {status === "running" || status === "queued" ? (
        <span aria-hidden="true" className="job-status-dot" />
      ) : null}
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}
