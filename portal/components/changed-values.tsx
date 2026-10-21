import { Icon, type IconName } from "@/components/shell/icons";
import { fieldWords } from "@/lib/changes-view";
import { CHANGE_LABELS, changeLine, valueLines, valueText, type ChangeKind, type ChangedField, type ChangedObject } from "@/lib/changed-values";
import { resourceTypeLabel } from "@/lib/presentation";

// The setting that changed and its value before and after, on Activity and Compare.
// A value that holds several settings (an object, a list of objects) reads as one
// line per setting inside it, so nothing hides behind "3 settings (see Technical details)".
const CSS = `
.cv-list { display: grid; gap: var(--space-xs); margin: 0; padding: 0; list-style: none; }
.cv-row { display: grid; gap: var(--space-xs) var(--space-sm); align-items: start; grid-template-columns: minmax(8rem, 0.8fr) minmax(0, 1.2fr) auto minmax(0, 1.2fr); padding: var(--space-xs) 0; border-top: 1px solid var(--line); }
.cv-row:first-child { border-top: 0; }
.cv-name { font-weight: 600; font-size: 0.875rem; overflow-wrap: anywhere; padding-top: var(--space-2xs); }
.cv-side { display: grid; gap: var(--space-2xs); min-width: 0; padding: var(--space-2xs) var(--space-sm); border-radius: var(--radius-md); background: var(--surface-muted); overflow-wrap: anywhere; font-size: 0.8125rem; }
.cv-side[data-side="before"] { box-shadow: inset 3px 0 0 var(--neutral); }
.cv-side[data-side="after"] { box-shadow: inset 3px 0 0 var(--text-soft); }
.cv-side[data-empty] { color: var(--text-soft); }
.cv-side > small { color: var(--text-soft); font-size: 0.6875rem; font-weight: 600; letter-spacing: 0.02em; }
.cv-value { font-family: var(--font-mono); }
.cv-lines { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; font-family: var(--font-mono); }
.cv-lines b { font-family: var(--font-sans); font-weight: 600; color: var(--text-soft); }
.cv-arrow { width: 1rem; height: 1rem; margin-top: var(--space-xs); color: var(--text-muted); }
.cv-more { margin: 0; color: var(--text-soft); font-size: 0.8125rem; }
.cv-objects { display: grid; gap: var(--space-sm); margin: 0; padding: 0; list-style: none; }
.cv-object { display: grid; gap: var(--space-xs); padding: var(--space-sm); border: 1px solid var(--line); border-radius: var(--radius-md); background: var(--surface); min-width: 0; }
.cv-object-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-sm); }
.cv-object-name { font-weight: 650; overflow-wrap: anywhere; }
.cv-object-kind { color: var(--text-soft); font-size: 0.8125rem; }
.cv-chip { display: inline-flex; align-items: center; gap: var(--space-2xs); padding: 1px var(--space-xs); border: 1px solid var(--line-strong); border-radius: 999px; color: var(--text); font-size: 0.75rem; font-weight: 600; }
.cv-chip svg { width: 0.875rem; height: 0.875rem; }
.cv-object-line { margin: 0; color: var(--text-soft); font-size: 0.8125rem; }
@media (max-width: 640px) {
  .cv-row { grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); }
  .cv-name { grid-column: 1 / -1; padding-top: 0; }
}
`;

export function ChangedValuesStyles() {
  return <style href="keel-changed-values" precedence="default">{CSS}</style>;
}

const CHANGE_ICONS: Record<ChangeKind, IconName> = { changed: "swap", added: "plus", removed: "close" };

export function ChangeChip({ change }: { change: ChangeKind }) {
  return <span className="cv-chip" data-change={change}><Icon name={CHANGE_ICONS[change]} />{CHANGE_LABELS[change]}</span>;
}

/** A value as a person reads it: one line, or one line per setting inside it. */
export function Value({ value, names }: { value: unknown; names?: Readonly<Record<string, string>> }) {
  const { lines, more } = valueLines(value, names);
  if (lines.length === 1 && !lines[0].label && !more) return <span className="cv-value">{lines[0].text}</span>;
  return (
    <ul className="cv-lines">
      {lines.map((line, index) => <li key={index}>{line.label ? <><b>{line.label}:</b> </> : null}{line.text}</li>)}
      {more ? <li><b>And {more} more</b></li> : null}
    </ul>
  );
}

/** Each setting that differs, with its value on both sides. */
export function ChangedFieldList({ fields, total, sides, names, change = "changed", label }: {
  fields: ChangedField[];
  total?: number;
  sides: { before: string; after: string };
  names?: Readonly<Record<string, string>>;
  change?: ChangeKind;
  label?: string;
}) {
  if (!fields.length) {
    return <p className="cv-more">{change === "changed" ? "Only settings Microsoft sets itself differ." : "It holds no settings Keel lists."}</p>;
  }
  const absent = change === "added" ? "before" : change === "removed" ? "after" : null;
  return (
    <>
      <ul aria-label={label} className="cv-list">
        {fields.map((field) => (
          <li aria-label={`${fieldWords(field.path)}: ${absent === "before" ? "not there" : valueText(field.before, names)} to ${absent === "after" ? "not there" : valueText(field.after, names)}`} className="cv-row" key={field.path}>
            <span className="cv-name">{fieldWords(field.path)}</span>
            <span className="cv-side" data-empty={absent === "before" || undefined} data-side="before"><small>{sides.before}</small>{absent === "before" ? "Not there" : <Value names={names} value={field.before} />}</span>
            <Icon className="cv-arrow" name="chevron" />
            <span className="cv-side" data-empty={absent === "after" || undefined} data-side="after"><small>{sides.after}</small>{absent === "after" ? "Not there" : <Value names={names} value={field.after} />}</span>
          </li>
        ))}
      </ul>
      {total && total > fields.length ? <p className="cv-more">And {total - fields.length} more {total - fields.length === 1 ? "setting" : "settings"}.</p> : null}
    </>
  );
}

/** Objects that changed, each with its settings before and after. */
export function ChangedObjects({ changes, sides, names }: { changes: ChangedObject[]; sides: { before: string; after: string }; names?: Readonly<Record<string, string>> }) {
  return (
    <ul className="cv-objects">
      {changes.map((change, index) => (
        <li className="cv-object" key={`${change.resourceType}-${change.name}-${index}`}>
          <div className="cv-object-head">
            <span className="cv-object-name">{change.name}</span>
            <span className="cv-object-kind">{resourceTypeLabel(change.resourceType)}</span>
            <ChangeChip change={change.change} />
          </div>
          <p className="cv-object-line">{changeLine(change)}</p>
          <ChangedFieldList change={change.change} fields={change.fields} label={`${change.name}: settings`} names={names} sides={sides} total={change.fieldsTotal} />
        </li>
      ))}
    </ul>
  );
}
