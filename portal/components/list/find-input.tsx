"use client";

import { useEffect, useRef, useState } from "react";

// How long typing must pause before the search goes into the address.
export const FIND_WAIT_MS = 200;

/** The text box of every Find field. It shows each key as it is typed and only writes
 * the search into the address (which filters the list) once typing pauses. Bound
 * straight to the address, the box lost keys: the address catches up a moment after
 * each key, so the box was redrawn with the old text and the next key landed on it
 * ("emergency" left "y"). A change from outside, such as "Clear the search", still
 * shows at once. */
export function FindInput({ value, onChange, placeholder, wait = FIND_WAIT_MS }: { value: string; onChange: (value: string) => void; placeholder: string; wait?: number }) {
  const [text, setText] = useState(value);
  // The last search this box wrote, so the address catching up is not taken for a change from outside.
  const sent = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(onChange);
  useEffect(() => { latest.current = onChange; });

  useEffect(() => {
    if (value === sent.current) return;
    clearTimeout(timer.current);
    sent.current = value;
    setText(value);
  }, [value]);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <input
      className="bare-input"
      onChange={(event) => {
        const next = event.target.value;
        setText(next);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          sent.current = next;
          latest.current(next);
        }, next ? wait : 0);
      }}
      placeholder={placeholder}
      type="search"
      value={text}
    />
  );
}
