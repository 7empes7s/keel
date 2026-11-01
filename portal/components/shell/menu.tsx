"use client";

import Link from "next/link";
// No prefetch on the menu: every page is server-rendered per request, so a prefetched
// link cost a full layout render (identity, approvals count, name) on the server for
// each link in view, twice over on a desktop, before anyone clicked. A click still
// shows the loading skeleton as soon as the page starts streaming.
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { SearchTrigger } from "@/components/command-palette";
import { KeelMark } from "@/components/keel-mark";
import {
  isCurrentPath,
  MENU_SECTIONS,
  SECTION_ICONS,
  SECTION_PURPOSE,
  sectionForPath,
  sectionLinks,
  visibleNavEntries,
  type NavCapabilities,
  type NavSection,
} from "@/components/nav-links";
import { Icon, type IconName } from "@/components/shell/icons";
import { Popover } from "@/components/shell/popover";
import { useShellState } from "@/components/shell/shell-state";
import { SignOutControls } from "@/components/sign-out";
import { ThemeToggle } from "@/components/theme-toggle";
import { hasItem, moveItem, removeItem, toggleClosed, type MenuGroup, type MenuItem, type PersonalGroup } from "@/lib/menu-prefs";
import { inboxNote, worstTone, type MenuStatuses, type SectionStatus } from "@/lib/menu-status";
import { personLabel } from "@/lib/sentences";
import { SERVICES } from "@/lib/services";
import type { ThemePreference } from "@/lib/theme";
import { useLiveSearchParams } from "@/lib/use-view-state";

export interface Person {
  email: string;
  // The display name from People; null when it has none, then a label from the email.
  name?: string | null;
  access: string;
  accessTitle?: string;
  // The person's own entry on People, for someone who may open it.
  href?: string;
}

const TONE_WORDS: Record<SectionStatus["tone"], string> = { urgent: "Urgent", soon: "Check soon", low: "Low risk", fine: "Fine" };

export function StatusBadge({ status }: { status: SectionStatus | undefined }) {
  if (!status) return null;
  return (
    <span className="menu-badge" data-dot={status.count === undefined || undefined} data-tone={status.tone} title={status.note}>
      {status.count !== undefined ? (status.count > 99 ? "99+" : status.count) : null}
      <span className="visually-hidden">{`${TONE_WORDS[status.tone]}: ${status.note}`}</span>
    </span>
  );
}

/** The current location as the menu stores it: path plus any view state in the query. */
export function useCurrentHref(): string {
  const pathname = usePathname() ?? "/";
  const search = useLiveSearchParams()?.toString() ?? "";
  return search ? `${pathname}?${search}` : pathname;
}

export function Bell({ canApprove, canRead, approvals, alerts, placement }: { canApprove: boolean; canRead: boolean; approvals: number | null; alerts: number | null; placement: "rail" | "top" }) {
  if (!canApprove && !canRead) return null;
  const waiting = (canApprove ? approvals ?? 0 : 0) + (canRead ? alerts ?? 0 : 0);
  const note = inboxNote(canApprove ? approvals ?? 0 : 0, canRead ? alerts ?? 0 : 0);
  return (
    <Popover
      button={<><Icon name="bell" />{waiting ? <span aria-hidden="true" className="bell-count">{waiting > 99 ? "99+" : waiting}</span> : null}</>}
      buttonClassName={`icon-button bell bell-${placement}`}
      label={`Notifications: ${note}`}
      panelClassName="bell-panel"
      title="Waiting on someone"
    >
      {(close) => (
        <ul className="bell-list">
          {canApprove ? (
            <li>
              <Link className="bell-item" href="/approvals" onClick={close} prefetch={false}>
                <Icon name="inbox" />
                <span><b>Approvals</b><small>Restores and changes waiting for approval</small></span>
                <span className="bell-item-count" data-zero={!approvals || undefined}>{approvals ?? "–"}</span>
              </Link>
            </li>
          ) : null}
          {canRead ? (
            <li>
              <Link className="bell-item" href="/alerts" onClick={close} prefetch={false}>
                <Icon name="bell" />
                <span><b>Alerts</b><small>Changes someone has to look at, with who owns each</small></span>
                <span className="bell-item-count" data-zero={!alerts || undefined}>{alerts ?? "–"}</span>
              </Link>
            </li>
          ) : null}
        </ul>
      )}
    </Popover>
  );
}

export function CloudSwitcher() {
  return (
    <Popover
      button={<><span aria-hidden="true" className="cloud-tile">365</span><span className="cloud-name">Microsoft 365<small>All services</small></span><Icon className="cloud-chevron" name="chevron-down" /></>}
      buttonClassName="cloud-switcher"
      label="Cloud: Microsoft 365, all services"
      panelClassName="cloud-panel"
      title="Cloud and services"
    >
      {() => (
        <>
          <p className="cloud-current"><span aria-hidden="true" className="cloud-tile">365</span><span><b>Microsoft 365</b><small>The cloud Keel looks after. Others will appear here when Keel supports them.</small></span><Icon className="cloud-check" name="check" /></p>
          <p className="popover-subtitle">Lists group what they show by Microsoft&apos;s own services:</p>
          <ul className="service-list">
            {SERVICES.map((service) => (
              <li key={service.code}><Icon name={service.icon} /><span><b>{service.name}</b><small>{service.about}</small></span></li>
            ))}
          </ul>
        </>
      )}
    </Popover>
  );
}

function PinButton({ item }: { item: MenuItem }) {
  const { prefs, update, add } = useShellState();
  const pinned = hasItem(prefs, "pinned", item.href);
  return (
    <button
      aria-label={pinned ? `Unpin ${item.label}` : `Pin ${item.label} to the top of the menu`}
      aria-pressed={pinned}
      className="menu-tool menu-pin"
      onClick={() => (pinned ? update(removeItem(prefs, "pinned", item.href)) : add("pinned", item))}
      title={pinned ? "Unpin" : "Pin to the top"}
      type="button"
    >
      <Icon filled={pinned} name="pin" />
    </button>
  );
}

const GROUP_TITLES: Record<PersonalGroup, string> = { pinned: "Pinned", favourites: "Favourites" };
const GROUP_EMPTY: Record<PersonalGroup, string> = {
  pinned: "Pin any page from Everything below with its pin button.",
  favourites: "Star a page or an item from its title to keep it here. Saved list filters land here too.",
};

function GroupHeader({ group, title, count, extra, actions }: { group: MenuGroup; title: string; count?: number; extra?: ReactNode; actions?: ReactNode }) {
  const { prefs, update } = useShellState();
  const closed = prefs.closed.includes(group);
  return (
    <div className="menu-group-head">
      <button aria-expanded={!closed} className="menu-group-toggle" onClick={() => update(toggleClosed(prefs, group))} type="button">
        <Icon className="menu-group-chevron" name="chevron-down" />
        <span className="menu-group-title">{title}</span>
        {count === undefined ? null : <span className="menu-group-count">{count}</span>}
        {extra}
      </button>
      {actions ? <span className="menu-group-actions">{actions}</span> : null}
    </div>
  );
}

function PersonalList({ group, current, onNavigate }: { group: PersonalGroup; current: string; onNavigate?: () => void }) {
  const { prefs, update } = useShellState();
  const [editing, setEditing] = useState(false);
  const items = prefs[group];
  const closed = prefs.closed.includes(group);
  useEffect(() => { if (!items.length) setEditing(false); }, [items.length]);

  const actions = items.length ? (
    <button aria-pressed={editing} className="menu-text-button" onClick={() => setEditing((value) => !value)} type="button">
      {editing ? "Done" : "Edit"}
    </button>
  ) : null;

  return (
    <section aria-label={GROUP_TITLES[group]} className="menu-group" data-group={group}>
      <GroupHeader actions={actions} count={items.length} group={group} title={GROUP_TITLES[group]} />
      {closed ? null : items.length ? (
        <ul className="menu-list">
          {items.map((item, index) => (
            <li className="menu-row" key={item.href}>
              <Link aria-current={item.href === current ? "page" : undefined} className="menu-link" href={item.href} onClick={onNavigate} prefetch={false}>
                <Icon name={item.icon} />
                <span className="menu-label">{item.label}</span>
              </Link>
              {editing ? (
                <span className="menu-edit">
                  <button aria-label={`Move ${item.label} up`} className="menu-tool" disabled={index === 0} onClick={() => update(moveItem(prefs, group, item.href, -1))} type="button"><Icon name="up" /></button>
                  <button aria-label={`Move ${item.label} down`} className="menu-tool" disabled={index === items.length - 1} onClick={() => update(moveItem(prefs, group, item.href, 1))} type="button"><Icon name="down" /></button>
                  <button aria-label={`Remove ${item.label} from ${GROUP_TITLES[group]}`} className="menu-tool" onClick={() => update(removeItem(prefs, group, item.href))} type="button"><Icon name="close" /></button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="menu-empty">{GROUP_EMPTY[group]}</p>
      )}
    </section>
  );
}

/** The top of the menu: what waits on this person, with counts. Approvals counts only
 * the requests they can decide; Alerts the ones nobody has acknowledged. */
function InboxGroup({ capabilities, approvals, alerts, pathname, onNavigate }: { capabilities: NavCapabilities; approvals: number | null; alerts: number | null; pathname: string; onNavigate?: () => void }) {
  const { prefs } = useShellState();
  const links = sectionLinks("Inbox", capabilities);
  if (!links.length) return null;
  const closed = prefs.closed.includes("inbox");
  const counts: Record<string, number | null> = { "/approvals": approvals, "/alerts": alerts };
  const notes: Record<string, (count: number) => string> = {
    "/approvals": (count) => `${count} ${count === 1 ? "request waits" : "requests wait"} for your decision`,
    "/alerts": (count) => `${count} ${count === 1 ? "alert is" : "alerts are"} not acknowledged yet`,
  };
  const total = links.reduce((sum, link) => sum + (counts[link.href] ?? 0), 0);
  const summary: SectionStatus | undefined = total ? { tone: "soon", count: total, note: inboxNote(counts["/approvals"] ?? 0, counts["/alerts"] ?? 0) } : undefined;
  return (
    <section aria-label="Inbox" className="menu-group" data-group="inbox">
      <GroupHeader extra={closed ? <StatusBadge status={summary} /> : undefined} group="inbox" title="Inbox" />
      {closed ? null : (
        <ul className="menu-list">
          {links.map((link) => {
            const count = counts[link.href];
            return (
              <li className="menu-row" key={link.href}>
                <Link aria-current={isCurrentPath(pathname, link.href) ? "page" : undefined} className="menu-link" href={link.href} onClick={onNavigate} prefetch={false} title={SECTION_PURPOSE.Inbox}>
                  <Icon name={link.href === "/approvals" ? "inbox" : "bell"} />
                  <span className="menu-label">{link.label}</span>
                  {count ? <StatusBadge status={{ tone: "soon", count, note: notes[link.href](count) }} /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Everything({ capabilities, statuses, pathname, onNavigate }: { capabilities: NavCapabilities; statuses: MenuStatuses; pathname: string; onNavigate?: () => void }) {
  const { prefs } = useShellState();
  const entries = visibleNavEntries(capabilities);
  const active = sectionForPath(pathname);
  // Each section's pages can be shown without leaving the page you are on. The section
  // you are in opens by itself whenever you arrive in it; any other stays as you left it.
  const [toggled, setToggled] = useState<Partial<Record<NavSection, boolean>>>({});
  useEffect(() => {
    if (!active) return;
    setToggled((current) => {
      if (!(active in current)) return current;
      const next = { ...current };
      delete next[active];
      return next;
    });
  }, [active, pathname]);
  const closed = prefs.closed.includes("everything");
  const attention = entries.filter((entry) => statuses[entry.group] && statuses[entry.group]!.tone !== "fine");
  const tone = worstTone(attention.map((entry) => statuses[entry.group]?.tone));
  // Closed, the group still says how many sections need someone, in the worst colour.
  const atTone = attention.filter((entry) => statuses[entry.group]?.tone === tone).length;
  const others = attention.length - atTone;
  const summary = tone ? { tone, count: atTone, note: `${atTone} ${atTone === 1 ? "section needs" : "sections need"} ${tone === "urgent" ? "urgent attention" : "attention"}${others ? `, and ${others} more ${others === 1 ? "needs" : "need"} a look` : ""}` } : undefined;
  return (
    <section aria-label="Everything" className="menu-group" data-group="everything">
      <GroupHeader extra={<StatusBadge status={summary} />} group="everything" title="Everything" />
      {closed ? null : (
        <ul className="menu-list">
          {entries.map((entry) => {
            const section = entry.group as NavSection;
            const subs = sectionLinks(section, capabilities);
            const isActive = active === section;
            const expandable = subs.length > 1;
            const open = expandable && (toggled[section] ?? isActive);
            const subId = `menu-sub-${section.toLowerCase().replace(/\s+/g, "-")}`;
            return (
              <li className="menu-section" data-active={isActive || undefined} data-open={open || undefined} key={section}>
                <div className="menu-row">
                  <Link
                    aria-current={isActive ? (isCurrentPath(pathname, entry.href) && subs.length === 1 ? "page" : "true") : undefined}
                    className="menu-link"
                    href={entry.href}
                    onClick={onNavigate}
                    prefetch={false}
                    title={SECTION_PURPOSE[section]}
                  >
                    <Icon name={SECTION_ICONS[section]} />
                    <span className="menu-label">{section}</span>
                    <StatusBadge status={statuses[section]} />
                  </Link>
                  {expandable ? (
                    <button
                      aria-controls={open ? subId : undefined}
                      aria-expanded={open}
                      aria-label={`${open ? "Hide" : "Show"} the ${subs.length} ${section} pages`}
                      className="menu-tool menu-expand"
                      onClick={() => setToggled((current) => ({ ...current, [section]: !open }))}
                      title={open ? "Hide pages" : `Show pages: ${subs.map((sub) => sub.label).join(", ")}`}
                      type="button"
                    >
                      <Icon name="chevron-down" />
                    </button>
                  ) : null}
                  <PinButton item={{ href: entry.href, label: section, icon: SECTION_ICONS[section] }} />
                </div>
                {open ? (
                  <ul className="menu-sub" id={subId}>
                    {subs.map((sub) => (
                      <li className="menu-row" key={sub.href}>
                        <Link aria-current={isCurrentPath(pathname, sub.href) ? "page" : undefined} className="menu-sublink" href={sub.href} onClick={onNavigate} prefetch={false}>
                          <span aria-hidden="true" className="menu-tick" />
                          <span className="menu-label">{sub.label}</span>
                        </Link>
                        <PinButton item={{ href: sub.href, label: sub.label, icon: SECTION_ICONS[section] }} />
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function initials(label: string): string {
  const name = label.split("@")[0].replace(/[^\p{L}]/gu, " ").trim();
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : name.slice(0, 2)).toUpperCase() || "?";
}

// Opening a page keeps its menu entry in sight: the rail scrolls on its own, so a
// sub-item low in a long section (Settings, Setup) would otherwise sit below the fold.
function useCurrentInView(ref: { current: HTMLElement | null }, pathname: string) {
  useEffect(() => {
    const nav = ref.current;
    const current = nav?.querySelector<HTMLElement>('[aria-current="page"]') ?? nav?.querySelector<HTMLElement>('[aria-current="true"]');
    if (!nav || !current) return;
    const scroller = nav.closest<HTMLElement>(".rail") ?? nav;
    const box = scroller.getBoundingClientRect();
    const item = current.getBoundingClientRect();
    if (item.top < box.top || item.bottom > box.bottom) current.scrollIntoView({ block: "center" });
  }, [ref, pathname]);
}

export function Menu({
  capabilities,
  statuses,
  approvals,
  alerts,
  person,
  theme,
  onHide,
  onNavigate,
  variant,
}: {
  capabilities: NavCapabilities;
  statuses: MenuStatuses;
  approvals: number | null;
  alerts: number | null;
  person: Person;
  theme: ThemePreference;
  onHide?: () => void;
  onNavigate?: () => void;
  variant: "rail" | "sheet";
}) {
  const pathname = usePathname() ?? "/";
  const current = useCurrentHref();
  const navRef = useRef<HTMLElement>(null);
  useCurrentInView(navRef, pathname);
  const name = person.name || personLabel({ kind: "person", id: "", name: null, email: person.email, readable: true }, person.email);
  const who = (
    <>
      <span aria-hidden="true" className="avatar">{initials(person.name || person.email)}</span>
      <span className="menu-person-text">
        <span className="menu-person-name" title={person.email}>{name}</span>
        <small title={person.accessTitle}>{person.access}{person.href ? " · your access" : ""}</small>
      </span>
    </>
  );
  return (
    <div className="menu" data-variant={variant}>
      <div className="menu-head">
        <Link aria-label="Keel dashboards" className="brand" href="/" onClick={onNavigate} prefetch={false}>
          <span aria-hidden="true" className="brand-mark"><KeelMark /></span>
          <strong>KEEL</strong>
        </Link>
        {variant === "rail" ? <Bell alerts={alerts} approvals={approvals} canApprove={capabilities.canApprove === true} canRead={capabilities.canRead === true} placement="rail" /> : null}
        {onHide ? (
          <button aria-label={variant === "rail" ? "Hide the menu" : "Close the menu"} className="icon-button menu-hide" onClick={onHide} title={variant === "rail" ? "Hide the menu. Bring it back from the left edge." : "Close"} type="button">
            <Icon name={variant === "rail" ? "hide" : "close"} />
          </button>
        ) : null}
      </div>
      <CloudSwitcher />
      {variant === "rail" ? <SearchTrigger /> : null}
      <nav aria-label="Menu" className="menu-nav" ref={navRef}>
        <InboxGroup alerts={alerts} approvals={approvals} capabilities={capabilities} onNavigate={onNavigate} pathname={pathname} />
        <PersonalList current={current} group="pinned" onNavigate={onNavigate} />
        <PersonalList current={current} group="favourites" onNavigate={onNavigate} />
        <Everything capabilities={capabilities} onNavigate={onNavigate} pathname={pathname} statuses={statuses} />
      </nav>
      <div className="menu-foot">
        {person.href ? (
          <Link className="menu-person menu-person-link" href={person.href} onClick={onNavigate} prefetch={false}>{who}</Link>
        ) : (
          <p className="menu-person">{who}</p>
        )}
        <ThemeToggle initial={theme} />
        <SignOutControls />
      </div>
    </div>
  );
}

export const TAB_SECTIONS: NavSection[] = ["Dashboards", "Backup", "Restore", "Baselines"];

/** Phone: the four sections people open most, and All for the full menu. */
export function TabBar({ capabilities, statuses, onAll, allOpen }: { capabilities: NavCapabilities; statuses: MenuStatuses; onAll: () => void; allOpen: boolean }) {
  const pathname = usePathname() ?? "/";
  const active = sectionForPath(pathname);
  const entries = visibleNavEntries(capabilities).filter((entry) => TAB_SECTIONS.includes(entry.group));
  const elsewhere = !entries.some((entry) => entry.group === active);
  const others = MENU_SECTIONS.filter((section) => !TAB_SECTIONS.includes(section)).map((section) => statuses[section]);
  const otherTone = worstTone([...others.map((status) => status?.tone), statuses.Inbox?.tone].filter((tone) => tone !== "fine"));
  return (
    <nav aria-label="Main sections" className="tabbar">
      {entries.map((entry) => (
        <Link aria-current={active === entry.group ? (pathname === entry.href ? "page" : "true") : undefined} className="tab" href={entry.href} key={entry.group} prefetch={false}>
          <Icon name={SECTION_ICONS[entry.group] as IconName} />
          <span>{entry.group}</span>
          {statuses[entry.group] && statuses[entry.group]!.tone !== "fine" ? <StatusBadge status={statuses[entry.group]} /> : null}
        </Link>
      ))}
      <button aria-expanded={allOpen} aria-haspopup="dialog" className="tab" data-current={elsewhere || undefined} onClick={onAll} type="button">
        <Icon name="more" />
        <span>All</span>
        {otherTone ? <StatusBadge status={{ tone: otherTone, note: "Something in the other sections needs attention" }} /> : null}
      </button>
    </nav>
  );
}
