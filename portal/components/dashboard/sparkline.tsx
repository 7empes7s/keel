"use client";

import { useState } from "react";

const WIDTH = 280;
const HEIGHT = 64;
const PAD_X = 4;
const PAD_TOP = 6;
const PAD_BOTTOM = 4;

function formatDay(day: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })
    .format(new Date(`${day}T00:00:00Z`));
}

// One series, so no legend: the card title names it. Area + 2px line, the latest day
// marked, and a crosshair tooltip on hover. The hidden table is the non-visual view.
export function Sparkline({ points, label }: { points: Array<{ day: string; count: number }>; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  if (points.length < 2) return null;

  const max = Math.max(1, ...points.map((point) => point.count));
  const x = (index: number) => PAD_X + (index / (points.length - 1)) * (WIDTH - PAD_X * 2);
  const y = (count: number) => PAD_TOP + (1 - count / max) * (HEIGHT - PAD_TOP - PAD_BOTTOM);
  const line = points.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.count).toFixed(1)}`).join("");
  const area = `${line}L${x(points.length - 1).toFixed(1)},${HEIGHT - PAD_BOTTOM}L${x(0).toFixed(1)},${HEIGHT - PAD_BOTTOM}Z`;
  const last = points.length - 1;
  const total = points.reduce((sum, point) => sum + point.count, 0);
  const peak = points.reduce((best, point) => (point.count > best.count ? point : best), points[0]);
  const shown = hover ?? last;

  return (
    <figure className="sparkline">
      <div className="sparkline-plot">
        <svg
          aria-label={`${label}: ${total} detected over ${points.length} days, peak ${peak.count} on ${formatDay(peak.day)}`}
          onMouseLeave={() => setHover(null)}
          onMouseMove={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            const ratio = (event.clientX - box.left) / box.width;
            setHover(Math.max(0, Math.min(last, Math.round(ratio * last))));
          }}
          preserveAspectRatio="none"
          role="img"
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        >
          <line className="sparkline-baseline" x1={PAD_X} x2={WIDTH - PAD_X} y1={HEIGHT - PAD_BOTTOM} y2={HEIGHT - PAD_BOTTOM} />
          <path className="sparkline-area" d={area} />
          <path className="sparkline-line" d={line} />
          {hover !== null ? (
            <line className="sparkline-crosshair" x1={x(hover)} x2={x(hover)} y1={PAD_TOP - 4} y2={HEIGHT - PAD_BOTTOM} />
          ) : null}
        </svg>
        {/* Dots are HTML so they stay round when the SVG stretches to the card width. */}
        <span
          aria-hidden="true"
          className={`sparkline-dot${hover === null ? " sparkline-dot-latest" : ""}`}
          style={{ left: `${(x(shown) / WIDTH) * 100}%`, top: `${(y(points[shown].count) / HEIGHT) * 100}%` }}
        />
        {hover !== null ? (
          <span
            className="sparkline-tooltip"
            style={{ left: `${(x(hover) / WIDTH) * 100}%` }}
          >
            <strong>{points[hover].count}</strong> on {formatDay(points[hover].day)}
          </span>
        ) : null}
      </div>
      <figcaption>
        <span>Detected per day · last {points.length} days</span>
        <span>Peak {peak.count}</span>
      </figcaption>
      <table className="visually-hidden">
        <caption>{label}</caption>
        <thead><tr><th scope="col">Day (UTC)</th><th scope="col">Detected</th></tr></thead>
        <tbody>{points.map((point) => <tr key={point.day}><td>{point.day}</td><td>{point.count}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}
