"use client";

import Link from "next/link";
import { useState } from "react";

import { OptionPicker } from "@/components/pickers/option-picker";
import { Icon } from "@/components/shell/icons";
import type { CompareInput, CompareTenant } from "@/lib/compare-view";
import { formatTimestamp } from "@/lib/presentation";

export interface QuickPick {
  label: string;
  about: string;
  from: string;
  to: string;
}

/** What to compare: two backups, chosen with the shared picker, plus one-click pairs.
 * It stays a GET form, so comparing never changes anything and every result is a link. */
export function CompareForm({ tenants, input, quick }: { tenants: CompareTenant[]; input: CompareInput | null; quick: QuickPick[] }) {
  const [from, setFrom] = useState<string | null>(input?.from ?? null);
  const [to, setTo] = useState<string | null>(input?.to ?? null);
  const options = tenants.filter((tenant) => tenant.snapshots.length > 0).flatMap((tenant) => tenant.snapshots.map((snapshot) => ({
    value: snapshot.id,
    label: formatTimestamp(snapshot.completedAt),
    icon: tenant.own ? "backup" as const : "cloud" as const,
    hint: `${tenant.label} · ${snapshot.resourceCount.toLocaleString("en-GB")} settings`,
  })));
  const current = (pick: QuickPick) => pick.from === input?.from && pick.to === input?.to;

  return (
    <section aria-labelledby="compare-form-heading" className="bl-card bl-compare-form">
      <h2 id="compare-form-heading">What to compare</h2>
      {quick.length ? (
        <ul aria-label="Quick comparisons" className="bl-quick">
          {quick.map((pick) => (
            <li key={pick.label}>
              <Link aria-current={current(pick) || undefined} className="bl-quick-link bl-link" href={`/compare?from=${encodeURIComponent(pick.from)}&to=${encodeURIComponent(pick.to)}`}>
                <b>{pick.label}</b>
                <small>{pick.about}</small>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <form action="/compare" className="bl-compare-pickers" method="get">
        <input name="from" type="hidden" value={from ?? ""} />
        <input name="to" type="hidden" value={to ?? ""} />
        <OptionPicker label="Before" onChange={setFrom} options={options} placeholder="Choose a backup" value={from} />
        <button
          aria-label="Swap before and after"
          className="icon-button bl-swap"
          disabled={!from || !to}
          onClick={() => { setFrom(to); setTo(from); }}
          title="Swap before and after"
          type="button"
        >
          <Icon name="swap" />
        </button>
        <OptionPicker label="After" onChange={setTo} options={options} placeholder="Choose a backup" value={to} />
        <button className="btn btn-primary" disabled={!from || !to || from === to} type="submit">Compare</button>
      </form>
      <p className="bl-help">
        Pick a backup from another tenant to compare the two tenants. Comparing only reads backups: nothing here changes anything.
        Comparing with the tenant as it is this minute is done by an operator on the Keel server.
      </p>
    </section>
  );
}
