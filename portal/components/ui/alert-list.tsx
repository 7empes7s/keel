import Link from "next/link";
import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/shell/icons";

// Shared alert rows (first built for the Resilience page). Each row: a tone stripe and
// icon, a tone word, a short title, one "What to do:" line, optional details behind
// "Show details", and at most one action. Callers sort worst first.

export type AlertTone = "urgent" | "soon" | "low";

export interface AlertItem {
  key: string;
  tone: AlertTone;
  icon: IconName;
  title: ReactNode;
  todo: ReactNode;
  // Specifics, error text included: shown only when the reader asks for them.
  more?: ReactNode[];
  action?: { label: string; href: string } | null;
}

export const ALERT_WORDS: Record<AlertTone, string> = { urgent: "Act now", soon: "Fix soon", low: "Good to know" };

/** The "Show details" disclosure the alert rows and error notices share. */
export function ShowDetails({ lines, summary = "Show details" }: { lines: ReactNode[]; summary?: string }) {
  if (!lines.length) return null;
  return (
    <details className="ui-alert-more" data-show-details="">
      <summary>{summary}</summary>
      <ul>{lines.map((line, index) => <li key={index}>{line}</li>)}</ul>
    </details>
  );
}

export function AlertRow({ item, as: Tag = "li", toneWord = true }: { item: AlertItem; as?: "li" | "div"; toneWord?: boolean }) {
  return (
    <Tag className="ui-alert" data-alert={item.key} data-tone={item.tone}>
      <span aria-hidden="true" className="ui-alert-icon"><Icon name={item.icon} /></span>
      <div className="ui-alert-body">
        <p className="ui-alert-title">{toneWord ? <span className="ui-alert-tone">{ALERT_WORDS[item.tone]}</span> : null}{item.title}</p>
        <p className="ui-alert-todo"><b>What to do:</b> {item.todo}</p>
        <ShowDetails lines={item.more ?? []} />
      </div>
      {item.action ? <Link className="btn btn-sm ui-alert-action" href={item.action.href}>{item.action.label}<Icon name="chevron" /></Link> : null}
    </Tag>
  );
}

/** A list of alert rows, or one calm line when there are none. */
export function AlertList({ items, calm = "Nothing needs you right now." }: { items: AlertItem[]; calm?: ReactNode }) {
  if (!items.length) return <p className="ui-calm"><Icon name="check-circle" />{calm}</p>;
  return <ul className="ui-alerts">{items.map((item) => <AlertRow item={item} key={item.key} />)}</ul>;
}
