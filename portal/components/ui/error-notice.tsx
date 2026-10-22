import type { ReactNode } from "react";

import { AlertRow, type AlertTone } from "@/components/ui/alert-list";
import { plainError, type PlainErrorOptions } from "@/lib/error-words";

// The portal's one error notice: a short plain cause, a "What to do:" line, and the full
// raw error only behind "Show details". Raw error text never renders outside it (the UI
// harness checks every page).
export function ErrorNotice({ error, title, todo, tone = "urgent", service, id = "error", toneWord = false }: {
  error: unknown;
  /** Overrides the plain cause, when the page knows better words. */
  title?: ReactNode;
  /** Overrides the next step, when the page knows the right one. */
  todo?: ReactNode;
  tone?: AlertTone;
  service?: PlainErrorOptions["service"];
  id?: string;
  toneWord?: boolean;
}) {
  const words = plainError(error, { service });
  return (
    <div className="ui-error-notice" data-error-notice="">
      <AlertRow
        as="div"
        item={{
          key: id,
          tone,
          icon: "alert",
          title: title ?? words.cause,
          todo: todo ?? words.todo,
          more: words.raw ? [<code className="ui-raw-error" key="raw">{words.raw}</code>] : [],
        }}
        toneWord={toneWord}
      />
    </div>
  );
}
