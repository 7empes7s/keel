"use client";

import Link from "next/link";
import { useMemo } from "react";

import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { MultiOptionPicker } from "@/components/pickers/option-picker";
import { Segmented } from "@/components/pickers/segmented";
import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { Verdict } from "@/components/verdict";
import { csvLine } from "@/lib/csv";
import { addsWords, applyFilters, readPicked, tileCounts, tileParam, withoutTile, type FilterTile } from "@/lib/filter-set";
import {
  BASELINE_RESULTS, OTHER_CATEGORY, RESULT_ORDER, baselineLabel, baselinesVerdict, byBaseline, foundLine, settingsWord, totalCounts,
  type BaselineResult, type BaselineSettingRow, type BaselineVersion, type IntuneBaselineData,
} from "@/lib/intune-baselines-view";
import { ago } from "@/lib/presentation";
import { readList, useViewState } from "@/lib/use-view-state";

// Intune security baselines: every setting of every Microsoft baseline version, matched
// by setting against all settings catalog policies. Result tiles add up (OR); the
// baseline picker and the version switch narrow (AND). Rows are grouped by baseline
// version, then by Intune's own category, and paged by the shared list.

const RESULT_TILES: FilterTile<BaselineSettingRow>[] = RESULT_ORDER.map((key) => ({ key, test: (row: BaselineSettingRow) => row.result === key }));
const VERSIONS = [{ value: "current", label: "Current versions" }, { value: "all", label: "All versions" }] as const;

export function IntuneBaselinesPage({ data }: { data: IntuneBaselineData }) {
  const view = useViewState();
  const now = data.generatedAt;
  const versions = view.get("versions") === "all" ? "all" : "current";
  const inView = useMemo(() => data.baselines.filter((baseline) => versions === "all" || baseline.current), [data.baselines, versions]);
  const pickedBaselines = readList(view.get("baseline")).filter((key) => inView.some((baseline) => baseline.key === key));
  const shownBaselines = pickedBaselines.length ? inView.filter((baseline) => pickedBaselines.includes(baseline.key)) : inView;
  const baselineByKey = useMemo(() => new Map(data.baselines.map((baseline) => [baseline.key, baseline])), [data.baselines]);
  const rows = useMemo(() => shownBaselines.flatMap((baseline) => baseline.settings), [shownBaselines]);
  const picked = readPicked(RESULT_TILES, view.get("result"));
  const shown = useMemo(() => applyFilters(rows, RESULT_TILES, picked), [rows, picked]);
  const totals = useMemo(() => new Map(tileCounts(rows, RESULT_TILES, picked).map((entry) => [entry.key, entry])), [rows, picked]);
  const counts = totalCounts(shownBaselines);
  const verdict = baselinesVerdict(data, shownBaselines);
  const tiles = RESULT_ORDER.filter((key) => key !== "unknown" || counts.unknown > 0 || picked.includes(key));

  const filters: ActiveFilter[] = [
    ...pickedBaselines.map((key) => ({ key: `baseline:${key}`, label: baselineLabel(baselineByKey.get(key) ?? { name: key, version: null }), clear: { baseline: pickedBaselines.filter((entry) => entry !== key).join(",") || null } })),
    ...picked.map((key) => ({ key: `result:${key}`, label: BASELINE_RESULTS[key as BaselineResult].plural, clear: { result: withoutTile(picked, key) } })),
  ];

  const groupings = useMemo<Grouping<BaselineSettingRow>[]>(() => [
    { key: "baseline", label: "Baseline", groupsOf: (items) => byBaselineGroups(items, baselineByKey) },
    { key: "result", label: "Result", groupsOf: (items) => RESULT_ORDER.map((result) => ({ key: result, label: BASELINE_RESULTS[result].plural, icon: BASELINE_RESULTS[result].icon, about: BASELINE_RESULTS[result].small, items: items.filter((item) => item.result === result) })).filter((group) => group.items.length) },
    { key: "category", label: "Category", groupsOf: (items) => categoryParts(items, "all").map((part) => ({ ...part, about: `${settingsWord(part.items.length)}${worst(part.items)}` })) },
  ], [baselineByKey]);

  // Grouped by baseline, the group header already names it.
  const groupedBy = view.get("group", "baseline");
  const renderRow = (row: BaselineSettingRow) => {
    const words = BASELINE_RESULTS[row.result];
    const baseline = baselineByKey.get(row.baselineKey);
    const off = row.result === "different" || row.result === "conflict";
    return (
      <div className="ib-row" data-result={row.result}>
        <span aria-hidden="true" className="cp-kind" data-tone={words.tone ?? undefined}><Icon name={words.icon} /></span>
        <span className="cp-row-name">
          <b>{row.name}</b>
          <small>{row.category}{baseline && groupedBy !== "baseline" ? ` · ${baselineLabel(baseline)}` : ""}</small>
        </span>
        <span className="cp-row-mid">
          <Badge icon={words.icon} tone={words.badge}>{words.label}</Badge>
          <small>{foundLine(row)}</small>
        </span>
        <span className="ib-values">
          <span className="ib-value"><small>Microsoft</small>{row.expected === null ? <span className="ib-any">Any value</span> : <span className="cp-miss-want">{row.expected}</span>}</span>
          {off ? (
            <ul aria-label={`What your policies set for ${row.name}`} className="ib-setby">
              {row.setBy.map((entry) => (
                <li key={`${entry.policyName}:${entry.value}`}><small>{entry.policyName}</small><span className={row.expected !== null && entry.value === row.expected ? "cp-miss-want" : "cp-miss-now"}>{entry.value}</span></li>
              ))}
            </ul>
          ) : null}
        </span>
        <span className="ib-tech">
          <TechnicalDetails summary="Technical details">
            <RecordField label="Setting ID" value={row.id} />
            {baseline ? <RecordField copy={false} label="Baseline template" value={`${baseline.key}${baseline.state ? ` (${baseline.state})` : ""}`} /> : null}
            {row.setBy.length ? <RecordField copy={false} label="Set by policies" value={row.setBy.map((entry) => `${entry.policyName}: ${entry.value}`).join("\n")} /> : null}
          </TechnicalDetails>
        </span>
      </div>
    );
  };

  function exportRows(chosen: BaselineSettingRow[]) {
    const lines = [csvLine(["Baseline", "Version", "Category", "Setting", "Result", "Microsoft value", "Set by", "Setting ID"])];
    for (const row of chosen) {
      const baseline = baselineByKey.get(row.baselineKey);
      lines.push(csvLine([baseline?.name ?? "", baseline?.version ?? "", row.category, row.name, BASELINE_RESULTS[row.result].label, row.expected ?? "Any value", row.setBy.map((entry) => `${entry.policyName}: ${entry.value}`).join("; "), row.id]));
    }
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `keel-intune-baselines-${now.slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const baselineOptions = inView.map((baseline) => ({ value: baseline.key, label: baselineLabel(baseline) }));
  const action = !data.policies && data.templates ? { label: "Run a backup", href: "/protect" } : null;

  return (
    <div className="cp-page ib-page">
      <Verdict action={action} detail={verdict.detail} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        {data.lastFailure ? (
          <p className="ib-alert" data-tone="urgent" role="status"><Icon name="alert" /><span><b>The last read of the baselines failed {ago(data.lastFailure.readAt, now)}.</b> {data.templates ? "The results below use the read before it." : "Keel tries again after the next backup."}</span></p>
        ) : null}
        {data.templates?.failures.length ? (
          <p className="ib-alert" data-tone="soon" role="status"><Icon name="clock" /><span><b>{data.templates.failures.length === 1 ? "1 baseline" : `${data.templates.failures.length} baselines`} could not be read: {data.templates.failures.map((failure) => failure.name ?? "a baseline").join(", ")}.</b> Keel tries again after the next backup.</span></p>
        ) : null}
        <p className="cp-context">
          {data.templates ? <span>Baselines read from your tenant {ago(data.templates.readAt, now)}</span> : null}
          {data.policies ? <span>Checked against {data.policies.count === 1 ? "1 settings catalog policy" : `${data.policies.count} settings catalog policies`} from the backup {ago(data.policies.readAt, now)}</span> : null}
          <span>Any policy counts, not only ones made from a baseline.</span>
          <Link className="cp-inline-link" href="/benchmarks">Back to Compliance</Link>
        </p>

        {inView.length ? (
          <section aria-labelledby="ib-baselines-heading" className="cp-section">
            <h2 className="ib-heading" id="ib-baselines-heading">Baselines</h2>
            <div className="ib-cards">
              {inView.map((baseline) => {
                const on = pickedBaselines.includes(baseline.key);
                const total = RESULT_ORDER.reduce((sum, result) => sum + baseline.counts[result], 0);
                const next = on ? pickedBaselines.filter((key) => key !== baseline.key) : [...pickedBaselines, baseline.key];
                return (
                  <button aria-pressed={on} className="ib-card" key={baseline.key} onClick={() => view.set({ baseline: next.join(",") || null })} title={on ? "Shown: click to stop showing only this baseline" : "Click to show this baseline's settings"} type="button">
                    <span className="ib-card-head"><b>{baseline.name}</b>{on ? <Icon name="check" /> : null}</span>
                    <small>{baseline.version ?? "No version"}{baseline.current ? "" : " · older version"} · {settingsWord(total)}</small>
                    <span aria-hidden="true" className="ib-bar">
                      {RESULT_ORDER.filter((result) => baseline.counts[result]).map((result) => <span data-result={result} key={result} style={{ flexGrow: baseline.counts[result] }} />)}
                    </span>
                    <span className="ib-card-counts">
                      {RESULT_ORDER.filter((result) => baseline.counts[result]).map((result) => <span data-result={result} key={result}>{countWords(result, baseline.counts[result])}</span>)}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : null}

        {rows.length || picked.length ? (
          <section aria-label="Results at a glance" className="cp-tiles" style={{ ["--cp-tiles" as string]: tiles.length }}>
            {tiles.map((key) => {
              const words = BASELINE_RESULTS[key];
              const active = picked.includes(key);
              const adds = addsWords(totals.get(key), picked.length);
              const tone = (key === "conflict" || key === "different") && counts[key] ? "urgent" : key === "not-configured" && counts[key] ? "soon" : undefined;
              return (
                <button aria-current={active || undefined} className="cp-tile" data-tone={tone} key={key} onClick={() => view.set({ result: tileParam(RESULT_TILES, picked, key) })} title={active ? "Picked: click to remove it from the view" : "Click to add these to the view"} type="button">
                  <span className="cp-tile-label"><Icon name={words.icon} />{words.label}{active ? <Icon className="tile-check" name="check" /> : null}</span>
                  <b className="cp-tile-count">{counts[key]}</b>
                  <small>{words.small}</small>
                  {adds ? <small className="tile-adds">{adds}</small> : null}
                </button>
              );
            })}
          </section>
        ) : null}

        <section aria-labelledby="ib-settings-heading" className="cp-section">
          <h2 className="visually-hidden" id="ib-settings-heading">Settings</h2>
          {data.baselines.length ? (
            <div className="ib-controls">
              <MultiOptionPicker anyLabel="Every baseline" label="Baseline" onChange={(values) => view.set({ baseline: values.join(",") || null })} options={baselineOptions} values={pickedBaselines} />
              <Segmented label="Versions" onChange={(value) => view.set({ versions: value === "all" ? "all" : null, baseline: null })} options={VERSIONS} value={versions} />
            </div>
          ) : null}
          <ActiveFilters filters={filters} noun={{ one: "setting", many: "settings" }} shown={shown.length} total={rows.length} />
          {rows.length === 0 ? (
            <div className="sel-empty cp-empty">
              <p>{data.templates ? "No baseline settings to show." : "No baseline has been read from the tenant yet."}</p>
              <Link className="btn btn-sm" href="/schedules"><Icon name="clock" />See when backups run</Link>
            </div>
          ) : shown.length === 0 ? (
            <NoMatches filters={filters} noun={{ one: "setting", many: "settings" }} />
          ) : (
            <SelectableList
              action={{
                label: (count) => `Export ${settingsWord(count)}`,
                detail: () => "Saves these settings, Microsoft's values and what your policies set as a CSV file.",
                run: (ids) => exportRows(shown.filter((row) => ids.includes(row.key))),
              }}
              getId={(row) => row.key}
              groupings={groupings}
              items={shown}
              label="Baseline settings"
              matches={(row, text) => `${row.name} ${row.category} ${row.expected ?? ""} ${row.setBy.map((entry) => `${entry.policyName} ${entry.value}`).join(" ")}`.toLowerCase().includes(text)}
              noun={{ one: "setting", many: "settings" }}
              renderRow={renderRow}
              rowName={(row) => row.name}
              sorts={[{ key: "result", label: "Result", compare: (a, b) => BASELINE_RESULTS[a.result].rank - BASELINE_RESULTS[b.result].rank }]}
              toneOf={(row) => BASELINE_RESULTS[row.result].tone}
            />
          )}
        </section>

        <TechnicalDetails summary="Technical details for these results">
          <RecordField copy={false} label="Templates read from" value="GET /beta/deviceManagement/configurationPolicyTemplates (templateFamily baseline), then .../{id}/settingTemplates?$expand=settingDefinitions" />
          <RecordField copy={false} label="Matched by" value="settingDefinitionId, across every settings catalog policy (configurationPolicy) in the newest complete backup" />
          {data.policies ? <RecordField label="Backup" value={data.policies.snapshotId} /> : null}
        </TechnicalDetails>
      </div>
    </div>
  );
}

function countWords(result: BaselineResult, count: number): string {
  if (result === "match") return `${count} matching`;
  return `${count} ${BASELINE_RESULTS[result].label.toLowerCase()}`;
}

function worst(items: BaselineSettingRow[]): string {
  const off = items.filter((item) => item.result === "different" || item.result === "conflict").length;
  const missing = items.filter((item) => item.result === "not-configured").length;
  return `${off ? ` · ${off} differ` : ""}${missing ? ` · ${missing} not configured` : ""}`;
}

/** Intune's categories inside a group, by name, with settings Microsoft gave no category last. */
function categoryParts(items: BaselineSettingRow[], prefix: string): ListGroup<BaselineSettingRow>[] {
  const map = new Map<string, BaselineSettingRow[]>();
  for (const item of items) map.set(item.category, [...(map.get(item.category) ?? []), item]);
  return [...map.entries()]
    .sort(([a], [b]) => Number(a === OTHER_CATEGORY) - Number(b === OTHER_CATEGORY) || a.localeCompare(b))
    .map(([category, list]) => ({ key: `${prefix}-${category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, label: category, about: settingsWord(list.length), items: list }));
}

function byBaselineGroups(items: BaselineSettingRow[], baselines: Map<string, BaselineVersion>): ListGroup<BaselineSettingRow>[] {
  const map = new Map<string, BaselineSettingRow[]>();
  for (const item of items) map.set(item.baselineKey, [...(map.get(item.baselineKey) ?? []), item]);
  return [...map.entries()]
    .map(([key, list]) => ({ key, list, baseline: baselines.get(key) }))
    .sort((a, b) => (a.baseline && b.baseline ? byBaseline(a.baseline, b.baseline) : 0))
    .map(({ key, list, baseline }) => {
      const parts = categoryParts(list, key);
      return {
        key,
        label: baseline ? baselineLabel(baseline) : key,
        icon: "service-intune" as const,
        about: `${baseline?.current === false ? "Older version · " : ""}${settingsWord(list.length)}${worst(list)}`,
        parts,
        items: parts.flatMap((part) => part.items),
      };
    });
}
