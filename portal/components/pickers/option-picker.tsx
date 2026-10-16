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
        {(close) => <OptionList close={close} label={label} onChange={onChange} options={options} value={value} />}
      </Popover>
    </div>
  );
}

function OptionList<V extends string>({ label, options, value, onChange, close }: {
  label: string;
  options: readonly ChoiceOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  close: () => void;
}) {
  const [query, setQuery] = useState("");
  const listId = useId();
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? options.filter((option) => `${option.label} ${option.hint ?? ""}`.toLowerCase().includes(q)) : [...options];
  }, [options, query]);
  const [active, setActive] = useState(() => Math.max(0, shown.findIndex((option) => option.value === value)));
  const current = Math.min(active, Math.max(shown.length - 1, 0));

  function choose(option: ChoiceOption<V> | undefined) {
    if (!option) return;
    onChange(option.value);
    close();
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
      <ul aria-label={label} className="option-list" id={listId} role="listbox">
        {shown.length ? shown.map((option, index) => (
          <li
            aria-selected={option.value === value}
            className="option"
            data-active={index === current || undefined}
            id={`${listId}-${index}`}
            key={option.value}
            onClick={() => choose(option)}
            onMouseMove={() => setActive(index)}
            role="option"
          >
            {option.icon ? <Icon name={option.icon} /> : null}
            <span><b>{option.label}</b>{option.hint ? <small>{option.hint}</small> : null}</span>
            {option.value === value ? <Icon className="option-check" name="check" /> : null}
          </li>
        )) : <li className="option-empty" role="presentation">Nothing matches “{query}”.</li>}
      </ul>
    </div>
  );
}
