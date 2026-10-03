"use client";

import { useState } from "react";

import { ConfirmButton } from "@/components/ui/confirm-button";
import { DISPLAY_ENUMS } from "@/lib/presentation";
import { toast } from "@/lib/toast";

// Roadmap task-130: grant, remove and disable through the existing guarded routes,
// which re-check roles / users and refuse removing the last admin.
function usePrincipalWrite(principalId: string) {
  const [busy, setBusy] = useState(false);
  async function post(path: string, body: Record<string, unknown>, success: string) {
    setBusy(true);
    try {
      const response = await fetch(`/api/principals/${encodeURIComponent(principalId)}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        toast({ tone: "warning", title: "Not changed", detail: response.status === 403 ? "KEEL keeps at least one active admin." : "The change was not saved." });
        return;
      }
      toast({ title: success });
      // A full reload: these controls also render outside an app router (page tests).
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }
  return { busy, post };
}

export function RemoveRoleButton({ principalId, grantId, name, role }: { principalId: string; grantId: string; name: string; role: string }) {
  const { busy, post } = usePrincipalWrite(principalId);
  return (
    <ConfirmButton
      confirmLabel="Remove role"
      description={<p>{name} loses the {role.toLowerCase()} role now.</p>}
      disabled={busy}
      onConfirm={() => post("revoke", { grantId }, "Role removed")}
      size="sm"
      title={`Remove ${role.toLowerCase()} from ${name}?`}
    >
      Remove
    </ConfirmButton>
  );
}

export function PrincipalControls({ principalId, name, canRoles, canUsers }: { principalId: string; name: string; canRoles: boolean; canUsers: boolean }) {
  const { busy, post } = usePrincipalWrite(principalId);
  const [role, setRole] = useState("viewer");
  return (
    <div className="form-actions principal-controls">
      {canRoles ? (
        <form className="inline-form" onSubmit={(event) => { event.preventDefault(); void post("grant", { role }, "Role granted"); }}>
          <label className="filter-field">
            <span>Add a role</span>
            <select disabled={busy} onChange={(event) => setRole(event.target.value)} value={role}>
              {Object.entries(DISPLAY_ENUMS.role).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </select>
          </label>
          <button className="btn btn-secondary btn-sm" disabled={busy} type="submit">Add role</button>
        </form>
      ) : null}
      {canUsers ? (
        <ConfirmButton
          confirmLabel="Disable"
          description={<p>{name} can no longer sign in to KEEL. Their roles stay recorded.</p>}
          disabled={busy}
          onConfirm={() => post("disable", {}, "Person disabled")}
          size="sm"
          title={`Disable ${name}?`}
        >
          Disable
        </ConfirmButton>
      ) : null}
    </div>
  );
}
