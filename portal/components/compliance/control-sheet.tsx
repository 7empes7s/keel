"use client";

import Link from "next/link";
import { useState } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { ChangeComparisonStyles, EveryToggle } from "@/components/change-comparison";
import { FindingRecord } from "@/components/compliance/compliance-record";
import { FixPanel } from "@/components/compliance/fix-panel";
import { Icon } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import {
  EXCEPTION_EFFECT,
  NOT_RUN_YET,
  NOT_SET_UP_HELP,
  RESULTS,
  canFixOn,
  canGrantOn,
  checkSubjectWord,
  CHECK_LINE_LIMIT,
  checksCapped,
  controlChecks,
  controlName,
  controlService,
  controlWhat,
  controlWhy,
  evidenceSentence,
  evidenceSnapshot,
  exceptionChip,
  formatDay,
  grantLabel,
  grantedByName,
  linkedChangeName,
  newestBackup,
  ownerPerson,
  planLinkSentence,
  resultLine,
  resultOf,
  standardName,
} from "@/lib/compliance-view";
import { ago, formatTimestamp } from "@/lib/presentation";
import type { ControlCheck } from "@/lib/compliance-view";
import type { SheetStep } from "@/lib/sheet-step";
import { toast } from "@/lib/toast";
import type { ComplianceFinding } from "@/lib/types";

const SEVERITY: Record<string, string> = { high: "High", medium: "Medium", low: "Low", critical: "Critical" };

// One control, opened from its row (`?open=<evaluationId>`): what it checks and why,
// the result, the backup it rests on, its exception and the changes linked to it.
// Grant or renew is the one amber action, on a control that fails or is not set up
// yet. A control Keel can fix shows "Make it pass" per object first, since fixing
// beats accepting.
export function ControlSheet({ finding, now, canConfigure, canRestore = false, grantHref, onClose, onRemoved, step = null, onStep }: {
  finding: ComplianceFinding;
  // Called once one of the tenant's own checks is removed from this panel.
  onRemoved?: () => void;
  step?: SheetStep | null;
  onStep?: (id: string) => void;
  now: string;
  canConfigure: boolean;
  canRestore?: boolean;
  grantHref: string;
  onClose: () => void;
}) {
  const result = resultOf(finding);
  const words = RESULTS[result];
  const service = controlService(finding);
  const why = controlWhy(finding);
  const chip = exceptionChip(finding, now);
  const owner = ownerPerson(finding);
  const grantedBy = grantedByName(finding);
  const snapshot = evidenceSnapshot(finding);
  const newest = newestBackup(finding);
  const { change } = finding.links;
  const plan = planLinkSentence(finding);
  const canGrant = canGrantOn(finding, canConfigure);
  const changeCount = change.linked.length;
  // Fixing beats accepting: when Keel can fix it, the exception is the second choice.
  const fixable = canFixOn(finding, canRestore);
  // Every setting the control checked, current against expected (none while it could not check).
  const checks = result === "unknown" || result === "not-relevant" ? [] : controlChecks(finding);
  const removable = canConfigure && Boolean(finding.own);
  const [removing, setRemoving] = useState(false);

  async function remove() {
    if (!finding.own || removing) return;
    if (!window.confirm(`Remove the check "${controlName(finding)}"? It stops running; its past results stay in the evidence.`)) return;
    setRemoving(true);
    try {
      const response = await fetch("/api/actions/compliance/own-check/remove", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ checkId: finding.own.id }) });
      if (!response.ok) { toast({ tone: "warning", title: "The check was not removed", detail: response.status === 403 ? "You need the configuration permission." : "Try again in a moment." }); return; }
      toast({ title: "Check removed" });
      onRemoved?.();
    } catch {
      toast({ tone: "warning", title: "The check was not removed", detail: "Keel could not be reached." });
    } finally {
      setRemoving(false);
    }
  }

  return (
    <DetailsSheet
      footer={(canGrant || changeCount || removable) ? <>
        {canGrant ? <Link className={(result === "failing" || result === "not-set-up") && !fixable ? "btn btn-primary" : "btn"} href={grantHref}>{grantLabel(finding)}</Link> : null}
        {changeCount ? <Link className="btn" href="/drift">{changeCount === 1 ? "Review the change" : `Review the ${changeCount} changes`}</Link> : null}
        {removable ? <button aria-busy={removing || undefined} className="btn" disabled={removing} onClick={() => void remove()} type="button"><Icon name="close" />Remove this check</button> : null}
        {canGrant ? <p className="bl-help">{EXCEPTION_EFFECT}</p> : null}
      </> : undefined}
      noun="control"
      onStep={onStep}
      step={step}
      kicker={<span className="cp-sheet-kicker"><Icon name={service.icon} />Control · {service.name}</span>}
      onClose={onClose}
      title={controlName(finding)}
    >
      <div className="cp-sheet">
        <div className="cp-sheet-result">
          <Badge icon={words.icon} tone={words.badge}>{words.label}</Badge>
          <span>{resultLine(finding, now)}</span>
        </div>
        <p>{controlWhat(finding)}</p>
        {why ? <p className="cp-why">{why}</p> : null}

        <FixPanel canRestore={canRestore} finding={finding} key={finding.id} now={now} />

        <dl className="cp-facts">
          <div>
            <dt>Checked</dt>
            <dd>
              <time dateTime={finding.evaluatedAt ?? undefined} title={formatTimestamp(finding.evaluatedAt)}>{ago(finding.evaluatedAt, now)}</time>
              {snapshot && newest ? <>, on the <Link className="cp-inline-link" href={`/restore?snapshot=${encodeURIComponent(snapshot)}`}>backup of {formatTimestamp(newest)}</Link></> : null}
            </dd>
          </div>
          <div><dt>Standard</dt><dd>{standardName(finding)}</dd></div>
          {finding.severity ? <div><dt>How serious</dt><dd>{SEVERITY[finding.severity] ?? finding.severity}</dd></div> : null}
        </dl>
        {!snapshot ? <p className="cp-muted">{evidenceSentence(finding, now)}</p> : null}
        {result === "unknown" ? <p className="cp-muted">{NOT_RUN_YET}</p> : null}
        {result === "not-set-up" ? <p className="cp-callout" data-tone="soon"><Icon name="plus" />{NOT_SET_UP_HELP}</p> : null}

        {checks.length ? <ControlChecks checks={checks} key={finding.id} subject={checkSubjectWord(finding)} /> : null}

        {finding.exception ? (
          <section aria-labelledby="cp-exception-heading" className="cp-block">
            <h3 id="cp-exception-heading">Exception {chip ? <Badge tone={chip.tone}>{chip.label}</Badge> : null}</h3>
            {finding.exception.reason ? <p className="cp-quote">“{finding.exception.reason}”</p> : null}
            <p className="cp-muted">
              {owner ? <>Owner <Person person={owner} /></> : "No named owner"}
              {grantedBy ? <> · granted by {grantedBy}{finding.exception.grantedAt ? ` on ${formatDay(finding.exception.grantedAt)}` : ""}</> : null}
            </p>
          </section>
        ) : null}

        {change.state !== "none" ? (
          <section aria-labelledby="cp-changes-heading" className="cp-block">
            <h3 id="cp-changes-heading">Linked changes</h3>
            {change.linked.length ? (
              <ul className="cp-links">
                {change.linked.map((item) => (
                  <li key={item.id}>
                    <Link className="cp-inline-link" href={`/drift?open=${encodeURIComponent(item.id)}`}>{linkedChangeName(item)}</Link>
                    <small>{ago(item.detectedAt, now)}</small>
                  </li>
                ))}
              </ul>
            ) : null}
            {change.mismatched.length ? (
              <p className="cp-muted">
                {change.mismatched.length === 1 ? "1 more open change to the same kind comes" : `${change.mismatched.length} more open changes to the same kind come`} from a different backup, so {change.mismatched.length === 1 ? "it is" : "they are"} not linked to this result.
              </p>
            ) : null}
          </section>
        ) : null}

        {plan ? (
          <p className="cp-muted">{plan} <Link className="cp-inline-link" href="/approvals">Open approvals</Link></p>
        ) : null}

        <FindingRecord finding={finding} />
      </div>
    </DetailsSheet>
  );
}

// Expected against current for each setting the control checked. Failing rows come first
// and are highlighted; when some fail, the ones that meet the standard wait behind the
// "Show every setting" switch, as on the Changes panel.
function ControlChecks({ checks, subject }: { checks: ControlCheck[]; subject: string }) {
  const failing = checks.filter((check) => !check.ok).length;
  const passing = checks.length - failing;
  const [every, setEvery] = useState(false);
  const shown = failing && !every ? checks.filter((check) => !check.ok) : checks;
  // Only the first lines are kept on a large tenant: never print a count as if it were all.
  const capped = checksCapped(checks);
  return (
    <section aria-labelledby="cp-checks-heading" className="cp-block">
      <h3 id="cp-checks-heading">
        {failing ? "What fails" : "Settings checked"}{" "}
        {failing ? <Badge tone="urgent">{failing === 1 ? "1 setting" : `${failing} settings`}</Badge> : null}{" "}
        {passing ? <Badge tone="fine">{failing ? `${passing}${capped ? " or more" : ""} meet the standard` : passing === 1 ? "Meets the standard" : capped ? "All shown meet the standard" : `All ${passing} meet the standard`}</Badge> : null}
      </h3>
      {failing && passing ? (
        <div className="cp-checks-tools">
          <ChangeComparisonStyles />
          <EveryToggle more={capped} on={every} onChange={setEvery} total={checks.length} />
          {every ? null : <small>Hidden: {passing === 1 ? "1 setting meets" : `${passing} settings meet`} the standard.</small>}
        </div>
      ) : null}
      {capped ? <p className="bl-help">Keel keeps the first {CHECK_LINE_LIMIT} settings it checked, failing ones first.</p> : null}
      <table className="cp-misses">
        <thead><tr><th scope="col">{subject}</th><th scope="col">Setting</th><th scope="col">Now</th><th scope="col">Should be</th></tr></thead>
        <tbody>
          {shown.map((check, index) => (
            <tr data-ok={check.ok ? "true" : "false"} key={`${check.subject}-${check.setting}-${index}`}>
              <th data-label={subject} scope="row">
                <span className="cp-check-subject">
                  <Icon name={check.ok ? "check-circle" : "x-circle"} />
                  <span className="visually-hidden">{check.ok ? "Meets the standard: " : "Fails: "}</span>
                  {check.subject}
                </span>
              </th>
              <td data-label="Setting">{check.setting}</td>
              <td data-label="Now"><span className={check.ok ? "cp-check-now" : "cp-miss-now"}>{check.now}</span></td>
              <td data-label="Should be"><span className={check.ok ? "cp-check-want" : "cp-miss-want"}>{check.shouldBe}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
