"use client";

import { Icon } from "@/components/shell/icons";
import { useViewState } from "@/lib/use-view-state";

export interface ActiveFilter {
  key: string;
  // Plain words for the chip: "Could lock out admins", "In Entra ID", "Find: “mail”".
  label: string;
  // The address changes that drop this filter, such as { risk: "cosmetic" } or { q: null }.
  clear: Record<string, string | null>;
}

function clearAll(filters: readonly ActiveFilter[]): Record<string, null> {
  return Object.fromEntries(filters.flatMap((filter) => Object.keys(filter.clear)).map((key) => [key, null]));
}

function plural(count: number, noun: { one: string; many: string }) {
  return `${count} ${count === 1 ? noun.one : noun.many}`;
}

function Chips({ filters, onClear }: { filters: readonly ActiveFilter[]; onClear: (changes: Record<string, string | null>) => void }) {
  return (
    <ul aria-label="Active filters" className="filter-chips">
      {filters.map((filter) => (
        <li key={filter.key}>
          <button aria-label={`Remove filter: ${filter.label}`} className="filter-chip" onClick={() => onClear(filter.clear)} title="Remove this filter" type="button">
            <span>{filter.label}</span>
            <Icon name="close" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The filters on a list as removable chips, how many rows they leave, and Clear all.
 *  Nothing shows while no filter is on. */
export function ActiveFilters({ filters, shown, total, noun, extra = {} }: {
  filters: readonly ActiveFilter[];
  shown: number;
  total: number;
  noun: { one: string; many: string };
  // Other address keys Clear all should drop too, such as an open details panel.
  extra?: Record<string, null>;
}) {
  const view = useViewState();
  if (!filters.length) return null;
  return (
    <div className="filter-bar" data-empty={shown === 0 || undefined}>
      <p className="filter-count" role="status">
        Showing <b>{shown}</b> of {plural(total, noun)}
      </p>
      <Chips filters={filters} onClear={(changes) => view.set(changes)} />
      <button className="btn btn-sm filter-clear" onClick={() => view.set({ ...clearAll(filters), ...extra })} type="button">Clear all</button>
    </div>
  );
}

/** What a filtered list shows when nothing matches: never a dead end. Each filter can
 *  be dropped on its own, or all at once. */
export function NoMatches({ filters, noun, extra = {} }: { filters: readonly ActiveFilter[]; noun: { one: string; many: string }; extra?: Record<string, null> }) {
  const view = useViewState();
  return (
    <div className="filter-empty" role="status">
      <span aria-hidden="true" className="filter-empty-icon"><Icon name="filter" /></span>
      <div>
        <h3>No {noun.many} match these filters</h3>
        <p>{filters.length > 1 ? "Remove a filter to see more, or clear them all." : "Remove the filter to see everything."}</p>
        <Chips filters={filters} onClear={(changes) => view.set(changes)} />
      </div>
      <button className="btn btn-primary" onClick={() => view.set({ ...clearAll(filters), ...extra })} type="button">{filters.length > 1 ? "Clear all filters" : "Clear the filter"}</button>
    </div>
  );
}
