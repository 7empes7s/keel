// Roadmap task-98: styles for the semantic comparison and the decision workbook, kept
// with the components rather than in the shared stylesheet. React hoists and dedupes a
// <style> with an href and precedence, so rendering it from several rows is harmless.
const CSS = `
.semantic-group { display: grid; gap: var(--space-xs); }
.semantic-group h4 { margin: 0; font-size: 0.875rem; }
.semantic-count { color: var(--text-soft); font-weight: 400; }
.semantic-group-fixed h4 { color: var(--failed); }
.diff-unknown .diff-before { font-style: italic; color: var(--text-soft); }
.semantic-capped, .semantic-cosmetic { margin: 0; }
.decision-workbook .decision-table { max-width: 44rem; }
.decision-workbook tfoot th, .decision-workbook tfoot td { font-weight: 600; border-top: 1px solid var(--line-strong); }
.decision-notes { margin: var(--space-sm) 0 0; padding-left: var(--space-lg); display: grid; gap: var(--space-2xs); }
.decision-evidence {
  display: grid;
  gap: var(--space-xs);
  padding: var(--space-md) var(--space-lg) var(--space-lg);
  border-top: 1px solid var(--line-strong);
}
.decision-list { display: grid; gap: var(--space-xs); margin: 0; }
.decision-row {
  display: grid;
  grid-template-columns: minmax(8rem, 12rem) minmax(0, 1fr);
  gap: var(--space-sm);
  padding-left: var(--space-sm);
  border-left: 3px solid var(--line);
}
.decision-row dt { font-weight: 600; }
.decision-row dd { margin: 0; overflow-wrap: anywhere; }
.decision-row-mismatch { border-left-color: var(--failed); }
.decision-mismatch { color: var(--failed); font-weight: 600; }
.decision-mismatch-note { margin: 0; color: var(--failed); font-weight: 600; }
.decision-items { margin: 0; padding-left: var(--space-md); display: grid; gap: var(--space-2xs); }
@media (max-width: 40rem) {
  .decision-row { grid-template-columns: minmax(0, 1fr); gap: var(--space-2xs); }
}
`;

export function DecisionStyles() {
  return <style href="keel-decision-workbook" precedence="default">{CSS}</style>;
}
