#!/usr/bin/env bash
# Prints the engine-side test files that CI runs in the "Run restore engine tests" step of
# .github/workflows/portal.yml, one per line, relative to engine/ (the step's working
# directory). Discovery is by glob over tracked files, so a new *.test.mjs under engine/,
# cli/ or tools/ runs in CI without editing the workflow.
#
#   tools/engine-test-files.sh                 # list
#   cd engine && node --test --test-concurrency=1 $(../tools/engine-test-files.sh)
#
# EXCLUDED lists files that cannot pass on a CI runner. Keep it short and give a reason;
# remove an entry once its test is fixed.
set -euo pipefail

EXCLUDED=(
  # Reads host-only material (/opt/mimoun/backup.sh) that a runner does not have.
  engine/store/dumpManifest.test.mjs
  # Need the pinned benchmark catalogs under /var/lib/keel/reference-data.
  engine/roadmap/nist-benchmark-acceptance.test.mjs
  engine/roadmap/scubagear-benchmark-acceptance.test.mjs
  # Fail today (null revision lookup); never ran in CI. Fix, then remove from this list.
  engine/roadmap/foundation.test.mjs
  # 5 of 17 subtests fail today; never ran in CI. Fix, then remove from this list.
  cli/keel-scheduler.test.mjs
)

root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"

files="$(git ls-files -- 'engine/*.test.mjs' 'cli/*.test.mjs' 'tools/*.test.mjs' \
  | grep -vxF -f <(printf '%s\n' "${EXCLUDED[@]}") \
  | sed -e 's#^engine/##' -e 's#^\(cli\|tools\)/#../\1/#')"

if [ -z "$files" ]; then
  echo "engine-test-files: discovered no test files" >&2
  exit 1
fi
printf '%s\n' "$files"
