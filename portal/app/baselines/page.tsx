import { connection } from "next/server";

import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { formatAge, formatTimestamp } from "@/lib/presentation";
import { getBaselinesData } from "@/lib/portal-data";
import type { BaselinesData } from "@/lib/types";

export default async function BaselinesPage() {
  await connection();

  let data: BaselinesData;
  try {
    data = await getBaselinesData();
  } catch {
    return (
      <>
        <PageHeader
          description="Named recovery reference points and their captured resource counts."
          eyebrow="Recovery history"
          marker="Read-only"
          title="Baselines"
        />
        <DataUnavailable surface="Baseline data" />
      </>
    );
  }

  return (
    <>
      <PageHeader
        description="Named recovery reference points and their captured resource counts."
        eyebrow="Recovery history"
        generatedAt={data.generatedAt}
        marker="Read-only"
        title="Baselines"
      />

      <section aria-labelledby="baseline-list-heading" className="report-section">
        <div className="section-heading-row report-heading">
          <div>
            <p className="section-kicker">Newest first</p>
            <h2 id="baseline-list-heading">Baseline register</h2>
          </div>
          <span className="result-count">
            {data.baselines.length} {data.baselines.length === 1 ? "baseline" : "baselines"}
          </span>
        </div>

        {data.baselines.length ? (
          <div className="table-scroll">
            <table className="data-table baselines-table">
              <thead>
                <tr>
                  <th scope="col">Label</th>
                  <th scope="col">Set at</th>
                  <th scope="col">Age</th>
                  <th scope="col">Set by</th>
                  <th scope="col">State</th>
                  <th className="number-column" scope="col">Resources</th>
                </tr>
              </thead>
              <tbody>
                {data.baselines.map((baseline) => (
                  <tr className={baseline.active ? "active-row" : undefined} key={baseline.id}>
                    <th data-label="Label" scope="row">
                      <span className="baseline-table-label">
                        <strong>{baseline.label ?? "Unnamed baseline"}</strong>
                        {baseline.description ? <small>{baseline.description}</small> : null}
                      </span>
                    </th>
                    <td data-label="Set at">
                      <time dateTime={baseline.setAt}>{formatTimestamp(baseline.setAt)}</time>
                    </td>
                    <td data-label="Age">
                      {formatAge(baseline.setAt, new Date(data.generatedAt))}
                    </td>
                    <td className="wrap-value" data-label="Set by">{baseline.setBy}</td>
                    <td data-label="State">
                      {baseline.active ? (
                        <span className="active-indicator">Active</span>
                      ) : (
                        <span className="inactive-indicator">Inactive</span>
                      )}
                    </td>
                    <td className="number-column" data-label="Resources">
                      {baseline.resourceCount.toLocaleString("en-GB")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty-state">No baselines are recorded for this tenant.</p>
        )}
      </section>
    </>
  );
}
