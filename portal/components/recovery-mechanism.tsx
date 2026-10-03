import { formatTimestamp, resourceLabel } from "@/lib/presentation";

// Roadmap task-64: how each resource of a reviewed dry run will be recovered.
// The mechanism is part of the immutable artifact and its plan digest, so what
// this table shows is exactly what promotion may execute. A manual or refused
// mechanism never writes.
export type RecoveryMechanismName =
  | "update-existing"
  | "soft-delete-restore"
  | "recreate"
  | "delete"
  | "manual"
  | "refused";

export interface RecoveryMechanism {
  naturalKey: string;
  mechanism: RecoveryMechanismName;
  idOutcome: "retained" | "new" | "terminal" | "none";
  retainedId: string | null;
  deadline: string | null;
  credentialMode: string | null;
  reason: string | null;
}

const LABELS: Record<RecoveryMechanismName, string> = {
  "update-existing": "Update in place",
  "soft-delete-restore": "Restore from deleted items",
  recreate: "Recreate",
  delete: "Delete",
  manual: "Manual handoff",
  refused: "Refused",
};

// Tone of each mechanism's pill: kept ids read as safe, a new id as caution, and
// a handoff or refusal as blocked.
const TONES: Record<RecoveryMechanismName, string> = {
  "update-existing": "ok",
  "soft-delete-restore": "ok",
  recreate: "warn",
  delete: "neutral",
  manual: "bad",
  refused: "bad",
};

const ID_LABELS: Record<RecoveryMechanism["idOutcome"], string> = {
  retained: "Same ID kept",
  new: "New ID assigned",
  terminal: "Removed",
  none: "—",
};

export function mechanismLabel(mechanism: RecoveryMechanismName): string {
  return LABELS[mechanism] ?? mechanism;
}

export function RecoveryMechanismTable({ mechanisms }: { mechanisms: RecoveryMechanism[] }) {
  if (mechanisms.length === 0) return null;
  return (
    <div className="recovery-mechanisms">
      <p className="severity-label">RECOVERY MECHANISM</p>
      <table className="data-table recovery-table">
        <thead>
          <tr>
            <th scope="col">Resource</th>
            <th scope="col">Mechanism</th>
            <th scope="col">Object ID</th>
            <th scope="col">Deadline</th>
          </tr>
        </thead>
        <tbody>
          {mechanisms.map((entry) => (
            <tr className={`mechanism-row mechanism-${entry.mechanism}`} key={entry.naturalKey}>
              <td data-label="Resource"><span className="resource-name">{resourceLabel(entry.naturalKey)}</span></td>
              <td data-label="Mechanism">
                <span className={`pill pill-${TONES[entry.mechanism] ?? "neutral"} mechanism-badge-${entry.mechanism}`}>{mechanismLabel(entry.mechanism)}</span>
                {entry.reason ? <small className="mechanism-reason">{entry.reason}</small> : null}
              </td>
              <td data-label="Object ID">{ID_LABELS[entry.idOutcome] ?? entry.idOutcome}</td>
              <td data-label="Deadline">{entry.deadline ? formatTimestamp(entry.deadline) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
