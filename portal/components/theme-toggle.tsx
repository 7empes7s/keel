"use client";

import { useEffect, useState } from "react";

import {
  applyThemePreference,
  THEME_EVENT,
  type ThemePreference,
} from "@/lib/theme";

const OPTIONS: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export function ThemeToggle({ initial }: { initial: ThemePreference }) {
  const [preference, setPreference] = useState<ThemePreference>(initial);

  // The command palette can change the theme too; stay in step with it.
  useEffect(() => {
    const sync = (event: Event) => setPreference((event as CustomEvent<ThemePreference>).detail);
    window.addEventListener(THEME_EVENT, sync);
    return () => window.removeEventListener(THEME_EVENT, sync);
  }, []);

  return (
    <div aria-label="Colour theme" className="theme-toggle" role="radiogroup">
      {OPTIONS.map((option) => (
        <button
          aria-checked={preference === option.value}
          className="theme-option"
          key={option.value}
          onClick={() => applyThemePreference(option.value)}
          role="radio"
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
