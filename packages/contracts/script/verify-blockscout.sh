#!/usr/bin/env bash
# Verifies a deployed contract on a Blockscout explorer from Foundry's standard JSON input.
# Works without the solc version list (which forge verify-contract needs) by posting the
# build-info input directly to Blockscout's v2 API.
#
# Usage: script/verify-blockscout.sh <explorer-url> <address> <ContractName> [constructor-args-hex]
# Linked libraries: set LIBRARIES='{"path/File.sol":{"Lib":"0x..."}}' (standard JSON form).
# Example:
#   script/verify-blockscout.sh https://explorer.testnet.chain.robinhood.com 0xabc... CurveilRouter \
#     "$(cast abi-encode 'c(address,address)' 0x... 0x...)"
set -euo pipefail

explorer="${1:?explorer url}"
address="${2:?address}"
name="${3:?contract name}"
args="${4:-}"
args="${args#0x}"

here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Compile only src/ and its imports into a scratch folder. Tests and scripts are left out of the
# input: Blockscout fails to process inputs that carry them, and they do not affect bytecode.
(cd "$here" && forge build --build-info --force --skip test --skip script \
  --out "$work/out" --cache-path "$work/cache" >/dev/null)

python3 - "$work/out/build-info" "$name" "$work/input.json" <<'PY'
import json, os, sys
folder, name, dest = sys.argv[1:4]
for f in sorted(os.listdir(folder)):
    if not f.endswith(".json"):
        continue
    info = json.load(open(os.path.join(folder, f)))
    contracts = info.get("output", {}).get("contracts", {})
    if not contracts or any(name in c for c in contracts.values()):
        inp = info["input"]
        libs = os.environ.get("LIBRARIES")
        if libs:
            inp.setdefault("settings", {})["libraries"] = json.loads(libs)
        json.dump(inp, open(dest, "w"))
        sys.exit(0)
sys.exit(f"{name} not found in build info")
PY

# Must match foundry.toml's solc_version; Blockscout needs the full version with commit.
version="${SOLC_LONG_VERSION:-0.8.28+commit.7893614a}"

curl -sS --max-time 120 -X POST "$explorer/api/v2/smart-contracts/$address/verification/via/standard-input" \
  -F "compiler_version=v$version" \
  -F "contract_name=$name" \
  -F "autodetect_constructor_args=false" \
  -F "constructor_args=$args" \
  -F "license_type=none" \
  -F "files[0]=@$work/input.json;type=application/json"
echo
