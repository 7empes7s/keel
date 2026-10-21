import Link from "next/link";

import { displayEnum } from "@/lib/presentation";
import { riskRows } from "@/lib/overview-view";

// Open changes split by risk: a proportional bar for shape, then one link per risk that
// opens the Changes page filtered to it. Worst first, so the riskiest class is leftmost.
export function RiskBar({ items }: { items: Array<{ blastRadius: string; count: number }> }) {
  const rows = riskRows(items);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return (
    <div className="ov-risk">
      {total > 0 ? (
        <div aria-hidden="true" className="ov-risk-track">
          {rows.filter((row) => row.count > 0).map((row) => <span data-tone={row.tone} key={row.key} style={{ flexGrow: row.count }} />)}
        </div>
      ) : null}
      <ul className="ov-risk-legend">
        {rows.map((row) => (
          <li key={row.key}>
            <Link className="ov-legend-link" href={row.href}>
              <span aria-hidden="true" className="ov-swatch" data-tone={row.tone} />
              <span className="ov-legend-label">{displayEnum("blastRadius", row.key)}</span>
              <b>{row.count.toLocaleString("en-GB")}</b>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
