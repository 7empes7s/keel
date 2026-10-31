// UI-harness stand-in for lib/url-history: the route is the URL hash (shims/navigation.tsx).
export function replaceUrl(href: string): void {
  history.replaceState(null, "", `#${href}`);
  dispatchEvent(new HashChangeEvent("hashchange"));
}

export function pushUrl(href: string): void {
  location.hash = href;
}

export function subscribeUrl(listener: () => void): () => void {
  addEventListener("hashchange", listener);
  return () => removeEventListener("hashchange", listener);
}

// Both readers follow the hash here, so there is nothing to catch up.
export function announceUrl(): void {}

export function currentQuery(): string {
  return location.hash.slice(1).split("?")[1] ?? "";
}

export function currentPath(): string {
  return location.hash.slice(1).split(/[?#]/)[0] || "/";
}
