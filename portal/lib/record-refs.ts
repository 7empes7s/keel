// What a linked record resolved to, for a Technical details field's usage line.
// Kept out of components/technical-details.tsx on purpose: that file is "use client",
// and a server component (the job list on Restore and What's protected) cannot call a
// function exported from a client module. Next.js throws at render time.

export type RefLike = { kind: string; id: string; name: string | null; readable: boolean; email?: string | null };

/** What a linked record resolved to, for a field's usage line. */
export function refUsage(ref: RefLike | null | undefined, extra?: string | null): string | undefined {
  if (!ref) return extra ?? undefined;
  const name = ref.readable ? ref.name : "no longer readable";
  const parts = [name !== ref.id ? name : null, ref.email && ref.email !== name && ref.email !== ref.id ? ref.email : null, extra].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}
