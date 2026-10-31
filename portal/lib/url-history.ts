// Changes the address bar without asking the server for the page again. Next.js keeps
// usePathname and useSearchParams in step with the browser's own history calls, so view
// state kept in the URL (closed groups, filters, an open panel) updates instantly.
// router.replace would re-run the page's server reads on every click.
//
// Next.js applies those history calls as a low-priority router update, and a background
// refresh (useRefreshPoll) that is still waiting on the server holds them back until it
// lands. On a slow server the panel did not open and the Find box stopped filtering.
// So every write here also tells the pages at once: useLiveSearchParams
// (lib/use-view-state) reads the address straight from the browser.
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of [...listeners]) listener();
}

export function replaceUrl(href: string): void {
  window.history.replaceState(null, "", href);
  announce();
}

export function pushUrl(href: string): void {
  window.history.pushState(null, "", href);
  announce();
}

/** Calls `listener` after each address write here, after Back or Forward, and after
 * announceUrl. Returns the call that stops it. */
export function subscribeUrl(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("popstate", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("popstate", listener);
  };
}

/** Tells the pages the address changed some other way, such as a Next.js link. */
export function announceUrl(): void {
  announce();
}

/** The query string the address bar holds right now, without the "?". Read this, not
 * useSearchParams, when building the next address: the hook only catches up on the next
 * draw, so two writes close together would each start from the same old query. */
export function currentQuery(): string {
  return window.location.search.replace(/^\?/, "");
}

/** The path the address bar holds right now. */
export function currentPath(): string {
  return window.location.pathname;
}
