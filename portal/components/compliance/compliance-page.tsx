"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type MouseEvent } from "react";

import { BaselinesStyles } from "@/components/baselines/styles";
import { ControlSheet } from "@/components/compliance/control-sheet";
import { FindingRecordFields, StorageRecordFields } from "@/components/compliance/compliance-record";
import { ExceptionSheet, type Granted } from "@/components/compliance/exception-sheet";
import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import { Verdict } from "@/components/verdict";
import {
  NOT_A_CERTIFICATION,
  NOT_RUN_YET,
  RESULTS,
  canGrantOn,
  complianceCounts,
  complianceVerdict,
  controlName,
  controlService,
  controlShort,
  findingTypes,
  grantLabel,
  immutabilitySentence,
  orderFindings,
  ownerPerson,
  resultLine,
  resultOf,
  standardName,
  storageSentence,
  type ControlResult,
} from "@/lib/compliance-view";
import { addsWords, applyFilters, readPicked, tileCounts, tileParam, withoutTile, type FilterTile } from "@/lib/filter-set";
import { ago } from "@/lib/presentation";
import { serviceOrder } from "@/lib/services";
import { toast } from "@/lib/toast";
import type { ComplianceData, ComplianceFinding } from "@/lib/types";
import { pushUrl } from "@/lib/url-history";
import { useViewState } from "@/lib/use-view-state";

// Compliance (portal audit, pick A on a desktop, B on a phone): which security controls
// pass, and why. Four count tiles (Failing, With exception, Could not check, Passing)
// are links that set `result=`; controls sit in one SelectableList grouped by Microsoft
// service, with a phone-only scorecard of tiles per service above it. A name opens the
// control's panel (`?open=<id>`); "Grant an exception" (`?grant=<ids>`) is the one amber
// action, on failing controls. Ids stay in one record at the foot.

const TILES: { key: ControlResult; small: string }[] = [
  { key: "failing", small: "Not met, no exception in force" },
  { key: "excepted", small: "Not met, accepted until a date" },
  { key: "unknown", small: "The backup it needs is missing or too old" },
  { key: "passing", small: "Met on the last check" },
];
const RESULT_TILES: FilterTile<ComplianceFinding>[] = (Object.keys(RESULTS) as ControlResult[]).map((key) => ({ key, test: (finding: ComplianceFinding) => resultOf(finding) === key }));

export function CompliancePage({ data, canConfigure, now = data.generatedAt }: {
  data: ComplianceData;
  canConfigure: boolean;
  now?: string;
}) {
  const router = useRouter();
  const view = useViewState();
  const pathname = usePathname() ?? "/benchmarks";
  const params = useSearchParams();
  const [granted, setGranted] = useState<Record<string, Granted>>({});

  // An exception just saved shows at once, before the page's next read brings it back.
  const findings = useMemo(() => orderFindings(data.findings.map((finding) => {
    const fresh = granted[finding.id];
    if (!fresh) return finding;
    return {
      ...finding,
      exceptionState: "authorized" as const,
      exposed: false,
      exception: {
        ...(finding.exception ?? {}),
        id: finding.exception?.id ?? "", grantedBy: null, grantedAt: now,
        owner: fresh.owner, reason: fresh.reason, expiresAt: fresh.expiresAt,
        ownerRef: fresh.ownerName && !fresh.ownerName.includes("@") ? { kind: "person", id: "", name: fresh.ownerName, href: null } : null,
        grantedByRef: null,
      },
    };
  })), [data.findings, granted, now]);
  const counts = useMemo(() => complianceCounts(findings), [findings]);
  const verdict = complianceVerdict({ ...data, findings });
  // The result tiles add up: `result=failing,unknown` shows controls in either.
  const filter = readPicked(RESULT_TILES, params?.get("result")) as ControlResult[];
  const filterKey = filter.join(",");
  const shown = useMemo(() => applyFilters(findings, RESULT_TILES, filterKey ? filterKey.split(",") : []), [findings, filterKey]);
  const tileTotals = useMemo(() => new Map(tileCounts(findings, RESULT_TILES, filterKey ? filterKey.split(",") : []).map((entry) => [entry.key, entry])), [findings, filterKey]);
  const activeFilters: ActiveFilter[] = filter.map((key) => ({ key: `result:${key}`, label: RESULTS[key].plural, clear: { result: withoutTile(filter, key) } }));
  const opened = findings.find((finding) => finding.id === view.get("open")) ?? null;
  const grantIds = view.get("grant").split(",").filter(Boolean);
  const granting = canConfigure ? findings.filter((finding) => grantIds.includes(finding.id) && finding.verdict === "fail") : [];
  const failing = findings.filter((finding) => resultOf(finding) === "failing");
  const baseline = data.activeBaseline;
  const { storage } = data;

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const text = next.toString();
    return text ? `${pathname}?${text}` : pathname;
  };
  const openHref = (id: string) => href({ open: id, grant: null });
  const grantHref = (ids: string[]) => href({ grant: ids.join(","), open: ids.length === 1 ? ids[0] : null });
  const follow = (event: MouseEvent, to: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    pushUrl(to);
  };

  const verdictAction = canConfigure && failing.length === 1 && !granting.length ? { label: grantLabel(failing[0]), href: grantHref([failing[0].id]) } : null;

  const groupings = useMemo<Grouping<ComplianceFinding>[]>(() => [
    { key: "service", label: "Service", groupsOf: (items) => groupBy(items, (item) => controlService(item).code, (_key, list) => { const service = controlService(list[0]); return { label: service.name, icon: service.icon, about: `${service.about} · ${controlsWord(list.length)}${worstWords(list)}` }; }, (key) => serviceOrder(key)) },
    { key: "result", label: "Result", groupsOf: (items) => groupBy(items, (item) => resultOf(item), (key, list) => ({ label: RESULTS[key as ControlResult].plural, icon: RESULTS[key as ControlResult].icon, about: controlsWord(list.length) }), (key) => RESULTS[key as ControlResult].rank) },
    { key: "standard", label: "Standard", groupsOf: (items) => groupBy(items, (item) => standardName(item), (key, list) => ({ label: key, icon: "check-circle" as IconName, about: controlsWord(list.length) }), () => 0) },
  ], []);

  function exportResults(chosen: ComplianceFinding[], name: string) {
    download(`keel-compliance-${name}-${now.slice(0, 10)}.json`, JSON.stringify({ generatedAt: now, results: chosen.map((finding) => ({ ...finding, result: resultOf(finding) })) }, null, 2));
  }

  const renderRow = (finding: ComplianceFinding) => {
    const result = resultOf(finding);
    const words = RESULTS[result];
    const service = controlService(finding);
    const owner = ownerPerson(finding);
    return (
      <div className="cp-row" data-result={result}>
        <span aria-hidden="true" className="cp-kind" data-tone={words.tone ?? undefined}><Icon name={service.icon} /></span>
        <span className="cp-row-name">
          <Link className="cp-row-link" href={openHref(finding.id)} onClick={(event) => follow(event, openHref(finding.id))}>{controlName(finding)}</Link>
          <small>Checks {findingTypes(finding)} · checked {ago(finding.evaluatedAt, now)}</small>
        </span>
        <span className="cp-row-mid">
          <Badge icon={words.icon} tone={words.badge}>{words.label}</Badge>
          <small>{resultLine(finding, now)}</small>
          {owner ? <small className="cp-owner">Owner <Person person={owner} /></small> : null}
        </span>
        <span className="cp-row-acts">
          {result === "failing" && canGrantOn(finding, canConfigure) ? <Link className="btn btn-sm" href={grantHref([finding.id])}>{finding.exception ? "Renew exception" : "Grant exception"}</Link> : null}
          {result === "unknown" ? <Link className="btn btn-sm" href="/protect"><Icon name="backup" />Run a backup</Link> : null}
        </span>
      </div>
    );
  };

  const services = useMemo(() => groupBy(findings, (item) => controlService(item).code, (_key, list) => { const service = controlService(list[0]); return { label: service.name, icon: service.icon, about: service.about }; }, (key) => serviceOrder(key)), [findings]);

  return (
    <div className="cp-page">
      <Verdict action={verdictAction} detail={verdict.detail} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <p className="cp-context">
          <span>
            {baseline ? <>Measured against <Link className="cp-inline-link" href="/baselines">{baseline.label ?? "the approved setup"}</Link>{baseline.capture?.capturedAt ? `, captured ${ago(baseline.capture.capturedAt, now)}` : ""}.</> : <>No approved setup is active. <Link className="cp-inline-link" href="/baselines">Approved setups</Link></>}
          </span>
          <span>{NOT_RUN_YET}</span>
        </p>

        <section aria-label="Results at a glance" className="cp-tiles">
          {TILES.map((tile) => {
            const words = RESULTS[tile.key];
            const active = filter.includes(tile.key);
            const adds = addsWords(tileTotals.get(tile.key), filter.length);
            const tone = tile.key === "failing" && counts.failing ? "urgent" : (tile.key === "unknown" || tile.key === "excepted") && counts[tile.key] ? "soon" : undefined;
            return (
              <Link aria-current={active || undefined} className="cp-tile" data-tone={tone} href={href({ result: tileParam(RESULT_TILES, filter, tile.key), open: null, grant: null })} key={tile.key} title={active ? "Picked: click to remove it from the view" : "Click to add these to the view"}>
                <span className="cp-tile-label"><Icon name={words.icon} />{words.label}{active ? <Icon className="tile-check" name="check" /> : null}</span>
                <b className="cp-tile-count">{counts[tile.key]}</b>
                <small>{tile.small}</small>
                {adds ? <small className="tile-adds">{adds}</small> : null}
              </Link>
            );
          })}
        </section>

        {/* Pick B on a phone: one card per service, one tile per control, coloured by result. */}
        {findings.length ? (
          <section aria-labelledby="cp-by-service-heading" className="cp-section cp-by-service">
            <h2 className="visually-hidden" id="cp-by-service-heading">By service</h2>
            {services.map((group) => (
              <div className="cp-service" key={group.key}>
                <div className="cp-service-head">
                  <span aria-hidden="true" className="cp-kind">{group.icon ? <Icon name={group.icon} /> : null}</span>
                  <span><b>{group.label}</b><small>{controlsWord(group.items.length)} · {group.items.filter((item) => resultOf(item) === "passing").length} passing</small></span>
                </div>
                <div className="cp-ctiles">
                  {group.items.map((finding) => {
                    const words = RESULTS[resultOf(finding)];
                    return (
                      <Link className="cp-ctile" data-tone={words.tone ?? undefined} href={openHref(finding.id)} key={finding.id} onClick={(event) => follow(event, openHref(finding.id))}>
                        <Badge icon={words.icon} tone={words.badge}>{resultOf(finding) === "excepted" ? "Exception" : words.label}</Badge>
                        <b>{controlShort(finding)}</b>
                        <small>{resultLine(finding, now)}</small>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </section>
        ) : null}

        <section aria-labelledby="cp-controls-heading" className="cp-section">
          <h2 className="visually-hidden" id="cp-controls-heading">Controls</h2>
          <ActiveFilters extra={{ open: null, grant: null }} filters={activeFilters} noun={{ one: "control", many: "controls" }} shown={shown.length} total={findings.length} />
          {findings.length === 0 ? (
            <p className="sel-empty">No control has been checked on this tenant yet.</p>
          ) : shown.length === 0 ? (
            <NoMatches extra={{ open: null, grant: null }} filters={activeFilters} noun={{ one: "control", many: "controls" }} />
          ) : (
            <SelectableList
              action={canConfigure ? {
                label: (count) => `Grant an exception to ${controlsWord(count)}`,
                detail: (_count, ids) => {
                  const fails = shown.filter((finding) => ids.includes(finding.id) && finding.verdict === "fail").length;
                  return fails === 0 ? "None of these fails, so none can have an exception." : `Opens one exception for the ${controlsWord(fails)} that ${fails === 1 ? "fails" : "fail"}. The others are not changed.`;
                },
                run: (ids) => {
                  const fails = shown.filter((finding) => ids.includes(finding.id) && finding.verdict === "fail").map((finding) => finding.id);
                  if (fails.length === 0) { toast({ tone: "warning", title: "Nothing to accept", detail: "Only a failing control can have an exception." }); return; }
                  pushUrl(grantHref(fails));
                },
              } : {
                label: (count) => `Export ${controlsWord(count)}`,
                detail: () => "Saves these results and what they rest on as a JSON file.",
                run: (ids) => exportResults(shown.filter((finding) => ids.includes(finding.id)), "selected"),
              }}
              getId={(item) => item.id}
              groupings={groupings}
              items={shown}
              label="Controls"
              matches={(item, text) => `${controlName(item)} ${findingTypes(item)}`.toLowerCase().includes(text)}
              more={canConfigure ? [{ label: "Export these results", run: (ids) => exportResults(shown.filter((finding) => ids.includes(finding.id)), "selected") }] : []}
              noun={{ one: "control", many: "controls" }}
              renderRow={renderRow}
              rowName={(item) => controlName(item)}
              toneOf={(item) => RESULTS[resultOf(item)].tone}
            />
          )}
        </section>

        <div className="cp-storage">
          <span aria-hidden="true" className="cp-storage-icon"><Icon name="cloud" /></span>
          <p><b>{storageSentence(storage)}</b>{storage.configured ? ` ${immutabilitySentence(storage)}` : null}</p>
          <span className="cp-help" tabIndex={0} title={NOT_A_CERTIFICATION}><Icon name="info" /><span className="visually-hidden">{NOT_A_CERTIFICATION}</span></span>
        </div>

        <TechnicalDetails summary="Technical details for these results">
          <RecordField copy={false} label="Read with" value="GET /api/evidence?kind=benchmark-evaluation,benchmark-exception" />
          <RecordField copy={false} label="Grant with" value="POST /api/actions/compliance/exception {evaluationId, owner, reason, expiresAt}" />
          {baseline ? <RecordField label="Approved setup ID" value={baseline.id} /> : null}
          {findings.map((finding) => <FindingRecordFields finding={finding} key={finding.id} />)}
          <StorageRecordFields storage={storage} />
        </TechnicalDetails>
      </div>

      {opened || granting.length ? <BaselinesStyles /> : null}
      {opened && !granting.length ? (
        <ControlSheet canConfigure={canConfigure} finding={opened} grantHref={grantHref([opened.id])} key={opened.id} now={now} onClose={() => view.set({ open: null })} />
      ) : null}
      {granting.length ? (
        <ExceptionSheet
          findings={granting}
          key={granting.map((finding) => finding.id).join(",")}
          onClose={() => view.set({ grant: null })}
          onDone={(saved) => { setGranted((current) => ({ ...current, ...saved })); view.set({ grant: null }); router.refresh(); }}
          today={now.slice(0, 10)}
        />
      ) : null}
    </div>
  );
}

/** Export evidence: every check and exception Keel recorded, as one JSON file. */
export function ExportEvidence() {
  const [busy, setBusy] = useState(false);
  async function run() {
    setBusy(true);
    try {
      const response = await fetch("/api/evidence?kind=benchmark-evaluation,benchmark-exception&limit=200");
      if (!response.ok) { toast({ tone: "warning", title: "Evidence could not be read", detail: response.status === 403 ? "You need the read permission." : "Try again in a moment." }); return; }
      const body = (await response.json()) as { entries: unknown[]; generatedAt: string };
      download(`keel-compliance-evidence-${String(body.generatedAt ?? new Date().toISOString()).slice(0, 10)}.json`, JSON.stringify(body, null, 2));
      toast({ title: `Evidence exported: ${body.entries.length} ${body.entries.length === 1 ? "record" : "records"}` });
    } catch {
      toast({ tone: "warning", title: "Evidence could not be read", detail: "Keel could not be reached." });
    } finally {
      setBusy(false);
    }
  }
  return <button aria-busy={busy || undefined} className="btn" disabled={busy} onClick={() => void run()} type="button"><Icon name="save" />Export evidence</button>;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function controlsWord(count: number): string {
  return `${count} ${count === 1 ? "control" : "controls"}`;
}

function worstWords(list: ComplianceFinding[]): string {
  const failing = list.filter((item) => resultOf(item) === "failing").length;
  return failing ? ` · ${failing} failing` : "";
}

function groupBy<T>(items: T[], key: (item: T) => string, meta: (key: string, list: T[]) => Omit<ListGroup<T>, "items" | "key">, rank: (key: string) => number): ListGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: list })).sort((a, b) => rank(a.key) - rank(b.key));
}
