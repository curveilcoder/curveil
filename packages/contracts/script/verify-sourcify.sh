#!/usr/bin/env bash
# Publishes the source of every contract a forge script deployed to Sourcify, which Blockscout
# reads. Works from the broadcast file, so no constructor arguments are needed: Sourcify matches
# the creation transaction itself.
#
# Usage: script/verify-sourcify.sh <chain id> <broadcast run-latest.json>...
# Example: script/verify-sourcify.sh 4663 broadcast/DeployMarkets.s.sol/4663/run-latest.json
set -euo pipefail

chain="${1:?chain id}"
shift
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Compile only src/ and its imports, the same way the deploy did (scripts do not change bytecode).
(cd "$here" && forge build --build-info --force --skip test --skip script \
  --out "$work/out" --cache-path "$work/cache" >/dev/null)

python3 - "$chain" "$work/out" "$@" <<'PY'
import json, os, sys, time, urllib.request
chain, out, runs = sys.argv[1], sys.argv[2], sys.argv[3:]
API = "https://sourcify.dev/server"
version = os.environ.get("SOLC_LONG_VERSION", "0.8.28+commit.7893614a")

# Contract name -> (source path, standard JSON input), from the build info.
where = {}
folder = os.path.join(out, "build-info")
for f in sorted(os.listdir(folder)):
    if not f.endswith(".json"):
        continue
    info = json.load(open(os.path.join(folder, f)))
    for path, cs in info.get("output", {}).get("contracts", {}).items():
        for name in cs:
            where.setdefault(name, (path, info["input"]))

def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

def get(url):
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

todo = []
for run in runs:
    b = json.load(open(run))
    for t in b["transactions"]:
        if t.get("contractName") and t.get("contractAddress") and t.get("transactionType") in ("CREATE", "CREATE2"):
            todo.append((t["contractName"], t["contractAddress"], t["hash"]))
        for a in t.get("additionalContracts", []):
            if a.get("contractName"):
                todo.append((a["contractName"], a["address"], t["hash"]))

for name, addr, tx in todo:
    if name not in where:
        print(f"skip {name} {addr}: not in build info")
        continue
    st, j = get(f"{API}/v2/contract/{chain}/{addr}")
    if st == 200 and j.get("match"):
        print(f"ok   {name} {addr} already {j['match']}")
        continue
    path, inp = where[name]
    st, j = post(f"{API}/v2/verify/{chain}/{addr}", {
        "stdJsonInput": inp, "compilerVersion": version,
        "contractIdentifier": f"{path}:{name}", "creationTransactionHash": tx,
    })
    vid = j.get("verificationId")
    if not vid:
        print(f"fail {name} {addr}: {st} {json.dumps(j)[:200]}")
        continue
    for _ in range(40):
        time.sleep(3)
        st, s = get(f"{API}/v2/verify/{vid}")
        if s.get("isJobCompleted"):
            c = s.get("contract") or {}
            err = s.get("error")
            print(f"{'ok  ' if c.get('match') else 'fail'} {name} {addr} {c.get('match') or (err or {}).get('message', '')[:160]}")
            break
    else:
        print(f"wait {name} {addr}: still running ({vid})")
PY
