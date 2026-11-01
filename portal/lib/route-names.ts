// Pages that moved to a URL matching their menu name (UI audit D4, 1 Nov 2026). Old
// links, bookmarks and notification links keep working: the proxy sends each old path,
// with anything below it and its query, to the new one. Only page routes moved; the
// /api routes keep their names.
export const RENAMED_ROUTES: Readonly<Record<string, string>> = {
  "/drift": "/changes",
  "/baselines": "/approved-setups",
  "/benchmarks": "/compliance",
  "/policies": "/rules",
  "/principals": "/people",
  "/readiness": "/emergency-access",
};

/** The new path for an old page path ("/policies/p1" → "/rules/p1"), or null. */
export function renamedPath(pathname: string): string | null {
  for (const [from, to] of Object.entries(RENAMED_ROUTES)) {
    if (pathname === from) return to;
    if (pathname.startsWith(`${from}/`)) return `${to}${pathname.slice(from.length)}`;
  }
  return null;
}
