import Link from "next/link";

import { Icon } from "@/components/shell/icons";
import { coverageSegments } from "@/lib/overview-view";
import type { CoverageSummary } from "@/lib/types";

const RADIUS = 38;
const STROKE = 10;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP = 2.5;

// Backed up / failed / not backed up as one ring with surface gaps between segments.
// Every segment is also a labelled row beside it that opens its list on What's
// protected, so identity never rests on colour.
export function CoverageRing({ coverage, big = false }: { coverage: CoverageSummary; big?: boolean }) {
  const { segments, total, percent } = coverageSegments(coverage);
  const visible = segments.filter((segment) => segment.value > 0).length;
  let offset = 0;

  return (
    <div className="ov-ring" data-big={big || undefined}>
      <div className="ov-ring-chart">
        <svg aria-hidden="true" viewBox="0 0 100 100">
          <circle className="ov-ring-track" cx="50" cy="50" r={RADIUS} strokeWidth={STROKE} />
          {segments.map((segment) => {
            if (segment.value === 0) return null;
            const length = (segment.value / total) * CIRCUMFERENCE;
            const drawn = Math.max(0, length - (visible > 1 ? GAP : 0));
            const element = (
              <circle
                className="ov-ring-segment"
                cx="50"
                cy="50"
                data-part={segment.key}
                key={segment.key}
                r={RADIUS}
                strokeDasharray={`${drawn} ${CIRCUMFERENCE - drawn}`}
                strokeDashoffset={-offset}
                strokeWidth={STROKE}
              />
            );
            offset += length;
            return element;
          })}
        </svg>
        <span className="ov-ring-center"><b>{percent}%</b><small>backed up</small></span>
      </div>
      <ul className="ov-legend">
        {segments.map((segment) => (
          <li key={segment.key}>
            <Link className="ov-legend-link" href={segment.href}>
              <span aria-hidden="true" className="ov-swatch" data-part={segment.key} />
              <span className="ov-legend-label">{segment.label}</span>
              <b>{segment.value.toLocaleString("en-GB")}</b>
              <Icon name="chevron" />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
