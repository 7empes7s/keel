import { Icon } from "@/components/shell/icons";
import { type EngineRef, personLabel } from "@/lib/sentences";

// A person as initials and a name, never an email or a system code (shared frame,
// "People"). The email shows only on hover; Keel's own accounts get a grey avatar
// with a clock, and an account that no longer exists a grey "?". Initials are drawn
// from a data attribute so the text of a sentence reads "asked by Amara Okafor".
export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\s'-]/gu, " ").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] ?? "" : "";
  return (first + last).toUpperCase() || "?";
}

export function Person({ person, fallback, capitalise = false }: {
  person: EngineRef | null | undefined;
  fallback?: string;
  capitalise?: boolean;
}) {
  const label = personLabel(person, fallback);
  const name = capitalise ? label.replace(/^./, (letter) => letter.toUpperCase()) : label;
  const known = Boolean(person?.readable);
  const avatar = person?.system ? (
    <span aria-hidden="true" className="person-avatar" data-system=""><Icon name="clock" /></span>
  ) : (
    <span aria-hidden="true" className="person-avatar" data-initials={known ? initials(label) : "?"} data-system={known ? undefined : ""} />
  );
  return (
    <span className="person" title={person?.email ?? undefined}>
      {avatar}
      <span className="person-name">{name}</span>
    </span>
  );
}
