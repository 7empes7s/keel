# KEEL keelops queue

Work queue between the **coordinator** (the KEEL Developer cloud session) and
**keelops** (the VPS session running as the `keelops` user). It lives only on
branch `claude/keelops-queue` and is never merged to master. This keeps deploys from
being triggered by queue updates.

## Protocol

**Who writes what**
- The coordinator adds and edits items.
- keelops writes only each item's `Status` and `Result` fields.
- The **Operator decisions** section is written only by the human operator. No Claude
  session fills in or changes a decision.

**keelops, on each pass**
1. `git fetch origin claude/keelops-queue` and check out its tip.
2. Take the first item with `Status: todo` whose `Needs` are all `done`, and whose
   decisions (if any) are filled in below by the human operator.
3. Set `Status: in-progress` and push. Do the work. Then set `Status` to `done`,
   `blocked` or `failed` and write `Result`. A Result names:
   - the evidence branch (if any) and the commit it captured;
   - the verify output and its exit code;
   - what was created or changed in the tenant or on the host;
   - anything blocking.
   Then push. If a push is rejected, `git pull --rebase` and retry. Only ever touch your
   own fields.
4. One item at a time. If an item is blocked, move on to the next one it doesn't
   block.

**Hard rules for every item**
- Tenant objects:
  - Create or change only `KEEL-RT-*` or `keel-rehearsal-*` fixtures.
  - Never touch the operator's admin, break-glass or Global Reader accounts.
  - No Conditional Access, MFA or security-defaults changes.
  - Never grant an app a new permission or role unless a filled decision below says so.
- Secrets: never print, log or commit a secret (HMAC key, JWT, token, certificate,
  password).
- Evidence:
  - Never hand-edit evidence.
  - A failed or refused capture is a result. Report it.
  - Check every evidence file for secrets before committing it.
- Git:
  - Never push to master, merge a PR, or force-push.
  - Never edit tests or code; if a step seems to need that, report it as `blocked`.
  - Evidence goes on `claude/live-evidence-<task>`, branched from `origin/master`, and
    contains only that gate's files under `docs/release/qualifications/`.
- Host: don't run git in `/opt/keel`. Use your own clone or a worktree, checked out at
  the commit `/opt/keel-live` is deployed at.
- Builds: each record binds to one build. Run 120 → 121 → 122 → 123 in one sitting at
  the same deployed build (each requires the previous record to verify at that build).
  If `/opt/keel-live` moves during a chain, stop and report.

## Items

### K1: Setup check: report the live build and health (read-only)
- Drafted by the "Mulinux Claude operator setup" thread (2026-10-25) to prove the queue wake-up end to end.
- Needs: nothing.
- Status: todo
- Result:
- Do: report `git -C /opt/keel-live rev-parse --short HEAD`, the body of `curl -s http://127.0.0.1:3600/api/health`, and the time you received the `[keelops-queue]` message. Change nothing.
- **Expected:** a short sha and `"status":"ok"`.

## Operator decisions (human operator only)

Write `yes`, `no` or your instructions after each one. If a decision is blank, every
item that needs it stays untouched.
