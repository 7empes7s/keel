import Link from "next/link";

// Changes has two views: Open changes (to accept or undo) and Every change (the change
// feed, insights track IN-FEED). Every reader sees the switch: a reader scoped to some
// entities gets both views filtered to their entities (issue #981). Server-safe, no hooks.
export function ChangesViews({ current }: { current: "open" | "feed" }) {
  return (
    <nav aria-label="Changes views" className="section-tabs changes-views">
      <Link aria-current={current === "open" ? "page" : undefined} className="section-tab" href="/changes">Open changes</Link>
      <Link aria-current={current === "feed" ? "page" : undefined} className="section-tab" href="/changes?view=feed">Every change</Link>
    </nav>
  );
}
