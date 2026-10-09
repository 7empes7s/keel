import { resourceLabel } from "@/lib/presentation";

// Roadmap task-152: a Conditional Access policy the backup had turned on is always
// restored report-only. Turning it back on is a separate step, approved by a second
// person, so the restore lists it here instead of calling itself done.
export interface PendingStep {
  naturalKey: string;
  resourceType: string;
  step: string;
  snapshotState: string;
  restoredState: string;
  description: string;
}

export function PendingSteps({ steps }: { steps?: PendingStep[] | null }) {
  if (!steps?.length) return null;
  return (
    <div className="pending-steps">
      <p className="severity-label">Still to do after this restore</p>
      <ul className="closure-list">
        {steps.map((step) => (
          <li key={`${step.step}:${step.naturalKey}`}>
            <strong>{resourceLabel(step.naturalKey)}</strong>: the backup had this policy turned on. It is restored in
            report-only mode and protects no one until it is turned on in a separate step that a second person approves,
            after KEEL checks that every break-glass account can still sign in.
          </li>
        ))}
      </ul>
    </div>
  );
}
