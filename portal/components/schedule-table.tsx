import Link from "next/link";
import { formatTimestamp } from "@/lib/presentation";
import type { Schedule, SchedulesData } from "@/lib/schedules";
import { ScheduleEditor } from "@/components/schedule-editor";

export function describeCadence(schedule: Schedule): string {
  if (schedule.cron_override !== null) return `Cron: ${schedule.cron_override} (UTC)`;
  const { n, every, atTime } = schedule.cadence;
  const interval = `Every ${n} ${every}${n === 1 ? "" : "s"}`;
  if (!atTime) return interval;
  return every === "hour" ? `${interval}, at minute ${atTime.slice(3)} (UTC)` : `${interval} at ${atTime} UTC`;
}

export function ScheduleTable({ schedules, deferrals, canEdit }: Pick<SchedulesData, "schedules" | "deferrals"> & { canEdit: boolean }) {
  return <section aria-labelledby="schedule-heading" className="report-section">
    <div className="section-heading-row report-heading">
      <h2 id="schedule-heading">Collection and maintenance</h2>
      <span className="result-count">{schedules.length} schedules</span>
    </div>
    {schedules.length ? <div className="table-scroll"><table className="data-table">
      <thead><tr>
        <th scope="col">Job kind</th><th scope="col">Tier</th><th scope="col">Cadence</th>
        <th scope="col">Next run</th><th scope="col">Last run</th><th scope="col">Last result</th>
        <th scope="col">Schedule</th>
      </tr></thead>
      <tbody>{schedules.map((schedule) => <tr key={schedule.id}>
        <th scope="row" data-label="Job kind">{schedule.job_kind}</th>
        <td data-label="Tier">{schedule.tier ?? "—"}</td>
        <td data-label="Cadence">{describeCadence(schedule)}</td>
        <td data-label="Next run">{schedule.enabled ? <time dateTime={schedule.next_due_at}>{formatTimestamp(schedule.next_due_at)}</time> : "Disabled"}</td>
        <td data-label="Last run">{schedule.last_run_at ? <time dateTime={schedule.last_run_at}>{formatTimestamp(schedule.last_run_at)}</time> : "Not started"}</td>
        <td data-label="Last result" className="wrap-value">
          {schedule.last_job_id && schedule.last_status ? <Link href={`/jobs/${encodeURIComponent(schedule.last_job_id)}`}>{schedule.last_status}</Link> : "No runs yet"}
          {schedule.last_status === "failed" && schedule.last_error !== null ? <pre className="job-error job-payload">{schedule.last_error}</pre> : null}
        </td>
        <td data-label="Schedule">
          <span>{schedule.enabled ? "Enabled" : "Disabled"}</span>
          {canEdit ? <ScheduleEditor key={`${schedule.id}:${schedule.next_due_at}:${schedule.enabled}`} schedule={schedule} /> : null}
        </td>
      </tr>)}</tbody>
    </table></div> : <p className="empty-state">No schedules configured.</p>}
    {deferrals.length ? <section aria-labelledby="drift-deferrals-heading">
      <h3 id="drift-deferrals-heading">Drift detection deferred</h3>
      <p>Drift detection will be retried after the next collection with successful per-type coverage.</p>
      {deferrals.map((job) => <div key={job.id}>
        <Link href={`/jobs/${encodeURIComponent(job.id)}`}>View deferred job</Link>
        <pre className="job-error job-payload">{job.error}</pre>
      </div>)}
    </section> : null}
  </section>;
}
