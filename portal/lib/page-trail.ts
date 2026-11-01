import { headers } from "next/headers";

import { cameFrom, type Crumb, type NavSection, type Trail } from "@/lib/nav-sections";

/** The breadcrumb for a page reached from several places: the menu page the person came
 * from, or the page's usual trail (`cameFrom`). Server pages only. */
export async function pageTrail(section: NavSection, parents: readonly Crumb[]): Promise<Trail> {
  const request = await headers();
  return cameFrom(request.get("referer"), [request.get("host"), request.get("x-forwarded-host")], { section, parents });
}
