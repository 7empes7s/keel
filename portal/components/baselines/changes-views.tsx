import Link from "next/link";

// Changes has two views: Open changes (to accept or undo) and Every change (the change
// feed, insights track IN-FEED). Only a central administrator sees the switch: the feed
// spans the whole tenant. Server-safe, no hooks.
export function ChangesViews({ current }: { current: "open" | "feed" }) {
  return (
    <nav aria-label="Changes views" className="section-tabs changes-views">
      <Link aria-current={current === "open" ? "page" : undefined} className="section-tab" href="/drift">Open changes</Link>
      <Link aria-current={current === "feed" ? "page" : undefined} className="section-tab" href="/drift?view=feed">Every change</Link>
    </nav>
  );
}
