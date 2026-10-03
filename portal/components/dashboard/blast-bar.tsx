import { displayEnum } from "@/lib/presentation";

// Open changes split by impact: a proportional bar for shape, labelled rows for
// the numbers. Severity order is fixed, so the worst class is always leftmost.
export function BlastBar({ items }: { items: Array<{ blastRadius: string; count: number }> }) {
  const total = items.reduce((sum, item) => sum + item.count, 0);
  return (
    <div className="blast-bar">
      {total > 0 ? (
        <div aria-hidden="true" className="blast-bar-track">
          {items.filter((item) => item.count > 0).map((item) => (
            <span className={`blast-bar-segment blast-fill-${item.blastRadius}`} key={item.blastRadius} style={{ flexGrow: item.count }} />
          ))}
        </div>
      ) : null}
      <dl className="blast-bar-legend">
        {items.map((item) => (
          <div key={item.blastRadius}>
            <dt><span aria-hidden="true" className={`legend-swatch blast-fill-${item.blastRadius}`} />{displayEnum("blastRadius", item.blastRadius)}</dt>
            <dd>{item.count.toLocaleString("en-GB")}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
