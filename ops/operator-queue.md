# Operator queue

Work for the keel-operator on Mulinux. One entry per task, newest last. Mark an entry
`done` (with the evidence) or `blocked` (with the reason) when you finish it.

## 2026-10-05: deploy the Democracy2.0 citizen app at cracia.techinsiderbytes.com

- **Status:** open
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
- **Done when:** `curl -fsS https://cracia.techinsiderbytes.com/healthz` returns
  `{"ok":true,...}` with `items` above 0. Comment the output on demo2.0#12 and close it.
