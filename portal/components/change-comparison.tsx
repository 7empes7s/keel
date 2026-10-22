"use client";

import { useMemo, useState, type ReactNode } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import { absentWords, compareSettings, comparisonSentence, DIFF_WORDS, wholeItem, type Diff, type EntryDiff, type SettingRow } from "@/lib/change-comparison";

// The comparison for one change: a summary with filters, then each setting that differs
// next to its approved (or previous) value, coloured by what happened to it (added green,
// removed red, changed amber). Settings that match fold away. Long lists fold too.
const CSS = `
.cc { display: grid; gap: var(--space-sm); }
.cc-summary { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs); margin: 0; }
.cc-sentence { margin: 0; font-weight: 600; }
.cc-filters { display: flex; flex-wrap: wrap; gap: var(--space-2xs, 0.25rem); }
.cc-filter { display: inline-flex; align-items: center; gap: 0.3rem; min-height: 2rem; padding: 0 var(--space-sm); border: 1px solid var(--line-strong); border-radius: var(--radius-pill); background: var(--surface); color: var(--text); font: inherit; font-size: 0.8125rem; font-weight: 600; cursor: pointer; }
.cc-filter[aria-pressed="true"] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.cc-filter:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.cc-dot { width: 0.55rem; height: 0.55rem; border-radius: 50%; background: var(--neutral); }
[data-diff="changed"] > .cc-dot, .cc-dot[data-diff="changed"] { background: var(--check-soon); }
.cc-dot[data-diff="added"] { background: var(--fine); }
.cc-dot[data-diff="removed"] { background: var(--urgent); }
.cc-dot[data-diff="unknown"] { background: var(--low-risk); }
.cc-section { display: grid; gap: var(--space-xs); }
.cc-section > h4 { margin: var(--space-xs) 0 0; color: var(--text-soft); font-size: 0.75rem; font-weight: 700; }
.cc-rows { display: grid; gap: var(--space-xs); margin: 0; padding: 0; list-style: none; }
.cc-row { display: grid; gap: var(--space-xs) var(--space-sm); grid-template-columns: minmax(8rem, 0.9fr) minmax(0, 1.2fr) minmax(0, 1.2fr); align-items: start; padding: var(--space-sm); border: 1px solid var(--line); border-left-width: 4px; border-radius: var(--radius-md); background: var(--surface); }
.cc-row[data-diff="changed"] { border-left-color: var(--check-soon); }
.cc-row[data-diff="added"] { border-left-color: var(--fine); }
.cc-row[data-diff="removed"] { border-left-color: var(--urgent); }
.cc-row[data-diff="unknown"] { border-left-color: var(--low-risk); }
.cc-row[data-list] { grid-template-columns: minmax(8rem, 0.9fr) minmax(0, 2.4fr); }
.cc-name { display: grid; gap: 0.3rem; align-content: start; min-width: 0; font-weight: 600; font-size: 0.875rem; overflow-wrap: anywhere; }
.cc-name small { color: var(--text-soft); font-weight: 500; font-size: 0.75rem; }
.cc-chip { white-space: nowrap; justify-self: start; display: inline-flex; align-items: center; gap: 0.25rem; padding: 1px var(--space-xs); border-radius: var(--radius-pill); font-size: 0.6875rem; font-weight: 700; letter-spacing: 0.02em; background: var(--neutral-bg); color: var(--text); }
.cc-chip svg { width: 0.8rem; height: 0.8rem; }
.cc-chip[data-diff="changed"] { background: var(--check-soon-bg); color: var(--check-soon); }
.cc-chip[data-diff="added"] { background: var(--fine-bg); color: var(--fine); }
.cc-chip[data-diff="removed"] { background: var(--urgent-bg); color: var(--urgent); }
.cc-chip[data-diff="unknown"] { background: var(--low-risk-bg); color: var(--low-risk); }
.cc-side { display: grid; gap: 0.2rem; min-width: 0; padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-md); background: var(--surface-muted); overflow-wrap: anywhere; font-size: 0.875rem; }
.cc-side > small { color: var(--text-soft); font-size: 0.75rem; font-weight: 700; }
.cc-side[data-empty] > span { color: var(--text-soft); font-style: italic; }
.cc-row[data-diff="changed"] .cc-side[data-side="after"], .cc-row[data-diff="added"] .cc-side[data-side="after"] { background: var(--check-soon-bg); }
.cc-row[data-diff="added"] .cc-side[data-side="after"] { background: var(--fine-bg); }
.cc-row[data-diff="removed"] .cc-side[data-side="before"] { background: var(--urgent-bg); }
.cc-row[data-diff="removed"] .cc-side[data-side="before"] > span, .cc-row[data-diff="changed"] .cc-side[data-side="before"] > span { text-decoration: line-through; text-decoration-thickness: 1px; text-decoration-color: color-mix(in srgb, currentColor 55%, transparent); }
.cc-entries { display: grid; gap: 0.3rem; margin: 0; padding: 0; list-style: none; }
.cc-entry { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem var(--space-xs); padding: 0.3rem var(--space-xs); border-radius: var(--radius-md); background: var(--surface-muted); font-size: 0.875rem; overflow-wrap: anywhere; }
.cc-entry[data-diff="added"] { background: var(--fine-bg); }
.cc-entry[data-diff="removed"] { background: var(--urgent-bg); }
.cc-entry[data-diff="removed"] > span { text-decoration: line-through; text-decoration-thickness: 1px; }
.cc-entry[data-diff="changed"] { background: var(--check-soon-bg); }
.cc-entry small { color: var(--text-soft); }
.cc-more { justify-self: start; border: 0; background: none; padding: 0; color: var(--text); font: inherit; font-size: 0.8125rem; font-weight: 600; text-decoration: underline; cursor: pointer; }
.cc-whole { display: grid; gap: var(--space-xs); min-width: 0; }
.cc-whole-toggle { justify-self: start; display: inline-flex; align-items: center; gap: var(--space-2xs, 0.25rem); min-height: 2rem; padding: 0 var(--space-sm); border: 1px solid var(--line-strong); border-radius: var(--radius-pill); background: var(--surface); color: var(--text); font: inherit; font-size: 0.8125rem; font-weight: 600; cursor: pointer; }
.cc-whole-toggle svg { width: 0.9rem; height: 0.9rem; }
.cc-whole-toggle:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.cc-whole-list { display: grid; grid-template-columns: minmax(8rem, 0.9fr) minmax(0, 2fr); gap: 0.3rem var(--space-sm); margin: 0; padding: var(--space-xs) var(--space-sm); border-left: 4px solid var(--line-strong); border-radius: var(--radius-md); background: var(--surface-muted); font-size: 0.8125rem; }
.cc-whole[data-diff="added"] .cc-whole-list { border-left-color: var(--fine); background: var(--fine-bg); }
.cc-whole[data-diff="removed"] .cc-whole-list { border-left-color: var(--urgent); background: var(--urgent-bg); }
.cc-whole-list > p { grid-column: 1 / -1; margin: 0; color: var(--text-soft); font-size: 0.75rem; font-weight: 600; }
.cc-whole-list dt { color: var(--text-soft); overflow-wrap: anywhere; }
.cc-whole-list dd { margin: 0; overflow-wrap: anywhere; }
.cc-empty { margin: 0; color: var(--text-soft); }
.cc-row[data-diff="same"] { border-left-color: var(--line-strong); }
.cc-row[data-diff="same"] .cc-side { background: transparent; }
.cc-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs) var(--space-sm); }
.cc-every { display: inline-flex; align-items: center; gap: var(--space-xs); min-height: 2.25rem; padding: 0 var(--space-sm) 0 var(--space-xs); border: 1px solid var(--line-strong); border-radius: var(--radius-pill); background: var(--surface); color: var(--text); font: inherit; font-size: 0.8125rem; font-weight: 600; cursor: pointer; }
.cc-every small { color: var(--text-soft); font-weight: 500; }
.cc-every:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.cc-switch { position: relative; flex: none; width: 2rem; height: 1.125rem; border-radius: var(--radius-pill); background: var(--line-strong); transition: background var(--duration-base) var(--ease-out); }
.cc-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: calc(1.125rem - 4px); height: calc(1.125rem - 4px); border-radius: 50%; background: var(--surface); box-shadow: 0 1px 2px rgb(0 0 0 / 0.25); transition: transform var(--duration-base) var(--ease-out); }
.cc-every[aria-checked="true"] { border-color: var(--accent); }
.cc-every[aria-checked="true"] .cc-switch { background: var(--accent); }
.cc-every[aria-checked="true"] .cc-switch::after { transform: translateX(0.875rem); }
.cc-hidden { color: var(--text-soft); font-size: 0.8125rem; }
@media (prefers-reduced-motion: reduce) { .cc-switch, .cc-switch::after { transition: none; } }
@media (max-width: 640px) {
  .cc-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); padding: var(--space-xs) var(--space-sm); }
  .cc-row > .cc-name { grid-column: 1 / -1; grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
  .cc-row > .cc-name > small { grid-column: 1 / -1; grid-row: 2; }
  .cc-row[data-list] { grid-template-columns: minmax(0, 1fr); }
  .cc-whole-list { grid-template-columns: minmax(0, 1fr); }
  .cc-whole-list dd { margin-bottom: var(--space-xs); }
}
`;

export function ChangeComparisonStyles() {
  return <style href="keel-change-comparison" precedence="default">{CSS}</style>;
}

const DIFF_ICONS: Record<Diff, IconName> = { changed: "swap", added: "plus", removed: "close", same: "check", unknown: "info" };

export function DiffChip({ diff }: { diff: Diff }) {
  return <span className="cc-chip" data-diff={diff}><Icon name={DIFF_ICONS[diff]} />{DIFF_WORDS[diff]}</span>;
}

const ENTRY_LIMIT = 6;
const ROW_LIMIT = 8;

function Entries({ entries, open = false }: { entries: EntryDiff[]; open?: boolean }) {
  const [all, setAll] = useState(open);
  const differing = entries.filter((entry) => entry.diff !== "same");
  const kept = entries.length - differing.length;
  const shown = all ? entries : differing.slice(0, ENTRY_LIMIT);
  const hidden = entries.length - shown.length;
  return (
    <>
      <ul className="cc-entries">
        {shown.map((entry, index) => (
          <li className="cc-entry" data-diff={entry.diff} key={`${entry.diff}-${index}`}>
            {entry.diff === "same" ? null : <DiffChip diff={entry.diff} />}
            <span>{entry.text}</span>
            {entry.was ? <small>was {entry.was}</small> : null}
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <button aria-expanded={all} className="cc-more" onClick={() => setAll(true)} type="button">
          {differing.length > ENTRY_LIMIT ? `Show all ${entries.length} entries` : `Show the ${kept} ${kept === 1 ? "entry" : "entries"} that stayed`}
        </button>
      ) : null}
    </>
  );
}

export function SettingRowView({ row, sides, note }: { row: SettingRow; sides: { before: string; after: string }; note?: string }) {
  const name = (
    <span className="cc-name">
      {row.label}
      {note ? <small>{note}</small> : null}
      <DiffChip diff={row.diff} />
    </span>
  );
  if (row.entries) {
    return (
      <li aria-label={`${row.label}: ${row.entries.filter((entry) => entry.diff !== "same").map((entry) => `${DIFF_WORDS[entry.diff]} ${entry.text}`).join("; ")}`} className="cc-row" data-diff={row.diff} data-list="">
        {name}
        <div><Entries entries={row.entries} open={row.diff === "same"} /></div>
      </li>
    );
  }
  const side = (which: "before" | "after", value: string | null) => (
    <span className="cc-side" data-empty={value === null || undefined} data-side={which}>
      <small>{sides[which]}</small>
      <span>{value ?? absentWords(row, which)}</span>
    </span>
  );
  return (
    <li aria-label={`${row.label}: ${row.before ?? absentWords(row, "before").toLowerCase()} to ${row.after ?? absentWords(row, "after").toLowerCase()}`} className="cc-row" data-diff={row.diff} data-section={row.section}>
      {name}
      {side("before", row.before)}
      {side("after", row.after)}
    </li>
  );
}

/** Rows already known to differ, coloured the same way (Compare, Activity, Restore). */
export function SettingRows({ rows, sides, label }: { rows: SettingRow[]; sides: { before: string; after: string }; label?: string }) {
  return (
    <>
      <ChangeComparisonStyles />
      <ul aria-label={label} className="cc-rows">
        {rows.map((row) => <SettingRowView key={row.path} row={row} sides={sides} />)}
      </ul>
    </>
  );
}

/** A whole item that was added or removed. Its badge already says what happened, so its
 *  settings stay folded until asked for, then read as one value each (the side that holds
 *  them), tinted green when added and red when removed. Never a before/after row each. */
export function ItemSettings({ rows, diff, held, label, more = 0 }: {
  rows: SettingRow[];
  diff: "added" | "removed";
  // The side that holds the settings ("Approved setup", "22 Oct 2026").
  held: string;
  label?: string;
  // Settings the item holds beyond `rows`.
  more?: number;
}) {
  const [open, setOpen] = useState(false);
  const count = rows.length + more;
  const what = count === 1 ? "its 1 setting" : `its ${count.toLocaleString("en-GB")} settings`;
  return (
    <div className="cc-whole" data-diff={diff}>
      <ChangeComparisonStyles />
      <button aria-expanded={open} className="cc-whole-toggle" onClick={() => setOpen(!open)} type="button">
        <Icon name={open ? "up" : "down"} />{open ? `Hide ${what}` : `Show ${what}`}
      </button>
      {open ? (
        <dl aria-label={label} className="cc-whole-list">
          <p>{diff === "added" ? "Added with these settings" : "Held these settings"} ({held})</p>
          {rows.map((row) => (
            <div key={row.path} style={{ display: "contents" }}>
              <dt>{row.section === "General" ? row.label : `${row.section} › ${row.label.toLowerCase()}`}</dt>
              <dd>{(diff === "added" ? row.after : row.before) ?? absentWords(row, diff === "added" ? "after" : "before")}</dd>
            </div>
          ))}
          {more > 0 ? <p>And {more.toLocaleString("en-GB")} more {more === 1 ? "setting" : "settings"}.</p> : null}
        </dl>
      ) : null}
    </div>
  );
}

function bySection(rows: SettingRow[]): [string, SettingRow[]][] {
  const map = new Map<string, SettingRow[]>();
  for (const row of rows) map.set(row.section, [...(map.get(row.section) ?? []), row]);
  return [...map.entries()];
}

/**
 * `before` / `after`: the two copies. `sides` names them ("Approved setup", "Now").
 * `against` reads in the summary ("the approved setup"). `notes` adds a line under a
 * setting by path. `behaviour`, when given, lists the settings that change behaviour:
 * any other setting that differs is one Microsoft manages itself and folds away.
 * `extra` sits under the summary.
 */
export function ChangeComparison({ before, after, names = {}, sides, against, beforeKnown = true, notes = {}, behaviour = null, extra, label }: {
  before: unknown;
  after: unknown;
  names?: Readonly<Record<string, string>>;
  sides: { before: string; after: string };
  against: string;
  beforeKnown?: boolean;
  notes?: Readonly<Record<string, string>>;
  behaviour?: string[] | null;
  extra?: ReactNode;
  label: string;
}) {
  const comparison = useMemo(() => compareSettings(before, after, names, beforeKnown), [before, after, names, beforeKnown]);
  const isQuiet = (path: string) => behaviour !== null && !behaviour.some((entry) => path === entry || path.startsWith(`${entry}.`) || entry.startsWith(`${path}.`));
  const [filter, setFilter] = useState<Diff | "all">("all");
  const [allRows, setAllRows] = useState(false);
  // Changed settings only, unless asked for every setting (then nothing folds away).
  const [every, setEvery] = useState(false);
  const loud = comparison.rows.filter((row) => row.diff !== "same" && !isQuiet(row.path));
  const quietCount = comparison.rows.filter((row) => row.diff !== "same" && isQuiet(row.path)).length;
  const sameCount = comparison.rows.filter((row) => row.diff === "same").length;
  const kinds = (["changed", "added", "removed", "unknown"] as const).filter((kind) => loud.some((row) => row.diff === kind));
  const filtered = filter === "all" ? loud : loud.filter((row) => row.diff === filter);
  const shown = every ? comparison.rows : allRows ? filtered : filtered.slice(0, ROW_LIMIT);
  const sections = bySection(shown);
  const hiddenWords = [
    sameCount ? `${sameCount} ${sameCount === 1 ? "setting is" : "settings are"} the same` : "",
    quietCount ? `${quietCount} ${quietCount === 1 ? "setting Microsoft manages itself also differs" : "settings Microsoft manages itself also differ"}` : "",
  ].filter(Boolean);
  const sentence = quietCount && !loud.length
    ? `Only ${quietCount === 1 ? "1 setting Microsoft manages itself differs" : `${quietCount} settings Microsoft manages itself differ`}. Nothing that changes behaviour was changed.`
    : comparisonSentence({ ...comparison, rows: comparison.rows.filter((row) => !isQuiet(row.path)), differing: loud.length, counts: { ...comparison.counts, ...Object.fromEntries((["changed", "added", "removed", "unknown"] as const).map((kind) => [kind, loud.filter((row) => row.diff === kind).length])) } }, against);

  const whole = wholeItem(comparison);
  if (whole) {
    return (
      <div className="cc" aria-label={label} data-whole={whole} role="group">
        <ChangeComparisonStyles />
        <div className="cc-summary">
          <DiffChip diff={whole} />
          <p className="cc-sentence">{comparisonSentence(comparison, against)}</p>
        </div>
        {extra}
        <ItemSettings diff={whole} held={whole === "added" ? sides.after : sides.before} label={`${label}: its settings`} rows={comparison.rows} />
      </div>
    );
  }
  return (
    <div className="cc" aria-label={label} data-every={every || undefined} role="group">
      <ChangeComparisonStyles />
      <div className="cc-summary">
        <p className="cc-sentence">{sentence}</p>
      </div>
      {extra}
      {hiddenWords.length ? (
        <div className="cc-bar">
          <EveryToggle on={every} onChange={setEvery} total={comparison.rows.length} />
          {every ? null : <small className="cc-hidden">Hidden: {hiddenWords.join("; ")}.</small>}
        </div>
      ) : null}
      {!every && (kinds.length > 1 || loud.length > ROW_LIMIT) ? (
        <div aria-label="Show" className="cc-filters" role="group">
          <button aria-pressed={filter === "all"} className="cc-filter" onClick={() => setFilter("all")} type="button">All {loud.length}</button>
          {kinds.map((kind) => (
            <button aria-pressed={filter === kind} className="cc-filter" key={kind} onClick={() => setFilter(kind)} type="button">
              <span aria-hidden="true" className="cc-dot" data-diff={kind} />{DIFF_WORDS[kind]} {loud.filter((row) => row.diff === kind).length}
            </button>
          ))}
        </div>
      ) : null}
      {sections.map(([section, rows]) => (
        <div className="cc-section" key={section}>
          {sections.length > 1 || section !== "General" ? <h4>{section}</h4> : null}
          <ul className="cc-rows">
            {rows.map((row) => <SettingRowView key={row.path} note={notes[row.path] ?? (row.diff !== "same" && isQuiet(row.path) ? MANAGED_NOTE : undefined)} row={row} sides={sides} />)}
          </ul>
        </div>
      ))}
      {!every && filtered.length > shown.length ? (
        <button aria-expanded={false} className="cc-more" onClick={() => setAllRows(true)} type="button">Show {filtered.length - shown.length} more {filtered.length - shown.length === 1 ? "setting" : "settings"}</button>
      ) : null}
    </div>
  );
}

const MANAGED_NOTE = "Microsoft manages this itself";

/** The switch between changed settings only (the default) and every setting the item holds. */
export function EveryToggle({ on, onChange, total }: { on: boolean; onChange: (on: boolean) => void; total: number }) {
  return (
    <button aria-checked={on} className="cc-every" onClick={() => onChange(!on)} role="switch" type="button">
      <span aria-hidden="true" className="cc-switch" />
      Show every setting
      <small>{total.toLocaleString("en-GB")} in all</small>
    </button>
  );
}
