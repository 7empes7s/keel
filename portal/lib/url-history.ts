// Changes the address bar without asking the server for the page again. Next.js keeps
// usePathname and useSearchParams in step with the browser's own history calls, so view
// state kept in the URL (closed groups, filters, an open panel) updates instantly.
// router.replace would re-run the page's server reads on every click.
export function replaceUrl(href: string): void {
  window.history.replaceState(null, "", href);
}

export function pushUrl(href: string): void {
  window.history.pushState(null, "", href);
}

/** The address as it is now, for code that runs after React's copy is out of date
 * (an unmount). */
export function currentUrl(): { pathname: string; search: string } {
  return { pathname: window.location.pathname, search: window.location.search };
}
