import { CompareForm, type QuickPick } from "@/components/baselines/compare-form";
import { BaselinesStyles } from "@/components/baselines/styles";
import { Icon } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { fieldWords } from "@/lib/changes-view";
import {
  CHANGE_WORDS, bytesWords, compareValueWords, containerWords, contentItemWords, countsWords, differenceTotals, notComparedSentence,
  rawValue, sideWords, workloadLabel, workloadNotComparedSentence,
  type CompareData, type CompareField, type CompareResult, type ContentHoldingsSection, type ContentItemsSection,
  type SettingsGroup, type SettingsItem, type SettingsSection, type WorkloadGroup, type WorkloadsSection,
} from "@/lib/compare-view";
import { formatTimestamp, resourceTypeLabel } from "@/lib/presentation";
import { holdsObjectId } from "@/lib/object-ids";
import { plainKind } from "@/lib/baselines-view";
import { SERVICES } from "@/lib/services";

// Wave 2 CMP: the Compare page. The form submits with GET, so comparing never changes
// anything. Results are grouped by service and kind, plain names first; every key, id
// and hash sits under Technical details.
const CSS = `
.compare-view { display: grid; gap: var(--space-md); }
.compare-form { display: grid; gap: var(--space-sm); grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); align-items: end; }
.compare-form select { min-width: 0; width: 100%; }
.compare-help { margin: 0; color: var(--text-soft); }
.compare-summary { display: grid; gap: var(--space-sm); grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); margin: 0; }
.compare-summary div { display: grid; gap: var(--space-2xs); padding: var(--space-sm) var(--space-md); border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface-raised); }
.compare-summary dd { font-size: 1.5rem; font-weight: 750; letter-spacing: -0.03em; }
.compare-summary small { display: block; color: var(--text-soft); font-size: 0.8125rem; font-weight: 500; letter-spacing: 0; }
.compare-section { display: grid; gap: var(--space-sm); }
.compare-section h3 { margin: var(--space-sm) 0 0; font-size: 0.9375rem; }
.compare-group { border: 1px solid var(--line); border-radius: 0.5rem; background: var(--surface); }
.compare-group > summary { cursor: pointer; padding: var(--space-sm) var(--space-md); display: flex; flex-wrap: wrap; gap: var(--space-xs) var(--space-md); justify-content: space-between; }
.compare-group > summary:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: 0.5rem; }
.compare-group-name { font-weight: 650; }
.compare-group-counts { color: var(--text-soft); }
.compare-items { list-style: none; margin: 0; padding: 0 var(--space-md) var(--space-md); display: grid; gap: var(--space-sm); }
.compare-item { display: grid; gap: var(--space-xs); padding: var(--space-xs) var(--space-sm); border-left: 3px solid var(--line-strong); overflow-wrap: anywhere; min-width: 0; }
.compare-item p { margin: 0; }
.compare-item-head { display: flex; flex-wrap: wrap; gap: var(--space-xs); align-items: baseline; }
.compare-item-name { font-weight: 600; }
.compare-change { font-size: 0.75rem; font-weight: 750; letter-spacing: 0.04em; text-transform: uppercase; }
.compare-change-changed { color: var(--partial); }
.compare-change-added { color: var(--protected); }
.compare-change-removed { color: var(--failed); }
.compare-item.compare-changed { border-left-color: var(--partial); }
.compare-item.compare-added { border-left-color: var(--protected); }
.compare-item.compare-removed { border-left-color: var(--failed); }
.compare-note { margin: 0; color: var(--text-soft); }
.compare-list { margin: 0; padding-left: var(--space-lg); display: grid; gap: var(--space-2xs); }
.compare-fields { width: 100%; }
`;

function CompareStyles() {
  return <style href="keel-compare" precedence="default">{CSS}</style>;
}

/** An object's name, or a plain stand-in when its key is an id or a composed key. */
function itemName(item: SettingsItem, resourceType: string): string {
  if (item.name) return item.name;
  const rest = item.naturalKey.slice(item.naturalKey.indexOf(":") + 1);
  return holdsObjectId(rest) || /[a-z][A-Za-z]+:/.test(rest) ? `An unnamed ${resourceTypeLabel(resourceType)}` : rest;
}

/** A workload resource by its name: "Finance team (site)", never the site id its key holds. */
function resourceKeyWords(key: string, name?: string | null): string {
  if (key === "organization") return "Organization";
  const match = /^([A-Za-z]+):(.+)$/.exec(key);
  const kind = match ? match[1].replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : null;
  const saved = name?.trim();
  if (saved && !holdsObjectId(saved)) return kind ? `${saved} (${kind})` : saved;
  if (!match) return holdsObjectId(key) ? "An unnamed setting" : key;
  return holdsObjectId(match[2]) ? `An unnamed ${kind}` : `${match[2]} (${kind})`;
}

// The two sides' short names, set once per page so every before/after column says which.
interface Sides { before: string; after: string }

function FieldTable({ fields, total, id, sides }: { fields: CompareField[]; total?: number; id: string; sides: Sides }) {
  if (fields.length === 0) return <p className="compare-note">Only settings Microsoft sets itself differ.</p>;
  return (
    <>
      <ul aria-labelledby={id} className="bl-sides-list compare-fields">
        {fields.map((field) => (
          <li className="bl-sides-row" key={field.path}>
            <span className="bl-sides-name">{fieldWords(field.path)}</span>
            <span className="bl-side" data-side="before"><small>{sides.before}</small><span className="diff-before">{compareValueWords(field.before)}</span></span>
            <Icon className="bl-sides-arrow" name="chevron" />
            <span className="bl-side" data-side="after"><small>{sides.after}</small><span className="diff-after">{compareValueWords(field.after)}</span></span>
          </li>
        ))}
      </ul>
      {total && total > fields.length ? <p className="compare-note">And {total - fields.length} more settings.</p> : null}
    </>
  );
}

const PRESENCE: Record<string, { before: string; after: string }> = {
  added: { before: "Not there", after: "There" },
  removed: { before: "There", after: "Not there" },
};

function ItemHead({ name, changeType, id, sides }: { name: string; changeType: SettingsItem["changeType"]; id: string; sides?: Sides }) {
  const presence = PRESENCE[changeType];
  return (
    <div className="compare-item-head">
      <span className="compare-item-name" id={id}>{name}</span>
      <span className={`compare-change compare-change-${changeType}`}>{CHANGE_WORDS[changeType]}</span>
      {presence && sides ? (
        <span className="bl-presence">
          <span className="bl-side" data-side="before"><small>{sides.before}</small>{presence.before}</span>
          <Icon className="bl-sides-arrow" name="chevron" />
          <span className="bl-side" data-side="after"><small>{sides.after}</small>{presence.after}</span>
        </span>
      ) : null}
    </div>
  );
}

/** A service heading with Microsoft's own icon for it. */
function ServiceHeading({ service }: { service: string }) {
  const known = SERVICES.find((entry) => entry.name === service || entry.name.split(" and ").includes(service) || entry.code === service);
  return <h3 className="bl-service-heading"><Icon name={known?.icon ?? "cloud"} />{service}</h3>;
}

function SettingsGroupView({ group, index, sides }: { group: SettingsGroup; index: number; sides: Sides }) {
  return (
    <details className="compare-group">
      <summary>
        <span className="compare-group-name">{plainKind(group.resourceType)}</span>
        <span className="compare-group-counts">{countsWords(group)}</span>
        <Icon className="compare-group-chevron" name="chevron-down" />
      </summary>
      <ul className="compare-items">
        {group.items.map((item, itemIndex) => {
          const id = `compare-setting-${index}-${itemIndex}`;
          return (
            <li className={`compare-item compare-${item.changeType}`} key={item.naturalKey}>
              <ItemHead changeType={item.changeType} id={id} name={itemName(item, group.resourceType)} sides={sides} />
              {item.changeType === "changed" ? <FieldTable fields={item.fields ?? []} id={id} sides={sides} total={item.fieldsTotal} /> : null}
            </li>
          );
        })}
        {group.total > group.items.length ? <li className="compare-note">And {group.total - group.items.length} more.</li> : null}
      </ul>
    </details>
  );
}

function byService<T extends { service: string }>(groups: T[]): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const group of groups) map.set(group.service, [...(map.get(group.service) ?? []), group]);
  return [...map.entries()];
}

function SettingsPanel({ settings, portable, sides }: { settings: SettingsSection; portable: boolean; sides: Sides }) {
  return (
    <section aria-labelledby="compare-settings-heading" className="item-card compare-section">
      <h2 id="compare-settings-heading">Settings</h2>
      <p className="compare-help">
        {countsWords(settings.totals)} across every kind Keel backs up; {settings.totals.unchanged.toLocaleString("en-GB")} the same.
        {" "}Open a kind to see each setting before and after.
        {portable ? " Objects are matched by name, and a difference in ids alone does not count." : ""}
      </p>
      {byService(settings.groups).map(([service, groups]) => (
        <div className="compare-section" key={service}>
          <ServiceHeading service={service} />
          {groups.map((group) => <SettingsGroupView group={group} index={settings.groups.indexOf(group)} key={group.resourceType} sides={sides} />)}
        </div>
      ))}
      {settings.notCompared.length ? (
        <>
          <h3>Not compared</h3>
          <p className="compare-note">A side that did not read a kind in full proves nothing about it, so nothing is reported as removed.</p>
          <ul className="compare-list">
            {settings.notCompared.map((entry) => (
              <li key={entry.resourceType}>{plainKind(entry.resourceType)} ({entry.service}): {notComparedSentence(entry)}</li>
            ))}
          </ul>
        </>
      ) : null}
      {settings.unmatched.length ? (
        <>
          <h3>Cannot be matched across tenants</h3>
          <p className="compare-note">These kinds are known only by an id each tenant gives them, so the same object cannot be found in the other tenant.</p>
          <ul className="compare-list">
            {settings.unmatched.map((entry) => (
              <li key={entry.resourceType}>{plainKind(entry.resourceType)} ({entry.service}): {entry.left} in the first, {entry.right} in the second.</li>
            ))}
          </ul>
        </>
      ) : null}
      {settings.groups.length ? (
        <TechnicalDetails summary="Technical details: settings">
          {settings.groups.flatMap((group) => group.items.map((item) => (
            <RecordField key={item.naturalKey} label={`${item.changeType} ${group.resourceType}`} value={item.naturalKey}
              usage={item.fields?.length ? item.fields.map((field) => `${field.path}: ${rawValue(field.before)} → ${rawValue(field.after)}`).join("; ") : undefined} />
          )))}
        </TechnicalDetails>
      ) : null}
    </section>
  );
}

function WorkloadGroupView({ group, index, sides }: { group: WorkloadGroup; index: number; sides: Sides }) {
  if (group.state !== "compared") {
    return <li><strong>{workloadLabel(group.workload)}</strong>: {workloadNotComparedSentence(group)}</li>;
  }
  return (
    <li>
      <details className="compare-group">
        <summary>
          <span className="compare-group-name">{workloadLabel(group.workload)}</span>
          <span className="compare-group-counts">{countsWords(group)}</span>
          <Icon className="compare-group-chevron" name="chevron-down" />
        </summary>
        <ul className="compare-items">
          {(group.items ?? []).map((item, itemIndex) => {
            const id = `compare-workload-${index}-${itemIndex}`;
            return (
              <li className={`compare-item compare-${item.changeType}`} key={item.resourceKey}>
                <ItemHead changeType={item.changeType} id={id} name={resourceKeyWords(item.resourceKey, item.name)} sides={sides} />
                {item.changeType === "changed" ? <FieldTable fields={item.fields ?? []} id={id} sides={sides} total={item.fieldsTotal} /> : null}
              </li>
            );
          })}
          {group.unverified ? <li className="compare-note">{group.unverified} could not be checked, because one side read only part of the workload.</li> : null}
          {group.unmatched ? <li className="compare-note">{group.unmatched} are known only by an id each tenant gives them, so they cannot be matched across tenants.</li> : null}
          {group.unverifiedFields ? <li className="compare-note">{group.unverifiedFields} settings were not read on both sides and are not compared.</li> : null}
        </ul>
      </details>
    </li>
  );
}

function WorkloadsPanel({ workloads, liveStored, sides }: { workloads: WorkloadsSection; liveStored: boolean; sides: Sides }) {
  return (
    <section aria-labelledby="compare-workloads-heading" className="item-card compare-section">
      <h2 id="compare-workloads-heading">App settings</h2>
      <p className="compare-help">
        Exchange, Teams, Purview, SharePoint and other app settings, as each side last read them: {countsWords(workloads.totals)}.
        {liveStored ? " The second side uses the newest stored collection." : ""}
      </p>
      {workloads.groups.length === 0 ? <p className="compare-note">No workload settings were collected for either side.</p> : null}
      {byService(workloads.groups).map(([service, groups]) => (
        <div className="compare-section" key={service}>
          <ServiceHeading service={service} />
          <ul className="compare-list" style={{ listStyle: "none", paddingLeft: 0 }}>
            {groups.map((group) => <WorkloadGroupView group={group} index={workloads.groups.indexOf(group)} key={group.workload} sides={sides} />)}
          </ul>
        </div>
      ))}
      {workloads.groups.length ? (
        <TechnicalDetails summary="Technical details: app settings">
          {workloads.groups.map((group) => (
            <RecordField key={group.workload} label={`Workload ${group.workload}`}
              value={`${group.left?.collectionId ?? "none"} (${group.left?.outcome ?? "none"}) → ${group.right?.collectionId ?? "none"} (${group.right?.outcome ?? "none"})`}
              usage={(group.items ?? []).map((item) => `${item.changeType} ${item.resourceKey}`).join("; ") || undefined} />
          ))}
        </TechnicalDetails>
      ) : null}
    </section>
  );
}

function ContentItemsPanel({ content }: { content: ContentItemsSection }) {
  const changed = content.groups.filter((group) => group.added + group.removed + group.changed > 0);
  return (
    <section aria-labelledby="compare-content-heading" className="item-card compare-section">
      <h2 id="compare-content-heading">Content</h2>
      <p className="compare-help">Mail, files, sites, Teams and plans Keel holds, item by item: {countsWords(content.totals)}.</p>
      {changed.length === 0 ? <p className="compare-note">No stored item differs.</p> : null}
      {byService(changed).map(([service, groups]) => (
        <div className="compare-section" key={service}>
          <ServiceHeading service={service} />
          {groups.map((group) => (
            <div className="compare-section" key={group.workload}>
              <p className="compare-note">{workloadLabel(group.workload)}: {group.leftItems.toLocaleString("en-GB")} items, then {group.rightItems.toLocaleString("en-GB")}.</p>
              {group.containers.map((container) => (
                <details className="compare-group" key={container.container}>
                  <summary>
                    <span className="compare-group-name">{containerWords(container.container)}</span>
                    <span className="compare-group-counts">{countsWords(container)}</span>
                    <Icon className="compare-group-chevron" name="chevron-down" />
                  </summary>
                  <ul className="compare-items">
                    {container.items.map((item, index) => (
                      <li className={`compare-item compare-${item.changeType}`} key={item.itemKey}>
                        <ItemHead changeType={item.changeType} id={`compare-content-${group.workload}-${index}`} name={contentItemWords(item)} />
                        {item.changeType === "changed" && item.beforeBytes !== null && item.afterBytes !== null ? (
                          <p className="compare-note">{bytesWords(item.beforeBytes)}, then {bytesWords(item.afterBytes)}.</p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
          ))}
        </div>
      ))}
      {content.total > content.shown ? <p className="compare-note">Showing {content.shown} of {content.total} items. The full list is in Technical details for an operator.</p> : null}
      {changed.length ? (
        <TechnicalDetails summary="Technical details: content">
          {changed.flatMap((group) => group.containers.map((container) => (
            <RecordField key={`${group.workload}/${container.container}`} label={`Container (${group.workload})`} value={container.container}
              usage={container.items.map((item) => `${item.changeType} ${item.itemKey} ${item.beforeSha256 ?? "absent"} → ${item.afterSha256 ?? "absent"}`).join("; ")} />
          )))}
        </TechnicalDetails>
      ) : null}
    </section>
  );
}

function ContentHoldingsPanel({ content }: { content: ContentHoldingsSection }) {
  return (
    <section aria-labelledby="compare-content-heading" className="item-card compare-section">
      <h2 id="compare-content-heading">Content</h2>
      <p className="compare-help">
        Items in two tenants have different ids, so content is compared by what each tenant holds: {content.totals.inBoth.toLocaleString("en-GB")} items in both,
        {" "}{content.totals.onlyLeft.toLocaleString("en-GB")} only in the first, {content.totals.onlyRight.toLocaleString("en-GB")} only in the second.
      </p>
      {content.groups.length ? (
        <div className="table-scroll">
          <table aria-labelledby="compare-content-heading" className="data-table">
            <thead><tr><th scope="col">Workload</th><th scope="col">First</th><th scope="col">Second</th><th scope="col">In both</th><th scope="col">Only first</th><th scope="col">Only second</th></tr></thead>
            <tbody>
              {content.groups.map((group) => (
                <tr key={group.workload}>
                  <th data-label="Workload" scope="row">{workloadLabel(group.workload)} ({group.service})</th>
                  <td data-label="First">{group.leftItems.toLocaleString("en-GB")} items, {bytesWords(group.leftBytes)}</td>
                  <td data-label="Second">{group.rightItems.toLocaleString("en-GB")} items, {bytesWords(group.rightBytes)}</td>
                  <td data-label="In both">{group.inBoth.toLocaleString("en-GB")}</td>
                  <td data-label="Only first">{group.onlyLeft.toLocaleString("en-GB")}</td>
                  <td data-label="Only second">{group.onlyRight.toLocaleString("en-GB")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="compare-note">Neither tenant has stored content.</p>}
    </section>
  );
}

function shortSide(side: CompareResult["left"], tenants: CompareData["tenants"], portable: boolean): string {
  const when = side.kind === "live" ? "Now" : formatTimestamp(side.at).replace(/, \d\d:\d\d UTC$/, "");
  if (!portable) return when;
  return `${when} · ${tenants.find((tenant) => tenant.tenantRef === side.tenantRef)?.label ?? "another tenant"}`;
}

function Summary({ data, result }: { data: CompareData; result: CompareResult }) {
  const totals = differenceTotals(result);
  const tiles = [
    { key: "settings", label: "Settings", count: totals.settings, note: totals.settings === 1 ? "difference" : "differences", href: "#compare-settings-heading", shown: Boolean(result.settings) },
    { key: "workloads", label: "App settings", count: totals.workloads, note: totals.workloads === 1 ? "difference" : "differences", href: "#compare-workloads-heading", shown: Boolean(result.workloads) },
    { key: "content", label: "Content", count: totals.content, note: result.content?.by === "holdings" ? (totals.content === 1 ? "item in one tenant only" : "items in one tenant only") : (totals.content === 1 ? "item differs" : "items differ"), href: "#compare-content-heading", shown: Boolean(result.content) },
  ];
  return (
    <section aria-labelledby="compare-summary-heading" className="bl-section compare-section">
      {/* Two backups of this tenant are already named by the pickers above; two tenants
          are named here, since the pickers show only times. */}
      {result.portable ? (
        <h2 className="bl-compare-title" id="compare-summary-heading">
          <span className="bl-side" data-side="before"><small>Before</small>{sideWords(result.left, data.tenants, result.portable)}</span>
          <Icon className="bl-sides-arrow" name="chevron" />
          <span className="bl-side" data-side="after"><small>After</small>{sideWords(result.right, data.tenants, result.portable)}</span>
        </h2>
      ) : <h2 className="visually-hidden" id="compare-summary-heading">What is different</h2>}
      <dl className="compare-summary bl-tiles">
        {tiles.map((tile) => (
          <div className="bl-card bl-tile" key={tile.key}>
            <dt className="bl-tile-label">{tile.label}</dt>
            <dd>
              <b className="bl-tile-count">{tile.count.toLocaleString("en-GB")}</b>
              <small>{tile.note}</small>
              {tile.shown ? <a className="bl-inline-link" href={tile.href}>See them</a> : null}
            </dd>
          </div>
        ))}
      </dl>
      <TechnicalDetails>
        <RecordField label="Compare mode" value={result.mode} />
        <RecordField label="From snapshot" value={result.left.snapshotId} usage={`Tenant ${result.left.tenantRef}, completed ${result.left.at ?? "unknown"}`} />
        <RecordField label="To snapshot" value={result.right.snapshotId} usage={`Tenant ${result.right.tenantRef}, completed ${result.right.at ?? "unknown"}`} />
        <RecordField label="Compared at" value={result.generatedAt} copy={false} />
      </TechnicalDetails>
    </section>
  );
}

export function CompareView({ data, quick = [] }: { data: CompareData; quick?: QuickPick[] }) {
  const result = data.result;
  const sides: Sides = result
    ? { before: shortSide(result.left, data.tenants, result.portable), after: shortSide(result.right, data.tenants, result.portable) }
    : { before: "Before", after: "After" };
  return (
    <div className="compare-view bl-page">
      <CompareStyles />
      <BaselinesStyles />
      <CompareForm input={data.input} quick={quick} tenants={data.tenants} />
      {result ? <Summary data={data} result={result} /> : null}
      {result?.settings ? <SettingsPanel portable={result.portable} settings={result.settings} sides={sides} /> : null}
      {result?.workloads ? <WorkloadsPanel liveStored={Boolean(result.right.latestStored?.includes("workloads"))} sides={sides} workloads={result.workloads} /> : null}
      {result?.content?.by === "item" ? <ContentItemsPanel content={result.content} /> : null}
      {result?.content?.by === "holdings" ? <ContentHoldingsPanel content={result.content} /> : null}
    </div>
  );
}
