"use client";

import { useMemo } from "react";

import { DatePicker } from "@/components/pickers/date-picker";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Segmented } from "@/components/pickers/segmented";
import { Icon } from "@/components/shell/icons";
import type { Day } from "@/lib/date-range";
import type { SnapshotOption } from "@/lib/portal-jobs";
import { backupAge, backupDays, backupForDay, backupsOn, dayWords, plural, takenAt, timeWords } from "@/lib/restore-view";
import { useLiveSearchParams } from "@/lib/use-view-state";

/** The point in time a restore goes back to: always visible with its age, picked on a
 * calendar that marks the days with a backup, with the time when a day has several. */
export function RestorePoint({ snapshots, chosen, now, disabled = false, onPick, headingId = "restore-point-heading", urlDay = true }: {
  snapshots: SnapshotOption[];
  chosen: SnapshotOption;
  now: string;
  disabled?: boolean;
  // `day` is the day the person asked for when it had no backup of its own.
  onPick: (snapshotId: string, day?: Day) => void;
  // A second picker on the page (another service's backups) needs its own heading id
  // and does not read the main picker's `day` from the URL.
  headingId?: string;
  urlDay?: boolean;
}) {
  const marked = useMemo(() => backupDays(snapshots), [snapshots]);
  const at = takenAt(chosen);
  const day: Day | null = at ? at.slice(0, 10) : null;
  // The day asked for rides in the URL, so the note survives loading the backup.
  const params = useLiveSearchParams();
  const asked = urlDay ? params?.get("day") ?? null : null;
  const notice = asked && asked !== day ? `No backup on ${dayWords(`${asked}T00:00:00Z`)}, so this is the one before it.` : null;
  const sameDay = day ? backupsOn(snapshots, day) : [];
  const newest = snapshots[0];
  const isNewest = newest?.id === chosen.id;

  function pickDay(value: Day) {
    const found = backupForDay(snapshots, value);
    if (!found) return;
    onPick(found.snapshot.id, found.exact ? undefined : value);
  }

  const times = [...sameDay].reverse().map((snapshot) => ({ value: snapshot.id, label: timeWords(takenAt(snapshot)).replace(" UTC", ""), hint: plural(snapshot.resourceCount, "setting") }));

  return (
    <section aria-labelledby={headingId} className="restore-point">
      <div className="restore-point-now">
        <span aria-hidden="true" className="restore-point-icon"><Icon name="restore" /></span>
        <div>
          <h2 className="restore-point-label" id={headingId}>Restore to</h2>
          <p className="restore-point-when">
            <time dateTime={at ?? undefined}>{dayWords(at)}, {timeWords(at)}</time>
          </p>
          <p className="restore-point-age">
            {[
              backupAge(at, now),
              `${plural(chosen.resourceCount, "setting")} saved`,
              isNewest ? "your newest backup" : `${plural(snapshots.findIndex((entry) => entry.id === chosen.id), "backup")} taken after it`,
            ].join(" · ")}
          </p>
          {notice ? <p className="restore-point-notice" role="status">{notice}</p> : null}
        </div>
      </div>
      <div className="restore-point-pick">
        {disabled ? null : (
          <>
            <DatePicker
              label="Backup day"
              marked={marked}
              markedLabel="Has a backup"
              mode="single"
              onChange={(value) => { if (value) pickDay(value.from); }}
              today={now.slice(0, 10)}
              value={day ? { from: day } : null}
            />
            {sameDay.length > 1 ? (
              sameDay.length <= 4 ? (
                <Segmented label="Time (UTC)" onChange={(value) => onPick(value)} options={times} value={chosen.id} />
              ) : (
                <OptionPicker label="Time (UTC)" onChange={(value) => onPick(value)} options={times} value={chosen.id} />
              )
            ) : null}
          </>
        )}
        {!isNewest && newest && !disabled ? (
          <button className="btn btn-sm restore-point-newest" onClick={() => onPick(newest.id)} type="button">
            Use the newest backup
          </button>
        ) : null}
        <p className="restore-point-hint">
          {disabled ? "To pick another backup, change your selection first." : `Days with a dot have a backup. ${plural(snapshots.length, "backup")} to choose from.`}
        </p>
      </div>
    </section>
  );
}
