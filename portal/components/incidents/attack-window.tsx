"use client";

import { Person } from "@/components/ui/person";
import { STATES, personOf, timeline, windowSentence } from "@/lib/incidents-view";
import type { IncidentDetail } from "@/lib/portal-data";

const LEFT = 16;
const WIDTH = 608;
const X = (fraction: number) => LEFT + fraction * WIDTH;

// When the attacker had access: one axis from the oldest backup to now, the attack
// windows as bands (an ongoing one runs to now, hatched) and each backup as a dot
// tinted by its state, so "taken during the attack" reads at a glance. Tokens only.
export function AttackTimeline({ detail, now }: { detail: IncidentDetail; now: string }) {
  const line = timeline(detail, now);
  const described = `${detail.intervals.length ? detail.intervals.map(windowSentence).join("; ") : "No attack window recorded"}. ${line.dots.map((dot) => dot.label).join("; ")}.`;
  return (
    <div className="ir-tl">
    <svg aria-label={described} className="ir-timeline" role="img" viewBox="0 0 640 76">
      <defs>
        <pattern height="8" id="ir-hatch" patternTransform="rotate(45)" patternUnits="userSpaceOnUse" width="8">
          <rect className="ir-hatch-line" height="8" width="3" />
        </pattern>
      </defs>
      {line.ticks.map((tick) => <line className="ir-grid" key={`g${tick.label}`} x1={X(tick.x)} x2={X(tick.x)} y1={26} y2={66} />)}
      <line className="ir-axis" x1={LEFT} x2={LEFT + WIDTH} y1={46} y2={46} />
      {line.bands.map((band, index) => (
        <g key={index}>
          <rect className="ir-band" height={34} rx={4} width={band.width * WIDTH} x={X(band.x)} y={29} />
          {band.ongoing ? <rect fill="url(#ir-hatch)" height={34} opacity={0.5} rx={4} width={band.width * WIDTH} x={X(band.x)} y={29} /> : null}
          <line className="ir-edge" x1={X(band.x)} x2={X(band.x)} y1={24} y2={68} />
        </g>
      ))}
      <line className="ir-now" x1={X(1)} x2={X(1)} y1={20} y2={72} />
      {line.dots.map((dot) => (
        <g key={dot.id}>
          {dot.recommended ? <circle className="ir-ring" cx={X(dot.x)} cy={46} r={10} /> : null}
          <circle className="ir-dot" cx={X(dot.x)} cy={46} data-state={dot.state} r={6}><title>{dot.label}</title></circle>
        </g>
      ))}
    </svg>
    {/* Labels are text beside the drawing, so they keep their size at any width. */}
    <span aria-hidden="true" className="ir-tl-now">Now</span>
    <span aria-hidden="true" className="ir-tl-ticks">
      {line.ticks.map((tick) => <span key={tick.label} style={{ left: `${(X(tick.x) / 640) * 100}%` }}>{tick.label}</span>)}
    </span>
    </div>
  );
}

export function AttackWindowList({ detail }: { detail: IncidentDetail }) {
  if (!detail.intervals.length) return <p className="ir-muted">Not recorded yet, so no backup is marked as taken during the attack.</p>;
  return (
    <ul className="ir-windows">
      {detail.intervals.map((interval) => (
        <li key={interval.id}>
          <b>{windowSentence(interval)}</b>
          <span>{interval.recordedBy ? <><Person person={personOf(interval.recordedBy)} />: </> : null}{interval.reason}</span>
        </li>
      ))}
    </ul>
  );
}

export function TimelineLegend() {
  return (
    <p className="ir-legend">
      {(["cleared", "unchecked", "unsafe"] as const).map((state) => <span key={state}><i aria-hidden="true" className="ir-legend-dot" data-state={state} />{STATES[state].label}</span>)}
      <span><i aria-hidden="true" className="ir-legend-band" />Attacker had access</span>
    </p>
  );
}
