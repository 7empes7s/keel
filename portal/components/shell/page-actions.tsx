"use client";

import { Icon, type IconName } from "@/components/shell/icons";
import { useCurrentHref } from "@/components/shell/menu";
import { useShellState } from "@/components/shell/shell-state";
import { hasItem, removeItem } from "@/lib/menu-prefs";

/** The star beside a page's title: keeps this page, as it is now, in Favourites. */
export function PageActions({ title, icon }: { title: string; icon: IconName }) {
  const { prefs, update, add } = useShellState();
  const href = useCurrentHref();
  const starred = hasItem(prefs, "favourites", href);
  return (
    <span className="page-actions">
      <button
        aria-label={starred ? `Remove ${title} from Favourites` : `Add ${title} to Favourites`}
        aria-pressed={starred}
        className="icon-button page-star"
        onClick={() => (starred ? update(removeItem(prefs, "favourites", href)) : add("favourites", { href, label: title, icon }))}
        title={starred ? "In Favourites. Select to remove." : "Add to Favourites in the menu"}
        type="button"
      >
        <Icon filled={starred} name="star" />
      </button>
    </span>
  );
}
