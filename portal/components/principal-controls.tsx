"use client";

import { useState } from "react";

import { DetailsSheet } from "@/components/baselines/details-sheet";
import { BaselinesStyles } from "@/components/baselines/styles";
import { OptionPicker } from "@/components/pickers/option-picker";
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
      tone="danger"
    >
      Remove
    </ConfirmButton>
  );
}

/** Manage one person in the side panel: their roles (remove one, add one) and disable. */
export function PrincipalManage({ principalId, name, grants, past, canRoles, canUsers }: {
  principalId: string;
  name: string;
  grants: { id: string; role: string; sentence: string }[];
  past: string[];
  canRoles: boolean;
  canUsers: boolean;
}) {
  const { busy, post } = usePrincipalWrite(principalId);
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState("viewer");
  return (
    <>
      <button className="btn btn-sm" onClick={() => setOpen(true)} type="button">Manage</button>
      {open ? <BaselinesStyles /> : null}
      {open ? (
        <DetailsSheet
          footer={canUsers ? (
            <ConfirmButton
              confirmLabel="Disable"
              description={<p>{name} can no longer sign in to KEEL. Their roles stay recorded.</p>}
              disabled={busy}
              onConfirm={() => post("disable", {}, "Person disabled")}
              title={`Disable ${name}?`}
              tone="danger"
            >
              Disable {name}
            </ConfirmButton>
          ) : null}
          kicker="People"
          onClose={() => setOpen(false)}
          title={name}
        >
          <div className="st-sheet-part">
            <h3>Roles</h3>
            {grants.length === 0 ? <p className="bl-help">No roles yet, so {name} can sign in but do nothing.</p> : (
              <ul className="st-sheet-list">
                {grants.map((grant) => (
                  <li key={grant.id}>
                    <span>{grant.sentence}</span>
                    {canRoles ? <RemoveRoleButton grantId={grant.id} name={name} principalId={principalId} role={grant.role} /> : null}
                  </li>
                ))}
              </ul>
            )}
            {past.length ? <p className="bl-help">Earlier: {past.join("; ")}.</p> : null}
          </div>
          {canRoles ? (
            <form className="st-sheet-part st-form" onSubmit={(event) => { event.preventDefault(); void post("grant", { role }, "Role granted"); }}>
              <h3>Add a role</h3>
              <div className="st-inline">
                <OptionPicker label="Role" onChange={(value: string) => setRole(value)} options={Object.entries(DISPLAY_ENUMS.role).map(([code, label]) => ({ value: code, label }))} value={role} />
                <button aria-busy={busy || undefined} className="btn" disabled={busy} type="submit">Add role</button>
              </div>
            </form>
          ) : null}
        </DetailsSheet>
      ) : null}
    </>
  );
}
