import type { ReactNode } from "react";

import { Icon, type IconName } from "@/components/shell/icons";
import type { RiskTone } from "@/lib/menu-status";

// The Settings pages in the frame What's protected and the list kit use: a section head
// with one plain line, rounded group panels with a shaded head, and rows with a kind
// icon, a name with a short line under it, a status and a sentence, and the row's own
// action on the right. A risk stripe marks rows that need someone.

export function SettingsSection({ id, title, about, extra, children }: {
  id: string;
  title: string;
  about: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="pt-section">
      <div className="pt-section-head">
        <div>
          <h2 id={id}>{title}</h2>
          <p>{about}</p>
        </div>
        {extra ? <div className="st-head-actions">{extra}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function SettingsGroup({ icon, title, about, count, aside, children }: {
  icon?: IconName;
  title?: ReactNode;
  about?: ReactNode;
  count?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="sel-group st-group">
      {title ? (
        <header className="sel-group-head st-group-head">
          {icon ? <Icon name={icon} /> : null}
          <span className="sel-group-name"><b>{title}</b>{about ? <small>{about}</small> : null}</span>
          {count ? <span className="sel-group-count">{count}</span> : null}
          {aside}
        </header>
      ) : null}
      <ul className="sel-rows">{children}</ul>
    </section>
  );
}

export function SettingsRow({ tone, icon, iconTone, name, meta, status, line, actions }: {
  tone?: RiskTone | null;
  icon: IconName | ReactNode;
  iconTone?: RiskTone | null;
  name: ReactNode;
  meta?: ReactNode;
  status?: ReactNode;
  line?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <li className="sel-row st-row" data-tone={tone ?? undefined}>
      <div className="sel-row-body pt-row">
        {typeof icon === "string" ? (
          <span aria-hidden="true" className="pt-kind" data-tone={iconTone ?? undefined}><Icon name={icon as IconName} /></span>
        ) : icon}
        <span className="pt-row-name">
          <b>{name}</b>
          {meta ? <small>{meta}</small> : null}
        </span>
        <span className="pt-row-mid">
          {status ?? <span />}
          {line ? <span className="pt-row-line">{line}</span> : null}
        </span>
        <span className="pt-row-acts">{actions}</span>
      </div>
    </li>
  );
}

/** A row that says the group is empty, in the group's own words. */
export function SettingsEmptyRow({ children }: { children: ReactNode }) {
  return <li className="sel-row st-empty-row"><span className="pt-row-line">{children}</span></li>;
}
