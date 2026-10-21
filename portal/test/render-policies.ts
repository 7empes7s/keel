import { type ComponentProps, type ContextType, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PoliciesPage } from "@/components/policies/policies-page";
import { PolicyPage } from "@/components/policies/policy-page";

// Server-renders the Policies body at /policies?<search>, the way the page does: the
// filters, the grouping and the open sheet live in the URL.
async function contexts(pathname: string, search: string) {
  const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const { PathnameContext, SearchParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
  return (child: ReturnType<typeof createElement>) => renderToStaticMarkup(createElement(AppRouterContext.Provider, { value: {} as ContextType<typeof AppRouterContext> },
    createElement(PathnameContext.Provider, { value: pathname },
      createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as unknown as ContextType<typeof SearchParamsContext> }, child))));
}

export async function renderPoliciesAt(search: string, props: ComponentProps<typeof PoliciesPage>): Promise<string> {
  return (await contexts("/policies", search))(createElement(PoliciesPage, props));
}

export async function renderPolicy(props: ComponentProps<typeof PolicyPage>): Promise<string> {
  return (await contexts(`/policies/${props.policy.id}`, ""))(createElement(PolicyPage, props));
}
