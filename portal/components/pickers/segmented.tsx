"use client";

import { useRef, type KeyboardEvent } from "react";

import { Icon, type IconName } from "@/components/shell/icons";

export interface ChoiceOption<V extends string = string> {
  value: V;
  label: string;
  icon?: IconName;
  // A short line under the label in the searchable list, or the segment's tooltip.
  hint?: string;
}

/** Two to four choices, all visible: a radio group drawn as one control, the same
 * height and radius as a button. Arrow keys move between choices. */
export function Segmented<V extends string>({ label, options, value, onChange, hideLabel = false }: {
  label: string;
  options: readonly ChoiceOption<V>[];
  value: V;
  onChange: (value: V) => void;
  hideLabel?: boolean;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    const jump = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : null;
    if (!step && jump === null) return;
    event.preventDefault();
    const next = jump ?? (index + step + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  }

  return (
    <div className="picker-field">
      <span className={hideLabel ? "visually-hidden" : "picker-label"} id={`seg-${label.replace(/\W+/g, "-")}`}>{label}</span>
      <div aria-labelledby={`seg-${label.replace(/\W+/g, "-")}`} className="segmented" role="radiogroup">
        {options.map((option, index) => {
          const checked = option.value === value;
          return (
            <button
              aria-checked={checked}
              className="segment"
              key={option.value}
              onClick={() => onChange(option.value)}
              onKeyDown={(event) => onKey(event, index)}
              ref={(element) => { refs.current[index] = element; }}
              role="radio"
              tabIndex={checked ? 0 : -1}
              title={option.hint}
              type="button"
            >
              {option.icon ? <Icon name={option.icon} /> : null}
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
