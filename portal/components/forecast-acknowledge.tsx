"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ForecastWarningCode } from "@/lib/schedules";
import { toast } from "@/lib/toast";

// Roadmap task-110: accept a measured load warning without changing the schedule.
// The server re-checks the configuration grant; the interval floor still applies.
export function ForecastAcknowledge({ scheduleId, name, codes }: { scheduleId: string; name: string; codes: ForecastWarningCode[] }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function acknowledge() {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/schedules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: scheduleId, acknowledgeForecast: codes }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(typeof payload.error === "string" && payload.error === "forecast_warning_not_current"
        ? "This warning has changed since the page loaded. Reload to see the current estimate."
        : "The warning could not be accepted.");
      toast({ title: `Warning on ${name} accepted; the schedule is unchanged` });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The warning could not be accepted.");
    } finally {
      setSaving(false);
    }
  }

  return <div className="forecast-acknowledge">
    <button className="btn btn-ghost btn-sm" type="button" onClick={acknowledge} disabled={saving} aria-label={`Accept the load warning on ${name}`}>
      {saving ? "Accepting…" : "Accept warning"}
    </button>
    {error ? <p className="form-error" role="alert">{error}</p> : null}
  </div>;
}
