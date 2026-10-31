"use client";

import Link from "next/link";
import { useMemo, type MouseEvent } from "react";

import { ListPager, SortControl, useListPaging, type ListSort } from "@/components/list/list-paging";
import { Icon } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import {
  COVERAGE_WORDS,
  KNOWN_STANDARDS_NOTE,
  RESULTS,
  controlName,
  coverageReason,
  coverageSentence,
  orderCoverageRows,
  standardCoverage,
  type ControlResult,
  type CoverageRow,
} from "@/lib/compliance-view";
import { addsWords, applyFilters, readPicked, tileCounts, tileParam, type FilterTile } from "@/lib/filter-set";
import { pageWindow, sortRows } from "@/lib/paging";
import type { ComplianceFinding, KnownStandard } from "@/lib/types";
import { useViewState } from "@/lib/use-view-state";

// The result chips over the table add up: picking Fails and Could not check shows both.
const RESULT_KEYS = Object.keys(RESULTS) as ControlResult[];
const RESULT_CHIPS: FilterTile<CoverageRow>[] = RESULT_KEYS.map((key) => ({ key, test: (row) => row.result === key }));
const SORTS: ListSort<CoverageRow>[] = [
  { key: "policy", label: "Policy", compare: (left, right) => left.ref.localeCompare(right.ref, "en", { numeric: true }) },
  { key: "area", label: "Area", compare: (left, right) => (left.areaName ?? left.area).localeCompare(right.areaName ?? right.area) },
];
const PREFIX = "std-";
const RESULT_KEY = `${PREFIX}result`;
const STANDARD_KEY = "std";
// The policy table stays folded until asked for (`std-list=open`) or a filter, sort or
// page of it is in the address: the page's own list already shows each control.
const LIST_KEY = `${PREFIX}list`;

// Measure against a known standard (CISA SCuBA, NIST SP 800-53): for each published
// policy, the Keel checks that cover it and how they stand, worst first. Policies no
// check covers are listed apart, so the gaps show and nothing reads as a pass by default.
export function KnownStandards({ standards, findings, openHref, follow }: {
  standards: KnownStandard[];
  findings: ComplianceFinding[];
  openHref: (id: string) => string;
  follow: (event: MouseEvent, to: string) => void;
}) {
  const view = useViewState();
  const paging = useListPaging<CoverageRow>({ prefix: PREFIX, sorts: SORTS });
  // The picked standard sits in the address with its filter, sort and page, so a link or
  // Back opens the same view.
  const standard = standards.find((entry) => entry.id === view.get(STANDARD_KEY)) ?? standards[0];
  const coverage = useMemo(() => (standard ? standardCoverage(standard, findings) : null), [standard, findings]);
  const checked = useMemo(() => orderCoverageRows(coverage?.rows.filter((row) => row.result !== "not-checked") ?? []), [coverage]);
  const filter = readPicked(RESULT_CHIPS, view.get(RESULT_KEY));
  const shown = useMemo(() => {
    const found = applyFilters(checked, RESULT_CHIPS, filter);
    return paging.sort ? sortRows(found, paging.sort.compare, paging.dir) : found;
    // `filter` is read from the address on every render; its text is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checked, filter.join(","), paging.sort, paging.dir]);
  const open = view.get(LIST_KEY) === "open" || [RESULT_KEY, `${PREFIX}page`, `${PREFIX}sort`, `${PREFIX}size`].some((key) => Boolean(view.get(key)));
  if (!standard || !coverage) return null;
  const unchecked = coverage.rows.filter((row) => row.result === "not-checked");
  const areas = [...new Set(unchecked.map((row) => row.areaName ?? row.area))];
  const counts = new Map(tileCounts(checked, RESULT_CHIPS, filter).map((entry) => [entry.key, entry]));
  const chips = RESULT_KEYS.filter((key) => (counts.get(key)?.count ?? 0) > 0 || filter.includes(key));
  const anyPartial = checked.some((row) => row.mapped.some((item) => item.match === "partial"));
  const { start, end } = pageWindow(paging.pageOf(shown.length), shown.length, paging.size);
  const pick = (id: string) => {
    if (id === standard.id) return;
    view.set({ [STANDARD_KEY]: id === standards[0]?.id ? null : id, [RESULT_KEY]: null, [LIST_KEY]: null, [`${PREFIX}sort`]: null, [`${PREFIX}dir`]: null, [`${PREFIX}size`]: null, ...paging.resetPage });
  };

  return (
    <section aria-labelledby="cp-known-heading" className="cp-section cp-known">
      <h2 id="cp-known-heading">Measure against a known standard</h2>
      <div aria-label="Known standard" className="cp-presets" role="group">
        {standards.map((entry) => (
          <button aria-pressed={entry.id === standard.id} className="cp-preset" key={entry.id} onClick={() => pick(entry.id)} type="button">{entry.name}</button>
        ))}
      </div>
      <p><b>{coverageSentence(standard, coverage)}</b></p>
      <p className="cp-muted">{standard.name} {standard.edition}: {standard.scope}. {standard.how} {standard.publisher}. {standard.licence}.</p>

      {checked.length ? (
        <>
          <div className="cp-known-bar">
            {chips.length > 1 || filter.length || !open ? (
              <div aria-label="Show results" className="cp-known-chips" role="group">
                {chips.map((key) => {
                  const words = RESULTS[key];
                  const active = filter.includes(key);
                  const adds = addsWords(counts.get(key), filter.length);
                  return (
                    <button
                      aria-pressed={active}
                      className="cp-known-chip"
                      data-tone={words.badge}
                      key={key}
                      onClick={() => view.set({ [RESULT_KEY]: tileParam(RESULT_CHIPS, filter, key), ...paging.resetPage })}
                      title={active ? "Picked: click to remove it from the view" : "Click to add these to the view"}
                      type="button"
                    >
                      <Icon name={words.icon} />{words.plural}<b>{counts.get(key)?.count ?? 0}</b>
                      {adds ? <small>{adds}</small> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {open ? <SortControl paging={paging} sorts={SORTS} /> : null}
          </div>
          {!open ? (
            <button aria-expanded="false" className="btn btn-sm cp-known-toggle" onClick={() => view.set({ [LIST_KEY]: "open" })} type="button">
              <Icon name="down" />Show each policy ({checked.length})
            </button>
          ) : (
          <>
          <button aria-expanded="true" className="btn btn-sm cp-known-toggle" onClick={() => view.set({ [LIST_KEY]: null, [RESULT_KEY]: null, [`${PREFIX}sort`]: null, [`${PREFIX}dir`]: null, [`${PREFIX}size`]: null, ...paging.resetPage })} type="button">
            <Icon name="up" />Hide the policies
          </button>
          {shown.length ? (
          <table className="cp-misses cp-known-table">
            <thead><tr><th scope="col">Policy</th><th scope="col">Keel check</th>{anyPartial ? <th scope="col">How much</th> : null}<th scope="col">Result</th></tr></thead>
            <tbody>
              {shown.slice(start, end).map((row) => <CoveredRow follow={follow} key={row.ref} openHref={openHref} row={row} showMatch={anyPartial} />)}
            </tbody>
          </table>
          ) : <p className="cp-muted">No policy has these results. Pick another result above.</p>}
          <ListPager label={`${standard.name} policies`} noun={{ one: "policy", many: "policies" }} paging={paging} total={shown.length} />
          </>
          )}
        </>
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

function CoveredRow({ row, openHref, follow, showMatch }: { row: CoverageRow; openHref: (id: string) => string; follow: (event: MouseEvent, to: string) => void; showMatch: boolean }) {
  const words = row.result === "not-checked" ? null : RESULTS[row.result];
  const why = coverageReason(row);
  return (
    <tr data-result={row.result}>
      <th data-label="Policy" scope="row"><span>{row.ref}{row.areaName ? <small className="cp-known-area">{row.areaName}</small> : null}</span></th>
      <td data-label="Keel check"><span>
        {row.mapped.map((item) => (
          <span className="cp-known-check" key={item.controlId}>
            {item.finding ? <Link className="cp-inline-link" href={openHref(item.finding.id)} onClick={(event) => follow(event, openHref(item.finding!.id))}>{controlName(item.finding)}</Link> : "Not run yet"}
          </span>
        ))}
      </span></td>
      {showMatch ? (
        <td data-label="How much"><span>
          {row.mapped.map((item) => (
            <span className="cp-known-check" key={item.controlId}>{COVERAGE_WORDS[item.match]}{item.note ? <small>{item.note}</small> : null}</span>
          ))}
        </span></td>
      ) : null}
      <td data-label="Result"><span>
        {words ? <Badge icon={words.icon} tone={words.badge}>{words.label}</Badge> : null}
        {why ? <small className="cp-known-why">{why}</small> : null}
      </span></td>
    </tr>
  );
}
