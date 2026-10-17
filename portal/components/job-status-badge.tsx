import type { IconName } from "@/components/shell/icons";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { displayEnum } from "@/lib/presentation";

const STATUS: Record<string, { tone: BadgeTone; icon: IconName }> = {
  queued: { tone: "low", icon: "clock" },
  running: { tone: "soon", icon: "play" },
  succeeded: { tone: "fine", icon: "check-circle" },
  failed: { tone: "urgent", icon: "x-circle" },
  cancelled: { tone: "neutral", icon: "pause" },
};

export function jobStatusTone(status: string): BadgeTone {
  return STATUS[status]?.tone ?? "neutral";
}

// Keyed by status so a refresh that changes it remounts the badge and replays its
// entrance: the change is seen, not just silently swapped.
export function JobStatusBadge({ status }: { status: string }) {
  const look = STATUS[status] ?? { tone: "neutral" as const, icon: "info" as const };
  return (
    <Badge className="job-badge" icon={look.icon} key={status} tone={look.tone}>
      {displayEnum("jobStatus", status)}
    </Badge>
  );
}
