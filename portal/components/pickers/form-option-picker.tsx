"use client";

import { useState } from "react";

import { OptionPicker } from "@/components/pickers/option-picker";
import type { ChoiceOption } from "@/components/pickers/segmented";

/** A searchable picker inside a plain form: the chosen value goes with the form under
 * `name`, like a select. For lists too long to scroll through. */
export function FormOptionPicker({ name, label, options, defaultValue = "", placeholder }: {
  name: string;
  label: string;
  options: readonly ChoiceOption<string>[];
  defaultValue?: string;
  placeholder?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <>
      <OptionPicker label={label} onChange={setValue} options={options} placeholder={placeholder} value={value} />
      <input name={name} type="hidden" value={value} />
    </>
  );
}
