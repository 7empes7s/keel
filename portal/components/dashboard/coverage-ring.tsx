import type { CoverageSummary } from "@/lib/types";

const RADIUS = 38;
const STROKE = 10;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const GAP = 2.5;

// Covered / failed / not covered as one ring with surface gaps between segments.
// Every segment is also a labelled row beside it, so identity never rests on colour.
export function CoverageRing({ coverage }: { coverage: CoverageSummary }) {
  const uncovered = coverage.notCovered + coverage.neverCollected;
  const total = Math.max(coverage.total, coverage.covered + coverage.failed + uncovered, 1);
  const segments = [
    { key: "covered", label: "Covered", value: coverage.covered },
    { key: "failed", label: "Failed", value: coverage.failed },
    { key: "uncovered", label: "Not covered", value: uncovered },
  ];
  const visible = segments.filter((segment) => segment.value > 0).length;
  let offset = 0;
  const percent = Math.round((coverage.covered / total) * 100);

  return (
    <div className="coverage-ring">
      <svg aria-hidden="true" viewBox="0 0 100 100">
        <circle className="ring-track" cx="50" cy="50" r={RADIUS} strokeWidth={STROKE} />
        {segments.map((segment) => {
          if (segment.value === 0) return null;
          const length = (segment.value / total) * CIRCUMFERENCE;
          const drawn = Math.max(0, length - (visible > 1 ? GAP : 0));
          const element = (
            <circle
              className={`ring-segment ring-${segment.key}`}
              cx="50"
              cy="50"
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
      <div className="ring-center">
        <strong>{percent}%</strong>
        <span>covered</span>
      </div>
      <dl className="ring-legend">
        {segments.map((segment) => (
          <div key={segment.key}>
            <dt><span aria-hidden="true" className={`legend-swatch ring-${segment.key}`} />{segment.label}</dt>
            <dd>{segment.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
