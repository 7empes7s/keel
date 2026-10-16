"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import { Icon } from "@/components/shell/icons";
import { useCurrentHref } from "@/components/shell/menu";
import { useShellState } from "@/components/shell/shell-state";
import { removeItem } from "@/lib/menu-prefs";

/** Saved filters for this list: each is a real link to the view as it was saved, and
 * also sits under Custom in the menu. Saving keeps the whole URL: grouping, find,
 * dates, closed groups. */
export function SavedFilters() {
  const { prefs, update, add } = useShellState();
  const pathname = usePathname() ?? "/";
  const current = useCurrentHref();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const saved = prefs.custom.filter((item) => item.href.split("?")[0] === pathname && item.href.includes("?"));
  const canSave = current.includes("?") && !saved.some((item) => item.href === current);

  return (
    <div className="saved-filters">
      <span className="picker-label">Saved filters</span>
      <div className="saved-filter-row">
        {saved.map((item) => (
          <span className="saved-filter" data-current={item.href === current || undefined} key={item.href}>
            <Link aria-current={item.href === current ? "page" : undefined} href={item.href}>
              <Icon name="filter" />{item.label}
            </Link>
            <button aria-label={`Delete saved filter ${item.label}`} onClick={() => update(removeItem(prefs, "custom", item.href))} title="Delete this saved filter" type="button"><Icon name="close" /></button>
          </span>
        ))}
        {naming ? (
          <form
            className="saved-filter-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (add("custom", { href: current, label: name, icon: "filter" })) {
                setNaming(false);
                setName("");
              }
            }}
          >
            <input aria-label="Name for this filter" autoFocus maxLength={60} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); setNaming(false); } }} placeholder="Name this filter" required value={name} />
            <button className="btn btn-sm btn-primary" type="submit">Save</button>
            <button className="btn btn-sm" onClick={() => setNaming(false)} type="button">Cancel</button>
          </form>
        ) : (
          <button
            className="btn btn-sm"
            disabled={!canSave}
            onClick={() => setNaming(true)}
            title={canSave ? "Keep this view under a name; it also appears under Custom in the menu" : saved.some((item) => item.href === current) ? "This view is already saved" : "Change the grouping or find something first"}
            type="button"
          >
            <Icon name="save" />Save filter
          </button>
        )}
        {!saved.length && !naming ? <small className="saved-filter-empty">None yet.</small> : null}
      </div>
    </div>
  );
}
