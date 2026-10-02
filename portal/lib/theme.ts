// Theme preference: "system" follows the OS; "light" and "dark" pin it. The choice is
// a cookie (not localStorage) so the server can render <html data-theme> and the page
// never flashes the wrong palette before hydration.
export type ThemePreference = "system" | "light" | "dark";

export const THEME_COOKIE = "keel-theme";
export const THEME_EVENT = "keel-theme-change";

export function parseThemePreference(value: string | undefined | null): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

function writeCookie(value: string): void {
  try {
    document.cookie = value;
  } catch {
    // Cookies blocked: the choice still applies to this page view, it just won't persist.
  }
}

export function applyThemePreference(preference: ThemePreference): void {
  const root = document.documentElement;
  if (preference === "system") {
    delete root.dataset.theme;
    writeCookie(`${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`);
  } else {
    root.dataset.theme = preference;
    writeCookie(`${THEME_COOKIE}=${preference}; path=/; max-age=31536000; samesite=lax`);
  }
  window.dispatchEvent(new CustomEvent<ThemePreference>(THEME_EVENT, { detail: preference }));
}
