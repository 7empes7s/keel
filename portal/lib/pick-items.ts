import { impactTone, impactWords, itemKindName, itemService } from "@/lib/baselines-view";
import { changeName } from "@/lib/changes-view";
import { controlName, controlService, standardName } from "@/lib/compliance-view";
import type { PickItem } from "@/lib/pick-summary";
import { BLAST_RADIUS_ORDER } from "@/lib/presentation";
import { serviceOrder } from "@/lib/services";
import { itemKind, kindOrder } from "@/lib/type-groups";
import type { ComplianceFinding, DriftRecord } from "@/lib/types";

const rankIn = (order: readonly string[], value: string) => {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
};

/** One chosen change as a confirm panel lists it: its name, kind, service and risk. */
export function changePick(item: DriftRecord): PickItem {
  const service = itemService(item);
  const kind = itemKindName(item);
  return {
    id: item.id,
    name: changeName(item),
    service: { key: service.code, label: service.name, icon: service.icon, rank: serviceOrder(service.code) },
    kind: { key: kind, label: kind, rank: kindOrder(itemKind(item), service.code) },
    risk: { key: item.blastRadius, label: impactWords(item.blastRadius), tone: impactTone(item.blastRadius), rank: rankIn(BLAST_RADIUS_ORDER, item.blastRadius) },
  };
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];
const SEVERITY_WORDS: Record<string, { label: string; tone: "urgent" | "soon" | "low" }> = {
  critical: { label: "Critical", tone: "urgent" },
  high: { label: "High", tone: "urgent" },
  medium: { label: "Medium", tone: "soon" },
  low: { label: "Low", tone: "low" },
};

/** One chosen control as a confirm panel lists it: its name, standard, service and how
 * serious it is (when the standard says). */
export function findingPick(finding: ComplianceFinding): PickItem {
  const service = controlService(finding);
  const standard = standardName(finding);
  const severity = finding.severity ? SEVERITY_WORDS[finding.severity] : undefined;
  return {
    id: finding.id,
    name: controlName(finding),
    service: { key: service.code, label: service.name, icon: service.icon, rank: serviceOrder(service.code) },
    kind: { key: standard, label: standard, rank: 0 },
    risk: severity && finding.severity ? { key: finding.severity, label: severity.label, tone: severity.tone, rank: rankIn(SEVERITY_ORDER, finding.severity) } : null,
  };
}
