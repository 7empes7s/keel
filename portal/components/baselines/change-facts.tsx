import { ATTRIBUTION_HEADLINES, attributionSentence } from "@/components/change-attribution";
import { changedBy, itemKindName } from "@/lib/baselines-view";
import { compareSettings, DIFF_WORDS } from "@/lib/change-comparison";
import { ago, formatTimestamp } from "@/lib/presentation";
import type { DriftRecord } from "@/lib/types";

// The four answers a person needs first about one change: what setting and value
// changed, when, and who made it. Accepting or undoing it sits in the panel's footer.

/** "App permission grants: removed App Contoso · Write access", or "and 2 more". */
export function whatChanged(item: DriftRecord): string {
  const kind = itemKindName(item);
  const read = Boolean(item.serviceRead);
  if (item.changeType === "added") return `${kind} added: ${read ? "it is new since the previous read" : "the approved setup does not have it"}.`;
  if (item.changeType === "removed") return `${kind} removed: ${read ? "the newest read no longer has it" : "the approved setup has it, the tenant no longer does"}.`;
  const comparison = compareSettings(item.before, item.after, item.refNames ?? {}, item.before !== null && item.before !== undefined);
  const behaviour = item.semantic && item.semantic.state === "compared" && item.semantic.rules !== "generic" ? item.semantic.fields.map((field) => field.path) : null;
  const differing = comparison.rows.filter((row) => row.diff !== "same" && (!behaviour || behaviour.some((path) => row.path === path || row.path.startsWith(`${path}.`) || path.startsWith(`${row.path}.`))));
  if (!differing.length) return comparison.differing ? "Only settings Microsoft manages itself changed." : "No setting Keel compares differs.";
  const first = differing[0];
  const cut = (text: string | null) => (text && text.length > 80 ? `${text.slice(0, 77)}…` : text ?? "not set");
  const name = first.section === "General" ? first.label : `${first.section} › ${first.label.toLowerCase()}`;
  const entry = first.entries?.find((candidate) => candidate.diff !== "same");
  const detail = entry
    ? `${DIFF_WORDS[entry.diff].toLowerCase()} ${cut(entry.text)}`
    : first.diff === "changed" ? `${cut(first.before)} → ${cut(first.after)}`
      : first.diff === "added" ? `now ${cut(first.after)}`
        : first.diff === "removed" ? `was ${cut(first.before)}, now not set` : `now ${cut(first.after)}`;
  const moreEntries = Math.max(0, (first.entries?.filter((candidate) => candidate.diff !== "same").length ?? 0) - 1);
  const more = differing.length - 1;
  const tail = [moreEntries ? `${moreEntries} more ${moreEntries === 1 ? "entry" : "entries"}` : "", more ? `${more} more ${more === 1 ? "setting" : "settings"}` : ""].filter(Boolean).join(" and ");
  return `${name}: ${detail}${tail ? `, and ${tail}` : ""}.`;
}

export function ChangeFacts({ item, now }: { item: DriftRecord; now: string }) {
  const madeAt = item.attribution?.verdict === "exact" ? item.attribution.evidence[0]?.occurredAt ?? null : null;
  const when = madeAt ?? item.detectedAt;
  const who = changedBy(item);
  const whoNote = item.serviceRead
    ? "Keel compares two reads of this service and cannot see who made it."
    : item.attribution
      ? who ? ATTRIBUTION_HEADLINES[item.attribution.verdict] : attributionSentence(item.attribution)
      : "Keel has not checked the audit log for this change yet.";
  return (
    <dl aria-label="This change at a glance" className="bl-glance">
      <div className="bl-glance-fact" data-fact="what">
        <dt>What changed</dt>
        <dd>{whatChanged(item)}</dd>
      </div>
      <div className="bl-glance-fact">
        <dt>{madeAt ? "When it was made" : "When Keel found it"}</dt>
        <dd>
          <time dateTime={when}>{formatTimestamp(when)}</time>
          <small>{ago(when, now)}{madeAt ? ", from the audit log" : ". The exact time it was made is not known yet."}</small>
        </dd>
      </div>
      <div className="bl-glance-fact" data-known={who ? "" : undefined}>
        <dt>Who made it</dt>
        <dd>
          {who ?? "Not known yet"}
          <small>{whoNote}</small>
        </dd>
      </div>
    </dl>
  );
}
