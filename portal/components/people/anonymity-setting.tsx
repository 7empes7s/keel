"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Icon } from "@/components/shell/icons";
import { Badge } from "@/components/ui/badge";
import { ConfirmButton } from "@/components/ui/confirm-button";
import { Person } from "@/components/ui/person";
import { postAction } from "@/lib/action-client";
import type { AnonymitySetting } from "@/lib/anonymity";
import { ago, formatTimestamp } from "@/lib/presentation";
import { toast } from "@/lib/toast";

// People page: the "Hide people's names" setting (Track A3). On, every page that names
// who did something shows a code name instead. Only an admin changes it; each change is
// written to the audit record, so Activity shows who turned it on or off and when.
export function AnonymitySettingCard({ setting, canChange, now }: {
  setting: AnonymitySetting | null;
  canChange: boolean;
  now: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = Boolean(setting?.enabled);

  async function change(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      await postAction("/api/anonymity", { enabled }, crypto.randomUUID());
      toast({ title: enabled ? "Names are now hidden" : "Names are shown again", detail: "The change is in the audit record." });
      router.refresh();
    } catch {
      setError("Keel could not change this setting. Try again, or check that you are an admin.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Hide people's names" className="anon-card" data-on={on ? "" : undefined}>
      <span aria-hidden="true" className="anon-card-icon"><Icon name={on ? "eye-off" : "eye"} /></span>
      <div>
        <h2>
          Hide people&apos;s names
          {setting ? <Badge icon={on ? "eye-off" : "eye"} tone={on ? "low" : "neutral"}>{on ? "On" : "Off"}</Badge> : <Badge tone="soon">Could not check</Badge>}
        </h2>
        <p>
          {on
            ? "Every page that names who did something shows each person by a code name, like Person K7Q2, and so do the spreadsheets and reports downloaded from those pages. A Keel user keeps the same code name on every page; people named by the Microsoft audit log on Changes get code names of their own. Only this list of people, and the admin forms that pick someone from it, still show names."
            : "Turn on to show people by code names instead of their names on every page that names who did something, and in the spreadsheets and reports downloaded from those pages. This list of people still shows names, for admins."}
        </p>
        {setting?.changedAt ? (
          <p className="anon-card-when">
            Last changed by <Person person={setting.changedBy} /> <time dateTime={setting.changedAt} title={formatTimestamp(setting.changedAt)}>{ago(setting.changedAt, now)}</time>.
          </p>
        ) : null}
      </div>
      {canChange && setting ? (on ? (
        <ConfirmButton
          cancelLabel="Keep hidden"
          confirmLabel="Show names"
          description={<p>Everyone who can open Keel will see people&apos;s names again. The change is written to the audit record with your name.</p>}
          disabled={busy}
          onConfirm={() => change(false)}
          title="Show people's names again?"
          tone="danger"
        ><Icon name="eye" />Show names</ConfirmButton>
      ) : (
        <button aria-busy={busy || undefined} className="btn btn-primary" disabled={busy} onClick={() => void change(true)} type="button"><Icon name="eye-off" />Hide names</button>
      )) : null}
      {error ? <p className="anon-card-error" role="alert">{error}</p> : null}
    </section>
  );
}
