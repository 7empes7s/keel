import {
  assertSelectionClosed,
  dependencyClosure,
  selectionGuardRefusals,
} from "../../../../../../engine/restore/selection.mjs";
import {
  getReferences,
  getResourceVersions,
} from "../../../../../../engine/store/db.mjs";

import { guarded, InvalidActionRequest, readActionParams } from "@/lib/action";
import { DATA_SURFACES, guardedRead } from "@/lib/read";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Portal-design §4.1, plan task 17: the selection preview. It is a READ-ONLY
// computation — no enqueue, no job, no tenant write (recordAttempt: false) — but it
// still sits behind the wrapper at the restore capability, because authorisation is
// never enforced only in the UI. The closure is computed here, server-side, from the
// snapshot's stored references; anything a client computed is never trusted. The
// resource mapping mirrors cli/keel-restore.mjs exactly (users and authentication
// strength policies are read-only in M1), so what the preview shows is what the
// restore CLI will plan.
const restoreSelection = guarded(
  {
    action: "restore:selection-preview",
    capability: "restore",
    recordAttempt: false,
  },
  async ({ client, tenantRef: ref, request }) => {
    const body = await readActionParams(request);
    const { snapshotId, selected } = body;
    if (typeof snapshotId !== "string" || snapshotId.length === 0) {
      throw new InvalidActionRequest("snapshotId is required");
    }
    if (
      !Array.isArray(selected)
      || selected.some((key) => typeof key !== "string" || key.length === 0)
    ) {
      throw new InvalidActionRequest("selected must be an array of natural keys");
    }

    // Scoped to this tenant: a snapshot from anywhere else is indistinguishable from
    // one that does not exist.
    const { rows: snapshots } = await client.query(
      `SELECT id FROM snapshot WHERE id = $1 AND tenant_ref = $2`,
      [snapshotId, ref],
    );
    if (!snapshots[0]) {
      return Response.json(
        { error: "not_found" },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    }

    const versions = (await getResourceVersions(client, { snapshotId })) as Record<
      string,
      unknown
    >[];
    const references = (await getReferences(client, { snapshotId })) as Record<
      string,
      unknown
    >[];
    const refsByVersion = new Map<
      string,
      { field: string; symbol: string | null; required: boolean }[]
    >();
    for (const reference of references) {
      const fromVersion = String(reference.from_version);
      if (!refsByVersion.has(fromVersion)) refsByVersion.set(fromVersion, []);
      refsByVersion.get(fromVersion)?.push({
        field: String(reference.field_path),
        symbol: reference.to_symbol === null ? null : String(reference.to_symbol),
        required: Boolean(reference.required),
      });
    }
    const resources = versions
      .filter(
        (version) =>
          version.resource_type !== "user"
          && version.resource_type !== "authenticationStrengthPolicy",
      )
      .map((version) => ({
        naturalKey: String(version.natural_key),
        resourceType: String(version.resource_type),
        payload: version.payload,
        references: refsByVersion.get(String(version.id)) ?? [],
        blastRadius: String(version.blast_radius),
        restorePriority: 100,
      }));

    let closure;
    try {
      closure = dependencyClosure(resources, selected);
    } catch (error) {
      // An unknown selected key is a request problem, not a server failure — the
      // detail-free 503 would hide a fixable mistake from the operator.
      throw new InvalidActionRequest(
        error instanceof Error ? error.message : "invalid selection",
      );
    }

    return Response.json(
      {
        snapshotId,
        selected: closure.selected,
        closureKeys: closure.keys,
        added: closure.added,
        unresolvedReferences: closure.unresolvedReferences,
        // The guard refusals (e.g. AD-synced objects) surface NOW, at selection time —
        // not after a job has been approved and started.
        guardRefusals: selectionGuardRefusals(closure.resources),
        // What the raw selection still lacks to be closed — the deselect-refusal case:
        // when the operator tries to remove something another selection requires, the
        // refusal is driven from this list, with the requirer and field as the reason.
        missingRequirements: assertSelectionClosed(resources, selected),
      },
      { headers: { "cache-control": "no-store" } },
    );
  },
);

export const POST = guardedRead(
  DATA_SURFACES.restoreSelectionApi,
  restoreSelection,
);
