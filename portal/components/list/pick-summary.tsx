"use client";

import { useMemo } from "react";

import { RiskChip } from "@/components/baselines/parts";
import { BaselinesStyles } from "@/components/baselines/styles";
import { PagedRows, type PagedRow } from "@/components/list/paged-rows";
import { Icon } from "@/components/shell/icons";
import { KIND_CHIPS, pickCounts, type PickItem } from "@/lib/pick-summary";


// The table opens by itself when it is short enough to read at a glance.
const OPEN_UP_TO = 5;

/** What a confirm panel applies to: counts by service, risk and kind, then every pick in
 * a table with Find, Order by and pages, folded away when there are many. One pick is
 * named on its own line. `prefix` keeps the table's address keys apart. */
export function PickSummary({ items, noun, prefix = "pick-", kindWord = "Kind" }: { items: PickItem[]; noun: { one: string; many: string }; prefix?: string; kindWord?: string }) {
  const sorts = useMemo(() => [
    { key: "risk", label: "Risk" },
    { key: "kind", label: kindWord },
    { key: "service", label: "Service" },
    { key: "name", label: "Name" },
  ], [kindWord]);
  const counts = useMemo(() => pickCounts(items), [items]);
  const rows = useMemo<PagedRow[]>(() => items.map((item) => ({
    id: item.id,
    text: `${item.name} ${item.kind.label} ${item.service.label} ${item.risk?.label ?? ""}`,
    // A lower rank is more serious, so ascending puts the riskiest first.
    values: { name: item.name, kind: item.kind.rank, service: item.service.rank, risk: item.risk?.rank ?? 99 },
    node: (
      <li className="pick-row">
        <b className="pick-name">{item.name}</b>
        <span className="pick-facts">
          <span className="pick-kind">{item.kind.label}</span>
          <span className="pick-service">{item.service.icon ? <Icon name={item.service.icon} /> : null}{item.service.label}</span>
        </span>
        {item.risk ? <RiskChip tone={item.risk.tone}>{item.risk.label}</RiskChip> : null}
      </li>
    ),
  })), [items]);

  if (!items.length) return null;
  if (items.length === 1) {
    const [item] = items;
    return (
      <div className="pick-summary">
        <BaselinesStyles />
        <p className="pick-one">
          <span className="pick-title">Applies only to</span>
          <b>{item.name}</b>
          <span className="pick-facts">
            <span className="pick-kind">{item.kind.label}</span>
            <span className="pick-service">{item.service.icon ? <Icon name={item.service.icon} /> : null}{item.service.label}</span>
            {item.risk ? <RiskChip tone={item.risk.tone}>{item.risk.label}</RiskChip> : null}
          </span>
        </p>
      </div>
    );
  }

  const shownKinds = counts.kinds.slice(0, KIND_CHIPS);
  const moreKinds = counts.kinds.length - shownKinds.length;
  const total = `${items.length} ${noun.many}`;
  return (
    <section aria-label={`What this applies to: ${total}`} className="pick-summary">
      <BaselinesStyles />
      <p className="pick-title">Applies only to these {total}</p>
      <dl className="pick-counts">
        {counts.risks.length ? (
          <div>
            <dt>Risk</dt>
            <dd>{counts.risks.map(({ facet, count }) => <RiskChip key={facet.key} tone={facet.tone}>{`${facet.label} · ${count}`}</RiskChip>)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Service</dt>
          <dd>{counts.services.map(({ facet, count }) => (
            <span className="pick-chip" key={facet.key}>{facet.icon ? <Icon name={facet.icon} /> : null}{facet.label}<b>{count}</b></span>
          ))}</dd>
        </div>
        <div>
          <dt>{kindWord}</dt>
          <dd>
            {shownKinds.map(({ facet, count }) => <span className="pick-chip" key={facet.key}>{facet.label}<b>{count}</b></span>)}
            {moreKinds > 0 ? <span className="pick-more">and {moreKinds} more {kindWord.toLowerCase()}{moreKinds === 1 ? "" : "s"}</span> : null}
          </dd>
        </div>
      </dl>
      <details className="pick-details" open={items.length <= OPEN_UP_TO}>
        <summary><Icon name="chevron-down" />See every one of the {total}</summary>
        <PagedRows label={`Chosen ${noun.many}`} listClassName="pick-table" noun={noun} prefix={prefix} rows={rows} sorts={sorts} />
      </details>
    </section>
  );
}
