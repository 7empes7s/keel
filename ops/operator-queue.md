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

- **Status:** open. Start only after 7empes7s/demo2.0#23 is merged (it switches `civic-agora.service` to `--read-only`;
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

## 2026-10-06: add the Commons argument library to cracia

- **Status:** open. Do this after the claim checker / Ideas entry above, and only once app-deploy@civic has made a
  release that includes 7empes7s/demo2.0#24 live (`ls /opt/civic/current/ops/deploy/civic-commons.service` exists).
- **Asked by:** Marouane, 2026-10-05 ("Commit everything to github and move along the plan don't stop").
- **Repo:** `7empes7s/demo2.0`, `main`. Steps are in `ops/deploy/README.md` (Commons rows).
- **Steps:**
  1. Copy `/opt/civic/current/ops/deploy/civic-commons.service` to `/etc/systemd/system/` and run
     `systemctl daemon-reload`. It serves the shipped seed library on 127.0.0.1:8093, read-only. No drop-in is needed
     (uv only, in `/usr/local/bin`).
  2. In `/etc/civic/companion.env` add `COMMONS_URL=http://127.0.0.1:8093`. Keep `PORT=8788`. Do not add Commons to
     `HEALTH_URLS` (optional service).
  3. `systemctl enable --now civic-commons && systemctl restart civic-companion`.
- **Check:** `curl -s 127.0.0.1:8093/healthz` → `{"ok": true, "arguments": 14, "matters": 2}`. Retry for up to
  60 s: the first start installs numpy (`journalctl -u civic-commons -f`).
- **Does not touch:** Keel, `/opt/keel*`, any M365 tenant. Do not expose 8093 beyond loopback.
- **Done when:** the local check passes and `systemctl is-active civic-commons` is `active`. Comment the output on the
  demo2.0 issue from the entry above (reopen it if closed, then close it again).

## 2026-10-06: switch the cracia Companion to a free-tier open-weight model

- **Status:** open. Start only after both are true: (1) app-deploy@civic has made a release that includes
  7empes7s/demo2.0#40 (`grep -q LLM_BASE_URL /opt/civic/current/ops/deploy/companion.env.example`), and (2) Marouane
  has handed you a Groq API key directly on Mulinux. The key never goes in git, an issue, a log, shell history or a chat.
- **Asked by:** Marouane, 2026-10-06 ("The AI is mostly going to be local at some point … let's choose a free tier and
  go with it for now"; "I don't think anyone would be crazy to rely on APIs of a model they have 0 control over").
- **Repo:** `7empes7s/demo2.0`, `main`. Background: `modules/companion/README.md` ("Choosing a model") and
  `ops/deploy/README.md`.
- **Steps:**
  1. Back up the env file: `cp -p /etc/civic/companion.env /etc/civic/companion.env.bak`.
  2. In `/etc/civic/companion.env` (keep mode 600 and owner) add `LLM_BASE_URL=https://api.groq.com/openai/v1`,
     `LLM_MODEL=llama-3.3-70b-versatile` and `LLM_API_KEY=<the key from Marouane>`, typed in an editor, never on a
     command line. Leave any existing `ANTHROPIC_API_KEY` or `COMPANION_MODEL` lines alone: `LLM_BASE_URL` wins.
     The URL must have no `user:pass@`, query or fragment, or the service refuses to start.
  3. Check Groq still lists the model, reading the key from the file so it never reaches the shell or `ps`:
     `sed -n 's/^LLM_API_KEY=/Authorization: Bearer /p' /etc/civic/companion.env | curl -s -H @- https://api.groq.com/openai/v1/models | jq -r '.data[].id'`.
     If `llama-3.3-70b-versatile` is missing, set `LLM_MODEL` to `qwen/qwen3-32b`, or another open-weight model from
     the list.
  4. `systemctl restart civic-companion`, then `systemctl is-active civic-companion` and
     `journalctl -u civic-companion -n 20`. Expect `active` and `companion model: openai <model> at https://api.groq.com`,
     with no key anywhere. If it is not `active`, restore the backup
     (`cp -p /etc/civic/companion.env.bak /etc/civic/companion.env && systemctl restart civic-companion`) and mark this
     entry `blocked` with the journal lines.
- **Check:**
  1. `curl -s 127.0.0.1:8788/healthz` shows `"companion":true` and `"model":{"kind":"openai","name":"<model>"}`.
  2. One real answer. Run `ID=$(curl -s 127.0.0.1:8788/data/snapshot.json | jq -r '.items[0].id')`, then
     `curl -s -o /tmp/explain.json -w '%{http_code}\n' -X POST 127.0.0.1:8788/api/explain -H 'content-type: application/json' -d "{\"item_id\":\"$ID\",\"lang\":\"fr\"}"`.
     It must print `200`, and `jq '[.sections[].sentences[] | select(.sources | length > 0)] | length' /tmp/explain.json`
     must be above 0 (sentences that cite a source).
  3. On a `502`, read the body. `the model gave an answer that could not be read` means a shape failure: try the other
     model once. `the model did not answer` means the call failed: the `model:` line in the journal names the cause
     (a 401 is the key, a 404 the model name, a 429 or 413 a free-tier limit). Fix that cause, or mark `blocked` with
     the journal line.
- **Does not touch:** Keel, `/opt/keel*`, any M365 tenant. No model runs on Mulinux itself.
- **Done when:** both checks pass. Delete `/etc/civic/companion.env.bak`. Comment the healthz output (it has no key) on
  a new demo2.0 issue titled "Companion on a free-tier open-weight model" and close it.

## 2026-10-07: add Desk (feedback, ideas, votes, procedures) and the staff portals to cracia

- **Status:** done (keel-operator, 2026-10-07 09:12 UTC). Desk `/healthz` ok (5 procedures, 1 staff); Companion
  `"desk":true`; `/portal/` 200 locally and publicly; procedures 5; admin sign-in 200. The live `ff8c05e` release was
  built before the step 1 `BUILD_CMD` change, so the portal was built once in place; later releases build it.
  `LLM_API_KEY` empty (no Groq key yet). Admin password is in `/etc/civic/desk-admin.initial` for Marouane.
  Evidence: https://github.com/7empes7s/demo2.0/issues/48 (closed). Original start condition: Do step 1 now. Do steps 2 to 6 only after 7empes7s/demo2.0#46 is merged and app-deploy@civic has
  made a release at or after its merge commit live:
  `grep -q 'env node' /opt/civic/current/ops/deploy/civic-desk.service && test -f /opt/civic/current/apps/portal/dist/index.html`.
- **Asked by:** Marouane, 2026-10-06 ("I want a full app … has an admin/operator/audit/end-user portals … keep it at
  feedback/suggestions/votes/official procedures' follow-up").
- **Repo:** `7empes7s/demo2.0`, `main`. Background: `docs/product/desk.md`, `modules/desk/README.md`,
  `ops/deploy/README.md` (Desk rows and "Mulinux notes").
- **Shape:** one new unit `civic-desk.service` on 127.0.0.1:8094 (Node 22, SQLite in `/var/lib/civic-desk/desk.db`,
  append-only hash-chained log), `PartOf=civic-companion`. The Companion forwards `/api/desk/*` to it and serves the
  staff portals at `/portal/`. No new port leaves loopback, no Caddy or tunnel change.
- **Steps:**
  1. Back up `/etc/civic/deploy.env` (`cp -p` to `.bak`), then append ` -w @democracy2/portal` to the end of the
     `npm run build -w @democracy2/citizen` part of `BUILD_CMD`, so the next release also builds `apps/portal/dist`.
     Keep the Node 22 `PATH` line. The portal workspace is already on `main` (demo2.0#44), so this is safe before #46.
  2. Copy `/opt/civic/current/ops/deploy/civic-desk.service` to `/etc/systemd/system/`, then give it the same Node 22
     drop-in as the Companion: `mkdir -p /etc/systemd/system/civic-desk.service.d && cp -p
     /etc/systemd/system/civic-companion.service.d/node22.conf /etc/systemd/system/civic-desk.service.d/`. Desk needs
     Node 22 (`node:sqlite`); the system Node cannot run it.
  3. Create `/etc/civic/desk.env` from `/opt/civic/current/ops/deploy/desk.env.example` with
     `install -m 600 -o root -g root`. Generate the first admin password into a root-only file,
     `(umask 077; openssl rand -base64 24 > /etc/civic/desk-admin.initial)`, and put the same value in
     `DESK_BOOTSTRAP_PASSWORD` with an editor, never on a command line. For the model, copy the three `LLM_*` lines
     from `/etc/civic/companion.env` over the example's (an editor again). If the Companion has no key yet (the
     free-tier entry above is still open), leave `LLM_API_KEY` empty: Desk runs, and its three helpers answer
     "no model" until then.
  4. In `/etc/civic/companion.env` add `DESK_URL=http://127.0.0.1:8094` and
     `PORTAL_DIR=/opt/civic/current/apps/portal/dist`. Keep `PORT=8788`. Do not add Desk to `HEALTH_URLS`: it is
     optional, and `/healthz` reports it as `"desk": true|false`.
  5. `systemctl daemon-reload && systemctl enable --now civic-desk && systemctl restart civic-companion`.
  6. Back up `/var/lib/civic-desk/desk.db` with the other civic state if a backup exists for it; never edit the file.
- **Check:**
  1. `curl -s 127.0.0.1:8094/healthz` answers `{"ok":true,...}`, and `journalctl -u civic-desk -n 20` shows no error.
  2. `curl -s 127.0.0.1:8788/healthz` shows `"desk":true` (wait 30 s after the restart first).
  3. `curl -s -o /dev/null -w '%{http_code}\n' 127.0.0.1:8788/portal/` prints `200`, and
     `curl -s 127.0.0.1:8788/api/desk/procedures | jq '.procedures | length'` is above 0 (the Esch seed).
  4. The admin can sign in, reading the password from the file so it never reaches the shell or `ps`:
     `jq -Rn '{login:"admin",password:input}' < /etc/civic/desk-admin.initial | curl -s -o /dev/null -w '%{http_code}\n' -X POST 127.0.0.1:8788/api/desk/staff/login -H 'content-type: application/json' -d @-`
     prints `200`.
- **Do not:** expose 8094 beyond loopback, edit or delete `desk.db`, or put the admin password or a model key in git,
  an issue, a log or a chat. Marouane reads `/etc/civic/desk-admin.initial` on Mulinux, signs in at `/portal/`,
  changes the password, then the file is deleted and `DESK_BOOTSTRAP_PASSWORD` blanked.
- **Does not touch:** Keel, `/opt/keel*`, any M365 tenant.
- **Done when:** the four checks pass and `https://cracia.techinsiderbytes.com/portal/` answers 200. Delete
  `/etc/civic/deploy.env.bak`. Comment the healthz output (no secrets) on a new demo2.0 issue titled
  "Deploy Desk and the staff portals" and close it.
