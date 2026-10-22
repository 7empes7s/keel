import { RecordField, TechnicalDetails } from "@/components/technical-details";
import {
  catalogueSentence,
  missingCatalogue,
  notUsedCatalogue,
  notUsedSentence,
  containerLine,
  discoveryHeadline,
  objectCount,
  sourceLabel,
  skippedSentence,
  sourceProblems,
  typeLabel,
  unreadableSentence,
  type DiscoveryInventoryData,
  type DiscoveryItem,
} from "@/lib/discovery";
import { ago, formatTimestamp } from "@/lib/presentation";

// Wave 1 DISC: what the tenant holds that KEEL could back up, from the latest
// discovery run. The answer leads; each list is collapsed, and every path, cmdlet and
// HTTP status sits under Technical details.

const HEADING_ID = "discovery-heading";

function ItemRow({ item }: { item: DiscoveryItem }) {
  return (
    <li className="activity-item">
      <div className="activity-main">
        <span className="activity-title">{typeLabel(item)}</span>
        <p className="activity-meta">
          {sourceLabel(item.source)}
          {item.status === "uncatalogued" && item.kind !== "cmdlet" ? ` · ${objectCount(item.objects, item.objectsExact)}` : null}
        </p>
        {item.status === "unreadable" ? <p className="activity-meta">{unreadableSentence(item)}</p> : null}
        {item.status === "skipped" ? <p className="activity-meta">{skippedSentence(item)}</p> : null}
        <TechnicalDetails>
          <RecordField label={item.kind === "cmdlet" ? "Cmdlet" : "Graph path"} value={item.name} />
          <RecordField copy={false} label="Found in" value={item.source} />
          {item.httpStatus !== null || item.message ? (
            <RecordField copy={false} label="Answer" value={[item.httpStatus, item.message].filter((part) => part !== null && part !== "").join(" · ")} />
          ) : null}
        </TechnicalDetails>
      </div>
    </li>
  );
}

function ItemList({ items, summary }: { items: DiscoveryItem[]; summary: string }) {
  if (!items.length) return null;
  return (
    <details className="technical-details">
      <summary>{summary}</summary>
      <ul className="activity-list">
        {items.map((item) => <ItemRow item={item} key={`${item.source}|${item.name}`} />)}
      </ul>
    </details>
  );
}

export function DiscoveryInventoryView({ data, now }: { data: DiscoveryInventoryData | null; now: string }) {
  if (!data) {
    return (
      <section aria-labelledby={HEADING_ID} className="report-section">
        <div className="section-heading-row report-heading">
          <div>
            <p className="section-kicker">Discovery</p>
            <h2 id={HEADING_ID}>What the tenant holds</h2>
          </div>
        </div>
        <p className="empty-state">Discovery has not run for this tenant yet, so KEEL cannot yet say what it is not backing up.</p>
      </section>
    );
  }
  const uncatalogued = data.items.filter((item) => item.status === "uncatalogued");
  const unreadable = data.items.filter((item) => item.status === "unreadable");
  const skipped = data.items.filter((item) => item.status === "skipped");
  const missing = missingCatalogue(data);
  const notUsed = notUsedCatalogue(data);
  const containers = containerLine(data);
  return (
    <section aria-labelledby={HEADING_ID} className="report-section">
      <div className="section-heading-row report-heading">
        <div>
          <p className="section-kicker">Discovery</p>
          <h2 id={HEADING_ID}>What the tenant holds</h2>
        </div>
        <span className="result-count">
          <time dateTime={data.finishedAt} title={formatTimestamp(data.finishedAt)}>checked {ago(data.finishedAt, now)}</time>
        </span>
      </div>
      <p>{discoveryHeadline(data)}</p>
      <p className={missing.length ? "action-error" : undefined}>{catalogueSentence(data)}</p>
      {containers ? <p className="activity-meta">{containers}</p> : null}
      {sourceProblems(data).map((line) => <p className="action-error" key={line}>{line}</p>)}
      <ItemList items={uncatalogued} summary={`Not backed up yet (${uncatalogued.length.toLocaleString("en-GB")})`} />
      <ItemList items={unreadable} summary={`KEEL cannot read (${unreadable.length.toLocaleString("en-GB")})`} />
      <ItemList items={skipped} summary={`Not worth backing up (${skipped.length.toLocaleString("en-GB")})`} />
      {missing.length ? (
        <details className="technical-details" open>
          <summary>{`Backed-up types not found (${missing.length})`}</summary>
          <ul className="activity-list">
            {missing.map((entry) => (
              <li className="activity-item" key={entry.type}>
                <div className="activity-main">
                  <span className="activity-title">{typeLabel({ kind: "entitySet", name: entry.path, entityType: entry.type })}</span>
                  <p className="activity-meta">
                    {entry.coverage === "not-in-metadata" ? "Microsoft no longer lists this type." : unreadableSentence({ reason: entry.reason, missingGrant: entry.missingGrant, grantSource: "documented" })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {notUsed.length ? (
        <details className="technical-details">
          <summary>{`Not used in this tenant (${notUsed.length})`}</summary>
          <ul className="activity-list">
            {notUsed.map((entry) => (
              <li className="activity-item" key={entry.type}>
                <div className="activity-main">
                  <span className="activity-title"><span className="pill pill-neutral">Not used</span> {typeLabel({ kind: "entitySet", name: entry.path, entityType: entry.type })}</span>
                  <p className="activity-meta">{notUsedSentence(entry)}</p>
                </div>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

/**
 * The Protect page's discovery section. `data` is the latest run (null before the
 * first one), or undefined when the inventory could not be read.
 */
export function DiscoveryInventory({ data, now }: { data: DiscoveryInventoryData | null | undefined; now: string }) {
  if (data === undefined) return <p className="action-error">KEEL could not read the discovery inventory. Reload in a minute.</p>;
  return <DiscoveryInventoryView data={data} now={now} />;
}
