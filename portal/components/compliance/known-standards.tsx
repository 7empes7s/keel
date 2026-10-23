"use client";

import Link from "next/link";
import { useMemo, useState, type MouseEvent } from "react";

import { Icon } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import {
  COVERAGE_WORDS,
  KNOWN_STANDARDS_NOTE,
  RESULTS,
  controlName,
  coverageSentence,
  standardCoverage,
  type CoverageRow,
} from "@/lib/compliance-view";
import type { ComplianceFinding, KnownStandard } from "@/lib/types";

// Measure against a known standard (CISA SCuBA, NIST SP 800-53): for each published
// policy, the Keel checks that cover it and how they stand. Policies no check covers are
// listed apart, so the gaps show and nothing reads as a pass by default.
export function KnownStandards({ standards, findings, openHref, follow }: {
  standards: KnownStandard[];
  findings: ComplianceFinding[];
  openHref: (id: string) => string;
  follow: (event: MouseEvent, to: string) => void;
}) {
  const [picked, setPicked] = useState(standards[0]?.id ?? "");
  const standard = standards.find((entry) => entry.id === picked) ?? standards[0];
  const coverage = useMemo(() => (standard ? standardCoverage(standard, findings) : null), [standard, findings]);
  if (!standard || !coverage) return null;
  const checked = coverage.rows.filter((row) => row.result !== "not-checked");
  const unchecked = coverage.rows.filter((row) => row.result === "not-checked");
  const areas = [...new Set(unchecked.map((row) => row.areaName ?? row.area))];

  return (
    <section aria-labelledby="cp-known-heading" className="cp-section cp-known">
      <h2 id="cp-known-heading">Measure against a known standard</h2>
      <div aria-label="Known standard" className="cp-presets" role="group">
        {standards.map((entry) => (
          <button aria-pressed={entry.id === standard.id} className="cp-preset" key={entry.id} onClick={() => setPicked(entry.id)} type="button">{entry.name}</button>
        ))}
      </div>
      <p><b>{coverageSentence(standard, coverage)}</b></p>
      <p className="cp-muted">{standard.name} {standard.edition}: {standard.scope}. {standard.publisher}. {standard.licence}.</p>

      {checked.length ? (
        <table className="cp-misses cp-known-table">
          <thead><tr><th scope="col">Policy</th><th scope="col">Keel check</th><th scope="col">How much</th><th scope="col">Result</th></tr></thead>
          <tbody>
            {checked.map((row) => <CoveredRow follow={follow} key={row.ref} openHref={openHref} row={row} />)}
          </tbody>
        </table>
      ) : <p className="cp-muted">No Keel check covers a policy of this standard yet.</p>}

      {unchecked.length ? (
        <details className="cp-known-gaps">
          <summary>{unchecked.length === 1 ? "1 policy Keel does not check yet" : `${unchecked.length} policies Keel does not check yet`}</summary>
          {areas.map((area) => (
            <p key={area}><b>{area}</b>: {unchecked.filter((row) => (row.areaName ?? row.area) === area).map((row) => row.ref).join(", ")}</p>
          ))}
          <p className="cp-muted">Write your own check for any of them that rests on a setting Keel backs up.</p>
        </details>
      ) : null}

      <p className="cp-muted"><Icon name="info" /> {KNOWN_STANDARDS_NOTE} <a className="cp-inline-link" href={standard.source} rel="noreferrer" target="_blank">Source</a></p>
    </section>
  );
}

function CoveredRow({ row, openHref, follow }: { row: CoverageRow; openHref: (id: string) => string; follow: (event: MouseEvent, to: string) => void }) {
  const words = row.result === "not-checked" ? null : RESULTS[row.result];
  return (
    <tr>
      <th data-label="Policy" scope="row">{row.ref}{row.areaName ? <small className="cp-known-area">{row.areaName}</small> : null}</th>
      <td data-label="Keel check">
        {row.mapped.map((item) => (
          <span className="cp-known-check" key={item.controlId}>
            {item.finding ? <Link className="cp-inline-link" href={openHref(item.finding.id)} onClick={(event) => follow(event, openHref(item.finding!.id))}>{controlName(item.finding)}</Link> : "Not run yet"}
          </span>
        ))}
      </td>
      <td data-label="How much">
        {row.mapped.map((item) => (
          <span className="cp-known-check" key={item.controlId}>{COVERAGE_WORDS[item.match]}{item.note ? <small>{item.note}</small> : null}</span>
        ))}
      </td>
      <td data-label="Result">{words ? <Badge icon={words.icon} tone={words.badge}>{words.label}</Badge> : null}</td>
    </tr>
  );
}
