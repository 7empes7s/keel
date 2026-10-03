// Portal experience contract, copy voice: name the thing in the reader's words and the
// next step; never the engine name. No stale value is ever substituted.
export function DataUnavailable({ surface }: { surface: string }) {
  return (
    <section className="data-error" role="alert">
      <h2>{surface} could not be read</h2>
      <p>
        KEEL could not read its database. Reload in a minute; if this persists, check the
        portal service.
      </p>
    </section>
  );
}
