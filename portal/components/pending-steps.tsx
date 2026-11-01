import { ApprovalText } from "@/components/approval-mode-context";
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
            report-only mode and protects no one until it is turned on in a separate step that <ApprovalText phrase="approver" /> approves,
            after KEEL checks that every break-glass account can still sign in.
          </li>
        ))}
      </ul>
    </div>
  );
}

// Issue #546: a step a writer leaves for a person on one object (assignments the
// backup did not read, a trust setting a restore never writes). A dry run keeps
// them on each object's result as `completion`: one step or a list.
export interface ObjectStep {
  kind?: string;
  requirement?: string;
  description?: string;
}

export interface ObjectWithSteps {
  naturalKey: string;
  completion?: ObjectStep | ObjectStep[] | null;
}

export function objectSteps(entries?: ObjectWithSteps[] | null): { naturalKey: string; requirement: string; description: string }[] {
  return (entries ?? []).flatMap((entry) => [entry.completion ?? []].flat()
    .filter((step): step is ObjectStep & { description: string } => typeof step?.description === "string" && step.description.length > 0)
    .map((step) => ({ naturalKey: entry.naturalKey, requirement: step.requirement ?? "step", description: step.description })));
}

export function ObjectSteps({ entries, label = resourceLabel }: { entries?: ObjectWithSteps[] | null; label?: (naturalKey: string) => string }) {
  const steps = objectSteps(entries);
  if (!steps.length) return null;
  return (
    <div className="alert alert-warning object-steps" role="status">
      <span className="alert-severity">By hand</span>
      <div>
        <h3>{steps.length === 1 ? "1 step is left for a person" : `${steps.length} steps are left for a person`}</h3>
        <ul className="closure-list">
          {steps.map((step, index) => (
            <li key={`${step.naturalKey}:${step.requirement}:${index}`}>
              <strong>{label(step.naturalKey)}</strong>: {step.description}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
