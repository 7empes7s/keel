import { Icon } from "@/components/shell/icons";

// Issue #981: what a reader scoped to some entities is told is left out of a change list.
// The words come from the loader (feedScopeNote); never a count of the rows left out.
export function ScopeNote({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="scope-note" data-scope="entities">
      <style href="keel-scope-note" precedence="default">{CSS}</style>
      <Icon name="info" />
      <span>{text}</span>
    </p>
  );
}

const CSS = `
.scope-note { display: flex; align-items: flex-start; gap: var(--space-xs); margin: 0; color: var(--text-soft); font-size: 0.875rem; line-height: 1.45; overflow-wrap: anywhere; }
.scope-note .icon { width: 1rem; height: 1rem; flex: none; margin-top: 0.125rem; }
`;
