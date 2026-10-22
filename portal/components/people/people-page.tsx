"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, type MouseEvent } from "react";

import { BaselinesStyles } from "@/components/baselines/styles";
import { ActiveFilters, NoMatches, type ActiveFilter } from "@/components/list/active-filters";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { AddPersonSheet } from "@/components/people/add-person-sheet";
import { PersonRecord } from "@/components/people/person-record";
import { PersonSheet } from "@/components/people/person-sheet";
import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, TechnicalDetails } from "@/components/technical-details";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import { Verdict } from "@/components/verdict";
import { changePerson } from "@/lib/people-change";
import {
  PERSON_STATES,
  ROLES,
  ROLE_ORDER,
  accessLine,
  accessReviewCsv,
  addRoleDetail,
  hasRole,
  inState,
  grantEntity,
  isRole,
  isSystem,
  liveRoles,
  mainRoleGroup,
  parseFilters,
  peopleCounts,
  peopleVerdict,
  personMatches,
  personName,
  personRef,
  personState,
  roleChips,
  sinceWords,
  systemWords,
  type PersonState,
  type PeopleState,
  type Role,
} from "@/lib/people-view";
import type { PrincipalView } from "@/lib/principals";
import { addsWords, tileCounts } from "@/lib/filter-set";
import { toast } from "@/lib/toast";
import { pushUrl } from "@/lib/url-history";
import { useViewState } from "@/lib/use-view-state";

// People (portal audit, one design): who can use Keel as one grouped list. Four count
// tiles (Can use Keel, Admins, Can approve, Disabled) are links that set a filter in
// the address; people sit in a SelectableList grouped by their highest role, with
// "Add Viewer to N people" for several at once. A name opens the person's panel
// (`?open=<id>`), where roles are added or removed and the person disabled or let back
// in. "Add person" (`?new=1`) opens a short sheet. Keel's own accounts are listed
// apart, with no controls. Ids and capability codes stay in one record at the foot.

const GROUP_ORDER = [...ROLE_ORDER, "starts-later", "no-role", "disabled"];

// Which filter key each tile stands for.
const TILE_KEYS: Record<string, string> = { use: "active", admins: "admin", approve: "approver", disabled: "disabled" };

export function PeoplePage({ people, canUsers, canRoles, now = new Date().toISOString() }: {
  people: PrincipalView[];
  canUsers: boolean;
  canRoles: boolean;
  now?: string;
}) {
  const router = useRouter();
  const view = useViewState();
  const pathname = usePathname() ?? "/principals";
  const params = useSearchParams();
  const get = (key: string) => params?.get(key) ?? null;
  const filters = useMemo(() => parseFilters(get), [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const [added, setAdded] = useState<PrincipalView[]>([]);
  const [busy, setBusy] = useState(false);

  // A person just added shows at once, before the page's next read brings them back.
  const everyone = useMemo(() => [...people, ...added.filter((person) => !people.some((entry) => entry.id === person.id))], [people, added]);
  const humans = useMemo(() => everyone.filter((person) => !isSystem(person)), [everyone]);
  const keelAccounts = useMemo(() => everyone.filter(isSystem), [everyone]);
  const counts = useMemo(() => peopleCounts(everyone, now), [everyone, now]);
  const verdict = peopleVerdict(counts);
  const shown = useMemo(() => humans.filter((person) => personMatches(person, filters, now)), [humans, filters, now]);
  const filtering = Boolean(filters.roles.length || filters.states.length);
  // Each tile and what picking it would add to the people shown now.
  const pickedTiles = [...filters.states, ...filters.roles] as string[];
  const tileTotals = useMemo(() => new Map(tileCounts(humans, [
    ...(["active", "disabled"] as const).map((state) => ({ key: state as string, test: (person: PrincipalView) => inState(person, state, now) })),
    ...ROLE_ORDER.map((role) => ({ key: role as string, test: (person: PrincipalView) => hasRole(person, role, now) })),
  ], pickedTiles).map((entry) => [entry.key, entry])), [humans, now, pickedTiles.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleRole = (role: Role) => ({ role: (filters.roles.includes(role) ? filters.roles.filter((entry) => entry !== role) : ROLE_ORDER.filter((entry) => entry === role || filters.roles.includes(entry))).join(",") || null });
  const toggleState = (state: PeopleState) => ({ state: (filters.states.includes(state) ? filters.states.filter((entry) => entry !== state) : (["active", "disabled"] as const).filter((entry) => entry === state || filters.states.includes(entry))).join(",") || null });
  // Chips in the tiles' order: Can use Keel, the roles, then Disabled.
  const activeFilters: ActiveFilter[] = [
    ...(filters.states.includes("active") ? [{ key: "state:active", label: "Can use Keel", clear: toggleState("active") }] : []),
    ...filters.roles.map((role) => ({ key: `role:${role}`, label: role === "approver" ? "Can approve" : ROLES[role].plural, clear: toggleRole(role) })),
    ...(filters.states.includes("disabled") ? [{ key: "state:disabled", label: "Disabled", clear: toggleState("disabled") }] : []),
  ];
  const openId = view.get("open");
  const opened = everyone.find((person) => person.id === openId) ?? null;
  const adding = Boolean(view.get("new")) && canUsers && canRoles;
  const canChange = canUsers || canRoles;

  const href = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params?.toString() ?? "");
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    const text = next.toString();
    return text ? `${pathname}?${text}` : pathname;
  };
  const openPerson = (event: MouseEvent, id: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    pushUrl(href({ open: id, new: null }));
  };

  // Several people at once: one call per person, then one toast that names what failed.
  async function forEach(ids: string[], what: string, run: (person: PrincipalView) => Promise<{ ok: boolean }>, skip: (person: PrincipalView) => boolean) {
    const chosen = humans.filter((person) => ids.includes(person.id) && !skip(person));
    if (chosen.length === 0) { toast({ tone: "warning", title: "Nothing to change", detail: "The chosen people are already as asked." }); return; }
    setBusy(true);
    try {
      const failed: string[] = [];
      for (const person of chosen) if (!(await run(person)).ok) failed.push(personName(person));
      const done = chosen.length - failed.length;
      if (failed.length) toast({ tone: "warning", title: `${what}: ${done} of ${chosen.length} people`, detail: `Not changed: ${failed.join(", ")}.` });
      else toast({ title: `${what}: ${done === 1 ? "1 person" : `${done} people`}` });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }
  const addRole = (role: Role, ids: string[]) => forEach(ids, `${ROLES[role].label} added`, (person) => changePerson(person.id, { kind: "grant", role }), (person) => Boolean(person.disabled_at) || liveRoles(person, now).includes(role));

  const disableMany = (ids: string[]) => forEach(ids, "Disabled", (person) => changePerson(person.id, { kind: "disable" }), (person) => Boolean(person.disabled_at));

  function exportCsv() {
    const blob = new Blob([accessReviewCsv(everyone, now)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `keel-access-review-${now.slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const verdictAction = verdict.tone === "urgent" && canUsers && canRoles && !adding ? { label: "Add an approver", href: href({ new: "1", as: "approver", open: null }) } : null;

  const tiles: { key: string; label: string; icon: IconName; value: number; small: string; changes: Record<string, string | null>; tone?: "urgent" | "soon"; active: boolean }[] = [
    { key: "use", label: "Can use Keel", icon: "check-circle", value: counts.canUse, small: counts.total > counts.canUse ? `${counts.total - counts.canUse} more without a role or disabled` : "Everyone added has a role", changes: toggleState("active"), active: filters.states.includes("active") },
    { key: "admins", label: "Admins", icon: "settings", value: counts.admins, small: counts.admins <= 1 ? "Add a second admin to be safe" : "Add people and grant roles", changes: toggleRole("admin"), tone: counts.admins <= 1 ? "soon" : undefined, active: filters.roles.includes("admin") },
    { key: "approve", label: "Can approve", icon: "inbox", value: counts.approvers, small: counts.approvers ? "Restores and changes someone asked for" : "Nobody can approve yet", changes: toggleRole("approver"), tone: counts.approvers === 0 ? "urgent" : undefined, active: filters.roles.includes("approver") },
    { key: "disabled", label: "Disabled", icon: "hide", value: counts.disabled, small: counts.disabled ? "Roles kept, cannot sign in" : "Nobody is disabled", changes: toggleState("disabled"), active: filters.states.includes("disabled") },
  ];

  const groupings = useMemo<Grouping<PrincipalView>[]>(() => [
    { key: "role", label: "Role", groupsOf: (items) => groupBy(items, (item) => mainRoleGroup(item, now), (key, list) => (key in ROLES ? { label: ROLES[key as Role].plural, icon: "settings" as IconName, about: `${ROLES[key as Role].meaning} · ${peopleWord(list.length)}` } : { label: PERSON_STATES[key as PersonState].plural, icon: PERSON_STATES[key as PersonState].icon, about: peopleWord(list.length) }), (key) => GROUP_ORDER.indexOf(key)) },
    { key: "state", label: "State", groupsOf: (items) => groupBy(items, (item) => personState(item, now), (key, list) => ({ label: PERSON_STATES[key as PersonState].plural, icon: PERSON_STATES[key as PersonState].icon, about: peopleWord(list.length) }), (key) => GROUP_ORDER.indexOf(key)) },
    { key: "scope", label: "Where", groupsOf: (items) => groupBy(items, (item) => (item.role_grants.some((grant) => grantEntity(grant)) ? "part" : "everywhere"), (key, list) => ({ label: key === "part" ? "Part of the company" : "Everywhere", icon: "cloud" as IconName, about: peopleWord(list.length) }), (key) => (key === "everywhere" ? 0 : 1)) },
  ], [now]);

  const renderRow = (person: PrincipalView) => {
    const state = personState(person, now);
    const words = PERSON_STATES[state];
    const chips = roleChips(person, now);
    return (
      <div className="pe-row" data-state={state} id={`person-${person.id}`}>
        <span className="pe-row-name">
          <Link className="pe-row-link" href={href({ open: person.id, new: null })} onClick={(event) => openPerson(event, person.id)}>
            <Person person={personRef(person)} />
          </Link>
          <small className="pe-email">{person.email}</small>
        </span>
        <span className="pe-row-roles">
          {chips.length ? chips.map((chip) => <Badge icon={null} key={chip.label} tone={chip.tone}>{chip.label}</Badge>) : <span className="pe-none">No role</span>}
        </span>
        <span className="pe-row-mid">
          {state === "active" ? null : <Badge icon={words.icon} tone={words.tone}>{words.label}</Badge>}
          <small>{sinceWords(person, now)}</small>
        </span>
        <span className="pe-row-can">{accessLine(person, now)}</span>
      </div>
    );
  };

  return (
    <div className="pe-page">
      <Verdict action={verdictAction} detail={verdict.detail} text={verdict.text} tone={verdict.tone} />
      <div data-layer="explanation">
        <section aria-label="People at a glance" className="pe-tiles">
          {tiles.map((tile) => {
            const adds = addsWords(tileTotals.get(TILE_KEYS[tile.key]), pickedTiles.length);
            return (
              <Link aria-current={tile.active || undefined} className="pe-tile" data-tone={tile.tone} href={href({ ...tile.changes, open: null, new: null })} key={tile.key} title={tile.active ? "Picked: click to remove it from the view" : "Click to add these to the view"}>
                <span className="pe-tile-label"><Icon name={tile.icon} />{tile.label}{tile.active ? <Icon className="tile-check" name="check" /> : null}</span>
                <b className="pe-tile-count">{tile.value}</b>
                <small>{tile.small}</small>
                {adds ? <small className="tile-adds">{adds}</small> : null}
              </Link>
            );
          })}
        </section>

        <div className="pe-tools">
          {filtering ? (
            <ActiveFilters extra={{ open: null }} filters={activeFilters} noun={{ one: "person", many: "people" }} shown={shown.length} total={humans.length} />
          ) : <p className="pe-filter-note">Adding someone here does not let them past your sign-in gate; allow their email there too.</p>}
          {humans.length ? <button className="btn btn-sm" onClick={exportCsv} type="button"><Icon name="save" />Export for access review</button> : null}
        </div>

        <section aria-labelledby="pe-people-heading" className="pe-section">
          <h2 className="visually-hidden" id="pe-people-heading">People</h2>
          {humans.length === 0 ? (
            <div className="pe-empty">
              <p className="sel-empty">Nobody has been added yet.</p>
              {canUsers && canRoles ? <Link className="btn" href={href({ new: "1" })}><Icon name="plus" />Add person</Link> : null}
            </div>
          ) : shown.length === 0 ? (
            <NoMatches extra={{ open: null }} filters={activeFilters} noun={{ one: "person", many: "people" }} />
          ) : canRoles || canUsers ? (
            <SelectableList
              action={canRoles ? {
                label: (count) => `Add Viewer to ${peopleWord(count)}`,
                detail: (_count, ids) => addRoleDetail("viewer", shown.filter((person) => ids.includes(person.id)), now),
                run: (ids) => { if (!busy) void addRole("viewer", ids); },
              } : {
                // Without the roles permission the one bulk action is Disable.
                label: (count) => `Disable ${peopleWord(count)}`,
                detail: () => "They can no longer sign in. Their roles are kept, and Enable again lets them back.",
                run: (ids) => { if (!busy) void disableMany(ids); },
              }}
              getId={(item) => item.id}
              groupings={groupings}
              items={shown}
              label="People"
              matches={(item, text) => `${personName(item)} ${item.email}`.toLowerCase().includes(text)}
              more={[
                ...(canRoles ? (["approver", "operator", "restorer", "investigator", "admin"] as Role[]).map((role) => ({ label: `Add ${ROLES[role].label} instead`, run: (ids: string[]) => void addRole(role, ids) })) : []),
                ...(canUsers && canRoles ? [{ label: "Disable these people", run: (ids: string[]) => void disableMany(ids) }] : []),
              ]}
              noun={{ one: "person", many: "people" }}
              renderRow={renderRow}
              rowName={(item) => personName(item)}
              toneOf={(item) => (personState(item, now) === "no-role" ? "low" : null)}
            />
          ) : (
            <ul className="pe-plain-list">{shown.map((person) => <li className="sel-row" key={person.id}>{renderRow(person)}</li>)}</ul>
          )}
        </section>

        {keelAccounts.length ? (
          <section aria-labelledby="pe-keel-heading" className="pe-section">
            <h2 className="pe-heading" id="pe-keel-heading">Keel&apos;s own accounts</h2>
            <ul className="pe-keel-list">
              {keelAccounts.map((account) => (
                <li className="pe-keel-row" id={`person-${account.id}`} key={account.id}>
                  <Person person={personRef(account)} />
                  <span>{systemWords(account)}</span>
                  <Badge icon={null} tone="neutral">{account.disabled_at ? "Disabled" : "Set by Keel"}</Badge>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <TechnicalDetails summary="Technical details for these people">
          <RecordField copy={false} label="Read with" value="GET /api/principals" />
          <RecordField copy={false} label="Add with" value="POST /api/principals {email, displayName, role, activeUntil, reason}" />
          {everyone.map((person) => <PersonRecord key={person.id} person={person} />)}
        </TechnicalDetails>
      </div>

      {opened || adding ? <BaselinesStyles /> : null}
      {opened && !adding ? (
        <PersonSheet key={opened.id} canRoles={canRoles} canUsers={canUsers && canChange} now={now} onClose={() => view.set({ open: null })} people={everyone} person={opened} />
      ) : null}
      {adding ? <AddPersonSheet initialRole={isRole(view.get("as")) ? (view.get("as") as Role) : "viewer"} onAdded={(person) => { if (person) setAdded((list) => [...list, person]); view.set({ new: null, as: null, role: null, state: null }); router.refresh(); }} onClose={() => view.set({ new: null, as: null })} /> : null}
    </div>
  );
}

function peopleWord(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

function groupBy<T>(items: T[], key: (item: T) => string, meta: (key: string, list: T[]) => Omit<ListGroup<T>, "items" | "key">, rank: (key: string) => number): ListGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey, list), items: list })).sort((a, b) => rank(a.key) - rank(b.key));
}
