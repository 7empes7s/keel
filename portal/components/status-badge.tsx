import { PROTECTION_STATE_LABEL, displayEnum } from "@/lib/presentation";
import type { CoverageType, ProtectionState } from "@/lib/types";

export function ProtectionBadge({ item }: { item: CoverageType }) {
  let label = PROTECTION_STATE_LABEL[item.protectionState];

  if (item.protectionState === "protected") {
    label = item.fidelity.measured ? "Verified protected" : "Declared protected";
  } else if (item.protectionState === "partially-protected") {
    label = item.fidelity.measured
      ? "Verified partial"
      : "Declared partial";
  }

  return (
    <span className={`state-badge state-${item.protectionState}`}>{label}</span>
  );
}

export function BlastBadge({ value }: { value: string }) {
  return <span className={`blast-badge blast-${value}`}>{displayEnum("blastRadius", value)}</span>;
}

export function ChangeBadge({ value }: { value: string }) {
  return <span className={`change-badge change-${value}`}>{displayEnum("changeType", value)}</span>;
}

export function StateBadge({ state }: { state: ProtectionState }) {
  return (
    <span className={`state-badge state-${state}`}>
      {PROTECTION_STATE_LABEL[state]}
    </span>
  );
}
