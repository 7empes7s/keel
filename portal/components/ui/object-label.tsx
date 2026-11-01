import { Badge } from "@/components/ui/badge";
import type { ObjectStatus } from "@/lib/object-label";
import { deletedSinceWords } from "@/lib/object-label";

// An object as a reader knows it (redesign A2, IN-NAMES): its name in bold and its kind
// in soft text, "Finance (group)", or "Unnamed group" when no backup names it. It never
// shows an id: the page keeps ids under Technical details. Server-safe, no hooks.
export function ObjectLabel({ name, type, className }: { name: string | null; type: string | null; className?: string }) {
  return (
    <span className={className ? `object-label ${className}` : "object-label"}>
      {name ? <span className="object-label-name">{name}</span> : <span className="object-label-name" data-unnamed="">{type ? `Unnamed ${type}` : "Unnamed setting"}</span>}
      {name && type ? <span className="object-label-type"> ({type})</span> : null}
    </span>
  );
}

/** "Deleted since 3 Oct 2026" when the newest backup no longer holds the object; nothing otherwise. */
export function ObjectStatusBadge({ status, deletedSince }: { status: ObjectStatus | null | undefined; deletedSince?: string | null }) {
  if (status !== "deleted") return null;
  return <Badge className="object-label-gone" icon="x-circle" tone="soon">{deletedSinceWords(deletedSince ?? null)}</Badge>;
}
