"use client";

import Link from "next/link";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BaselinesStyles } from "@/components/baselines/styles";
import { ChangeChip, ChangedFieldList } from "@/components/changed-values";
import { Icon } from "@/components/shell/icons";
import { compareItemLine, type CompareOpenable } from "@/lib/compare-view";
import { sheetStep } from "@/lib/sheet-step";
import { useViewState } from "@/lib/use-view-state";

// Compare's details panel: a changed item opens on its settings that differ (setting,
// before, after), with previous and next through every changed item on the page and
// the restore link pinned at the foot. The list itself stays one line per item.
const Opener = createContext<((id: string) => void) | null>(null);

export function CompareSheet({ items, sides, restore, children }: {
  items: CompareOpenable[];
  sides: { before: string; after: string; names?: Readonly<Record<string, string>> };
  // Where to restore the earlier side from, when it is a backup of this tenant.
  restore: { href: string; label: string } | null;
  children: ReactNode;
}) {
  const view = useViewState();
  const current = view.get("item");
  const opened = items.find((item) => item.id === current) ?? null;
  const step = useMemo(() => sheetStep(items.map((item) => item.id), opened?.id), [items, opened?.id]);
  const open = useMemo(() => (id: string) => view.set({ item: id }), [view]);
  return (
    <Opener.Provider value={open}>
      {children}
      {opened ? (
        <>
          <BaselinesStyles />
          <DetailsSheet
            footer={restore ? (
              <>
                <Link className="btn btn-primary" href={restore.href}>{restore.label}</Link>
                <p className="bl-help">Opens Restore on that backup. Nothing changes until you pick what to put back and it is approved.</p>
              </>
            ) : undefined}
            kicker={<><ChangeChip change="changed" /><span>{opened.kind} · {opened.service}</span></>}
            noun="setting"
            onClose={() => view.set({ item: null })}
            onStep={open}
            step={step}
            title={opened.name}
            wide
          >
            <p className="compare-sheet-line">{compareItemLine(opened.fields, opened.fieldsTotal)}</p>
            <ChangedFieldList fields={opened.fields} key={opened.id} label={`${opened.name}: settings`} names={sides.names} sides={sides} total={opened.fieldsTotal} />
          </DetailsSheet>
        </>
      ) : null}
    </Opener.Provider>
  );
}

/** "See what changed": opens one item in the panel. */
export function CompareOpen({ id, name }: { id: string; name: string }) {
  const open = useContext(Opener);
  if (!open) return null;
  return (
    <button aria-label={`See what changed in ${name}`} className="btn btn-sm compare-open" onClick={() => open(id)} type="button">
      See what changed<Icon name="chevron" />
    </button>
  );
}
