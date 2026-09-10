export interface DriftActionControls {
  canDispose: boolean;
  canRemediate: boolean;
}

export function driftActionControls(
  capabilities: readonly string[],
): DriftActionControls {
  return {
    canDispose: capabilities.includes("dispose-accept"),
    canRemediate: capabilities.includes("remediate"),
  };
}

export function remediationParams({
  selectedDriftIds,
  visibleDriftIds: _visibleDriftIds,
  justification,
}: {
  selectedDriftIds: string[];
  visibleDriftIds: string[];
  justification: string;
}): { driftIds: string[]; justification: string } {
  // The visible page is deliberately not the action scope. Bulk remediation applies
  // only to the IDs the operator selected, including a selection retained across pages.
  void _visibleDriftIds;
  return { driftIds: selectedDriftIds, justification };
}
