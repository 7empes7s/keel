"use client";
import { useState } from "react";
import { toast } from "@/lib/toast";

export interface FlagSetting { key: string; enabled: boolean; sentence: string }
export function ChangeFlagSettings({ initial }: { initial: FlagSetting[] }) {
  const [settings, setSettings] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function update(setting: FlagSetting) {
    setBusy(true);
    try {
      const response = await fetch("/api/change-flag-settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: setting.key, enabled: !setting.enabled }) });
      if (!response.ok) throw new Error();
      setSettings((await response.json()).settings);
      toast({ title: setting.enabled ? "Flag alerts turned off" : "Flag alerts turned on" });
    } catch { toast({ tone: "warning", title: "Setting could not be saved", detail: "Try again in a moment." }); }
    finally { setBusy(false); }
  }
  return <details className="card"><summary>Flagged change alerts</summary>
    <p>Choose which changes raise alerts. Turning one off is kept in the audit record. Existing alerts stay available for review.</p>
    {settings.map((setting) => <p key={setting.key}><label><input checked={setting.enabled} disabled={busy} onChange={() => void update(setting)} type="checkbox" /> {setting.sentence}</label></p>)}
  </details>;
}
