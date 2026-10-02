import { useSyncExternalStore } from "react";
// UI-harness stand-in for next/navigation: the route is the URL hash.
const read = () => (location.hash.slice(1) || "/");
const subscribe = (fn: () => void) => { addEventListener("hashchange", fn); return () => removeEventListener("hashchange", fn); };
export function usePathname() { return useSyncExternalStore(subscribe, read, () => "/"); }
const router = { push: (href: string) => { location.hash = href; }, replace: (href: string) => { location.hash = href; }, refresh() {}, back() { history.back(); }, forward() {}, prefetch() {} };
export function useRouter() { return router; }
export function useSearchParams() { return new URLSearchParams(); }
export function notFound(): never { throw new Error("notFound"); }
