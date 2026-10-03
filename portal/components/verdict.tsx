import Link from "next/link";

// Portal experience contract, the verdict layer: one plain sentence of at most 25
// words, one tone and at most one primary action. Exactly one per page.
export type VerdictTone = "good" | "attention" | "critical";

export function Verdict({ text, tone = "good", headline, action }: {
  text: string;
  tone?: VerdictTone;
  headline?: string;
  action?: { label: string; href: string } | null;
}) {
  return (
    <section className={`verdict verdict-${tone}`} data-layer="verdict">
      <div>
        {headline ? <h2 className="verdict-headline">{headline}</h2> : null}
        <p className="verdict-sentence">{text}</p>
      </div>
      {action ? <Link className="btn btn-primary primary" href={action.href}>{action.label}</Link> : null}
    </section>
  );
}
