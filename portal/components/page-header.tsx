import { formatTimestamp } from "@/lib/presentation";

export function PageHeader({
  eyebrow,
  title,
  description,
  generatedAt,
  marker,
}: {
  eyebrow: string;
  title: string;
  description: string;
  generatedAt?: string;
  marker?: string;
}) {
  return (
    <header className="page-header">
      <div className="page-title-group">
        <div className="eyebrow-line">
          <p className="eyebrow">{eyebrow}</p>
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
