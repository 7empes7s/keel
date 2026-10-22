"use client";

import { useId, useMemo, useState } from "react";

import type { ChoiceOption } from "@/components/pickers/segmented";
import { Icon } from "@/components/shell/icons";
import { Popover } from "@/components/shell/popover";

/** Many choices: a button that always shows the chosen one, opening a searchable list
 * with icons. Type to narrow it, arrows to move, Enter to choose. */
export function OptionPicker<V extends string>({ label, options, value, onChange, placeholder = "Choose…" }: {
  label: string;
  options: readonly ChoiceOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  placeholder?: string;
}) {
  const chosen = options.find((option) => option.value === value) ?? null;
  return (
    <div className="picker-field">
      <span className="picker-label" aria-hidden="true">{label}</span>
      <Popover
        button={<>
          {chosen?.icon ? <Icon name={chosen.icon} /> : null}
          <span className="picker-value" data-empty={!chosen || undefined}>{chosen?.label ?? placeholder}</span>
          <Icon className="picker-chevron" name="chevron-down" />
        </>}
        buttonClassName="picker-button"
        label={`${label}: ${chosen?.label ?? "none chosen"}`}
        panelClassName="option-panel"
        title={label}
      >
        {(close) => <OptionList label={label} onPick={(option) => { onChange(option.value); close(); }} options={options} picked={(option) => option === value} />}
      </Popover>
    </div>
  );
}

/** The same picker for a filter that takes several values: each choice is a tick box,
 * the panel stays open while you pick, and the picked values add up (any of them shows).
 * Nothing picked means everything, named by `anyLabel`. The button names the first
 * pick and counts the rest. `values` come back in the options' order. */
export function MultiOptionPicker<V extends string>({ label, options, values, onChange, anyLabel }: {
  label: string;
  options: readonly ChoiceOption<V>[];
  values: readonly V[];
  onChange: (values: V[]) => void;
  anyLabel: string;
}) {
  const chosen = options.filter((option) => values.includes(option.value));
  const first = chosen[0] ?? null;
  const toggle = (value: V) => {
    const next = values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
    onChange(options.map((option) => option.value).filter((entry) => next.includes(entry)));
  };
  return (
    <div className="picker-field">
      <span className="picker-label" aria-hidden="true">{label}</span>
      <Popover
        button={<>
          {first?.icon ? <Icon name={first.icon} /> : null}
          <span className="picker-value" data-empty={!first || undefined}>{first?.label ?? anyLabel}</span>
          {chosen.length > 1 ? <span className="picker-count" title={chosen.map((option) => option.label).join(", ")}>+{chosen.length - 1}</span> : null}
          <Icon className="picker-chevron" name="chevron-down" />
        </>}
        buttonClassName="picker-button"
        label={`${label}: ${chosen.length ? chosen.map((option) => option.label).join(" or ") : anyLabel}`}
        panelClassName="option-panel"
        title={label}
      >
        {(close) => (
          <>
            <OptionList label={label} multiple onPick={(option) => toggle(option.value)} options={options} picked={(option) => values.includes(option)} />
            <div className="option-foot">
              <span>{chosen.length ? `${chosen.length} picked, any can match` : "Pick one or more"}</span>
              {chosen.length ? <button className="btn btn-sm btn-ghost" onClick={() => onChange([])} type="button">Clear</button> : null}
              <button className="btn btn-sm" onClick={close} type="button">Done</button>
            </div>
          </>
        )}
      </Popover>
    </div>
  );
}

function OptionList<V extends string>({ label, options, picked, onPick, multiple = false }: {
  label: string;
  options: readonly ChoiceOption<V>[];
  picked: (value: V) => boolean;
  onPick: (option: ChoiceOption<V>) => void;
  multiple?: boolean;
}) {
  const [query, setQuery] = useState("");
  const listId = useId();
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((option) => `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(q)) : [...options];
  }, [options, query]);
  const [active, setActive] = useState(() => Math.max(0, shown.findIndex((option) => picked(option.value))));
  const current = Math.min(active, Math.max(shown.length - 1, 0));

  function choose(option: ChoiceOption<V> | undefined) {
    if (option) onPick(option);
  }

  return (
    <div className="option-list-wrap">
      <label className="option-search">
        <Icon name="search" />
        <input
          aria-activedescendant={shown[current] ? `${listId}-${current}` : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded="true"
          aria-label={`Find a ${label.toLowerCase()}`}
          className="bare-input"
          onChange={(event) => { setQuery(event.target.value); setActive(0); }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); setActive(Math.min(current + 1, shown.length - 1)); }
            else if (event.key === "ArrowUp") { event.preventDefault(); setActive(Math.max(current - 1, 0)); }
            else if (event.key === "Enter") { event.preventDefault(); choose(shown[current]); }
          }}
          placeholder="Type to find"
          role="combobox"
          value={query}
        />
      </label>
      <ul aria-label={label} aria-multiselectable={multiple || undefined} className="option-list" id={listId} role="listbox">
        {shown.length ? shown.map((option, index) => (
          <li
            aria-selected={picked(option.value)}
            className="option"
            data-picked={(multiple && picked(option.value)) || undefined}
            data-active={index === current || undefined}
            id={`${listId}-${index}`}
            key={option.value}
            onClick={() => choose(option)}
            onMouseMove={() => setActive(index)}
            role="option"
          >
            {multiple ? <span aria-hidden="true" className="option-box">{picked(option.value) ? <Icon name="check" /> : null}</span> : null}
            {option.icon ? <Icon name={option.icon} /> : null}
            <span><b>{option.label}</b>{option.hint ? <small>{option.hint}</small> : null}</span>
            {!multiple && picked(option.value) ? <Icon className="option-check" name="check" /> : null}
          </li>
        )) : <li className="option-empty" role="presentation">Nothing matches “{query}”.</li>}
      </ul>
    </div>
  );
}
