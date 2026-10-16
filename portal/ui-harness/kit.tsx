import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { DatePicker } from "@/components/pickers/date-picker";
import { OptionPicker } from "@/components/pickers/option-picker";
import { Segmented } from "@/components/pickers/segmented";
import { PageHeader } from "@/components/page-header";
import { addDays, inRange, rangeFromParam, rangeToParam, type Day } from "@/lib/date-range";
import type { RiskTone } from "@/lib/menu-status";
import { orderGroups, smartOrder } from "@/lib/selection";
import { serviceFor, serviceOrder, SERVICES } from "@/lib/services";
import { toast } from "@/lib/toast";
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

export function KitPage() {
  const view = useViewState();
  const when = rangeFromParam(view.get("when"));
  const service = view.get("service") || null;
  const show = view.get("show", "all");
  const items = SETTINGS.filter((item) => (!service || item.service === service)
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
          detail: (count) => `Puts ${count === 1 ? "it" : "them"} back as in the chosen backup. Nothing changes until someone else approves.`,
          run: (ids) => toast({ title: `Restore of ${ids.length} settings sent for approval`, detail: "Someone other than you has to approve it." }),
        }}
        getId={(item) => item.id}
        groupings={GROUPINGS}
        items={items}
        label="Changed settings"
        matches={(item, query) => `${item.name} ${item.kind} ${item.who}`.toLowerCase().includes(query)}
        more={[{ label: "Accept as approved setup", run: (ids) => toast({ title: `${ids.length} changes accepted` }) }, { label: "Export as a file", run: () => toast({ title: "Export started" }) }]}
        noun={{ one: "setting", many: "settings" }}
        renderRow={(item) => (
          <div className="kit-row">
            <span className="kit-row-name"><b>{item.name}</b><small>{item.kind} · {serviceFor(item.service).name}</small></span>
            <span className="kit-chip" data-tone={item.tone}>{TONE_WORDS[item.tone]}</span>
            <span className="kit-who">{item.who}<small>{ago(item.at)}</small></span>
          </div>
        )}
        rowName={(item) => `${item.name}, ${item.kind}`}
        toneOf={(item) => item.tone}
      />
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
.kit-chip { padding: 0.125rem var(--space-xs); border-radius: var(--radius-pill); font-size: 0.75rem; font-weight: 600; white-space: nowrap; }
.kit-chip[data-tone="urgent"] { background: var(--urgent-bg); color: var(--urgent); }
.kit-chip[data-tone="soon"] { background: var(--check-soon-bg); color: var(--check-soon); }
.kit-chip[data-tone="low"] { background: var(--low-risk-bg); color: var(--low-risk); }
.kit-chip[data-tone="fine"] { background: var(--fine-bg); color: var(--fine); }
@media (max-width: 40rem) { .kit-row { flex-wrap: wrap; gap: var(--space-2xs) var(--space-sm); } .kit-row-name { flex-basis: 100%; } .kit-who { display: block; min-width: 0; text-align: left; color: var(--text-soft); } .kit-who small::before { content: " · "; } }
`;
