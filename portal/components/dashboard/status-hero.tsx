import type { DashboardAlert } from "@/lib/types";

export type PostureTone = "critical" | "warning" | "healthy";

export function postureFor(alerts: DashboardAlert[]): { tone: PostureTone; headline: string; summary: string } {
  const critical = alerts.filter((alert) => alert.severity === "critical").length;
  const warning = alerts.filter((alert) => alert.severity === "warning").length;
  if (critical) {
    return {
      tone: "critical",
      headline: "Action needed",
      summary: `${critical} critical ${critical === 1 ? "issue" : "issues"}${warning ? ` and ${warning} ${warning === 1 ? "warning" : "warnings"}` : ""} below. Recovery may not be trustworthy until they are resolved.`,
    };
  }
  if (warning) {
    return {
      tone: "warning",
      headline: "Degraded",
      summary: `${warning} ${warning === 1 ? "warning" : "warnings"} below. Recovery is possible, but some protection is weaker than it should be.`,
    };
  }
  // KEEL claims only what it checked: absence of detected problems, not "all good".
  return {
    tone: "healthy",
    headline: "No issues detected",
    summary: "Baseline, collection, coverage and evidence checks all passed on this read.",
  };
}

export function StatusHero({
  alerts,
  facts,
}: {
  alerts: DashboardAlert[];
  facts: Array<{ label: string; value: string; tone?: "good" | "bad" }>;
}) {
  const posture = postureFor(alerts);
  return (
    <section aria-labelledby="posture-heading" className={`status-hero status-${posture.tone}`}>
      <div className="status-hero-main">
        <p className="status-hero-kicker">
          <span aria-hidden="true" className="status-hero-dot" />
          Tenant posture
        </p>
        <h2 id="posture-heading">{posture.headline}</h2>
        <p>{posture.summary}</p>
      </div>
      <dl className="status-hero-facts">
        {facts.map((fact) => (
          <div className={fact.tone ? `fact-${fact.tone}` : undefined} key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>{fact.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
