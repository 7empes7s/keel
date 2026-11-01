import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { DatePicker } from "@/components/pickers/date-picker";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Segmented } from "@/components/pickers/segmented";
import { DataUnavailable } from "@/components/data-unavailable";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import { Verdict } from "@/components/verdict";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { addDays, inRange, rangeFromParam, rangeToParam, type Day } from "@/lib/date-range";
import type { RiskTone } from "@/lib/menu-status";
import { orderGroups, smartOrder } from "@/lib/selection";
import { serviceFor, serviceOrder, SERVICES } from "@/lib/services";
import { refused, toast } from "@/lib/toast";
import { useViewState } from "@/lib/use-view-state";
import { worstTone } from "@/lib/menu-status";

// UI harness: the shared list and pickers the section pages build on, with sample
// settings. Not a portal page; section threads adopt these pieces on their own pages.
interface Setting {
  id: string;
  name: string;
  kind: string;
  service: string;
  tone: RiskTone;
  who: string;
  at: string;
}

const TODAY: Day = "2026-10-02";
const BACKUP_DAYS = new Set(Array.from({ length: 30 }, (_, index) => addDays(TODAY, -index)).filter((day) => Number(day.slice(8, 10)) % 3 !== 1));

const SETTINGS: Setting[] = [
  { id: "s1", name: "Block legacy sign-in", kind: "Sign-in rule", service: "Entra", tone: "urgent", who: "Amara Okafor", at: "2026-10-02T08:12:00Z" },
  { id: "s2", name: "Require MFA for admins", kind: "Sign-in rule", service: "Entra", tone: "urgent", who: "Amara Okafor", at: "2026-10-02T08:10:00Z" },
  { id: "s3", name: "Break-glass admins", kind: "Group", service: "Entra", tone: "soon", who: "Lee Chen", at: "2026-10-01T16:40:00Z" },
  { id: "s4", name: "HQ egress", kind: "Trusted location", service: "Entra", tone: "low", who: "Lee Chen", at: "2026-09-30T11:00:00Z" },
  { id: "s5", name: "Payroll connector", kind: "App access", service: "Entra", tone: "soon", who: "Sam Ortiz", at: "2026-09-29T09:30:00Z" },
  { id: "s6", name: "External forwarding", kind: "Mail flow rule", service: "Exchange", tone: "soon", who: "Sam Ortiz", at: "2026-10-01T10:05:00Z" },
  { id: "s7", name: "Finance shared mailbox", kind: "Mailbox", service: "Exchange", tone: "low", who: "Amara Okafor", at: "2026-09-27T14:00:00Z" },
  { id: "s8", name: "Anti-spam inbound", kind: "Mail protection", service: "Exchange", tone: "fine", who: "Lee Chen", at: "2026-09-21T08:00:00Z" },
  { id: "s9", name: "Finance site", kind: "Site sharing", service: "SharePoint", tone: "soon", who: "Sam Ortiz", at: "2026-10-01T12:30:00Z" },
  { id: "s10", name: "Records archive", kind: "Site", service: "SharePoint", tone: "low", who: "Lee Chen", at: "2026-09-25T15:20:00Z" },
  { id: "s11", name: "Guest access", kind: "Teams setting", service: "Teams", tone: "low", who: "Amara Okafor", at: "2026-09-28T13:00:00Z" },
  { id: "s12", name: "Meeting recordings", kind: "Meeting policy", service: "Teams", tone: "fine", who: "Sam Ortiz", at: "2026-09-19T10:00:00Z" },
  { id: "s13", name: "Windows baseline", kind: "Device rule", service: "Intune", tone: "soon", who: "Lee Chen", at: "2026-09-30T17:45:00Z" },
  { id: "s14", name: "iOS app protection", kind: "App rule", service: "Intune", tone: "fine", who: "Amara Okafor", at: "2026-09-18T09:00:00Z" },
];

const TONE_WORDS: Record<RiskTone, string> = { urgent: "Urgent", soon: "Check soon", low: "Low risk", fine: "Fine" };

function ago(at: string) {
  const hours = Math.round((Date.parse(`${TODAY}T09:40:00Z`) - Date.parse(at)) / 3_600_000);
  const days = Math.round(hours / 24);
  return hours < 24 ? `${Math.max(hours, 1)} h ago` : days === 1 ? "yesterday" : `${days} days ago`;
}

function ordered(items: Setting[]) {
  return smartOrder(items, (item) => item.tone, (item) => item.at);
}

function groupBy(items: Setting[], key: (item: Setting) => string, meta: (key: string) => Omit<ListGroup<Setting>, "items" | "key">, rank?: (key: string) => number): ListGroup<Setting>[] {
  const map = new Map<string, Setting[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  const groups = [...map.entries()].map(([groupKey, list]) => ({ key: groupKey, ...meta(groupKey), items: ordered(list) }));
  return rank ? groups.sort((a, b) => rank(a.key) - rank(b.key)) : orderGroups(groups, (group) => worstTone(group.items.map((item) => item.tone)));
}

const GROUPINGS: Grouping<Setting>[] = [
  { key: "service", label: "Service", groupsOf: (items) => groupBy(items, (item) => item.service, (code) => { const service = serviceFor(code); return { label: service.name, icon: service.icon, about: service.about }; }) },
  { key: "risk", label: "Risk", groupsOf: (items) => groupBy(items, (item) => item.tone, (tone) => ({ label: TONE_WORDS[tone as RiskTone], icon: tone === "fine" ? "check" : tone === "low" ? "info" : "alert" }), (tone) => ["urgent", "soon", "low", "fine"].indexOf(tone)) },
  { key: "person", label: "Person", groupsOf: (items) => groupBy(items, (item) => item.who, (who) => ({ label: who, icon: "service-entra" })) },
];

// A long list for paging: 50 more settings spread over the services, so pages,
// rows per page and Order by have something to split.
const MANY: Setting[] = Array.from({ length: 50 }, (_, index) => {
  const services = ["Entra", "Exchange", "SharePoint", "Teams", "Intune"];
  const tones: RiskTone[] = ["fine", "low", "soon", "fine", "low"];
  return { id: `m${index + 1}`, name: `Sample setting ${String(index + 1).padStart(2, "0")}`, kind: index % 2 ? "Sample rule" : "Sample setting", service: services[index % 5], tone: tones[index % 5], who: ["Lee Chen", "Sam Ortiz", "Amara Okafor"][index % 3], at: `2026-09-${String(1 + (index % 28)).padStart(2, "0")}T08:00:00Z` };
});

// The long list also shows kinds inside each service, so paging walks through parts.
const PART_GROUPINGS: Grouping<Setting>[] = [
  {
    ...GROUPINGS[0],
    groupsOf: (items) => GROUPINGS[0].groupsOf(items).map((group) => {
      const kinds = [...new Set(group.items.map((item) => item.kind))].sort();
      const parts = kinds.map((kind) => ({ key: kind.toLowerCase().replace(/\W+/g, "-"), label: kind, items: group.items.filter((item) => item.kind === kind) }));
      return { ...group, parts, items: parts.flatMap((part) => part.items) };
    }),
  },
  ...GROUPINGS.slice(1),
];

export function KitPage({ many = false }: { many?: boolean }) {
  const view = useViewState();
  const when = rangeFromParam(view.get("when"));
  const service = view.get("service") || null;
  const show = view.get("show", "all");
  const items = (many ? [...SETTINGS, ...MANY] : SETTINGS).filter((item) => (!service || item.service === service)
    && (show === "all" || (show === "action" ? item.tone === "urgent" || item.tone === "soon" : item.tone === "low" || item.tone === "fine"))
    && (!when || inRange(item.at.slice(0, 10), when)));

  return (
    <>
      <style>{KIT_CSS}</style>
      <PageHeader description="The shared list and pickers every section uses: select, group, find, save a filter, and pick dates." generatedAt={`${TODAY}T09:40:00Z`} section="Settings" status={{ tone: "soon", label: "Sample data" }} title="List and picker kit" />
      <div className="kit-pickers">
        <DatePicker allowClear label="Changed" lastBackup={addDays(TODAY, -1)} marked={BACKUP_DAYS} onChange={(value) => view.set({ when: rangeToParam(value) })} today={TODAY} value={when} />
        <OptionPicker
          label="Service"
          onChange={(value) => view.set({ service: value === "all" ? null : value })}
          options={[{ value: "all", label: "All services", icon: "cloud", hint: "Everything in Microsoft 365" }, ...SERVICES.filter((entry) => entry.code !== "Keel").sort((a, b) => serviceOrder(a.code) - serviceOrder(b.code)).map((entry) => ({ value: entry.code, label: entry.name, icon: entry.icon, hint: entry.about }))]}
          value={service ?? "all"}
        />
        <Segmented
          label="Show"
          onChange={(value) => view.set({ show: value }, { show: "all" })}
          options={[{ value: "all", label: "All" }, { value: "action", label: "Needs action" }, { value: "fine", label: "Low risk" }]}
          value={show}
        />
      </div>
      <SelectableList
        action={{
          label: (count) => `Restore ${count} ${count === 1 ? "setting" : "settings"}`,
          detail: (count) => `Puts ${count === 1 ? "it" : "them"} back as in the chosen backup. Nothing changes until it is approved.`,
          run: (ids) => toast({ title: `Restore of ${ids.length} settings sent for approval`, detail: "Someone other than you has to approve it." }),
        }}
        getId={(item) => item.id}
        groupings={many ? PART_GROUPINGS : GROUPINGS}
        items={items}
        label="Changed settings"
        matches={(item, query) => `${item.name} ${item.kind} ${item.who}`.toLowerCase().includes(query)}
        more={[{ label: "Accept as approved setup", run: (ids) => toast({ title: `${ids.length} changes accepted` }) }, { label: "Export as a file", run: () => toast({ title: "Export started" }) }]}
        noun={{ one: "setting", many: "settings" }}
        renderRow={(item) => (
          <div className="kit-row">
            <span className="kit-row-name"><b>{item.name}</b><small>{item.kind} · {serviceFor(item.service).name}</small></span>
            <Badge tone={item.tone}>{TONE_WORDS[item.tone]}</Badge>
            <span className="kit-who">{item.who}<small>{ago(item.at)}</small></span>
          </div>
        )}
        rowName={(item) => `${item.name}, ${item.kind}`}
        toneOf={(item) => item.tone}
      />
      <section aria-labelledby="kit-buttons-heading" className="report-section kit-messages">
        <h2 id="kit-buttons-heading">Buttons and messages</h2>
        <div className="form-actions">
          <ConfirmButton confirmLabel="Start" description={<p>Keel makes the changes it can and stops at the first step only you can do.</p>} onConfirm={() => { toast({ title: "Setup started" }); }} title="Start the setup?" tone="primary">Start setup</ConfirmButton>
          <ConfirmButton confirmLabel="Pause" description={<p>Splunk stops receiving audit entries until it is resumed.</p>} onConfirm={() => { toast({ title: "Paused" }); }} title="Pause Splunk?">Pause</ConfirmButton>
          <ConfirmButton cancelLabel="Keep the role" confirmLabel="Remove the role" description={<p>Amara will still sign in and see everything, but can no longer approve restores.</p>} onConfirm={() => { toast({ title: "Role removed" }); }} title="Remove Amara Okafor's approver role?" tone="danger">Remove access</ConfirmButton>
        </div>
        <div className="form-actions">
          <button className="btn" onClick={() => toast({ title: "Backup started for the critical settings", href: "/jobs/job-1", hrefLabel: "Watch it" })} type="button">Show a done message</button>
          <button className="btn" onClick={() => toast({ tone: "info", title: "Rule turned off", action: { label: "Undo", run: () => toast({ title: "Rule turned back on" }) } })} type="button">Show a message with Undo</button>
          <button className="btn" onClick={() => toast({ tone: "warning", title: "Could not send the test message", detail: "The address was refused." })} type="button">Show a failure message</button>
          <button className="btn" onClick={() => toast({ tone: "warning", title: "Undo not planned", ...refused(403, "AuthorizationError: Graph 403 Authorization_RequestDenied on /deviceManagement/deviceConfigurations") })} type="button">Show a refused request</button>
        </div>
        <DataUnavailable service={{ name: "ServiceNow", href: "/integrations" }} surface="ServiceNow approvals" />
        <DataUnavailable surface="Schedules" />
      </section>
      <section aria-labelledby="kit-frame" className="report-section kit-frame">
        <h2 id="kit-frame">Badges, people and status sentences</h2>
        <div className="kit-badges">
          <Badge tone="urgent">Failed</Badge>
          <Badge tone="soon">Out of date</Badge>
          <Badge tone="low">Restore not tested yet</Badge>
          <Badge tone="fine">Finished</Badge>
          <Badge icon="pause" tone="neutral">Turned off</Badge>
          <Badge icon="play" tone="soon">Running</Badge>
        </div>
        <div className="kit-badges">
          <Person person={{ kind: "principal", id: "p1", name: "Amara Okafor", readable: true, email: "amara@contoso.com" }} />
          <Person person={{ kind: "principal", id: "scheduler", name: "scheduler", readable: true, system: true }} />
          <Person person={{ kind: "principal", id: "gone", name: null, readable: false }} />
        </div>
        <Verdict action={{ label: "Try both again", href: "#/kit" }} detail="Authentication methods and Retention labels. Try again, or open them to see why." text="2 setting types failed their last backup." tone="urgent" />
        <Verdict detail="3 by people, 2 not in the audit log." text="5 settings changed since your approved setup." tone="soon" />
        <Verdict detail="Next backup in 20 minutes." text="Everything was backed up in the last 24 hours." tone="fine" />
        <Verdict detail="Differences are not good or bad on their own." text="These two backups differ in 4 settings." tone="neutral" />
      </section>
    </>
  );
}

// Sample-row styling for this preview only; tokens are the only colour source.
const KIT_CSS = `
.kit-pickers { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--space-md); margin-bottom: var(--space-lg); }
.kit-pickers > .picker-field { flex: 0 1 16rem; }
.kit-row { display: flex; align-items: center; gap: var(--space-md); min-width: 0; }
.kit-row-name { display: grid; flex: 1; min-width: 0; line-height: 1.3; }
.kit-row-name b { font-weight: 600; }
.kit-row-name small, .kit-who small { color: var(--text-soft); font-size: 0.8125rem; }
.kit-who { display: grid; min-width: 7.5rem; line-height: 1.3; font-size: 0.875rem; text-align: right; }
.kit-frame { display: grid; gap: var(--space-sm); }
.kit-frame > h2 { margin: 0; }
.kit-badges { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-sm); }
.kit-frame .verdict { margin: 0; }
@media (max-width: 40rem) { .kit-row { flex-wrap: wrap; gap: var(--space-2xs) var(--space-sm); } .kit-row-name { flex-basis: 100%; } .kit-who { display: block; min-width: 0; text-align: left; color: var(--text-soft); } .kit-who small::before { content: " · "; } }
`;
