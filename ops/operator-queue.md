# Operator queue

Work for the keel-operator on Mulinux. One entry per task, newest last. Mark an entry
`done` (with the evidence) or `blocked` (with the reason) when you finish it.

## 2026-10-05: deploy the Democracy2.0 citizen app at cracia.techinsiderbytes.com

- **Status:** done (keel-operator, 2026-10-05 22:55 UTC). `curl -fsS https://cracia.techinsiderbytes.com/healthz` →
  `{"ok":true,"items":18,"companion":false}`; release `c966a21`. Port **8788** (8787 is fact-checker-relay), Node 22 in
  `/opt/node22`, routed through the main tunnel + Caddy instead of a separate `cracia` tunnel. Evidence and the open
  item (no `ANTHROPIC_API_KEY` yet, so the Companion is off): https://github.com/7empes7s/demo2.0/issues/12#issuecomment-6004822579 (closed).
- **Asked by:** Marouane, 2026-10-05 ("publish to cloudflare … call it
  cracia.techinsiderbytes.com", then "if not use the keel-operator").
- **Repo:** `7empes7s/demo2.0`, default branch `main`.
- **Steps:** follow `ops/deploy/README.md` in that repo, in order. The full checklist is
  issue 7empes7s/demo2.0#12.
- **Shape:** one systemd unit `civic-companion.service` on 127.0.0.1:8787 with `/healthz`,
  pull-based deploys through brain's `app-deploy@civic` timer (CI-green `main` only),
  a twice-daily `civic-docket.timer` refreshing the Luxembourg Chamber snapshot, and a
  Cloudflare tunnel named `cracia` (`ops/deploy/publish-cloudflare.sh`).
- **Secrets:** `ANTHROPIC_API_KEY` goes in `/etc/civic/companion.env` (mode 600). The app
  runs without it; the Companion answers are then switched off. Never commit it.
- **Does not touch:** Keel, `/opt/keel*`, any M365 tenant.
- **Check:** `curl -s 127.0.0.1:8090/healthz` (`{"ok": true, "items": N, "sentences": M}`) and
  `curl -s 127.0.0.1:8091/healthz` (`{"ok": true, "ideas": 0, "identity": "none"}`; `"none"` proves Agora is read-only);
  then wait 30 s before the public check (the Companion caches a failed check for 30 s).
- **Done when:** `curl -fsS https://cracia.techinsiderbytes.com/healthz` returns
  `{"ok":true,...}` with `items` above 0. Comment the output on demo2.0#12 and close it.

## 2026-10-06: add the claim checker and the read-only Ideas list to cracia

- **Status:** done (keel-operator, 2026-10-06 03:15 UTC). Public `/healthz` →
  `{"ok":true,"items":18,"companion":false,"provenance":true,"agora":true}`; `/api/ideas` →
  `{"charter_version":"0.1.0","ideas":[]}`; Agora `identity: "none"` (read-only), 8090/8091 loopback only.
  Evidence: https://github.com/7empes7s/demo2.0/issues/25 (closed). Original start condition: Start only after 7empes7s/demo2.0#23 is merged (it switches `civic-agora.service` to `--read-only`;
  the unit on `main` before that still expects a key file) and app-deploy@civic has made a release at or after its merge
  commit live (`curl -s 127.0.0.1:8788/healthz` shows an `"agora"` key).
- **Asked by:** Marouane, 2026-10-05 ("Commit everything to github and move along the plan don't stop").
- **Repo:** `7empes7s/demo2.0`, `main`. The live release already auto-updates through `app-deploy@civic`; this entry only
  installs the two new optional services that the release now expects.
- **Steps:** follow `ops/deploy/README.md` on current `main`:
  1. `mkdir -p /opt/civic/shared/{venv,uv-cache,python}` and chown to `civic` (already created for civic-docket;
     harmless to re-run; the units need these to exist).
  2. Copy `/opt/civic/current/ops/deploy/civic-provenance.service` and `civic-agora.service` to `/etc/systemd/system/`
     (127.0.0.1:8090 and 127.0.0.1:8091; Agora runs `--read-only`: it refuses every post and vote), then run
     `systemctl daemon-reload`. No drop-in is needed: both units run only uv, which is in `/usr/local/bin` (#12), not node.
  3. In `/etc/civic/companion.env` add `PROVENANCE_URL=http://127.0.0.1:8090` and `AGORA_URL=http://127.0.0.1:8091`.
     Keep `PORT=8788`. Do not add either service to `HEALTH_URLS`: both are optional and the app degrades to
     "unavailable" without them.
  4. `systemctl enable --now civic-provenance civic-agora && systemctl restart civic-companion`.
- **Do not:** start Agora with `--dev-identity` or a nym key, or expose 8090/8091/8092 beyond loopback. Writes stay off
  until the Door verifier is deployed (separate entry, later).
- **Does not touch:** Keel, `/opt/keel*`, any M365 tenant.
- **Check:** `curl -s 127.0.0.1:8090/healthz` (`{"ok": true, "items": N, "sentences": M}`) and
  `curl -s 127.0.0.1:8091/healthz` (`{"ok": true, "ideas": 0, "identity": "none"}`; `"none"` proves Agora is read-only);
  then wait 30 s before the public check (the Companion caches a failed check for 30 s).
- **Done when:** `curl -fsS https://cracia.techinsiderbytes.com/healthz` shows `"provenance":true` and `"agora":true`,
  and `curl -fsS 'https://cracia.techinsiderbytes.com/api/ideas'` returns `{"charter_version":...,"ideas":[]}`.
  Comment the output on a new demo2.0 issue titled "Deploy claim checker and Ideas list" and close it.
