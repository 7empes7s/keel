"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { DatePicker } from "@/components/pickers/date-picker";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Segmented } from "@/components/pickers/segmented";
import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { postAction } from "@/lib/action-client";
import { toDay, type Day, type DayRange } from "@/lib/date-range";
import { formatTimestamp } from "@/lib/presentation";
import type { SnapshotOption } from "@/lib/portal-jobs";
import { toast } from "@/lib/toast";

type Source = "latest" | "earlier";

const STEPS = ["Start from", "Name it", "Check and create"] as const;

const snapshotDay = (snapshot: SnapshotOption): Day | null => {
  const at = snapshot.completedAt ?? snapshot.startedAt;
  return at ? toDay(new Date(at)) : null;
};

const settings = (count: number) => `${count.toLocaleString("en-GB")} ${count === 1 ? "setting" : "settings"}`;

const backupWords = (snapshot: SnapshotOption, start = "The"): string =>
  `${start} backup of ${formatTimestamp(snapshot.completedAt ?? snapshot.startedAt)}`;

/** Create an approved setup in three short steps: where it comes from, its name, then a
 * check that says exactly what will happen before anything is queued. It goes through the
 * guarded action API; a new idempotency key per finished request means a double click
 * returns the same job, while a second, deliberate create queues a new one. */
export function CreateWizard({
  snapshots,
  completedSnapshotsExist,
  disabled,
  today,
}: {
  // Complete backups safe for a whole-tenant setup, newest first.
  snapshots: SnapshotOption[];
  completedSnapshotsExist: boolean;
  disabled: boolean;
  today: Day;
}) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [source, setSource] = useState<Source>("latest");
  const [day, setDay] = useState<DayRange | null>(null);
  const [chosenId, setChosenId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const backupDays = useMemo(() => new Set(snapshots.map(snapshotDay).filter((value): value is Day => value !== null)), [snapshots]);
  const onDay = day ? snapshots.filter((snapshot) => snapshotDay(snapshot) === day.from) : snapshots;
  const latest = snapshots[0] ?? null;
  const chosen = source === "latest" ? latest : snapshots.find((snapshot) => snapshot.id === chosenId) ?? null;

  if (!snapshots.length) {
    return (
      <section className="bl-card bl-empty">
        <span aria-hidden="true" className="bl-kind-icon" data-tone="soon"><Icon name="backup" /></span>
        <div>
          <h2>No backup to start from yet</h2>
          <p>
            {completedSnapshotsExist
              ? "Backups exist, but none read the whole tenant without errors. An approved setup needs one complete backup."
              : "An approved setup is copied from a complete backup, and there is none yet."}
          </p>
        </div>
        <Link className="btn btn-primary" href="/protect"><Icon name="backup" />Go to Backup</Link>
      </section>
    );
  }

  function next() {
    setError(null);
    if (step === 0 && !chosen) {
      setError("Choose the backup to start from.");
      return;
    }
    if (step === 1 && !label.trim()) {
      setError("Give it a name, so people can find it again.");
      return;
    }
    setStep(step + 1);
  }

  async function create() {
    if (!chosen || !label.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const { payload } = await postAction(
        "/api/actions/baseline",
        { snapshotId: chosen.id, label: label.trim(), ...(description.trim() ? { description: description.trim() } : {}) },
        idempotencyKey,
      );
      const job = payload.job as { id: string };
      setJobId(job.id);
      toast({ title: "Approved setup being created", detail: "It becomes the setup in use when it is ready.", href: `/jobs/${encodeURIComponent(job.id)}`, hrefLabel: "Follow it" });
      setIdempotencyKey(crypto.randomUUID());
      router.refresh();
    } catch {
      setError("Keel could not start creating it. Nothing was changed; try again in a minute.");
    } finally {
      setSubmitting(false);
    }
  }

  if (jobId) {
    return (
      <section aria-live="polite" className="bl-card bl-wizard-done">
        <span aria-hidden="true" className="bl-kind-icon" data-tone="fine"><Icon name="check" /></span>
        <div>
          <h2>“{label.trim()}” is being created</h2>
          <p>Keel is copying {chosen ? settings(chosen.resourceCount) : "the settings"} from the backup. When it finishes, it becomes the approved setup in use and every change is measured against it.</p>
          <div className="bl-actions">
            <Link className="btn btn-primary" href={`/jobs/${encodeURIComponent(jobId)}`}>Follow its progress</Link>
            <Link className="btn" href="/approved-setups">Back to approved setups</Link>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="bl-wizard-heading" className="bl-card bl-wizard">
      <h2 className="visually-hidden" id="bl-wizard-heading">Create an approved setup</h2>
      <ol aria-label="Steps" className="bl-steps">
        {STEPS.map((name, index) => (
          <li aria-current={index === step ? "step" : undefined} data-done={index < step || undefined} key={name}>
            <span className="bl-step-dot">{index < step ? <Icon name="check" /> : index + 1}</span>
            <span>{name}</span>
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <div className="bl-step">
          <h3>Which backup should it copy?</h3>
          <p className="bl-help">An approved setup is a copy of every setting in one complete backup. Pick the one that shows the tenant as it should be.</p>
          <Segmented
            label="Start from"
            onChange={(value: Source) => { setSource(value); setError(null); }}
            options={[
              { value: "latest", label: "The latest backup", icon: "backup", hint: "The tenant as it was at the last complete backup" },
              { value: "earlier", label: "An earlier backup", icon: "calendar", hint: "Go back to a day when the tenant was right" },
            ]}
            value={source}
          />
          {source === "latest" && latest ? (
            <div className="bl-choice">
              <Icon name="backup" />
              <span><b>{backupWords(latest)}</b><small>{settings(latest.resourceCount)} · the newest complete backup</small></span>
            </div>
          ) : null}
          {source === "earlier" ? (
            <div className="bl-step-pickers">
              <DatePicker
                allowClear
                label="Day"
                marked={backupDays}
                markedLabel="Has a complete backup"
                mode="single"
                onChange={(value) => { setDay(value); setChosenId(null); }}
                today={today}
                value={day}
              />
              <OptionPicker
                label="Backup"
                onChange={(value: string) => setChosenId(value)}
                options={onDay.map((snapshot) => ({ value: snapshot.id, label: formatTimestamp(snapshot.completedAt ?? snapshot.startedAt), icon: "backup" as const, hint: settings(snapshot.resourceCount) }))}
                placeholder={onDay.length ? "Choose a backup" : "No backup that day"}
                value={chosenId}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {step === 1 ? (
        <div className="bl-step">
          <h3>What should it be called?</h3>
          <p className="bl-help">People see this name on every change that is measured against it.</p>
          <label className="picker-field">
            <span className="picker-label">Name</span>
            <input className="bl-input" maxLength={120} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. After the October audit" value={label} />
          </label>
          <label className="picker-field">
            <span className="picker-label">Note (optional)</span>
            <input className="bl-input" maxLength={500} onChange={(event) => setDescription(event.target.value)} placeholder="Why this setup is the right one" value={description} />
          </label>
        </div>
      ) : null}

      {step === 2 && chosen ? (
        <div className="bl-step">
          <h3>Check, then create</h3>
          <dl className="bl-review">
            <div><dt>Copies</dt><dd>{settings(chosen.resourceCount)} from {backupWords(chosen, "the")}</dd></div>
            <div><dt>Name</dt><dd>{label.trim()}{description.trim() ? <small>{description.trim()}</small> : null}</dd></div>
            <div><dt>Then</dt><dd>It becomes the approved setup in use. Every change from then on is measured against it, and the setup in use now is kept.</dd></div>
            <div><dt>In Microsoft 365</dt><dd>Nothing changes. Keel only reads its own backup.</dd></div>
          </dl>
        </div>
      ) : null}

      {error ? <p className="action-error" role="alert">{error}</p> : null}
      {disabled ? <p className="bl-help">Your role can look but not create an approved setup. Someone who can manage approved setups has to do it.</p> : null}

      <div className="bl-wizard-actions">
        {step > 0 ? <button className="btn" disabled={submitting} onClick={() => { setError(null); setStep(step - 1); }} type="button"><Icon name="chevron" className="bl-flip" />Back</button> : <Link className="btn" href="/approved-setups">Cancel</Link>}
        {step < 2 ? (
          <button className="btn btn-primary" disabled={disabled} onClick={next} type="button">Next<Icon name="chevron" /></button>
        ) : (
          <button aria-busy={submitting || undefined} className="btn btn-primary" disabled={disabled || submitting} onClick={() => void create()} type="button">Create approved setup</button>
        )}
      </div>
      {chosen ? (
        <TechnicalDetails>
          <RecordField label="Source snapshot ID" usage={<>use with <code>keel-baseline-create --snapshot-id</code></>} value={chosen.id} />
          <RecordField copy={false} label="Snapshot completed at" value={chosen.completedAt ?? chosen.startedAt} />
        </TechnicalDetails>
      ) : null}
    </section>
  );
}
