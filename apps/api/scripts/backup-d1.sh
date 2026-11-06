#!/usr/bin/env bash
# Exports the API's D1 database and proves the export restores.
#
#   scripts/backup-d1.sh <testnet|mainnet> <output dir>
#
# Writes <db>-<UTC time>.sql and its .sha256, restores the file into a throwaway local D1,
# and compares the row count of every table with the live database. Exits non-zero if any
# count differs. The export holds hashed session tokens and API keys and webhook secrets
# encrypted under WEBHOOK_MASTER_KEY: keep it private, never in git or a shared folder.
set -euo pipefail
NETWORK="${1:?network}"
OUT="${2:?output dir}"
DB="curveil-${NETWORK}"
cd "$(dirname "$0")/.."
mkdir -p "$OUT"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT/$DB-$STAMP.sql"

npx wrangler d1 export "$DB" --remote --env "$NETWORK" --output "$FILE" >/dev/null
sha256sum "$FILE" | cut -d' ' -f1 > "$FILE.sha256"

# Restore into an isolated local copy (its own persistence folder, nothing shared).
PERSIST="$(mktemp -d)"
trap 'rm -rf "$PERSIST"' EXIT
npx wrangler d1 execute "$DB" --local --env "$NETWORK" --persist-to "$PERSIST" --file "$FILE" --yes >/dev/null

TABLES=$(npx wrangler d1 execute "$DB" --remote --env "$NETWORK" --json \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations' ORDER BY name" \
  | python3 -c "import json,sys; print(' '.join(r['name'] for r in json.load(sys.stdin)[0]['results']))")
# One statement per table (D1 limits compound SELECTs); each comes back as its own result.
SQL=$(for t in $TABLES; do printf "SELECT '%s' AS t, COUNT(*) AS n FROM \"%s\"; " "$t" "$t"; done)
count() { npx wrangler d1 execute "$DB" "$@" --env "$NETWORK" --json --command "$SQL" | python3 -c "import json,sys; print(json.dumps({r['t']: r['n'] for s in json.load(sys.stdin) for r in s['results']}, sort_keys=True))"; }
LIVE=$(count --remote)
COPY=$(count --local --persist-to "$PERSIST")

python3 - "$LIVE" "$COPY" "$FILE" <<'PY'
import json, sys
live, copy, f = json.loads(sys.argv[1]), json.loads(sys.argv[2]), sys.argv[3]
# The indexer keeps writing while the export runs, so the live count may be a little ahead.
# A restored table that is missing, larger than live, or more than 1% (at least 5 rows) behind
# is a failed backup.
def ok(t):
    c = copy.get(t)
    return c is not None and c <= live[t] and live[t] - c <= max(5, live[t] // 100)
bad = {t: (live[t], copy.get(t)) for t in live if not ok(t)}
moved = {t: live[t] - copy[t] for t in live if ok(t) and copy[t] != live[t]}
print(f"{f}: {len(live)} tables, {sum(copy.values())} rows restored")
if moved:
    print("written during the export (fine):", moved)
if bad:
    print("FAILED (live, restored):", bad)
    sys.exit(1)
print("restore check passed")
PY
