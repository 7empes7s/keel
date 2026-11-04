"use client";

import Link from "next/link";
import { useMemo } from "react";

import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { Icon } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { Verdict } from "@/components/verdict";
import { addsWords, applyFilters, readPicked, tileCounts, tileParam, withoutTile } from "@/lib/filter-set";
import {
  KIND_ORDER, KIND_WORDS, OWNER_TILES, PROBLEMS, itemLink, itemName, ownerReviewVerdict, problemWords, unreadNotes,
  type OwnerReviewData, type OwnerReviewItem,
} from "@/lib/owner-review-view";
import { ago, formatTimestamp } from "@/lib/presentation";
import { useViewState } from "@/lib/use-view-state";

// Owner review (issue #964): groups, teams, apps and sites with no working owner. The
// tiles add up (OR); with none picked the list shows every item with a problem. Items
// with a working owner are counted, not listed. Ids sit under Technical details.

const NOUN = { one: "group, app or site", many: "groups, apps and sites" };

function plural(n: number, one: string, many: string) {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}

function Row({ item }: { item: OwnerReviewItem }) {
  const words = PROBLEMS[item.problem];
  const link = itemLink(item);
  return (
    <li className="or-row" data-problem={item.problem}>
      <span aria-hidden="true" className="cp-kind" data-tone={words.tone === "neutral" ? undefined : words.tone}><Icon name={words.icon} /></span>
      <span className="or-row-main">
        <b>{itemName(item)}</b>
        <small>{problemWords(item)}</small>
      </span>
      <span className="or-row-side">
        <Badge tone={words.tone}>{words.label}</Badge>
        {link ? (
          link.external
            ? <a className="or-link" href={link.href} rel="noreferrer" target="_blank">{link.label}<span className="visually-hidden"> (opens in a new tab)</span></a>
            : <Link className="or-link" href={link.href}>{link.label}</Link>
        ) : null}
      </span>
      <span className="or-row-tech">
        <TechnicalDetails>
          <RecordField label={item.kind === "site" ? "Site" : "Object ID"} value={item.id} />
          {item.appId ? <RecordField label="Application ID" value={item.appId} /> : null}
          {item.naturalKey ? <RecordField copy={false} label="Saved under" value={item.naturalKey} /> : null}
          <RecordField copy={false} label="Owners read" value={item.readAt} />
          {item.readFailure ? (
            <RecordGroup note={item.readFailure.outcome} title="Owner read">
              <RecordField copy={false} label="Owner read result" value={item.readFailure.outcome} />
              <RecordField copy={false} label="Microsoft answered (HTTP status)" value={item.readFailure.httpStatus} />
              <RecordField copy={false} label="Microsoft error code" value={item.readFailure.graphCode} />
              <RecordField copy={false} label="Error" value={item.readFailure.error} />
            </RecordGroup>
          ) : null}
          {item.owners.length ? (
            <RecordField copy={false} label="Owners as read" value={item.owners.map((owner) => `${owner.name ?? "No name"} (${owner.state})${owner.id ? ` ${owner.id}` : ""}`).join("\n")} />
          ) : null}
        </TechnicalDetails>
      </span>
    </li>
  );
}

export function OwnerReviewPage({ data }: { data: OwnerReviewData }) {
  const view = useViewState();
  const now = data.generatedAt;
  const problems = useMemo(() => data.items.filter((item) => item.problem !== "fine"), [data.items]);
  const picked = readPicked(OWNER_TILES, view.get("owners"));
  const shown = useMemo(() => applyFilters(problems, OWNER_TILES, picked), [problems, picked]);
  const totals = useMemo(() => new Map(tileCounts(problems, OWNER_TILES, picked).map((entry) => [entry.key, entry])), [problems, picked]);
  const counts = useMemo(() => new Map(OWNER_TILES.map((tile) => [tile.key, problems.filter(tile.test).length])), [problems]);
  const verdict = ownerReviewVerdict(data);
  const notes = unreadNotes(data);
  const tiles = OWNER_TILES.filter((tile) => tile.key !== "unread" || (counts.get(tile.key) ?? 0) > 0 || picked.includes(tile.key));
  const filters: ActiveFilter[] = picked.map((key) => ({ key, label: OWNER_TILES.find((tile) => tile.key === key)!.label, clear: { owners: withoutTile(picked, key) } }));
  const fine = data.items.length - problems.length;
  const skipped = data.skipped.microsoft + data.skipped.unknownPublisher + data.skipped.otherType;

  return (
    <div className="cp-page or-page">
      <Verdict detail={verdict.detail} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        {notes.map((note) => (
          <p className="ib-alert" data-tone="soon" key={note.kind} role="status">
            <Icon name="alert" />
            <span><b>{note.text}.</b> {note.detail}{note.fix ? <> <Link className="cp-inline-link" href={note.fix.href}>{note.fix.label}</Link></> : null}</span>
          </p>
        ))}
        <p className="cp-context">
          {data.directory.readAt ? <span>Owners checked against users from the backup <time dateTime={data.directory.readAt} title={formatTimestamp(data.directory.readAt)}>{ago(data.directory.readAt, now)}</time></span> : <span>No backup holds your users yet, so disabled and guest owners cannot be told apart.</span>}
          {data.sites.readAt ? <span>Site owners from the nightly backup <time dateTime={data.sites.readAt} title={formatTimestamp(data.sites.readAt)}>{ago(data.sites.readAt, now)}</time></span> : null}
          {fine ? <span>{plural(fine, "more has", "more have")} a working owner.</span> : null}
        </p>

        {problems.length || picked.length ? (
          <section aria-label="Owner problems at a glance" className="cp-tiles" style={{ ["--cp-tiles" as string]: tiles.length }}>
            {tiles.map((tile) => {
              const active = picked.includes(tile.key);
              const adds = addsWords(totals.get(tile.key), picked.length);
              const n = counts.get(tile.key) ?? 0;
              const tone = n && (tile.key === "no-owner" || tile.key === "only-disabled") ? "urgent" : n ? "soon" : undefined;
              return (
                <button aria-current={active || undefined} className="cp-tile" data-tone={tone} key={tile.key} onClick={() => view.set({ owners: tileParam(OWNER_TILES, picked, tile.key) })} title={active ? "Picked: click to remove it from the view" : "Click to add these to the view"} type="button">
                  <span className="cp-tile-label"><Icon name={tile.icon} />{tile.label}{active ? <Icon className="tile-check" name="check" /> : null}</span>
                  <b className="cp-tile-count">{n}</b>
                  <small>{tile.small}</small>
                  {adds ? <small className="tile-adds">{adds}</small> : null}
                </button>
              );
            })}
          </section>
        ) : null}

        <section aria-labelledby="or-list-heading" className="cp-section">
          <h2 className="visually-hidden" id="or-list-heading">To review</h2>
          <ActiveFilters filters={filters} noun={NOUN} shown={shown.length} total={problems.length} />
          {problems.length === 0 ? (
            <p className="empty-state">{data.items.length ? "Nothing to review: every group, app and site Keel checked has a working owner." : "Nothing has been checked yet. Owners are read with the backup."}</p>
          ) : shown.length === 0 ? (
            <NoMatches filters={filters} noun={NOUN} />
          ) : (
            KIND_ORDER.map((kind) => {
              const items = shown.filter((item) => item.kind === kind);
              if (!items.length) return null;
              const words = KIND_WORDS[kind];
              return (
                <section aria-labelledby={`or-${kind}-heading`} className="or-kind" key={kind}>
                  <h3 className="or-kind-heading" id={`or-${kind}-heading`}><Icon name={words.icon} />{words.heading} <span className="result-count">{items.length}</span></h3>
                  <ul className="or-list">
                    {items.map((item) => <Row item={item} key={`${item.kind}:${item.id}`} />)}
                  </ul>
                </section>
              );
            })
          )}
        </section>

        {data.sites.unread ? <p className="st-footnote">{plural(data.sites.unread, "site is", "sites are")} not checked yet: their owners are read with the nightly backup.</p> : null}
        {skipped ? <p className="st-footnote">{plural(skipped, "enterprise app is", "enterprise apps are")} left out: Microsoft&apos;s own apps, managed identities, and apps the backup cannot tell apart from Microsoft&apos;s.</p> : null}

        <TechnicalDetails summary="Technical details for this review">
          <RecordField copy={false} label="Owner lists" value="Owners are what Microsoft returned at the last backup. Keel never reports relationship reads as complete (coverage: relationshipCompleteness partial at best), so an owner added since then is not shown." />
          <RecordField copy={false} label="Relationship completeness" value={data.completeness} />
          {(["group", "application", "servicePrincipal"] as const).map((kind) => {
            const read = data.reads[kind];
            return (
              <RecordGroup key={kind} note={read.family} title={`Owner read: ${KIND_WORDS[kind].many}`}>
                {read.snapshotId ? <RecordField label="Backup ID" value={read.snapshotId} /> : null}
                <RecordField copy={false} label="Owner read finished" value={read.readAt} />
                <RecordField copy={false} label="Permission needed" value={read.permission} />
                <RecordField copy={false} label="Refused owner reads" value={read.refused} />
                <RecordField copy={false} label="Failed owner reads" value={read.failed} />
                <RecordField copy={false} label="Owners not read" value={read.notRead} />
              </RecordGroup>
            );
          })}
          <RecordGroup title="Users">
            {data.directory.snapshotId ? <RecordField label="Backup ID" value={data.directory.snapshotId} /> : null}
            <RecordField copy={false} label="Users read" value={data.directory.users} />
            <RecordField copy={false} label="User list read in full" value={data.directory.complete} />
          </RecordGroup>
          <RecordGroup title="Enterprise apps left out">
            <RecordField copy={false} label="Published by Microsoft" value={data.skipped.microsoft} />
            <RecordField copy={false} label="Publisher not known" value={data.skipped.unknownPublisher} />
            <RecordField copy={false} label="Managed identities and other types" value={data.skipped.otherType} />
          </RecordGroup>
        </TechnicalDetails>
      </div>
    </div>
  );
}
