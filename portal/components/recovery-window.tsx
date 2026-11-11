import { formatTimestamp } from "@/lib/presentation";

// Issue #1076: how long a deleted setting can still be recovered from the recycle bin,
// worked out on the server (lib/recovery-window.ts) from its deleted date + 30 days.
// "closing" is 7 days or fewer. Pure, so tests and client components share the words.
export interface RecoveryWindow {
  deadline: string;
  daysLeft: number;
  state: "open" | "closing" | "expired";
}

const days = (count: number) => `${count} ${count === 1 ? "day" : "days"} left`;

/** `recreates`: say that a restore recreates an expired one (the Changes list). A dry run
 * that refused it says only that it can no longer be recovered; its steps say the rest. */
export function recoveryWindowWords(window: RecoveryWindow, { recreates = true } = {}): string {
  if (window.state === "expired") return recreates ? "Can no longer be recovered from the recycle bin, so KEEL recreates it" : "Can no longer be recovered from the recycle bin";
  const until = `Can be recovered until ${formatTimestamp(window.deadline)}`;
  return window.state === "closing" ? `${until} (${days(window.daysLeft)})` : until;
}

export function RecoveryWindowNote({ window, recreates = true }: { window?: RecoveryWindow | null; recreates?: boolean }) {
  if (!window) return null;
  return <small className={`recovery-window recovery-window-${window.state}`}>{recoveryWindowWords(window, { recreates })}</small>;
}
