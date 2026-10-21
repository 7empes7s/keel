"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useMemo, useState, type MouseEvent } from "react";

import { ChangeDecision } from "@/components/baselines/change-decision";
import { DetailsSheet } from "@/components/baselines/details-sheet";
import { RiskChip } from "@/components/baselines/parts";
import { BaselinesStyles } from "@/components/baselines/styles";
import { ChangeAttributionPanel } from "@/components/change-attribution";
import { ChangeEvidencePanel } from "@/components/decision-workbook";
import { DriftDiff } from "@/components/drift-diff";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { SemanticDiff } from "@/components/semantic-diff";
import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import {
  changedBy, decisionWords, impactTone, impactWords, kindLine, plainKind, setupName, typeService, whyItMatters, type Decision,
} from "@/lib/baselines-view";
import { changeLabel, changeName } from "@/lib/changes-view";
import { workloadLabel } from "@/lib/compare-view";
import { toDay } from "@/lib/date-range";
import { driftActionControls } from "@/lib/drift-actions";
import { worstTone, type RiskTone } from "@/lib/menu-status";
import { ago, BLAST_RADIUS_ORDER, formatTimestamp } from "@/lib/presentation";
import { typeName } from "@/lib/protect-view";
import { orderGroups, smartOrder } from "@/lib/selection";
import { serviceFor, serviceOrder } from "@/lib/services";
import { toast } from "@/lib/toast";
import type { BaselineRecord, DriftRecord, SemanticSummary } from "@/lib/types";
import { useViewState } from "@/lib/use-view-state";

const toneOf = (item: DriftRecord): RiskTone => impactTone(item.blastRadius);

const listWords = (names: string[]): string => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

function ordered(items: DriftRecord[]): DriftRecord[] {
  return smartOrder(items, toneOf, (item) => item.detectedAt);
}

function groupBy(items: DriftRecord[], key: (item: DriftRecord) => string, meta: (key: string, items: DriftRecord[]) => Omit<ListGroup<DriftRecord>, "items" | "key">, rank?: (key: string) => number): ListGroup<DriftRecord>[] {
  const map = new Map<string, DriftRecord[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  const groups = [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: ordered(list) }));
  return rank ? groups.sort((a, b) => rank(a.key) - rank(b.key)) : orderGroups(groups, (group) => worstTone(group.items.map(toneOf)));
}

const RISK_ABOUT: Record<string, string> = {
  "tenant-lockout": "A wrong value here can lock admins or everyone out",
  "access-affecting": "Changes who can sign in or reach apps and data",
  cosmetic: "Names, labels and descriptions: nobody gains or loses access",
};

const GROUPINGS: Grouping<DriftRecord>[] = [
  {
    key: "service", label: "Service",
    groupsOf: (items) => groupBy(items, (item) => typeService(item.resourceType).code, (code) => {
      const service = serviceFor(code);
      return { label: service.name, icon: service.icon, about: service.about };
    }),
  },
  {
    key: "risk", label: "Risk",
    groupsOf: (items) => groupBy(items, (item) => item.blastRadius, (radius) => ({
      label: impactWords(radius), icon: radius === "cosmetic" ? "info" : "alert", about: RISK_ABOUT[radius],
    }), (radius) => { const index = BLAST_RADIUS_ORDER.indexOf(radius); return index === -1 ? 99 : index; }),
  },
  {
    key: "kind", label: "Kind",
    groupsOf: (items) => groupBy(items, (item) => item.resourceType, (type, list) => ({
      label: plainKind(type), icon: typeService(type).icon, about: `${typeService(type).name} · ${list.length === 1 ? "1 change" : `${list.length} changes`}`,
    })),
  },
  {
    key: "who", label: "Who",
    groupsOf: (items) => groupBy(items, (item) => changedBy(item) ?? "", (who) => ({
      label: who || "Not known yet", icon: "service-entra", about: who ? "Named by the Microsoft audit log" : "The audit log did not name who made these",
    })),
  },
];

/** The Changes page body: count tiles by risk, the shared list grouped by service, a
 * details panel per change, and accept, ignore or undo on the chosen changes. Service
 * setting changes (`serviceRead`) sit in the same list, so its filters and grouping
 * cover every service; they have no approved setup, so decisions skip them and their
 * details point to the Alerts page. */
export function ChangeList({
  baseline,
  capabilities,
  items,
  now,
  summary,
}: {
  // Null when no setup is approved yet: the list then holds service setting changes only.
  baseline: BaselineRecord | null;
  capabilities: string[];
  items: DriftRecord[];
  now: string;
  summary?: SemanticSummary;
}) {
  const view = useViewState();
  const pathname = usePathname() ?? "/drift";
  const params = useSearchParams();
  const [settled, setSettled] = useState<string[]>([]);
  const [deciding, setDeciding] = useState<{ decision: Decision; ids: string[] } | null>(null);
  const { canDispose, canRemediate } = driftActionControls(capabilities);

  const open = useMemo(() => items.filter((item) => !settled.includes(item.id)), [items, settled]);
  const service = view.get("service");
  const risk = view.get("risk");
  const shown = useMemo(() => open.filter((item) => (!service || typeService(item.resourceType).code === service) && (!risk || item.blastRadius === risk)), [open, service, risk]);
  const opened = open.find((item) => item.id === view.get("open")) ?? null;
  const deciding_items = deciding ? open.filter((item) => deciding.ids.includes(item.id)) : [];
  const serviceIds = useMemo(() => new Set(open.filter((item) => item.serviceRead).map((item) => item.id)), [open]);
  const decidable = (ids: string[]) => ids.filter((id) => !serviceIds.has(id));
  const skipped = (ids: string[]) => {
    const count = ids.filter((id) => serviceIds.has(id)).length;
    return count ? ` ${count === 1 ? "1 service setting change is" : `${count} service setting changes are`} left out: review ${count === 1 ? "it" : "them"} on the Alerts page.` : "";
  };

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const query = next.toString();
    return query ? `${pathname}?${query}` : pathname;
  };
  const follow = (event: MouseEvent, changes: Record<string, string | null>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    view.set(changes);
  };

  const radii = BLAST_RADIUS_ORDER.filter((radius) => open.some((item) => item.blastRadius === radius));
  const notes = summary ? [
    summary.mismatched ? `${summary.mismatched} ${summary.mismatched === 1 ? "change rests" : "changes rest"} on records that do not match each other. Its details say which.` : null,
    summary.unknownBefore ? `${summary.unknownBefore} ${summary.unknownBefore === 1 ? "change has" : "changes have"} no copy in the approved setup, so the earlier values are not known.` : null,
  ].filter((note): note is string => note !== null) : [];

  // Service setting changes have no approved setup to accept into or undo back to.
  function decide(decision: Decision, ids: string[]) {
    const chosen = decidable(ids);
    if (chosen.length) setDeciding({ decision, ids: chosen });
    else if (ids.length) view.set({ open: ids[0] });
  }

  const primary = canDispose
    ? {
      label: (count: number) => decisionWords("accept", count).confirm,
      detail: (count: number, ids: string[]) => `Adds ${count === 1 ? "it" : "them"} to the approved setup. Nothing in Microsoft 365 changes.${skipped(ids)}`,
      run: (ids: string[]) => decide("accept", ids),
    }
    : canRemediate
      ? {
        label: (count: number) => decisionWords("undo", count).title,
        detail: (_count: number, ids: string[]) => `Puts the approved values back once someone else approves.${skipped(ids)}`,
        run: (ids: string[]) => decide("undo", ids),
      }
      : {
        label: (count: number) => (count === 1 ? "Open its details" : "Open the first one"),
        detail: () => "You can read these changes. Accepting or undoing them needs a role that can decide.",
        run: (ids: string[]) => view.set({ open: ids[0] }),
      };
  const more = [
    ...(canDispose && canRemediate ? [{ label: "Undo these changes…", run: (ids: string[]) => decide("undo", ids) }] : []),
    ...(canDispose ? [{ label: "Ignore for now…", run: (ids: string[]) => decide("ignore", ids) }] : []),
  ];

  const serviceName = service ? serviceFor(service).name : null;
  const serviceReads = [...new Set(open.flatMap((item) => (item.serviceRead ? [serviceFor(typeService(item.resourceType).code).name] : [])))];
  return (
    <div className="bl-page">
      <BaselinesStyles />
      <section aria-label="Open changes by risk" className="bl-tiles">
        {radii.map((radius) => {
          const count = open.filter((item) => item.blastRadius === radius).length;
          const active = risk === radius;
          return (
            <Link aria-current={active || undefined} className="bl-card bl-tile bl-link" data-tone={impactTone(radius)} href={href({ risk: active ? null : radius, open: null })} key={radius} onClick={(event) => follow(event, { risk: active ? null : radius, open: null })}>
              <span className="bl-tile-label"><Icon name={radius === "cosmetic" ? "info" : "alert"} />{impactWords(radius)}</span>
              <b className="bl-tile-count">{count}</b>
              <small>{RISK_ABOUT[radius]}</small>
            </Link>
          );
        })}
        <Link aria-current={!risk || undefined} className="bl-card bl-tile bl-link" href={href({ risk: null, open: null })} onClick={(event) => follow(event, { risk: null, open: null })}>
          <span className="bl-tile-label"><Icon name="baselines" />All open changes</span>
          <b className="bl-tile-count">{open.length}</b>
          <small>{baseline && !serviceReads.length ? "Everything that differs from the approved setup" : "Everything waiting for review"}</small>
        </Link>
      </section>

      <div className="bl-context">
        {baseline ? (
          <p>
            <Icon name="baselines" />
            <span>Measured against <Link href="/baselines">{setupName(baseline)}</Link>, approved <time dateTime={baseline.setAt} title={formatTimestamp(baseline.setAt)}>{ago(baseline.setAt, now)}</time>.</span>
          </p>
        ) : null}
        {serviceReads.length ? (
          <p className="bl-note">
            <Icon name="info" />
            <span>{`${listWords(serviceReads)} ${serviceReads.length === 1 ? "has" : "have"} no approved setup yet, so Keel compares each read with the one before it. Review those changes on the `}<Link href="/alerts">Alerts page</Link>.</span>
          </p>
        ) : null}
        {notes.map((note) => <p className="bl-note" key={note}><Icon name="info" /><span>{note}</span></p>)}
      </div>

      {service || risk ? (
        <p className="bl-filter-note" role="status">
          Showing {[risk ? impactWords(risk).toLowerCase() : null, serviceName ? `in ${serviceName}` : null].filter(Boolean).join(" ")} only: {shown.length} of {open.length}.
          <Link className="bl-inline-link" href={href({ service: null, risk: null })} onClick={(event) => follow(event, { service: null, risk: null })}>Show every change</Link>
        </p>
      ) : null}

      <section aria-labelledby="open-drift-heading" className="bl-section">
        <h2 className="visually-hidden" id="open-drift-heading">Open changes</h2>
        {open.length ? (
          <SelectableList
            action={primary}
            getId={(item) => item.id}
            groupings={GROUPINGS}
            items={shown}
            label="Open changes"
            matches={(item, query) => `${changeName(item)} ${plainKind(item.resourceType)} ${typeName(item.resourceType)} ${changedBy(item) ?? ""}`.toLowerCase().includes(query)}
            more={more}
            noun={{ one: "change", many: "changes" }}
            renderRow={(item) => {
              const who = changedBy(item);
              return (
                <div className="bl-row">
                  <span aria-hidden="true" className="bl-kind-icon" data-tone={toneOf(item)}><Icon name={typeService(item.resourceType).icon} /></span>
                  <span className="bl-row-name">
                    <Link className="bl-row-link" href={href({ open: item.id })} onClick={(event) => follow(event, { open: item.id })}>{changeName(item)}</Link>
                    <small>{kindLine(item)}</small>
                  </span>
                  <RiskChip tone={toneOf(item)}>{impactWords(item.blastRadius)}</RiskChip>
                  <span className="bl-row-who">
                    {who ?? "Not known yet"}
                    <small><time dateTime={item.detectedAt} title={formatTimestamp(item.detectedAt)}>{ago(item.detectedAt, now)}</time></small>
                  </span>
                </div>
              );
            }}
            rowName={(item) => changeLabel(item)}
            toneOf={toneOf}
          />
        ) : (
          <div className="bl-card bl-empty">
            <span aria-hidden="true" className="bl-kind-icon" data-tone="fine"><Icon name="check" /></span>
            <div><h3>Nothing to review</h3><p>The tenant matches the approved setup. Keel checks again after the next backup.</p></div>
          </div>
        )}
        {open.length ? (
          <TechnicalDetails summary="Technical details: these changes">
            {open.map((item) => (
              <RecordField key={item.id} label={`${item.serviceRead ? "Service change ID" : "Drift ID"} · ${item.naturalKey}`} usage={`Natural key ${item.naturalKey}, detected ${item.detectedAt}`} value={item.id} />
            ))}
            {baseline ? <RecordField label="Baseline ID" usage={<code>GET /api/baselines</code>} value={baseline.id} /> : null}
          </TechnicalDetails>
        ) : null}
      </section>

      {opened && !deciding ? (
        <DetailsSheet
          footer={opened.serviceRead ? (
            <>
              <Link className="btn btn-primary" href="/alerts">Review on the Alerts page</Link>
              <p className="bl-help">{workloadLabel(opened.serviceRead.workload)} has no approved setup, so there is nothing to accept or undo. Acknowledge or resolve its alert once someone has checked the change.</p>
            </>
          ) : canDispose || canRemediate ? (
            <>
              {canDispose ? <button className="btn btn-primary" onClick={() => decide("accept", [opened.id])} type="button">Accept this change</button> : null}
              {canRemediate ? <button className="btn" onClick={() => decide("undo", [opened.id])} type="button">Undo this change</button> : null}
              {canDispose ? <button className="btn" onClick={() => decide("ignore", [opened.id])} type="button">Ignore for now</button> : null}
              <p className="bl-help">Accepting adds it to the approved setup and changes nothing in Microsoft 365. Undo first shows what it can put back, then needs someone else&apos;s approval.</p>
            </>
          ) : undefined}
          kicker={<><RiskChip tone={toneOf(opened)}>{impactWords(opened.blastRadius)}</RiskChip><span>{kindLine(opened)}</span></>}
          onClose={() => view.set({ open: null })}
          title={changeName(opened)}
          wide
        >
          <section className="bl-why" aria-label="Why it matters">
            <h3>Why it matters</h3>
            <p>{whyItMatters(opened.resourceType)}</p>
            <p className="bl-help">
              {opened.serviceRead
                ? `Keel found it ${ago(opened.detectedAt, now)}, when it compared the newest ${workloadLabel(opened.serviceRead.workload).toLowerCase()} read in ${typeService(opened.resourceType).name} with the one before. It does not know who made it.`
                : `${changedBy(opened) ? `${changedBy(opened)} made it` : "Keel does not know who made it yet"}; Keel found it ${ago(opened.detectedAt, now)}, in ${typeService(opened.resourceType).name}.`}
            </p>
          </section>
          {opened.semantic ? <SemanticDiff change={opened.semantic} item={opened} /> : <DriftDiff item={opened} />}
          {opened.evidence !== undefined ? <ChangeEvidencePanel attribution={opened.attribution} evidence={opened.evidence} now={now} /> : null}
          {opened.attribution !== undefined ? <ChangeAttributionPanel attribution={opened.attribution} now={now} /> : null}
          {opened.serviceRead ? (
            <TechnicalDetails>
              <RecordField label="Resource" value={opened.serviceRead.resourceKey} />
              <RecordField label="Service change ID" value={opened.id} />
              <RecordField copy={false} label="Service read" value={`${opened.serviceRead.workload} · ${opened.serviceRead.collectionId}`} />
              <RecordField label="Compared with read" value={opened.serviceRead.previousCollectionId} />
              <RecordField label="Alert" value={opened.serviceRead.alertId} />
              <RecordField copy={false} label="Seen at" value={opened.detectedAt} />
            </TechnicalDetails>
          ) : (
            <TechnicalDetails>
              <RecordField label="Natural key" value={opened.naturalKey} />
              <RecordField label="Drift ID" value={opened.id} />
              <RecordField copy={false} label="Detected at" value={opened.detectedAt} />
            </TechnicalDetails>
          )}
        </DetailsSheet>
      ) : null}

      {deciding && deciding_items.length ? (
        <DetailsSheet
          kicker={<span>{deciding_items.length === 1 ? changeName(deciding_items[0]) : `${deciding_items.length} changes`}</span>}
          onClose={() => setDeciding(null)}
          title={decisionWords(deciding.decision, deciding_items.length).title}
        >
          <ChangeDecision
            decision={deciding.decision}
            items={deciding_items}
            onCancel={() => setDeciding(null)}
            onDone={(done, message) => {
              setSettled((current) => [...new Set([...current, ...done])]);
              setDeciding(null);
              if (done.length) view.set({ open: null });
              toast(done.length ? { title: message } : { tone: "info", title: "Sent to approvers", detail: "Nothing changes until one of them approves.", href: "/approvals", hrefLabel: "Open approvals" });
            }}
            today={toDay(new Date(now))}
          />
        </DetailsSheet>
      ) : null}
    </div>
  );
}
