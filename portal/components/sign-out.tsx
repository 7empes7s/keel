"use client";

import { useState } from "react";

import { ACCESS_SIGN_OUT_PATH, MICROSOFT_SIGN_OUT_URL } from "@/lib/sign-out";

export function SignOutControls() {
  const [switching, setSwitching] = useState(false);

  // End the Access session first, from this page (same origin, so its cookie is
  // cleared), then leave for the Microsoft sign-out. The next visit to the portal asks
  // which Microsoft account to use.
  async function switchAccount() {
    setSwitching(true);
    try {
      await fetch(ACCESS_SIGN_OUT_PATH, { cache: "no-store", credentials: "same-origin", redirect: "manual" });
    } catch {
      // The Microsoft sign-out still runs; the Access session then ends at its expiry.
    }
    window.location.assign(MICROSOFT_SIGN_OUT_URL);
  }

  return (
    <div className="session-actions">
      <a className="session-action" href={ACCESS_SIGN_OUT_PATH}>
        Sign out
      </a>
      <button
        className="session-action"
        disabled={switching}
        onClick={switchAccount}
        title="Signs this browser out of Microsoft too, so the next sign-in asks which account to use"
        type="button"
      >
        {switching ? "Signing out…" : "Switch account"}
      </button>
    </div>
  );
}
