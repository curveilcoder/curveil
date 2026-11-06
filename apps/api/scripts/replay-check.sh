#!/usr/bin/env bash
# Rebuilds the index from the chain in a throwaway local database and checks it against the
# live one. Proves the database can be recreated from the chain alone if it is ever lost.
#
#   scripts/replay-check.sh <testnet|mainnet> [port]
#
# Starts a local API with an empty D1, lets its indexer catch up to the live index's
# finalized block, then compares every event table row for row (count, and a checksum of
# block, transaction and log index) up to that block.
set -euo pipefail
NETWORK="${1:?network}"
PORT="${2:-8790}"
DB="curveil-${NETWORK}"
cd "$(dirname "$0")/.."
PERSIST="$(mktemp -d)"
LOG="$PERSIST/dev.log"
cleanup() { [ -n "${DEV:-}" ] && kill "$DEV" 2>/dev/null; sleep 1; rm -rf "$PERSIST"; }
trap cleanup EXIT

remote() { npx wrangler d1 execute "$DB" --remote --env "$NETWORK" --json --command "$1" 2>/dev/null; }
local_() { npx wrangler d1 execute "$DB" --local --env "$NETWORK" --persist-to "$PERSIST" --json --command "$1" 2>/dev/null; }
scalar() { python3 -c "import json,sys; r=json.load(sys.stdin)[0]['results']; print(list(r[0].values())[0] if r else '')"; }

TARGET=$(remote "SELECT finalized_block FROM indexer_state WHERE id = 1" | scalar)
echo "live index finalized at block $TARGET; replaying from scratch"
npx wrangler d1 migrations apply "$DB" --local --env "$NETWORK" --persist-to "$PERSIST" >/dev/null 2>&1
setsid npx wrangler dev --env "$NETWORK" --port "$PORT" --inspector-port $((PORT + 1000)) --persist-to "$PERSIST" > "$LOG" 2>&1 < /dev/null &
DEV=$!

START=$(date +%s)
while :; do
  sleep 15
  curl -s -m 10 "http://localhost:$PORT/v1/status" -o /dev/null || true
  AT=$(local_ "SELECT indexed_block FROM indexer_state WHERE id = 1" | scalar || true)
  [ -n "$AT" ] && echo "  indexed $AT ($(( $(date +%s) - START ))s)"
  [ -n "$AT" ] && [ "$AT" -ge "$TARGET" ] && break
  [ $(( $(date +%s) - START )) -gt 5400 ] && { echo "gave up after 90 minutes"; exit 2; }
done
echo "caught up in $(( $(date +%s) - START ))s"

TABLES="swaps liquidity_events curve_trades launch_events escrow_events vault_commitments vault_nullifiers vault_activity vault_position_events liquidations funding_updates oracle_prices perp_vault_events operator_events fee_distributions governance_events"
FAIL=0
for t in $TABLES; do
  COLS=$(remote "SELECT name FROM pragma_table_info('$t')" | python3 -c "import json,sys; print(' '.join(r['name'] for r in json.load(sys.stdin)[0]['results']))")
  KEY="block_number"
  for c in tx_hash log_index; do case " $COLS " in *" $c "*) KEY="$KEY || ':' || $c";; esac; done
  Q="SELECT COUNT(*) || '/' || COALESCE(SUM(LENGTH($KEY) * block_number % 1000003), 0) AS v FROM $t WHERE block_number <= $TARGET"
  A=$(remote "$Q" | scalar); B=$(local_ "$Q" | scalar)
  if [ "$A" = "$B" ]; then echo "  ok   $t ${A%%/*} rows"; else echo "  DIFF $t live $A, replay $B"; FAIL=1; fi
done
[ $FAIL = 0 ] && echo "replay matches the live index" || { echo "replay differs"; exit 1; }
