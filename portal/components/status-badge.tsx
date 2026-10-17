import { Badge, type BadgeTone } from "@/components/ui/badge";
import { displayEnum } from "@/lib/presentation";

// Colour is risk only: a change that could lock admins out is urgent, one that
// affects access is soon, a cosmetic one is low. The kind of change is neutral.
const BLAST_TONES: Record<string, BadgeTone> = { "tenant-lockout": "urgent", "access-affecting": "soon", cosmetic: "low" };

export function BlastBadge({ value }: { value: string }) {
  return <Badge tone={BLAST_TONES[value] ?? "neutral"} icon={value === "tenant-lockout" ? "alert" : undefined}>{displayEnum("blastRadius", value)}</Badge>;
}

export function ChangeBadge({ value }: { value: string }) {
  return <Badge tone="neutral" icon={value === "added" ? "plus" : value === "removed" ? "close" : "swap"}>{displayEnum("changeType", value)}</Badge>;
}
