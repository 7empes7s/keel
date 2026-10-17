import { useSyncExternalStore } from "react";
// UI-harness stand-in for next/navigation: the route is the URL hash, and anything
// after "?" in it is the query string, so URL-kept view state works as in the portal.
const hash = () => location.hash.slice(1) || "/";
const readPath = () => hash().split(/[?#]/)[0] || "/";
const readSearch = () => hash().split("?")[1] ?? "";
const subscribe = (fn: () => void) => { addEventListener("hashchange", fn); return () => removeEventListener("hashchange", fn); };
export function usePathname() { return useSyncExternalStore(subscribe, readPath, () => "/"); }
const router = {
  push: (href: string) => { location.hash = href; },
  replace: (href: string) => { history.replaceState(null, "", `#${href}`); dispatchEvent(new HashChangeEvent("hashchange")); },
  refresh() {}, back() { history.back(); }, forward() {}, prefetch() {},
};
export function useRouter() { return router; }
export function useSearchParams() {
  const search = useSyncExternalStore(subscribe, readSearch, () => "");
  return new URLSearchParams(search);
}
export function notFound(): never { throw new Error("notFound"); }
