import Link from "next/link";
import { ScheduleEditor } from "@/components/schedule-editor";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { cadenceSentence, lastRunSentence, nextRunSentence, scheduleName } from "@/lib/protect-view";
import { formatTimestamp, fromNow } from "@/lib/presentation";
import type { Schedule, SchedulesData } from "@/lib/schedules";

/** "Every day at 05:00 UTC" / "On a custom timetable"; the cron expression is in the record. */
export function describeCadence(schedule: Schedule): string {
  return cadenceSentence(schedule);
}

/** "4 schedules are on; the next run is in 20 minutes." */
export function schedulesVerdict(schedules: Schedule[], now: string): { text: string; tone: "good" | "attention" } {
  if (schedules.length === 0) return { text: "Nothing runs on a schedule; backups happen only on demand.", tone: "attention" };
  const failed = schedules.filter((schedule) => schedule.last_status === "failed").length;
  if (failed) return { text: `${failed} ${failed === 1 ? "schedule" : "schedules"} failed on ${failed === 1 ? "its" : "their"} last run.`, tone: "attention" };
  const on = schedules.filter((schedule) => schedule.enabled);
  if (on.length === 0) return { text: "Every schedule is turned off; nothing runs on its own.", tone: "attention" };
  const next = on.reduce((soonest, schedule) => schedule.next_due_at < soonest.next_due_at ? schedule : soonest);
  const due = fromNow(next.next_due_at, now);
  return { text: `${on.length} of ${schedules.length} schedules are on; ${scheduleName(next)} runs next, ${due === "already passed" ? "now" : due}.`, tone: "good" };
}

export function ScheduleTable({ schedules, deferrals, canEdit, now }: Pick<SchedulesData, "schedules" | "deferrals"> & { canEdit: boolean; now?: string }) {
  const at = now ?? new Date().toISOString();
  return <section aria-labelledby="schedule-heading" className="report-section">
    <div className="section-heading-row report-heading">
      <h2 id="schedule-heading">Backups and upkeep</h2>
      <span className="result-count">{schedules.length} schedules</span>
    </div>
    {schedules.length ? <div className="table-scroll"><table className="data-table schedule-table">
      <thead><tr>
        <th scope="col">What runs</th><th scope="col">How often</th>
        <th scope="col">Next run</th><th scope="col">Last result</th><th scope="col">Details</th>
      </tr></thead>
      <tbody>{schedules.map((schedule) => <tr key={schedule.id}>
        <th scope="row" data-label="What runs">{scheduleName(schedule)}</th>
        <td data-label="How often">{cadenceSentence(schedule)}</td>
        <td data-label="Next run">{schedule.enabled
          ? <time dateTime={schedule.next_due_at} title={formatTimestamp(schedule.next_due_at)}>{nextRunSentence(schedule, at)}</time>
          : "Turned off."}</td>
        <td data-label="Last result" className="wrap-value">
          {schedule.last_job_id && schedule.last_status
            ? <Link href={`/jobs/${encodeURIComponent(schedule.last_job_id)}`}>{lastRunSentence(schedule, at)}</Link>
            : lastRunSentence(schedule, at)}
        </td>
        <td data-label="Details">
          {canEdit ? <ScheduleEditor key={`${schedule.id}:${schedule.next_due_at}:${schedule.enabled}`} schedule={schedule} /> : null}
          <TechnicalDetails>
            <RecordField label="Schedule ID" value={schedule.id} usage={<>Use with <code>POST /api/schedules</code></>} />
            <RecordField copy={false} label="Job kind" value={`${schedule.job_kind}${schedule.tier ? ` · ${schedule.tier}` : ""}`} />
            <RecordField copy={false} label="Cadence" value={schedule.cron_override !== null ? `cron ${schedule.cron_override} (UTC)` : JSON.stringify(schedule.cadence)} />
            <RecordField copy={false} label="Next due" value={schedule.next_due_at} />
            <RecordField copy={false} label="Enabled" value={String(schedule.enabled)} />
            {schedule.last_job_id ? <RecordField label="Last job ID" value={schedule.last_job_id} usage={<code>GET /api/jobs/{schedule.last_job_id}</code>} /> : null}
            {schedule.last_status ? <RecordField copy={false} label="Last status" value={`${schedule.last_status}${schedule.last_run_at ? ` at ${schedule.last_run_at}` : ""}`} /> : null}
            {schedule.last_status === "failed" && schedule.last_error !== null ? <RecordField copy={false} label="Last error" value={schedule.last_error} /> : null}
          </TechnicalDetails>
        </td>
      </tr>)}</tbody>
    </table></div> : <p className="empty-state">No schedules are set up.</p>}
    {deferrals.length ? <section aria-labelledby="drift-deferrals-heading">
      <h3 id="drift-deferrals-heading">Change check postponed</h3>
      <p>KEEL checks for changes again after the next backup in which every type succeeds.</p>
      {deferrals.map((job) => <div key={job.id}>
        <Link href={`/jobs/${encodeURIComponent(job.id)}`}>View the postponed check</Link>
        <TechnicalDetails>
          <RecordField label="Job ID" value={job.id} />
          <RecordField copy={false} label="Reason" value={job.error} />
        </TechnicalDetails>
      </div>)}
    </section> : null}
  </section>;
}
