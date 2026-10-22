import type { CSSProperties } from "react";

import { Icon, type IconName } from "@/components/shell/icons";

// Shared status tiles (first built for the Resilience page): a label with an icon, one
// big value, a short line about it, and a tone underline. Four across on a desktop,
// two on a phone.

export type TileTone = "urgent" | "soon" | "low" | "fine" | "neutral";

export interface StatTile {
  key: string;
  label: string;
  icon: IconName;
  value: string;
  about: string;
  tone: TileTone;
  href?: string;
}

export function StatTiles({ tiles, label = "At a glance" }: { tiles: StatTile[]; label?: string }) {
  const style = tiles.length && tiles.length < 4 ? ({ "--tile-count": tiles.length } as CSSProperties) : undefined;
  return (
    <section aria-label={label} className="ui-tiles" style={style}>
      {tiles.map((tile) => {
        const body = (
          <>
            <span className="ui-tile-label"><Icon name={tile.icon} />{tile.label}</span>
            <b className="ui-tile-value">{tile.value}</b>
            <small>{tile.about}</small>
          </>
        );
        return tile.href
          ? <a className="ui-tile" data-tile={tile.key} data-tone={tile.tone} href={tile.href} key={tile.key}>{body}</a>
          : <div className="ui-tile" data-tile={tile.key} data-tone={tile.tone} key={tile.key}>{body}</div>;
      })}
    </section>
  );
}
