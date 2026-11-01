"use client";

import { useApprovalWords } from "@/components/approval-mode-context";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { restoreSentNotice } from "@/lib/restore-sent";
import { ActionRequestError, postAction } from "@/lib/action-client";
import { type ListSort } from "@/components/list/list-paging";
import { SelectableList, type Grouping, type ListGroup } from "@/components/list/selectable-list";
import { RecoveryMechanismTable, type RecoveryMechanism } from "@/components/recovery-mechanism";
import { ContentEffectsPanel, type ContentEffect } from "@/components/content-effects";
import { IncidentQualificationSummary, type IncidentRecoveryView } from "@/components/incident-recovery";
import { ObjectSteps, PendingSteps, type ObjectStep, type PendingStep } from "@/components/pending-steps";
import { RestorePoint } from "@/components/restore/restore-point";
import { WorkloadKinds } from "@/components/restore/workload-services";
import { WorkloadRestore } from "@/components/restore/workload-restore";
import { Icon, type IconName } from "@/components/shell/icons";
import { RecordField, RecordGroup, TechnicalDetails, type RecordValue } from "@/components/technical-details";
import { Verdict, type VerdictTone } from "@/components/verdict";
import { toast } from "@/lib/toast";
import { fieldWords, refusalSentence } from "@/lib/changes-view";
import { SettingRows } from "@/components/change-comparison";
import { worstTone, type RiskTone } from "@/lib/menu-status";
import type { RestoreResource } from "@/lib/portal-data";
import type { SnapshotOption } from "@/lib/portal-jobs";
import { resourceTypeLabel } from "@/lib/presentation";
import type { RestoreChange, RestoreChangesData } from "@/lib/restore-changes";
import {
  IMPACT_ABOUT,
  IMPACT_ORDER,
  changeLine,
  changeTone,
  dayWords,
  impactWords,
  restoreService,
  rowImpact,
  itemName,
  nameBook,
  partialWords,
  plainLabel,
  plainType,
  plannedWords,
  plural,
  restoreVerdict,
  shortWhen,
  takenAt,
  whenWords,
  whoWords,
  type NameBook,
} from "@/lib/restore-view";
import { byRisk, byText, byTime } from "@/lib/paging";
import { orderGroups, smartOrder } from "@/lib/selection";
import { madeInSharePoint, SERVICES, serviceFor, serviceOrder } from "@/lib/services";
import { workloadOrder, type RestoreWorkload } from "@/lib/restore-workloads-view";
import { useViewState } from "@/lib/use-view-state";
import { typeService } from "@/lib/baselines-view";
import { itemArea, itemKind, kindOrder, kindParts } from "@/lib/type-groups";
import { ReasonHint } from "@/components/reason-hint";
import { optionalReasonMessage } from "@/lib/written-reason";

const DRY_RUN_POLL_MS = 3000;

interface AdditionReason {
  requiredBy: string;
  field: string;
}

interface Addition {
  naturalKey: string;
  resourceType: string;
  reasons: AdditionReason[];
}

interface UnresolvedReference {
  from: string;
  field: string;
  symbol: string;
}

interface GuardRefusal {
  naturalKey: string;
  reason: string;
}

interface SelectionPreview {
  selected: string[];
  closureKeys: string[];
  added: Addition[];
  unresolvedReferences: UnresolvedReference[];
  guardRefusals: GuardRefusal[];
  missingRequirements: Addition[];
}

interface DryRunResourceResult {
  naturalKey: string;
  reason?: string;
  error?: string;
  // Issue #546: steps a person must do on this object (one step or a list).
  completion?: ObjectStep | ObjectStep[] | null;
}

interface DryRunResults {
  applied: DryRunResourceResult[];
  skipped: DryRunResourceResult[];
  failed: DryRunResourceResult[];
  notRemediable: DryRunResourceResult[];
  // Roadmap task-152: steps the restore cannot finish itself (a policy left report-only).
  pendingSteps?: PendingStep[];
}

// Roadmap task-61: a group member/owner edge change the dry run planned, written
// only through qualified $ref operations. Null on artifacts persisted before edge
// restore existed, or when no restored group had observed edges.
interface RelationshipOperation {
  parentNaturalKey: string;
  family: "member" | "owner";
  action: "add" | "remove";
  targetNaturalKey: string | null;
  targetId: string | null;
}

interface DryRunArtifact {
  id: string;
  status: "completed" | "refused" | "failed";
  closureKeys: string[];
  guardRefusals: GuardRefusal[];
  results: DryRunResults;
  relationshipOperations?: RelationshipOperation[] | null;
  // Roadmap task-64: null on artifacts persisted before mechanisms were recorded.
  recoveryMechanisms?: RecoveryMechanism[] | null;
  // Roadmap task-66: content effects, the digest an approver binds to, and the
  // separate high-impact approvals already recorded for exactly these effects.
  contentEffects?: ContentEffect[] | null;
  effectsDigest?: string | null;
  contentEffectApprovals?: { approvedBy: string; approvedAt: string | null }[];
  // Roadmap task-71: the incident recovery context the dry run was planned under.
  incidentRecovery?: Parameters<typeof IncidentQualificationSummary>[0]["context"] | null;
  incidentRecoveryView?: IncidentRecoveryView | null;
}

const EDGE_RESULT_PREFIX = "edge:";

const DRY_RUN_OUTCOMES: { list: "applied" | "skipped" | "failed" | "notRemediable"; note: string }[] = [
  { list: "applied", note: "would apply" },
  { list: "skipped", note: "refused" },
  { list: "failed", note: "would fail" },
  { list: "notRemediable", note: "needs a person" },
];

/** One resource the closure added, with every resource that requires it and the
 *  field path that points at it. */
function AdditionGroup({ addition, note }: { addition: Addition; note: string }) {
  return (
    <RecordGroup note={note} title={addition.naturalKey}>
      <RecordField label="Stored key" value={addition.naturalKey} />
      <RecordField copy={false} label="Type" value={addition.resourceType} />
      {addition.reasons.map((reason) => (
        <RecordField key={`${reason.requiredBy}#${reason.field}`} label="Required by (stored key)" usage={<>at field <code>{reason.field}</code></>} value={reason.requiredBy} />
      ))}
    </RecordGroup>
  );
}

/** "Block legacy auth (Conditional Access policy)", the resources that need this one. */
function requiredByWords(reasons: AdditionReason[], names: NameBook): string {
  return [...new Set(reasons.map((reason) => plainLabel(reason.requiredBy, names)))].join(", ");
}

/** "Block legacy auth and Require MFA for admins". */
function namesList(keys: string[], book: NameBook): string {
  const names = keys.map((key) => plainLabel(key, book));
  if (names.length > 3) return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

async function previewSelection(
  snapshotId: string,
  selected: string[],
): Promise<SelectionPreview> {
  const response = await fetch("/api/actions/restore/selection", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ snapshotId, selected }),
  });
  if (!response.ok) throw new Error(`preview failed (${response.status})`);
  return (await response.json()) as SelectionPreview;
}

async function fetchJobStatus(jobId: string): Promise<string | null> {
  const response = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
  if (!response.ok) return null;
  const { job } = (await response.json()) as { job: { status: string } };
  return job.status;
}

async function fetchDryRunArtifact(artifactId: string): Promise<DryRunArtifact | null> {
  const response = await fetch(`/api/actions/restore/dry-run/${artifactId}`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`dry-run fetch failed (${response.status})`);
  const { artifact } = (await response.json()) as { artifact: DryRunArtifact };
  return artifact;
}

type RestoreStep = "select" | "dry-run" | "review" | "confirm" | "track";

// Roadmap task-131: the current step's title is the page's verdict sentence. The
// choose step's sentence says what changed instead (lib/restore-view restoreVerdict).
export function restoreStepVerdict(step: Exclude<RestoreStep, "select">, failed: boolean, started = false): { text: string; tone: VerdictTone } {
  switch (step) {
    case "dry-run": return { text: "Step 2 of 4: KEEL is checking what would change. Nothing is written.", tone: "good" };
    case "review": return failed
      ? { text: "Step 3 of 4: the check found problems, so nothing can be put back from it.", tone: "critical" }
      : { text: "Step 3 of 4: review what will change.", tone: "good" };
    case "confirm": return { text: "Step 3 of 4: review what will change, then send it for approval.", tone: "attention" };
    case "track": return started
      ? { text: "Step 4 of 4: approved without an approver, because restore approvals are off for the services it changes.", tone: "good" }
      : { text: "Step 4 of 4: sent to approvers. Nothing changes until one of them approves.", tone: "good" };
  }
}

// Review and send are one screen: the review ends in the send button.
const STEPS: { id: RestoreStep; label: string }[] = [
  { id: "select", label: "Choose" },
  { id: "dry-run", label: "Check" },
  { id: "confirm", label: "Review and send" },
  { id: "track", label: "Approval" },
];

export function RestoreStepper({ current, failed = false }: { current: RestoreStep; failed?: boolean }) {
  const index = STEPS.findIndex((step) => step.id === (current === "review" ? "confirm" : current));
  return (
    <ol aria-label="Restore steps" className="wizard-steps">
      {STEPS.map((step, position) => {
        const state = position < index ? "done" : position === index ? (failed ? "failed" : "current") : "upcoming";
        return (
          <li aria-current={position === index ? "step" : undefined} className={`wizard-step step-${state}`} key={step.id}>
            <span aria-hidden="true" className="wizard-step-marker">{state === "done" ? "✓" : state === "failed" ? "!" : position + 1}</span>
            <span className="wizard-step-label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

// One row of the list: a setting saved in the chosen backup, with what changed since.
interface RestoreItem extends RestoreResource {
  change?: RestoreChange;
  // What the row is called: the backup's name for it, never a bare id.
  label: string;
}

const CHANGED_GROUP = "changed";
const toneOf = (item: RestoreItem) => changeTone(item.change);
// Smart order: deleted, then changed, newest first; the rest by name.
const ordered = (items: RestoreItem[]) => [
  ...smartOrder(items.filter((item) => item.change), toneOf, (item) => item.change?.seenAt ?? null),
  ...items.filter((item) => !item.change).sort((x, y) => x.label.localeCompare(y.label)),
];

function grouped(items: RestoreItem[], keyOf: (item: RestoreItem) => string, meta: (key: string, list: RestoreItem[]) => Omit<ListGroup<RestoreItem>, "items" | "key">, rank?: (key: string) => number): ListGroup<RestoreItem>[] {
  const map = new Map<string, RestoreItem[]>();
  for (const item of items) map.set(keyOf(item), [...(map.get(keyOf(item)) ?? []), item]);
  const groups = [...map.entries()].map(([key, list]) => ({ key, ...meta(key, list), items: ordered(list) }));
  return rank
    ? groups.sort((a, b) => rank(a.key) - rank(b.key))
    : orderGroups(groups, (group) => worstTone(group.items.map((item) => toneOf(item) ?? undefined)));
}

function withKinds(group: ListGroup<RestoreItem>, service: string | null): ListGroup<RestoreItem> {
  const parts = kindParts(group.items, itemKind, service, (x, y) => x.label.localeCompare(y.label));
  return { ...group, items: parts.flatMap((part) => part.items), parts };
}

function serviceGroup(code: string): Omit<ListGroup<RestoreItem>, "items" | "key"> {
  const service = serviceFor(code === "other" ? null : code);
  return { label: service.name, icon: service.icon, about: service.about };
}

// Order by: name, kind of setting, risk, and when it changed.
const SORTS: ListSort<RestoreItem>[] = [
  { key: "name", label: "Name", compare: (a, b) => byText(a.label, b.label) },
  { key: "kind", label: "Setting type", compare: (a, b) => byText(resourceTypeLabel(a.resourceType), resourceTypeLabel(b.resourceType)) || byText(a.label, b.label) },
  { key: "risk", label: "Risk", desc: true, compare: (a, b) => byRisk(toneOf(a), toneOf(b)) },
  { key: "changed", label: "When it changed", desc: true, compare: (a, b) => byTime(a.change?.seenAt, b.change?.seenAt) },
];

// Kinds of setting backed up and put back on their own (mailboxes, Teams policies,
// Purview labels...), shown inside their service in the Service view and as their own
// group in the Type view. The find narrows them by name and service like the rows.
interface OtherKinds {
  workloads: RestoreWorkload[];
  query: string;
  render: (workloads: RestoreWorkload[]) => ReactNode;
}

function kindsMatching(kinds: OtherKinds): RestoreWorkload[] {
  const query = kinds.query.trim().toLowerCase();
  const shown = query
    ? kinds.workloads.filter((workload) => `${workload.name} ${workload.reads.join(" ")} ${serviceFor(workload.service).name}`.toLowerCase().includes(query))
    : kinds.workloads;
  return [...shown].sort((a, b) => serviceOrder(a.service) - serviceOrder(b.service) || workloadOrder(a.workload) - workloadOrder(b.workload));
}

const kindsWords = (count: number) => `${count} ${count === 1 ? "type" : "types"}`;

// Every Microsoft 365 service the portal knows, in its order, so none goes missing:
// "Keel" holds Keel's own records and has nothing to put back.
const RESTORE_SERVICES = SERVICES.filter((service) => service.code !== "Keel");

function groupingsFor(kinds: OtherKinds): Grouping<RestoreItem>[] {
  return [
    {
      key: "service",
      label: "Service",
      // "Changed recently" leads; every other setting sits under its Microsoft service,
      // and each service shows the kinds it backs up on their own after its rows.
      groupsOf: (items) => {
        const changed = items.filter((item) => item.change);
        const rest = items.filter((item) => !item.change);
        const others = kindsMatching(kinds);
        // Inside a service, settings sit under their kind: users, groups, roles, then
        // policies and tenant settings.
        const fromBackup = grouped(rest, (item) => item.service ?? "other", serviceGroup, (code) => serviceOrder(code === "other" ? null : code))
          .map((group) => withKinds(group, group.key === "other" ? null : group.key));
        const byCode = new Map(fromBackup.map((group) => [group.key.toLowerCase(), group]));
        const searching = kinds.query.trim() !== "";
        const services: ListGroup<RestoreItem>[] = [];
        for (const service of RESTORE_SERVICES) {
          const group = byCode.get(service.code.toLowerCase());
          const own = others.filter((workload) => (workload.service ?? "").toLowerCase() === service.code.toLowerCase());
          // While finding, a service with nothing that matches is left out.
          if (!group && !own.length && searching) continue;
          const base = group ?? { key: service.code, ...serviceGroup(service.code), items: [] };
          const rows = base.items.length;
          // Settings of this service that changed are listed under "Changed recently".
          const moved = changed.filter((item) => (item.service ?? "").toLowerCase() === service.code.toLowerCase()).length;
          const none = rows ? undefined : moved ? `${plural(moved, "setting")} changed, listed above` : "Nothing in this backup";
          services.push({
            ...base,
            count: own.length
              ? rows ? `${plural(rows, "setting")} · ${own.length} more ${own.length === 1 ? "type" : "types"}` : kindsWords(own.length)
              : none,
            extra: own.length
              ? kinds.render(own)
              : rows ? undefined : <p className="restore-kinds-none">{moved ? `Every ${service.name} setting in this backup has changed since; they are listed under Changed recently.` : `This backup holds no ${service.name} settings.`}</p>,
          });
        }
        // Anything not placed in a known service still shows, after them.
        const placed = new Set(RESTORE_SERVICES.map((service) => service.code.toLowerCase()));
        services.push(...fromBackup.filter((group) => !placed.has(group.key.toLowerCase())));
        return changed.length
          ? [{ key: CHANGED_GROUP, label: "Changed recently", icon: "clock" as IconName, about: "Different now, newest first", items: ordered(changed) }, ...services]
          : services;
      },
    },
    {
      key: "type",
      label: "Type",
      // Service by service, and inside each the same order as the Service view; the kinds
      // backed up on their own follow, each as its own group.
      groupsOf: (items) => [
        ...grouped(items, itemKind, (type) => ({
          label: plainType(type),
          icon: typeService(type).icon,
          about: `${typeService(type).name}${plainType(type).toLowerCase() !== resourceTypeLabel(type).toLowerCase() ? ` · Microsoft calls it ${resourceTypeLabel(type)}` : ""}`,
        }), (type) => kindOrder(type)),
        ...kindsMatching(kinds).map((workload): ListGroup<RestoreItem> => {
          const service = serviceFor(workload.service);
          return {
            key: `kind:${workload.workload}`,
            label: workload.name,
            icon: service.icon,
            about: `${service.name} · put back on its own`,
            items: [],
            count: workload.backup ? plural(workload.backup.items, "setting") : "Not backed up yet",
            extra: kinds.render([workload]),
          };
        }),
      ],
    },
    {
      key: "impact",
      label: "Impact",
      groupsOf: (items) => grouped(items, (item) => item.blastRadius, (radius) => ({
        label: impactWords(radius),
        icon: (radius === "tenant-lockout" ? "alert" : radius === "cosmetic" ? "check" : "info") as IconName,
        about: IMPACT_ABOUT[radius] ?? "How much a wrong restore could break",
      }), (radius) => (IMPACT_ORDER.indexOf(radius) === -1 ? IMPACT_ORDER.length : IMPACT_ORDER.indexOf(radius))),
    },
  ];
}

const TONE_WORDS: Record<RiskTone, string> = { urgent: "Deleted", soon: "Changed", low: "Low risk", fine: "Fine" };

// Restore (portal-design §4.1, plan task 8; redesign "Restore", handoff/redesign/CHOICE.md).
// The page leads with the point in time and what changed since it, grouped by Microsoft
// service with "Changed recently" on top; each change and each group has an undo. Every
// path still runs the same promotion: the server previews what the choice needs (adding
// what it depends on), a dry run (POST .../restore/dry-run) reads the tenant and persists
// its ACTUAL planned changes, and only THAT completed artifact can be sent for approval
// (POST .../restore, {artifactId}); no field here can request enforce directly. The
// dry-run route strips everything but the validated scope fields, the confirm route
// re-validates the artifact before creating an approval request, and
// cli/keel-restore.mjs re-validates it again, against a fresh read, before it writes.
export function RestoreSelection({
  canRestore,
  canApprove = false,
  resources,
  snapshotId,
  snapshots,
  incident = null,
  changes = null,
  now,
  lastRestore = null,
  workloads = [],
}: {
  canRestore: boolean;
  canApprove?: boolean;
  resources: RestoreResource[];
  snapshotId: string;
  snapshots: SnapshotOption[];
  // Roadmap task-71: plan this restore as a recovery point of an incident.
  incident?: { id: string; title: string } | null;
  // What changed since the chosen backup; null when it could not be read.
  changes?: RestoreChangesData | null;
  now: string;
  // The last restore job, for its tile: words, when, and its page.
  lastRestore?: { label: string; detail: string; href: string; tone: RiskTone } | null;
  // Kinds of setting backed up on their own (Exchange, SharePoint, Teams, Purview, Power
  // Platform); null when they could not be read.
  workloads?: RestoreWorkload[] | null;
}) {
  const router = useRouter();
  const approvalWords = useApprovalWords();
  const query = useViewState().get("q");
  const [openWorkload, setOpenWorkload] = useState<string | null>(null);
  const [preview, setPreview] = useState<SelectionPreview | null>(null);
  const [planning, setPlanning] = useState(false);
  const [justification, setJustification] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sentStarted, setSentStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The dry run in flight: set once .../restore/dry-run enqueues a job, cleared once
  // its artifact is fetched (success) or it fails outright.
  const [dryRunJobId, setDryRunJobId] = useState<string | null>(null);
  const [dryRunArtifactId, setDryRunArtifactId] = useState<string | null>(null);
  const [dryRunStatus, setDryRunStatus] = useState<"running" | "failed" | null>(null);
  const [artifact, setArtifact] = useState<DryRunArtifact | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const changeByKey = useMemo(() => new Map((changes?.changes ?? []).map((change) => [change.naturalKey, change])), [changes]);
  const names = useMemo(() => nameBook(resources), [resources]);
  const items = useMemo<RestoreItem[]>(() => resources.map((resource) => {
    const change = changeByKey.get(resource.naturalKey);
    const label = itemName(resource.naturalKey, names);
    const placed = { ...resource, service: restoreService(resource, label), label };
    return change ? { ...placed, change } : placed;
  }), [resources, changeByKey, names]);
  const groupings = useMemo(() => groupingsFor({
    workloads: workloads ?? [],
    query,
    render: (list) => (
      <>
        <p className="restore-kinds-head">Backed up separately. Each is put back on its own, with the same check and approval.</p>
        <WorkloadKinds canRestore={canRestore} now={now} onStart={setOpenWorkload} open={openWorkload} workloads={list} />
      </>
    ),
  }), [workloads, query, canRestore, now, openWorkload]);
  const workloadOpen = (workloads ?? []).find((workload) => workload.workload === openWorkload) ?? null;

  useEffect(() => () => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
  }, []);

  // After an undo, focus moves to the steps, so keyboard and screen-reader users land
  // where the page changed.
  const flowRef = useRef<HTMLDivElement>(null);

  function resetDryRun() {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setDryRunJobId(null);
    setDryRunArtifactId(null);
    setDryRunStatus(null);
    setArtifact(null);
  }

  function startOver() {
    resetDryRun();
    setPreview(null);
    setMessage(null);
    setError(null);
  }

  function pollDryRun(jobId: string, artifactId: string) {
    pollTimer.current = setTimeout(async () => {
      try {
        const status = await fetchJobStatus(jobId);
        if (status === "failed" || status === "cancelled") {
          setDryRunStatus("failed");
          setError("The check did not finish. Change the selection and try again.");
          return;
        }
        if (status === "succeeded") {
          const found = await fetchDryRunArtifact(artifactId);
          if (found) {
            setArtifact(found);
            setDryRunStatus(null);
            return;
          }
        }
        pollDryRun(jobId, artifactId);
      } catch {
        pollDryRun(jobId, artifactId);
      }
    }, DRY_RUN_POLL_MS);
  }

  // One path for every undo: a row's button, a group's button, or the selection bar.
  // The server first says what the choice depends on; a refusal stops here with the
  // reason, otherwise the dry run starts at once.
  async function plan(selection: string[]) {
    if (!canRestore || selection.length === 0) return;
    setPlanning(true);
    setMessage(null);
    setError(null);
    resetDryRun();
    let nextPreview: SelectionPreview;
    try {
      nextPreview = await previewSelection(snapshotId, selection);
      setPreview(nextPreview);
    } catch {
      setError("KEEL could not work out what this choice depends on. Nothing was started.");
      setPlanning(false);
      return;
    }
    if (nextPreview.guardRefusals.length) {
      setPlanning(false);
      return;
    }
    try {
      const { payload } = await postAction(
        "/api/actions/restore/dry-run",
        {
          snapshotId,
          selection,
          ...(incident ? { incidentId: incident.id } : {}),
        },
        idempotencyKey,
      );
      const job = payload.job as { id: string };
      const artifactId = payload.artifactId as string;
      if (!job || typeof job.id !== "string" || typeof artifactId !== "string") {
        setError("KEEL could not start the check. Try again in a minute.");
        return;
      }
      setIdempotencyKey(crypto.randomUUID());
      setDryRunJobId(job.id);
      setDryRunArtifactId(artifactId);
      setDryRunStatus("running");
      pollDryRun(job.id, artifactId);
    } catch (failure) {
      setError(failure instanceof ActionRequestError && failure.plain
        ? failure.plain
        : "KEEL could not start the check. Try again in a minute.");
    } finally {
      setPlanning(false);
    }
  }

  async function confirm() {
    if (!dryRunArtifactId || !artifact || artifact.status !== "completed") return;

    setSubmitting(true);
    setMessage(null);
    setError(null);
    try {
      const { payload } = await postAction(
        "/api/actions/restore",
        {
          artifactId: dryRunArtifactId,
          ...(justification.trim() ? { justification: justification.trim() } : {}),
        },
        idempotencyKey,
      );
      if (payload.approvalRequest) {
        const notice = restoreSentNotice(payload.approvalRequest);
        setMessage(`${notice.title}. ${notice.detail}`);
        setSentStarted(notice.started);
        setIdempotencyKey(crypto.randomUUID());
        resetDryRun();
        toast({ tone: notice.started ? "success" : "info", title: notice.title, detail: notice.detail, href: notice.href, hrefLabel: notice.hrefLabel });
        router.refresh();
      } else {
        setError("KEEL could not send the restore for approval. Try again in a minute.");
      }
    } catch {
      setError("KEEL could not send the restore for approval. Try again in a minute.");
    } finally {
      setSubmitting(false);
    }
  }

  // The step is derived from the existing promotion state, never stored on its own,
  // so it cannot disagree with what the server has actually been asked to do.
  const refused = !artifact && dryRunStatus !== "running" && preview !== null && preview.guardRefusals.length > 0;
  const step: RestoreStep = message
    ? "track"
    : artifact
      ? (artifact.status === "completed" ? "confirm" : "review")
      : dryRunStatus === "running" || planning
        ? "dry-run"
        : "select";
  const choosing = step === "select" && !refused;
  const currentSnapshot = snapshots.find((snapshot) => snapshot.id === snapshotId) ?? null;
  const isNewest = snapshots[0]?.id === snapshotId;
  const reviewFailed = artifact !== null && artifact.status !== "completed";
  const verdict: { text: string; tone: VerdictTone; detail?: string } = step === "select"
    ? restoreVerdict({ chosen: currentSnapshot ? takenAt(currentSnapshot) : null, isNewest, changes, partial: currentSnapshot ? partialWords(currentSnapshot) : null })
    : restoreStepVerdict(step, reviewFailed, sentStarted);
  const objectResults = (entries: DryRunResourceResult[]) => entries.filter((entry) => !entry.naturalKey.startsWith(EDGE_RESULT_PREFIX));
  const changedCount = (changes?.changes ?? []).filter((change) => change.kind === "changed").length;
  const deletedCount = (changes?.changes ?? []).filter((change) => change.kind === "deleted").length;
  useEffect(() => {
    if (!choosing) flowRef.current?.focus({ preventScroll: true });
  }, [choosing]);
  const pickSnapshot = (id: string, day?: string) => router.push(`/restore?snapshot=${id}${incident ? `&incident=${incident.id}` : ""}${day ? `&day=${day}` : ""}`);

  function undoButton(keys: string[], label: string, name: string, primary = false) {
    return (
      <button
        aria-label={`${label}: ${name}`}
        className={`btn btn-sm restore-undo${primary ? " btn-primary" : ""}`}
        disabled={!canRestore || planning || submitting}
        onClick={() => void plan(keys)}
        title={canRestore ? `Checks what would change first. ${approvalWords.untilApproved}` : "You can look, but restoring needs the restore role."}
        type="button"
      >
        <Icon name="restore" />
        {label}
      </button>
    );
  }

  return (
    <section aria-label="Plan a restore" className="restore-page">
      <Verdict detail={verdict.detail} text={verdict.text} tone={verdict.tone} />

      {incident ? (
        <p className="incident-restore-banner" role="note">
          Restoring for the incident <strong>{incident.title}</strong>. KEEL refuses unless an investigator cleared this
          backup or approved an override, and checks afterwards that the harmful settings are gone.
        </p>
      ) : null}

      {currentSnapshot ? (
        <RestorePoint chosen={currentSnapshot} disabled={!choosing} now={now} onPick={pickSnapshot} snapshots={snapshots} />
      ) : null}

      {choosing ? (
        <>
          <dl className="restore-tiles">
            <div className="restore-tile" data-tone={changedCount ? "soon" : "fine"}>
              <dt><Icon name="clock" />Changed since</dt>
              <dd>{changes ? changedCount + (changes.more ?? 0) : "?"}</dd>
              <dd className="restore-tile-about">{changes ? "Settings that are different now. Undo puts them back." : "KEEL could not compare this backup with now."}</dd>
            </div>
            <div className="restore-tile" data-tone={deletedCount ? "urgent" : "fine"}>
              <dt><Icon name="alert" />Deleted since</dt>
              <dd>{changes ? deletedCount : "?"}</dd>
              <dd className="restore-tile-about">In this backup but gone now. Undo brings them back.</dd>
            </div>
            <div className="restore-tile">
              <dt><Icon name="backup" />In this backup</dt>
              <dd>{resources.length.toLocaleString("en-GB")}</dd>
              <dd className="restore-tile-about">Settings you can put back from this point.</dd>
            </div>
            <div className="restore-tile" data-tone={lastRestore?.tone ?? undefined}>
              <dt><Icon name="restore" />Last restore</dt>
              <dd>{lastRestore ? <Link className="restore-tile-link" href={lastRestore.href}>{lastRestore.label}<Icon name="chevron" /></Link> : "None yet"}</dd>
              <dd className="restore-tile-about">{lastRestore ? lastRestore.detail : "No restore has run here yet."}</dd>
            </div>
          </dl>

          {isNewest && changes?.earlier?.count ? (
            <div className="restore-earlier" role="note">
              <Icon name="info" />
              <p>
                {plural(changes.earlier.count, "setting")} changed between the backups of {shortWhen(changes.earlier.takenAt)} and {shortWhen(currentSnapshot ? takenAt(currentSnapshot) : null)}.
                {" "}This backup already has those changes, so undoing them starts from the one before.
              </p>
              <Link className="btn btn-sm" href={`/restore?snapshot=${changes.earlier.id}${incident ? `&incident=${incident.id}` : ""}`}>
                See {changes.earlier.count === 1 ? "it" : "them"} from {dayWords(changes.earlier.takenAt)}
              </Link>
            </div>
          ) : null}

          {workloads === null ? (
            <p className="action-error">KEEL could not read the backups of Exchange, SharePoint, Teams, Purview and Power Platform. Reload in a minute.</p>
          ) : null}
          {items.length || workloads?.length ? (
            <div className="restore-list" id="restore-list">
              <SelectableList
                action={{
                  label: (count) => `Put back ${plural(count, "setting")}`,
                  detail: () => `KEEL checks what would change first. ${approvalWords.untilApproved}`,
                  run: (ids) => void plan(ids),
                }}
                getId={(item) => item.naturalKey}
                groupAction={(group) => {
                  const keys = group.items.filter((item) => item.change).map((item) => item.naturalKey);
                  if (!keys.length) return null;
                  // The one amber action on the page: undo everything that changed.
                  return undoButton(keys, keys.length === 1 ? "Undo 1 change" : `Undo all ${keys.length}`, group.label, group.key === CHANGED_GROUP);
                }}
                groupings={groupings}
                items={items}
                label={`Settings in the backup of ${dayWords(currentSnapshot ? takenAt(currentSnapshot) : null)}`}
                matches={(item, query) => `${item.label} ${plainType(item.resourceType)} ${resourceTypeLabel(item.resourceType)} ${serviceFor(item.service).name}`.toLowerCase().includes(query)}
                noun={{ one: "setting", many: "settings" }}
                renderRow={(item) => <RestoreRow compared={changes !== null} item={item} undo={item.change ? undoButton([item.naturalKey], item.change.kind === "deleted" ? "Bring back" : "Undo change", item.label) : null} />}
                sorts={SORTS}
                rowName={(item) => plainLabel(item.naturalKey, names)}
                toneOf={toneOf}
              />
            </div>
          ) : (
            <p className="empty-state">This backup has nothing KEEL can put back.</p>
          )}
          {workloadOpen ? (
            <WorkloadRestore
              canApprove={canApprove}
              canRestore={canRestore}
              key={workloadOpen.workload}
              name={workloadOpen.name}
              now={now}
              onClose={() => setOpenWorkload(null)}
              workload={workloadOpen.workload}
            />
          ) : null}
          {!canRestore ? <p className="restore-readonly">You can look at backups, but putting settings back needs the restore role.</p> : null}
        </>
      ) : (
        <div aria-label="Restore steps in progress" className="restore-flow" data-layer="explanation" ref={flowRef} role="region" tabIndex={-1}>
          <RestoreStepper current={step} failed={reviewFailed || refused} />
          {step !== "track" ? (
            <div className="wizard-summary">
              <div>
                <p className="section-kicker">What you chose</p>
                <p>
                  {preview ? namesList(preview.selected, names) : "Your selection"}
                  {preview && preview.added.length ? `, and ${plural(preview.added.length, "setting")} it needs` : null}
                  {currentSnapshot ? `, as in the backup of ${dayWords(takenAt(currentSnapshot))}` : null}
                </p>
              </div>
              <button
                className="btn btn-sm"
                disabled={submitting || dryRunStatus === "running" || planning}
                onClick={() => startOver()}
                type="button"
              >
                Change selection
              </button>
            </div>
          ) : null}

          {refused && preview ? (
            <section aria-labelledby="restore-refused-heading" className="wizard-panel review-refused">
              <h3 id="restore-refused-heading">KEEL cannot put this back</h3>
              <div className="data-error" role="alert">
                <ul>
                  {preview.guardRefusals.map((guardRefusal) => (
                    <li key={guardRefusal.naturalKey}>{refusalSentence(guardRefusal, plainLabel(guardRefusal.naturalKey, names))}</li>
                  ))}
                </ul>
                <p>Leave these out of your selection and try again.</p>
              </div>
              <TechnicalDetails>
                <RecordField label="Backup ID" value={snapshotId} />
                <RecordField label="Selected keys" value={preview.selected} />
                {preview.guardRefusals.map((guardRefusal) => (
                  <RecordGroup key={guardRefusal.naturalKey} note="safety check" title={guardRefusal.naturalKey}>
                    <RecordField label="Stored key" value={guardRefusal.naturalKey} />
                    <RecordField copy={false} label="Reason" value={guardRefusal.reason} />
                  </RecordGroup>
                ))}
              </TechnicalDetails>
            </section>
          ) : null}

          {preview && !refused && preview.added.length ? (
            <section aria-labelledby="restore-closure-heading" className="wizard-panel wizard-closure">
              <h3 id="restore-closure-heading">Also put back, because your choice needs {preview.added.length === 1 ? "it" : "them"}</h3>
              <ul className="closure-list">
                {preview.added.map((addition) => (
                  <li key={addition.naturalKey}>
                    <strong>{plainLabel(addition.naturalKey, names)}</strong>
                    {", because "}
                    {requiredByWords(addition.reasons, names)} {addition.reasons.length === 1 ? "depends" : "depend"} on it
                  </li>
                ))}
              </ul>
              {preview.unresolvedReferences.length ? (
                <div className="data-error" role="alert">
                  <p className="severity-label">Missing from this backup</p>
                  <ul>
                    {/* One line per item, however many of its settings point outside the backup. */}
                    {[...new Set(preview.unresolvedReferences.map((reference) => reference.from))].map((from) => {
                      const count = preview.unresolvedReferences.filter((reference) => reference.from === from).length;
                      return (
                        <li key={from}>
                          {plainLabel(from, names)} refers to {count === 1 ? "something" : `${count} things`} this backup does not hold; the restore
                          fails unless {count === 1 ? "it already exists" : "they already exist"} in the tenant.
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
              <TechnicalDetails>
                <RecordField label="Backup ID" value={snapshotId} />
                <RecordField label="Selected keys" value={preview.selected} />
                <RecordField label="Closure keys" usage="everything the restore writes: the selection plus what it needs" value={preview.closureKeys} />
                {preview.added.map((addition) => <AdditionGroup addition={addition} key={`added:${addition.naturalKey}`} note="added because it is needed" />)}
                {preview.unresolvedReferences.map((reference) => (
                  <RecordGroup key={`${reference.from}:${reference.field}`} note="unresolved reference" title={reference.from}>
                    <RecordField label="From (stored key)" value={reference.from} />
                    <RecordField copy={false} label="Field path" value={reference.field} />
                    <RecordField label="Refers to" value={reference.symbol} />
                  </RecordGroup>
                ))}
              </TechnicalDetails>
            </section>
          ) : null}

      {step === "track" ? (
        <section aria-labelledby="restore-track-heading" className="wizard-panel wizard-track">
          <h3 id="restore-track-heading">{sentStarted ? "Approved: restore approvals are off" : "Sent to approvers"}</h3>
          <p aria-live="polite">{message}</p>
          <ol className="track-timeline">
            <li className="track-done">Check finished</li>
            {sentStarted ? (
              <li className="track-done">No approver needed: restore approvals are off for the services it changes</li>
            ) : (
              <>
                <li className="track-done">Approval requested</li>
                <li className="track-current">{approvalWords.reviewStep}</li>
              </>
            )}
            <li className={sentStarted ? "track-current" : undefined}>KEEL checks the tenant again, then restores; the job appears below</li>
          </ol>
          <div className="form-actions">
            <a className="btn btn-secondary" href="#restore-jobs-heading">View restore jobs</a>
            <button
              className="btn btn-ghost"
              disabled={submitting || planning}
              onClick={() => startOver()}
              type="button"
            >
              Put back something else
            </button>
          </div>
        </section>
      ) : null}

          {step === "dry-run" ? (
            <section aria-live="polite" className="wizard-panel wizard-running">
              <h3>Checking what would change</h3>
              <div aria-hidden="true" className="progress-indeterminate"><span /></div>
              <p>This only reads your tenant; nothing is written. It usually takes under a minute.</p>
              {dryRunJobId ? (
                <TechnicalDetails>
                  <RecordField label="Job ID" value={dryRunJobId} usage={<code>GET /api/jobs/{dryRunJobId}</code>} />
                  {dryRunArtifactId ? <RecordField label="Dry run ID" value={dryRunArtifactId} usage={<code>GET /api/actions/restore/dry-run/{dryRunArtifactId}</code>} /> : null}
                  <RecordField copy={false} label="Polling interval (s)" value={DRY_RUN_POLL_MS / 1000} />
                </TechnicalDetails>
              ) : null}
            </section>
          ) : null}

      {artifact ? (
        <section aria-labelledby="restore-dry-run-heading" className={`wizard-panel wizard-review review-${artifact.status}`}>
          <div>
            <h3 id="restore-dry-run-heading">
              {artifact.status === "completed"
                ? "Ready to send for approval"
                : artifact.status === "refused"
                  ? "KEEL refused this plan; nothing can be put back from it"
                  : "The check failed; nothing can be put back from it"}
            </h3>
          </div>

          <dl className="stat-strip review-stats">
            <div><dt>Will be put back</dt><dd>{objectResults(artifact.results.applied).length}</dd></div>
            <div className={artifact.results.skipped.length ? "stat-warn" : undefined}><dt>Refused</dt><dd>{artifact.results.skipped.length}</dd></div>
            <div className={artifact.results.failed.length ? "stat-bad" : undefined}><dt>Would fail</dt><dd>{artifact.results.failed.length}</dd></div>
            <div className={artifact.results.notRemediable.length ? "stat-warn" : undefined}><dt>Needs doing by hand</dt><dd>{artifact.results.notRemediable.length}</dd></div>
          </dl>

          <ObjectSteps entries={objectResults(artifact.results.applied)} label={(key) => plainLabel(key, names)} />

          <BeforeAfter changes={changeByKey} names={names} keys={objectResults(artifact.results.applied).map((entry) => entry.naturalKey)} />

          {artifact.incidentRecovery ? <IncidentQualificationSummary context={artifact.incidentRecovery} view={artifact.incidentRecoveryView ?? null} /> : null}

          {/* Content effects gate the restore, so they lead the review. */}
          {artifact.contentEffects?.length && dryRunArtifactId ? (
            <ContentEffectsPanel
              approvals={artifact.contentEffectApprovals ?? []}
              artifactId={dryRunArtifactId}
              canApprove={canApprove}
              effects={artifact.contentEffects}
              effectsDigest={artifact.effectsDigest ?? null}
              onApproved={() => {
                void fetchDryRunArtifact(dryRunArtifactId).then((found) => { if (found) setArtifact(found); });
              }}
            />
          ) : null}

          {objectResults(artifact.results.applied).length ? (
            <div>
              <p className="severity-label">What will change</p>
              <ul className="closure-list">
                {objectResults(artifact.results.applied).map((entry) => (
                  <li key={entry.naturalKey}>
                    <strong>{plainLabel(entry.naturalKey, names)}</strong>
                    {`: ${plannedWords(entry.reason)}`}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <PendingSteps steps={artifact.results.pendingSteps} />

          {artifact.recoveryMechanisms?.length ? (
            <RecoveryMechanismTable mechanisms={artifact.recoveryMechanisms} names={names} />
          ) : null}

          {artifact.relationshipOperations?.length ? (
            <div>
              <p className="severity-label">Membership changes: people added to and removed from groups</p>
              <ul className="closure-list edge-list">
                {artifact.relationshipOperations.map((operation) => (
                  <li
                    className={`edge-op edge-${operation.action}`}
                    key={`${operation.parentNaturalKey}|${operation.family}|${operation.action}|${operation.targetNaturalKey ?? operation.targetId}`}
                  >
                    <span className="edge-action">{operation.action === "add" ? "+ Add" : "− Remove"}</span>
                    {" "}
                    <strong>{operation.targetNaturalKey ? plainLabel(operation.targetNaturalKey, names) : "a setting this restore creates"}</strong>
                    {` as ${operation.family} of `}
                    <strong>{plainLabel(operation.parentNaturalKey, names)}</strong>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {artifact.guardRefusals.length ? (
            <div className="data-error" role="alert">
              <p className="severity-label">Cannot restore</p>
              <ul>
                {artifact.guardRefusals.map((guardRefusal) => (
                  <li key={guardRefusal.naturalKey}>{refusalSentence(guardRefusal, plainLabel(guardRefusal.naturalKey, names))}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {artifact.results.failed.length ? (
            <div className="data-error" role="alert">
              <p className="severity-label">Would fail</p>
              <ul>
                {artifact.results.failed.map((entry) => (
                  <li key={entry.naturalKey}>
                    <strong>{plainLabel(entry.naturalKey, names)}</strong> would fail; the error is in Technical details.
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <TechnicalDetails>
            <RecordField label="Dry run ID" value={artifact.id} usage={<code>GET /api/actions/restore/dry-run/{artifact.id}</code>} />
            {dryRunJobId ? <RecordField label="Dry run job ID" value={dryRunJobId} usage={<code>GET /api/jobs/{dryRunJobId}</code>} /> : null}
            <RecordField copy={false} label="Status" value={artifact.status} />
            <RecordField label="Closure keys" value={artifact.closureKeys} />
            <RecordField label="Effects digest" usage="approvers bind to this exact set of content effects" value={artifact.effectsDigest} />
            {DRY_RUN_OUTCOMES.flatMap(({ list, note }) => artifact.results[list].map((entry) => (
              <RecordGroup key={`${list}:${entry.naturalKey}`} note={note} title={entry.naturalKey}>
                <RecordField label="Stored key" value={entry.naturalKey} />
                <RecordField copy={false} label="Outcome" value={list} />
                {entry.reason ? <RecordField copy={false} label="Reason" value={entry.reason} /> : null}
                {entry.error ? <RecordField label="Error" value={entry.error} /> : null}
              </RecordGroup>
            )))}
            {artifact.guardRefusals.map((guardRefusal) => (
              <RecordGroup key={`guard:${guardRefusal.naturalKey}`} note="safety check refused it" title={guardRefusal.naturalKey}>
                <RecordField label="Stored key" value={guardRefusal.naturalKey} />
                <RecordField copy={false} label="Reason" value={guardRefusal.reason} />
              </RecordGroup>
            ))}
            {(artifact.relationshipOperations ?? []).map((operation) => (
              <RecordGroup key={`edge:${operation.parentNaturalKey}|${operation.family}|${operation.action}|${operation.targetNaturalKey ?? operation.targetId}`} note={`${operation.family} ${operation.action}`} title={operation.parentNaturalKey}>
                <RecordField label="Group (stored key)" value={operation.parentNaturalKey} />
                <RecordField copy={false} label="Relationship" value={operation.family} />
                <RecordField copy={false} label="Action" value={operation.action} />
                <RecordField label="Target (stored key)" value={operation.targetNaturalKey} />
                <RecordField label="Target object ID" value={operation.targetId} />
              </RecordGroup>
            ))}
            {artifact.results.pendingSteps?.length ? <RecordField label="Steps left for a person" value={artifact.results.pendingSteps as unknown as RecordValue} /> : null}
            {artifact.recoveryMechanisms?.length ? <RecordField label="Recovery mechanisms" value={artifact.recoveryMechanisms as unknown as RecordValue} /> : null}
            {artifact.contentEffects?.length ? <RecordField label="Content effects" value={artifact.contentEffects as unknown as RecordValue} /> : null}
            {artifact.contentEffectApprovals?.length ? <RecordField label="Content effect approvals" value={artifact.contentEffectApprovals} /> : null}
          </TechnicalDetails>

          {artifact.status === "completed" ? (
            <div className="wizard-confirm">
              <div className="filter-bar">
                <label className="filter-field">
                  <span>Why (optional, approvers see it)</span>
                  <input
                    disabled={submitting}
                    onChange={(event) => setJustification(event.target.value)}
                    placeholder="Why is this restore appropriate?"
                    value={justification}
                  />
                  <ReasonHint value={justification} />
                </label>
              </div>
              <div className="drift-action-buttons">
                <button
                  aria-busy={submitting || undefined}
                  className="primary-action"
                  disabled={!canRestore || submitting || optionalReasonMessage(justification) !== null}
                  onClick={() => void confirm()}
                  type="button"
                >
                  Send for approval
                </button>
                <button
                  className="secondary-action"
                  disabled={submitting}
                  onClick={() => startOver()}
                  type="button"
                >
                  Discard
                </button>
              </div>
              <p className="selection-scope">
                This goes to approvers next. {approvalWords.planApprover} approves exactly this plan, and KEEL
                checks the tenant again before it writes.
              </p>
            </div>
          ) : (
            <div className="drift-action-buttons">
              <button
                className="btn"
                disabled={submitting}
                onClick={() => startOver()}
                type="button"
              >
                Start again
              </button>
            </div>
          )}
        </section>
      ) : null}

        </div>
      )}

      {error ? <p className="action-error" role="alert">{error}</p> : null}
    </section>
  );
}

/** A row: the setting's name and type, and either what changed since the backup (with
 * who and when, and its undo) or how much a wrong restore of it could break. */
function RestoreRow({ item, undo, compared }: { item: RestoreItem; undo: ReactNode; compared: boolean }) {
  const service = serviceFor(item.service);
  const change = item.change;
  const tone = changeTone(change);
  const impact = rowImpact(item.blastRadius, compared);
  const area = itemArea(item);
  const madeBy = madeInSharePoint(item.resourceType, item.name, item.label) ? "made in SharePoint admin center"
    : area ? "set in Intune endpoint security" : service.name;
  return (
    <div className="restore-row" data-changed={change ? change.kind : undefined}>
      <span className="restore-row-name">
        <b>{item.label}</b>
        <small title={`Microsoft calls it ${resourceTypeLabel(item.resourceType)}`}>{area ? `${area} policy` : plainType(item.resourceType)} · {madeBy}</small>
      </span>
      {change ? (
        <span className="restore-row-change">
          <span>{tone ? <span className="restore-chip" data-tone={tone}>{TONE_WORDS[tone]}</span> : null}{changeLine(change)}</span>
          <small title={`Changed ${whenWords(change)} UTC`}>{whoWords(change)} · {whenWords(change)}</small>
        </span>
      ) : impact ? (
        <span className="restore-row-impact" data-impact={impact} title="How much a wrong restore of it could break">
          <Icon name={impact === "tenant-lockout" ? "alert" : impact === "cosmetic" ? "page" : "info"} />
          {impactWords(impact)}
        </span>
      ) : <span />}
      <span className="restore-row-action">
        {undo ?? (compared ? <span className="restore-row-same"><Icon name="check" />Same now</span> : null)}
      </span>
    </div>
  );
}

/** Before and after for the settings a restore changes back, when KEEL knows them. */
function BeforeAfter({ keys, changes, names }: { keys: string[]; changes: Map<string, RestoreChange>; names: NameBook }) {
  const known = keys.map((key) => changes.get(key)).filter((change): change is RestoreChange => Boolean(change));
  if (!known.length) return null;
  return (
    <div className="restore-before-after">
      <p className="severity-label">Before and after</p>
      <ul>
        {known.map((change) => (
          <li key={change.naturalKey}>
            <strong>{plainLabel(change.naturalKey, names)}</strong>
            {change.kind === "deleted" ? (
              <p className="restore-ba-line"><span>Now: gone</span><Icon name="chevron" /><span>After: recreated as in the backup</span></p>
            ) : (
              <div className="restore-ba-table">
                <SettingRows
                  label={`${plainLabel(change.naturalKey, names)}: settings`}
                  rows={change.fields.map((field) => ({ path: field.path, section: "General", label: fieldWords(field.path), diff: "changed", before: field.after, after: field.before, entries: null }))}
                  sides={{ before: "Now", after: "After the restore" }}
                />
              </div>
            )}
            {change.fieldCount > change.fields.length ? <p className="restore-ba-more">{plural(change.fieldCount - change.fields.length, "more setting")} also go back.</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
