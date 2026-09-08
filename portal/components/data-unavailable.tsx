export function DataUnavailable({ surface }: { surface: string }) {
  return (
    <section className="data-error" role="alert">
      <p className="severity-label">DATA UNAVAILABLE</p>
      <h2>{surface} could not be read</h2>
      <p>
        KEEL could not read Postgres. No stale value is being substituted. Check the
        portal service and database connection, then reload this page.
      </p>
    </section>
  );
}
