"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { Icon } from "@/components/shell/icons";
import { Popover } from "@/components/shell/popover";
import {
  addDays,
  addMonths,
  compareDays,
  inRange,
  isDay,
  longDay,
  monthGrid,
  monthTitle,
  normalise,
  presetFor,
  presets as presetList,
  rangeLabel,
  type Day,
  type DayRange,
  type Preset,
} from "@/lib/date-range";

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** One date or range picker for every page: presets (Today, Last 7 days, Since last
 * backup), a calendar that can mark days (for example the days with a backup), and
 * typed dates for the keyboard. The chosen value always shows on the closed control.
 * On a phone it opens as a sheet. */
export function DatePicker({
  label,
  value,
  onChange,
  today,
  mode = "range",
  lastBackup,
  marked,
  markedLabel = "Has a backup",
  allowClear = false,
  presets,
}: {
  label: string;
  value: DayRange | null;
  onChange: (value: DayRange | null) => void;
  today: Day;
  mode?: "single" | "range";
  lastBackup?: Day | null;
  marked?: ReadonlySet<Day>;
  markedLabel?: string;
  allowClear?: boolean;
  // A page's own quick choices in place of the shared ones (Today, Last 7 days, …).
  presets?: Preset[];
}) {
  const list = presets ?? (mode === "range" ? presetList(today, lastBackup) : presetList(today).slice(0, 1));
  const shown = rangeLabel(value, today, list);
  return (
    <div className="picker-field">
      <span aria-hidden="true" className="picker-label">{label}</span>
      <Popover
        button={<><Icon name="calendar" /><span className="picker-value" data-empty={!value || undefined}>{shown}</span><Icon className="picker-chevron" name="chevron-down" /></>}
        buttonClassName="picker-button"
        label={`${label}: ${shown}`}
        panelClassName="date-panel"
        title={label}
      >
        {(close) => (
          <DatePanel
            allowClear={allowClear}
            close={close}
            list={list}
            marked={marked}
            markedLabel={markedLabel}
            mode={mode}
            onChange={onChange}
            today={today}
            value={value}
          />
        )}
      </Popover>
    </div>
  );
}

function DatePanel({ value, onChange, today, mode, list, marked, markedLabel, allowClear, close }: {
  value: DayRange | null;
  onChange: (value: DayRange | null) => void;
  today: Day;
  mode: "single" | "range";
  list: Preset[];
  marked?: ReadonlySet<Day>;
  markedLabel: string;
  allowClear: boolean;
  close: () => void;
}) {
  const start = value ? normalise(value) : null;
  const [focus, setFocus] = useState<Day>(start?.to ?? start?.from ?? today);
  const [pending, setPending] = useState<Day | null>(null);
  const [hover, setHover] = useState<Day | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);
  const preset = presetFor(value, list);

  useEffect(() => {
    if (!moved.current) return;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus();
  }, [focus]);

  function pick(day: Day) {
    if (mode === "single") {
      onChange({ from: day });
      close();
      return;
    }
    if (!pending) {
      setPending(day);
      return;
    }
    onChange(normalise({ from: pending, to: day }));
    setPending(null);
    close();
  }

  function onKey(event: KeyboardEvent<HTMLButtonElement>) {
    const moves: Record<string, () => Day> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
      Home: () => addDays(focus, -((new Date(`${focus}T00:00:00Z`).getUTCDay() + 6) % 7)),
      End: () => addDays(focus, 6 - ((new Date(`${focus}T00:00:00Z`).getUTCDay() + 6) % 7)),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    moved.current = true;
    setFocus(move());
  }

  const preview: DayRange | null = pending ? normalise({ from: pending, to: hover ?? pending }) : start;
  const grid = monthGrid(focus);

  return (
    <div className="date-picker" data-mode={mode}>
      {list.length > 1 ? (
        <div aria-label="Quick choices" className="date-presets" role="group">
          {list.map((entry) => (
            <button aria-pressed={preset?.id === entry.id} className="date-preset" key={entry.id} onClick={() => { onChange(entry.range); close(); }} type="button">
              {entry.label}
            </button>
          ))}
          <button aria-pressed={Boolean(value) && !preset} className="date-preset" onClick={() => { moved.current = true; setFocus(focus); gridRef.current?.querySelector<HTMLButtonElement>("[tabindex='0']")?.focus(); }} type="button">
            Custom
          </button>
        </div>
      ) : null}
      <div className="date-calendar">
        <div className="date-month">
          <button aria-label="Previous month" className="icon-button" onClick={() => setFocus(addMonths(focus, -1))} type="button"><Icon className="flip" name="chevron" /></button>
          <span aria-live="polite" className="date-month-title">{monthTitle(focus)}</span>
          <button aria-label="Next month" className="icon-button" onClick={() => setFocus(addMonths(focus, 1))} type="button"><Icon name="chevron" /></button>
        </div>
        <div aria-label={monthTitle(focus)} className="date-grid" ref={gridRef} role="group">
          {WEEKDAYS.map((day) => <span aria-hidden="true" className="date-weekday" key={day}>{day}</span>)}
          {grid.map(({ day, inMonth }) => {
            const selected = inRange(day, preview);
            const edge = preview ? day === normalise(preview).from || day === (normalise(preview).to ?? normalise(preview).from) : false;
            const hasMark = marked?.has(day) ?? false;
            return (
              <button
                aria-label={`${longDay(day)}${hasMark ? `, ${markedLabel.toLowerCase()}` : ""}${day === today ? ", today" : ""}`}
                aria-pressed={selected}
                className="date-day"
                data-day={day}
                data-edge={edge || undefined}
                data-in-month={inMonth || undefined}
                data-marked={hasMark || undefined}
                data-today={day === today || undefined}
                key={day}
                onClick={() => pick(day)}
                onFocus={() => setHover(day)}
                onKeyDown={onKey}
                onMouseEnter={() => setHover(day)}
                tabIndex={day === focus ? 0 : -1}
                type="button"
              >
                {Number(day.slice(8, 10))}
              </button>
            );
          })}
        </div>
        <p className="date-hint" aria-live="polite">
          {mode === "range" ? (pending ? "Now choose the last day." : "Choose the first day, then the last.") : "Choose a day."}
        </p>
        <TypedDates mode={mode} onChange={onChange} value={start} />
        <div className="date-foot">
          {marked?.size ? <span className="date-legend"><span aria-hidden="true" className="date-mark" />{markedLabel}</span> : <span />}
          {allowClear && value ? <button className="btn btn-sm" onClick={() => { onChange(null); close(); }} type="button">Clear</button> : null}
        </div>
      </div>
    </div>
  );
}

/** Keyboard entry: type the dates instead of picking them. */
function TypedDates({ mode, value, onChange }: { mode: "single" | "range"; value: DayRange | null; onChange: (value: DayRange) => void }) {
  const [from, setFrom] = useState(value?.from ?? "");
  const [to, setTo] = useState(value?.to ?? value?.from ?? "");
  function commit(nextFrom: string, nextTo: string) {
    if (!isDay(nextFrom)) return;
    if (mode === "single") onChange({ from: nextFrom });
    else if (isDay(nextTo) && compareDays(nextFrom, nextTo) <= 0) onChange(normalise({ from: nextFrom, to: nextTo }));
  }
  return (
    <div className="date-typed">
      <label>
        <span>{mode === "single" ? "Day" : "From"}</span>
        <input onChange={(event) => { setFrom(event.target.value); commit(event.target.value, to); }} type="date" value={from} />
      </label>
      {mode === "range" ? (
        <label>
          <span>To</span>
          <input min={from || undefined} onChange={(event) => { setTo(event.target.value); commit(from, event.target.value); }} type="date" value={to} />
        </label>
      ) : null}
    </div>
  );
}
