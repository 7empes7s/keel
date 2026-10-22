"use client";

import Link from "next/link";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { FindingRecord } from "@/components/compliance/compliance-record";
import { FixPanel } from "@/components/compliance/fix-panel";
import { Icon } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import {
  EXCEPTION_EFFECT,
  NOT_RUN_YET,
  RESULTS,
  canFixOn,
  canGrantOn,
  controlMisses,
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
import type { SheetStep } from "@/lib/sheet-step";
import type { ComplianceFinding } from "@/lib/types";

const SEVERITY: Record<string, string> = { high: "High", medium: "Medium", low: "Low", critical: "Critical" };

// One control, opened from its row (`?open=<evaluationId>`): what it checks and why,
// the result, the backup it rests on, its exception and the changes linked to it.
// Grant or renew is the one amber action, on a failing control only. A control Keel
// can fix shows "Make it pass" per object first, since fixing beats accepting.
export function ControlSheet({ finding, now, canConfigure, canRestore = false, grantHref, onClose, step = null, onStep }: {
  finding: ComplianceFinding;
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
  // What fails, by policy and setting: shown while the control fails (with or without an exception).
  const misses = result === "failing" || result === "excepted" ? controlMisses(finding) : [];

  return (
    <DetailsSheet
      footer={(canGrant || changeCount) ? <>
        {canGrant ? <Link className={result === "failing" && !fixable ? "btn btn-primary" : "btn"} href={grantHref}>{grantLabel(finding)}</Link> : null}
        {changeCount ? <Link className="btn" href="/drift">{changeCount === 1 ? "Review the change" : `Review the ${changeCount} changes`}</Link> : null}
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

        <FixPanel canRestore={canRestore} finding={finding} now={now} />

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

        {misses.length ? (
          <section aria-labelledby="cp-misses-heading" className="cp-block">
            <h3 id="cp-misses-heading">What fails <Badge tone="urgent">{misses.length === 1 ? "1 setting" : `${misses.length} settings`}</Badge></h3>
            <table className="cp-misses">
              <thead><tr><th scope="col">Policy</th><th scope="col">Setting</th><th scope="col">Now</th><th scope="col">Should be</th></tr></thead>
              <tbody>
                {misses.map((miss, index) => (
                  <tr key={`${miss.subject}-${miss.setting}-${index}`}>
                    <th data-label="Policy" scope="row">{miss.subject}</th>
                    <td data-label="Setting">{miss.setting}</td>
                    <td data-label="Now"><span className="cp-miss-now">{miss.now}</span></td>
                    <td data-label="Should be"><span className="cp-miss-want">{miss.shouldBe}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

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
