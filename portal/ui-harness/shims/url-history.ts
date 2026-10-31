// UI-harness stand-in for lib/url-history: the route is the URL hash (shims/navigation.tsx).
export function replaceUrl(href: string): void {
  history.replaceState(null, "", `#${href}`);
  dispatchEvent(new HashChangeEvent("hashchange"));
}

export function pushUrl(href: string): void {
  location.hash = href;
}

export function currentUrl(): { pathname: string; search: string } {
  const [pathname, search = ""] = location.hash.slice(1).split("?");
  return { pathname: pathname || "/", search: search ? `?${search}` : "" };
}
