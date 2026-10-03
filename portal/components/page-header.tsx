import type { NavSection } from "@/components/nav-links";
import { formatTimestamp } from "@/lib/presentation";

// Portal experience contract: the eyebrow is the navigation section the page sits in,
// typed so no page can carry a second taxonomy (portal/test/experience-contract.test.ts
// checks each page passes the section that owns its route).
export function PageHeader({
  section,
  title,
  description,
  generatedAt,
  marker,
}: {
  section: NavSection;
  title: string;
  description: string;
  generatedAt?: string;
  marker?: string;
}) {
  return (
    <header className="page-header">
      <div className="page-title-group">
        <div className="eyebrow-line">
          <p className="eyebrow">{section}</p>
          {marker ? <span className="mode-marker">{marker}</span> : null}
        </div>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {generatedAt ? (
        <p className="as-of">
          <span>Data read</span>
          <time dateTime={generatedAt}>{formatTimestamp(generatedAt)}</time>
        </p>
      ) : null}
    </header>
  );
}
