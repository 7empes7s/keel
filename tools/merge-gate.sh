#!/usr/bin/env bash
# Merge every open PR labelled `automerge` that passes the gate. See .github/workflows/merge-gate.yml.
# Needs: gh (GH_TOKEN), jq. Optional REQUIRE_REVIEW=true. DRY_RUN=1 prints decisions only.
set -euo pipefail

repo="${GITHUB_REPOSITORY:-$(gh repo view --json nameWithOwner -q .nameWithOwner)}"
owner="${repo%/*}"; name="${repo#*/}"
# Keep in sync with the pull_request paths in portal.yml.
code_paths='^(portal|engine|cli|tools)/|^\.github/workflows/portal\.yml$'
gate_job="Merge gate"
merged=0
refused=0

check_pr() {
  local n="$1" pr sha author files ci runs reviews threads
  # Inside `if check_pr`, set -e is off, so every call checks its own failure.
  pr=$(gh api "repos/$repo/pulls/$n") || { echo "#$n: could not read PR"; return 1; }
  [ "$(jq -r .state <<<"$pr")" = "open" ] || { echo "#$n: not open"; return 1; }
  [ "$(jq -r .draft <<<"$pr")" = "false" ] || { echo "#$n: draft"; return 1; }
  # mergeable is null while GitHub is still computing it; treat that as not ready yet.
  [ "$(jq -r .mergeable <<<"$pr")" = "true" ] || { echo "#$n: not mergeable yet ($(jq -r .mergeable_state <<<"$pr"))"; return 1; }
  sha=$(jq -r .head.sha <<<"$pr")
  author=$(jq -r .user.login <<<"$pr")
  files=$(gh api "repos/$repo/pulls/$n/files?per_page=100" --paginate -q '.[].filename') \
    || { echo "#$n: could not list files"; return 1; }

  # Every check run on the head commit (except this gate) must be finished and not failed.
  runs=$(gh api "repos/$repo/commits/$sha/check-runs?per_page=100" \
    | jq --arg g "$gate_job" '[.check_runs[] | select(.name != $g)]') || { echo "#$n: could not read checks"; return 1; }
  if jq -e 'any(.[]; .status != "completed")' <<<"$runs" >/dev/null; then echo "#$n: checks still running"; return 1; fi
  if jq -e 'any(.[]; .conclusion as $c | ["success","skipped","neutral"] | index($c) | not)' <<<"$runs" >/dev/null; then
    echo "#$n: a check failed"; return 1
  fi

  # A PR that touches code must have a passing Portal run on its head commit.
  if grep -Eq "$code_paths" <<<"$files"; then
    ci=$(gh api "repos/$repo/actions/workflows/portal.yml/runs?head_sha=$sha&per_page=20" -q '.workflow_runs') \
      || { echo "#$n: could not read Portal runs"; return 1; }
    jq -e 'any(.[]; .status == "completed" and .conclusion == "success")' <<<"$ci" >/dev/null \
      || { echo "#$n: Portal has not passed on $sha"; return 1; }
  fi

  # Latest review per reviewer: none may request changes.
  reviews=$(gh api "repos/$repo/pulls/$n/reviews?per_page=100" \
    | jq --arg a "$author" '[.[] | select(.user.login != $a and .state != "PENDING")] | group_by(.user.login) | map(max_by(.submitted_at))') \
    || { echo "#$n: could not read reviews"; return 1; }
  if jq -e 'any(.[]; .state == "CHANGES_REQUESTED")' <<<"$reviews" >/dev/null; then echo "#$n: changes requested"; return 1; fi
  if [ "${REQUIRE_REVIEW:-}" = "true" ] && ! jq -e 'length > 0' <<<"$reviews" >/dev/null; then
    echo "#$n: waiting for a review"; return 1
  fi

  threads=$(gh api graphql -F owner="$owner" -F name="$name" -F n="$n" -f query='
    query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){pullRequest(number:$n){
      reviewThreads(first:100){nodes{isResolved}}}}}' \
    | jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved | not)] | length') \
    || { echo "#$n: could not read review threads"; return 1; }
  [ "$threads" = "0" ] || { echo "#$n: $threads unresolved review thread(s)"; return 1; }
  return 0
}

# A failed list must fail the job: inside $(...) in a for list, set -e would not stop it,
# and the error text would be read as PR numbers.
prs=$(gh api "repos/$repo/issues?labels=automerge&state=open&per_page=100" -q '.[] | select(.pull_request) | .number') \
  || { echo "could not list automerge PRs" >&2; exit 1; }
for n in $prs; do
  if check_pr "$n"; then
    if [ -n "${DRY_RUN:-}" ]; then echo "#$n: ready (dry run)"; continue; fi
    echo "#$n: merging"
    # One refused merge must not stop the others. GitHub refuses GITHUB_TOKEN merges of PRs
    # that change .github/workflows/ (no `workflows` permission); those need a person to merge.
    if gh pr merge "$n" -R "$repo" --merge --delete-branch; then
      merged=$((merged + 1))
    else
      echo "#$n: merge refused; a PR that changes .github/workflows/ must be merged by hand"
      refused=$((refused + 1))
    fi
  fi
done

if [ "$merged" -gt 0 ] && [ -z "${DRY_RUN:-}" ]; then
  gh workflow run portal.yml -R "$repo" --ref master
  echo "Dispatched Portal on master after $merged merge(s)."
fi
# Fail the job after the loop, so a refused merge is visible without blocking the rest.
[ "$refused" -eq 0 ] || exit 1
