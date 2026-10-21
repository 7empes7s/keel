import { type ComponentProps, type ContextType, createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PeoplePage } from "@/components/people/people-page";

// Server-renders the People body at /principals?<search>, the way the page does: the
// filters, the grouping, the open panel and the Add person sheet live in the URL.
async function contexts(pathname: string, search: string) {
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  return (child: ReactElement) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as ContextType<typeof AppRouterContext> },
    createElement(PathnameContext.Provider, { value: pathname },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as unknown as ContextType<typeof SearchParamsContext> }, child))));
}

export async function renderPeopleAt(search: string, props: ComponentProps<typeof PeoplePage>): Promise<string> {
  return (await contexts("/principals", search))(createElement(PeoplePage, props));
}

/** Any element (such as the whole server page) inside the same router contexts. */
export async function renderInPeopleRoute(element: ReactElement, search = ""): Promise<string> {
  return (await contexts("/principals", search))(element);
}
