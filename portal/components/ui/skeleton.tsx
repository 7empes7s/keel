// Loading placeholders shaped like the content they stand in for, so a slow Postgres
// read shows the page's structure instead of a frozen previous page.
export function Skeleton({ className, width }: { className?: string; width?: string }) {
  return (
    <span
      aria-hidden="true"
      className={["skeleton", className].filter(Boolean).join(" ")}
      style={width ? { width } : undefined}
    />
  );
}

export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite" className="page-skeleton">
      <span className="visually-hidden">Loading…</span>
      <header className="page-header">
        <div className="page-title-group skeleton-stack">
          <Skeleton className="skeleton-eyebrow" />
          <Skeleton className="skeleton-title" />
          <Skeleton className="skeleton-text" width="min(36rem, 90%)" />
        </div>
        <Skeleton className="skeleton-meta" />
      </header>
      <div className="skeleton-section">
        <Skeleton className="skeleton-heading" />
        <div className="skeleton-cards">
          <Skeleton className="skeleton-card" />
          <Skeleton className="skeleton-card" />
          <Skeleton className="skeleton-card" />
        </div>
      </div>
      <div className="skeleton-section">
        <Skeleton className="skeleton-heading" />
        <div className="skeleton-table">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton className="skeleton-row" key={index} />
          ))}
        </div>
      </div>
    </div>
  );
}
