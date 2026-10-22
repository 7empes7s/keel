import { scoreSentence, scoreTone, type ComplianceScore } from "@/lib/compliance-view";

const RADIUS = 40;
const STROKE = 10;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

// A compliance score as a ring: the share of checked controls that pass, coloured by
// how good it is (green, amber, red; grey while nothing was checked). The number and
// the sentence beside it say the same thing in words, so it never rests on colour.
export function ScoreRing({ score, size = "md", label }: { score: ComplianceScore; size?: "sm" | "md" | "lg"; label?: string }) {
  const tone = scoreTone(score);
  const drawn = score.percent === null ? 0 : (score.percent / 100) * CIRCUMFERENCE;
  const words = `${label ? `${label}: ` : ""}${score.percent === null ? "no score yet" : `${score.percent}% pass`}. ${scoreSentence(score)}.`;
  return (
    <span className="score-ring" data-size={size} data-tone={tone} role="img" aria-label={words}>
      <svg aria-hidden="true" viewBox="0 0 100 100">
        <circle className="score-ring-track" cx="50" cy="50" r={RADIUS} strokeWidth={STROKE} />
        {drawn > 0 ? (
          <circle className="score-ring-value" cx="50" cy="50" r={RADIUS} strokeDasharray={`${drawn} ${CIRCUMFERENCE - drawn}`} strokeLinecap={score.percent === 100 ? "butt" : "round"} strokeWidth={STROKE} />
        ) : null}
      </svg>
      <span aria-hidden="true" className="score-ring-center">
        <b>{score.percent === null ? "–" : `${score.percent}%`}</b>
        {size === "lg" ? <small>pass</small> : null}
      </span>
    </span>
  );
}
