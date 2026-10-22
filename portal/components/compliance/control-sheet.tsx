"use client";

import Link from "next/link";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { FindingRecord } from "@/components/compliance/compliance-record";
import { Icon } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { Person } from "@/components/ui/person";
import {
  EXCEPTION_EFFECT,
  NOT_RUN_YET,
  NOT_SET_UP_HELP,
  RESULTS,
  canGrantOn,
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
import type { ComplianceFinding } from "@/lib/types";

const SEVERITY: Record<string, string> = { high: "High", medium: "Medium", low: "Low", critical: "Critical" };

// One control, opened from its row (`?open=<evaluationId>`): what it checks and why,
// the result, the backup it rests on, its exception and the changes linked to it.
// Grant or renew is the one amber action, on a control that fails or is not set up yet.
export function ControlSheet({ finding, now, canConfigure, grantHref, onClose }: {
  finding: ComplianceFinding;
  now: string;
  canConfigure: boolean;
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

  return (
    <DetailsSheet
      footer={(canGrant || changeCount) ? <>
        {canGrant ? <Link className={result === "failing" || result === "not-set-up" ? "btn btn-primary" : "btn"} href={grantHref}>{grantLabel(finding)}</Link> : null}
        {changeCount ? <Link className="btn" href="/drift">{changeCount === 1 ? "Review the change" : `Review the ${changeCount} changes`}</Link> : null}
        {canGrant ? <p className="bl-help">{EXCEPTION_EFFECT}</p> : null}
      </> : undefined}
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
